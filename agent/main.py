"""
NotiOps Web Chat agent —— AgentCore Runtime 入口（Strands Agents）。

契约（docs: HTTP protocol contract）：BedrockAgentCoreApp 自动暴露
  POST /invocations（JSON 入、SSE 出）、GET /ping，监听 0.0.0.0:8080。
agent.stream_async() 的事件被 yield 出去 → Runtime 转成 SSE 流。

工具：
  - aws_docs_search / aws_docs_read：官方文档检索（doc-first 防幻觉）。
  - web_search：联网搜索（AWS 原生 AgentCore web-search，查询不出 AWS），逐请求门控、
    默认关；用户在前端开启后 BFF 透传 payload.web_search=True 才生效。

BFF（bff/web-chat）通过 bedrock-agentcore:InvokeAgentRuntime 调本 runtime，
session_id = 前端 conversationId，把 SSE 透传给浏览器。payload 字段：
  prompt / text（必填）、model（可选）、locale（zh|en）、web_search（bool）。

注意：实际部署用的是 agent-build/ 下的 AgentCore CLI 脚手架（含 memory/MCP 接线，
.venv 故 gitignore）；本目录是**手写源码权威副本**，保持与部署行为一致。
"""
import json
import os

from strands import Agent
from strands.models import BedrockModel
from bedrock_agentcore import BedrockAgentCoreApp

from prompt import SYSTEM_PROMPT
from tools import (aws_docs_search, aws_docs_read, web_search, WEB_SEARCH_ENABLED,
                   CASE_TOOLS, PROPOSED_ACTIONS)
from core import finops_mcp as _finops_mcp  # 官方 awslabs cost+pricing MCP（进程内 stdio）

# FinOps 工具来自官方 MCP（只读白名单）；起不来则空列表，agent 照常运行。
try:
    FINOPS_TOOLS = _finops_mcp.get_tools()
except Exception:  # noqa: BLE001
    FINOPS_TOOLS = []
from core import web_search as _web_search_mod  # 强制必搜时直接调用其 search()

# 主题聚焦指令：topic != general 时注入，让主题 chat 针对该主题优化；工具仍全在。
_TOPIC_FOCUS = {
    "cases": (
        "[当前处于 **Support Cases 主题**。你是用户的 AWS Support 案例 AI 助手，不只是查询/创建工具：\n"
        "- 用户问案例时，先用 support_cases_list/support_case_get/support_case_communications 拉全相关 case，"
        "然后**主动给出**：整体梳理、当前卡点、根因解读、对 AWS 回复的解释、下一步建议。\n"
        "- 需要时**主动起草回复草稿**，并可提议「回复该 case」。\n"
        "- 创建/回复/关闭 case 是写操作：用 support_case_create/reply/resolve **提议**，"
        "只生成确认卡，用户确认后才执行，**绝不声称已执行**。\n"
        "- 计划不足(support_plan_required)时礼貌说明需 Business/Enterprise 计划。\n"
        "- case 标识：工具返回里有短数字（面向控制台）和长内部 ID 两个；一律用短数字、绝不用长的。\n"
        "- **面向用户一律称「Case ID / 案例 ID」，绝不用 displayId/caseId 等内部字段名**（用户读不懂）。\n"
        "- **凡提到 case 的 ID 都输出成可点击链接**："
        "`[<短数字ID>](https://support.console.aws.amazon.com/support/home#/case/?displayId=<短数字ID>)`。]\n\n"
    ),
    "finops": (
        "[当前处于 **FinOps（成本）主题**。你是用户的 AWS 成本优化顾问，不只是报数字的查询器。\n"
        "你有官方 AWS 成本/定价工具（awslabs MCP）：`cost-explorer`（成本/用量，preview 时用 "
        "`session-sql` 跟进）、`cost-comparison`、`cost-anomaly`、`cost-optimization`、`compute-optimizer`、"
        "`rec-details`、`ri-performance`、`sp-performance`、`budgets`、`free-tier-usage`、`storage-lens`、"
        "`list-cost-allocation-tags`；定价 `get_pricing`（先用 `get_pricing_service_codes`/`_attributes`/"
        "`_attribute_values` 定位维度）、`generate_cost_report`。\n"
        "- 回答成本/定价问题**必须先调对应工具拿真实数据**再作答，绝不编造金额/单价。\n"
        "- 拿到数据后**主动解读**：花在哪、为何涨降、有无异常、哪里能省，给可落地的下一步建议。\n"
        "- 用 Markdown 表格展示明细（金额+占比+环比/对比），金额带币种。\n"
        "- 某些数据源需账号内开启（Cost Optimization Hub / Compute Optimizer）；未启用时礼貌告知如何开启。\n"
        "- 只读查询，安全；不要输出任何变更命令。]\n\n"
    ),
}

app = BedrockAgentCoreApp()

# 模型可由 BFF 通过 payload.model 覆盖；默认跟随 config/llm-model-catalog.json 的
# default_model（现为 Grok 4.6）。
#
# ⚠️ 这份 alias→model_id 映射是**离线镜像**，不是运行时权威。部署的 agent
# （agent-build/NotiOpsWebChat/app/NotiOpsWebChat/model/load.py）从 DDB 的模型目录
# （PK=llmcfg）解析，Admin 改完下一条消息即生效；那边**刻意没有**合并这张硬编码表
# （见该文件顶部注释）。所以这里只需与 config/llm-model-catalog.json 的 seed 值同值，
# 加新模型时**先改目录**，这张表只是让本目录能独立跑起来。
_DEFAULT_MODEL = os.environ.get(
    "NOTIOPS_DEFAULT_MODEL", "global.xai.grok-4.6"
)

_MODEL_MAP = {
    "xai-grok-4-6": "global.xai.grok-4.6",  # 目录 default_model
    "claude-sonnet-5": "global.anthropic.claude-sonnet-5",
    "claude-opus-5": "global.anthropic.claude-opus-5",
    "claude-haiku-4-5": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    "claude-sonnet-4-6": "global.anthropic.claude-sonnet-4-6",  # 目录里已 disabled，留给老会话
    "amazon-nova-pro": "apac.amazon.nova-pro-v1:0",
    "deepseek-v3-2": "deepseek.v3.2",  # Bedrock ON_DEMAND，支持流式
    "gpt-5-6": "openai.gpt-5.6-terra",  # 走 Bedrock Mantle（OpenAI Responses API），见下
    "gpt-5-6-sol": "openai.gpt-5.6-sol",    # GPT-5.6 Sol，走 Mantle
    "gpt-5-6-luna": "openai.gpt-5.6-luna",  # GPT-5.6 Luna，走 Mantle
}

# 走 Bedrock Mantle 的模型（OpenAI Responses API，非标准 Converse）。
# 区域由这里**显式指定**（runtime 在 us-east-1，Mantle 不在），不从 model id 推。
# us-east-2 这个取值来自 GPT-5.4/5.5 那代的区域约束（AWS 博客见下）；给 5.6 沿用是
# 实测可用，换新模型/新区域前请重新核对，别把旧博客当 5.6 的依据。
# https://aws.amazon.com/blogs/aws/get-started-with-openai-gpt-5-5-gpt-5-4-models-and-codex-on-amazon-bedrock/
_MANTLE_MODELS = {
    "gpt-5-6": {"model_id": "openai.gpt-5.6-terra", "region": "us-east-2"},
    "gpt-5-6-sol": {"model_id": "openai.gpt-5.6-sol", "region": "us-east-2"},
    "gpt-5-6-luna": {"model_id": "openai.gpt-5.6-luna", "region": "us-east-2"},
}


def _make_mantle_responses_model(cfg: dict):
    """构造走 Bedrock Mantle 的 GPT-5.6（OpenAI Responses API）模型实例。

    坑：Strands 1.44 的 Mantle base_url 模板是 `https://bedrock-mantle.{region}.api.aws/v1`，
    **少了 `/openai`**。正确应为 `.../api.aws/openai/v1`（见 AWS 博客）。否则请求打到
    `/v1/responses`，服务端报 "model does not support the '/v1/responses' API"。
    修法：子类化 OpenAIResponsesModel，重写 _resolve_client_args —— 仍用官方逻辑每请求
    铸新 bearer token，只把 base_url 补成 `/openai/v1`（已含则不重复插，幂等）。"""
    from strands.models.openai_responses import OpenAIResponsesModel

    class _MantleResponsesModel(OpenAIResponsesModel):
        def _resolve_client_args(self):  # type: ignore[override]
            args = super()._resolve_client_args()
            base = args.get("base_url") or ""
            if base.endswith("/v1") and "/openai/v1" not in base:
                args["base_url"] = base[: -len("/v1")] + "/openai/v1"
            return args

    return _MantleResponsesModel(
        model_id=cfg["model_id"],
        bedrock_mantle_config={"region": cfg["region"]},
    )


def _build_agent(model_key: str | None, topic: str | None = None) -> Agent:
    key = model_key or ""
    if key in _MANTLE_MODELS:
        try:
            model = _make_mantle_responses_model(_MANTLE_MODELS[key])
        except Exception:  # noqa: BLE001 — 依赖缺失/区域未开通 → 回退默认，不阻断整轮
            model = BedrockModel(model_id=_DEFAULT_MODEL)
    else:
        model = BedrockModel(model_id=_MODEL_MAP.get(key, _DEFAULT_MODEL))
    # 单 agent 全能：Cases 等工具在任何对话都必须可用（用户可在通用对话直接开案例）。
    # 曾按主题裁剪省 token，但会让通用对话无法创建案例 —— 破坏核心能力，已回退。
    return Agent(
        model=model,
        system_prompt=SYSTEM_PROMPT,
        tools=[aws_docs_search, aws_docs_read, web_search, *CASE_TOOLS, *FINOPS_TOOLS],
    )


def _lang_directive() -> str:
    """每轮语言指令：**用与用户问题相同的语言回答**（中→中、英→英、日→日、韩→韩…）。
    不做任何语言检测——模型本就能自动匹配任意语言；之前硬塞 'Respond in English'
    才导致中文提问被强制英文。注意：不能用前端 UI 语言(locale)决定回答语言，
    因为 UI 默认英文，会把非英文提问也带偏。"""
    return ("[Reply in the SAME language as the user's question "
            "(Chinese→Chinese, English→English, 日本語→日本語, 한국어→한국어, etc.).]\n\n")


def _has_cjk(text: str) -> bool:
    """本轮是否为中文（含 CJK 字符即视为中文；否则英文）。用于进度行文案的语言选择，
    与正文的『跟随提问语言』一致——中问中答、英问英答。"""
    return any("一" <= c <= "鿿" for c in (text or ""))


# 工具名 → 面向用户的一句"正在做什么"（处理期间进度行文案，双语随本轮语言）。
# 未收录的工具（含动态 MCP 工具，如成本）走启发式兜底。纯展示用，绝不因其失败影响正文。
_TOOL_PROGRESS = {
    "aws_docs_search": ("查阅 AWS 文档", "Reading AWS docs"),
    "aws_docs_read": ("查阅 AWS 文档", "Reading AWS docs"),
    "web_search": ("联网搜索", "Searching the web"),
    "support_cases_list": ("查询 Support 工单", "Fetching support cases"),
    "support_case_get": ("查询 Support 工单", "Fetching support case"),
    "support_case_communications": ("读取工单往来", "Reading case correspondence"),
    "support_case_create": ("准备创建工单", "Preparing to create a case"),
    "support_case_reply": ("准备回复工单", "Preparing case reply"),
    "support_case_resolve": ("准备关闭工单", "Preparing to resolve case"),
}


def _progress_for_tool(name: str, en: bool) -> str:
    """把工具名翻成一句进度文案（双语，随本轮语言）。收录表优先；未收录的按关键词启发式归类。"""
    n = (name or "").strip()
    pair = _TOOL_PROGRESS.get(n)
    if pair:
        return pair[1] if en else pair[0]
    low = n.lower()
    if "cost" in low or "pricing" in low or "billing" in low or low.startswith("ce_"):
        return "Analyzing cost data" if en else "分析成本数据"
    if "search" in low or "query" in low or "get" in low or "describe" in low or "list" in low:
        return "Fetching data" if en else "检索数据"
    return "Working" if en else "正在处理"


def _collect_sources(messages, since_idx: int):
    """扫描本轮新增消息里的 toolResult，解析工具返回的 JSON，提取 sources。
    aws_docs_* / web_search 都返回 {..., "sources":[{icon,title,detail}]}，
    Strands 把 dict 结果 json.dumps 进 toolResult 的 content[].text。去重后返回。"""
    out, seen = [], set()
    for msg in messages[since_idx:]:
        content = msg.get("content", []) if isinstance(msg, dict) else []
        for block in content:
            if not isinstance(block, dict):
                continue
            tr = block.get("toolResult")
            if not isinstance(tr, dict):
                continue
            for c in tr.get("content", []):
                txt = c.get("text") if isinstance(c, dict) else None
                if not txt:
                    continue
                try:
                    data = json.loads(txt)
                except (ValueError, TypeError):
                    continue
                srcs = data.get("sources") if isinstance(data, dict) else None
                if not isinstance(srcs, list):
                    continue
                for s in srcs:
                    if not isinstance(s, dict):
                        continue
                    key = s.get("detail") or s.get("title")
                    if not key or key in seen:
                        continue
                    seen.add(key)
                    out.append({
                        "icon": s.get("icon", "doc"),
                        "title": s.get("title") or key,
                        "detail": s.get("detail", ""),
                    })
    return out


def _event_has_bytes(obj, _depth: int = 0) -> bool:
    """事件里是否含 bytes —— 含 bytes 的事件**一律不能发给前端**。

    AgentCore runtime 序列化事件时 json.dumps 遇到 bytes 抛 TypeError，其兜底是
    `json.dumps(str(obj))` —— 整个事件的 **Python repr** 变成一个合法 JSON 字符串发出，
    BFF 拿到字符串事件当正文追加，用户在回答里看到
    `{'event': {…'reasoningContent': {'redactedContent': b'rsn_…'`。
    实测触发者是 Grok 这类**加密思考链**模型（Sonnet 的思考链是明文 text，不带 bytes，
    所以同一份代码在 Sonnet 上看不出问题）。已知来源见下面 `_stream_events` 的按名过滤；
    本函数是兜底，保证换模型/新增二进制 chunk 时失败模式不再是「往回答里灌 repr」。"""
    if isinstance(obj, (bytes, bytearray, memoryview)):
        return True
    if _depth > 6:  # 事件是浅结构；设上限防病态嵌套
        return False
    if isinstance(obj, dict):
        return any(_event_has_bytes(v, _depth + 1) for v in obj.values())
    if isinstance(obj, (list, tuple)):
        return any(_event_has_bytes(v, _depth + 1) for v in obj)
    return False


def _stream_events(event, en: bool):
    """把 Strands 的一个原始 stream 事件翻成 0..n 个「发给前端」的事件。

    只转发**看得懂的**事件：正文增量原样、工具开始 → 进度行、思考过程明文 → reasoning。
    其余（Strands 自有事件、contentBlockStart、加密思考链、任何含 bytes 的事件）一律丢弃。
    """
    if not isinstance(event, dict) or "event" not in event:
        return []  # Strands 自有事件（init_event_loop / TextStreamEvent 等）不外发
    _ev = event["event"]
    cbs = _ev.get("contentBlockStart")
    if cbs is not None:
        _tu = (cbs.get("start") or {}).get("toolUse") or {}
        _tname = _tu.get("name") if isinstance(_tu, dict) else ""
        return [{"progress": {"text": _progress_for_tool(_tname, en), "kind": "tool"}}] if _tname else []
    _delta = (_ev.get("contentBlockDelta") or {}).get("delta") or {}
    if isinstance(_delta, dict) and isinstance(_delta.get("text"), str):
        return [event]  # 正文增量：最常见的一支，先走
    _rc = _delta.get("reasoningContent") if isinstance(_delta, dict) else None
    if isinstance(_rc, dict):
        # 只发明文思考；signature / redactedContent 对用户无意义，且后者是 bytes。
        _rtext = _rc.get("text")
        return [{"reasoning": {"text": _rtext}}] if isinstance(_rtext, str) and _rtext else []
    if _event_has_bytes(event):
        return []
    return [event]


@app.entrypoint
async def invoke(payload):
    """AgentCore Runtime 调用入口。payload 来自 BFF 的 InvokeAgentRuntime body。"""
    user_message = payload.get("prompt") or payload.get("text") or ""
    if not user_message:
        yield {"error": "no prompt"}
        return

    # 本轮是否开启联网搜索（前端开关 → BFF 透传）。ContextVar 逐请求隔离。
    web_on = bool(payload.get("web_search"))
    WEB_SEARCH_ENABLED.set(web_on)
    # FinOps Agent 深度模式（前端开关 → BFF payload.finops_agent，仅 FinOps 主题）。
    # ⚠️ 占位：AWS FinOps Agent（preview）暂无公开调用 API，等其开放远程调用再接真实调用。
    finops_deep = bool(payload.get("finops_agent"))
    PROPOSED_ACTIONS.set([])  # 重置本轮待确认写操作收集器

    agent = _build_agent(payload.get("model"), payload.get("topic"))
    ws = "ON" if web_on else "OFF"
    now = str(payload.get("now") or "")
    model_id = _MODEL_MAP.get(payload.get("model") or "", _DEFAULT_MODEL)
    # 常驻元信息压成一行 [ctx: …]（system prompt 已说明：这是背景、勿复述）。
    # 压成一行可显著减少弱模型(Nova)对简单输入过度解释。
    meta = []
    if now: meta.append(f"date={now}")
    meta.append(f"model={model_id}")
    meta.append(f"web_search={ws}")
    ctx = f"[ctx: {'; '.join(meta)}]\n"
    focus = _TOPIC_FOCUS.get(str(payload.get("topic") or "general"), "")  # 主题聚焦
    # FinOps 深度模式占位说明（开启时注入）：先用快档成本工具尽力答 + 诚实告知深度模式即将上线。
    finops_note = (
        "[FinOps Agent 深度模式已开启：AWS FinOps Agent 的远程调用能力尚在路上，本轮先用现有"
        "成本工具尽力分析；请在回答末尾用一句话友好告知用户「深度 FinOps Agent 分析即将上线，"
        "当前已为你做了快速成本分析」。]\n" if finops_deep else ""
    )
    # Skills 注入：显式 /skill（payload.skill_id 强注入全文）或自然语言（注入 skill 目录）。
    skill_note = ""
    try:
        from core import skills as _skills
        _sid = str(payload.get("skill_id") or "").strip()
        if _sid:
            _sk = _skills.load_skill_body(_sid)
            if _sk and _sk.get("body"):
                skill_note = (f"[用户显式选择使用 Skill「{_sk['name']}」。请严格按下面内容处理本轮，"
                              f"并在开头用一句话说明正在使用该 Skill「{_sk['name']}」——"
                              f"**这句话以及整条回复都必须用【与用户提问相同的语言】**"
                              f"(英文问就用英文，如「Using Skill: {_sk['name']}」；中文问才用中文)。\n"
                              f"=== Skill ===\n{_sk['body']}\n=== 结束 ===]\n")
        else:
            skill_note = _skills.skills_directive()
    except Exception:  # noqa: BLE001
        skill_note = ""
    prompt = f"{ctx}{_lang_directive()}{focus}{finops_note}{skill_note}{user_message}"

    # ── 勾选 web search = 强制必搜（确定性，不依赖模型自行决定）──
    # 直接对用户问题预搜一次，结果作为上下文喂入；搜索失败/无结果则回退大模型作答。
    forced_sources = []
    if web_on:
        year = now[:4] if now[:4].isdigit() else ""
        search_q = f"{user_message} {year}".strip() if year and year not in user_message else user_message
        try:
            res = _web_search_mod.search(search_q)
        except Exception:  # noqa: BLE001 — 搜索失败不阻断回答
            res = {}
        if res.get("text"):
            forced_sources = res.get("sources", []) or []
            prompt += ("\n\n[联网搜索结果（已为本轮自动检索，请**基于以下结果**作答，"
                       "优先采用日期较新的条目；不要用训练记忆里的旧信息回答时效性问题）]:\n"
                       + res["text"])
        else:
            prompt += ("\n\n[联网搜索本轮未返回可用结果。请基于你已有的知识尽力作答；"
                       "若涉及最新/实时信息，提醒用户该信息可能不是最新、可稍后重试联网搜索。]")

    start_idx = len(agent.messages)

    # 本轮语言（进度行文案随之，与正文『跟随提问语言』一致）。
    _en = not _has_cjk(user_message)

    # 流式：把 Strands 的事件逐个 yield，Runtime 转 SSE。
    # 额外抽出两类"处理中"信号（长耗时时聊天窗口不再干等）：
    #   · 工具开始调用 → {progress}：一句"正在做什么"（双语随本轮语言）。
    #   · reasoning 增量 → {reasoning}：模型思考过程（前端可折叠灰字，收到正文即隐藏）。
    async for event in agent.stream_async(prompt):
        for _out in _stream_events(event, _en):
            yield _out

    # 收尾：合并强制预搜来源 + 模型额外调工具的来源，去重后作为末尾事件发出。
    try:
        sources = list(forced_sources)
        seen = {s.get("detail") or s.get("title") for s in sources}
        for s in _collect_sources(agent.messages, start_idx):
            key = s.get("detail") or s.get("title")
            if key and key not in seen:
                seen.add(key)
                sources.append(s)
        if sources:
            yield {"sources": sources}
    except Exception:  # noqa: BLE001 — 收集失败不影响正文
        pass

    # 收尾：把本轮待确认的写操作提议发给前端（确认卡）。
    try:
        actions = PROPOSED_ACTIONS.get() or []
        if actions:
            yield {"actions": actions}
    except Exception:  # noqa: BLE001
        pass

    # 收尾：把**本轮**的 token 用量发给前端（消息末尾显示如「· 1,234 tokens」）。
    # Strands 每次 stream_async 开始会 reset_usage_metrics()，故此处的
    # accumulated_usage 恰好是本轮累计用量，逐请求隔离、可直接用。
    try:
        usage = getattr(agent.event_loop_metrics, "accumulated_usage", None)
        if usage:
            inp = int(usage.get("inputTokens", 0) or 0)
            out = int(usage.get("outputTokens", 0) or 0)
            tot = int(usage.get("totalTokens", 0) or (inp + out))
            if tot:
                yield {"usage": {"inputTokens": inp, "outputTokens": out, "totalTokens": tot}}
    except Exception:  # noqa: BLE001
        pass


if __name__ == "__main__":
    app.run()
