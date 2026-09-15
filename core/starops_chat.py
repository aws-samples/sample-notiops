"""「STAROps 对话」（IM 侧）—— 直连阿里云 **STAROps 数字员工** 的 `CreateChat`（SSE）。

`bff/web-chat/starops_chat.mjs` 的语义移植。目标是**在 IM 里像用 DevOps Agent 一样用
STAROps**：直接跟数字员工说话、让它自己发起巡检/调查、把思考与工具调用实时刷进卡片。
**NotiOps 侧 0 token** —— 回答是客户自己的数字员工生成的（计客户的阿里云 AI 额度），
我们只当传输层。三条路在 IM 侧完全同构：

    IM ── worker ── STAROps CreateChat            （本模块，0 token）
    IM ── worker ── DevOps Agent SendMessage      （core/devops_chat.py，0 token）
    IM ── worker ── agent runtime ── Bedrock      （core/agent_chat.py，烧 token 的那条）

── 为什么是「移植」而不是「重写」──────────────────────────────────────────
与 `core/devops_chat.py` 文件头同一条理由，且这里更强：JS 那份的每一处怪异写法背后都是
一个**已经踩过的生产 bug**（`variables` 里一个 number 换来泛化 503、`data:` 后面没空格、
`lastChunk` 不是结束信号、artifacts 是全文副本……）。重写等于把那些坑重新踩一遍，而 IM
侧更难查：没有右侧面板、只有一张卡。所以**逐函数对照**，改动时两边一起改。

── 与 JS 那份的四处**故意**不同 ────────────────────────────────────────────
 1. **没有 SSE**。`emit(kind, payload)` 是可选回调，worker 拿它节流 PATCH 卡片；
    与 `core/devops_chat.py` 的做法完全一致（那边 `Sink` 就是为此而写，这里直接复用）。
 2. **thread 不由本模块落库**。`session` 进、`session` 出，DynamoDB 由调用方
    （`platforms/*/caps.py`）写 —— 与 `run_devops_chat` 对 `execution_id` 的口径一致：
    本模块**不 import `core/ddb_state`**，于是它的单测不需要造 DynamoDB。
 3. **`steps` 回给调用方**。IM 的「过程行」是卡片里的一块折叠区，不是独立面板。
 4. **HTTP 走 `urllib`**（经 `core/net.safe_urlopen`）。IM worker 的 `requirements.txt` 里
    没有 `requests`，更没有阿里云 SDK（「依赖必钉版本」）。代价与对策见下面 ⚠️ 三条。

⚠️ **urllib 流式读取的三个坑**（每一条都有对应的实现细节，别"简化"掉）：
   a. **必须用 `read1(n)` 而不是 `read(n)`**。`read(n)` 会阻塞到攒满 n 个字节才返回，
      而 SSE 的帧只有几十到几百字节 —— 用 `read()` 的表现是"答案一次性蹦出来"甚至
      读到超时，实时性直接归零。`read1` 只做一次底层读，拿到多少给多少。
   b. **必须用增量解码器**。chunk 边界会切在一个 UTF-8 汉字的中间，每个 chunk 各自
      `decode()` 会在正文里留下 `<28>` —— 而中文界面下这是**默认情况**，不是边缘情况。
   c. **socket 超时不等于墙钟**。urllib 只能在 `urlopen(timeout=)` 设一个**每次读**的
      超时；我们要的是「首字节前 120s 判卡死、之后按整轮 840s 判超时」两段语义，
      所以首字节到达后把底层 socket 的超时**放宽到剩余预算**（`_widen_read_timeout`）。
      放宽失败时如实记一条日志并退回单一超时口径 —— **不静默**。

── ✅ 已对真实服务验证（2026-09-13，JS 那条路）─────────────────────────────
地域 `cn-beijing`、内置数字员工 `apsara-ops`，`GetDigitalEmployee` / `CreateThread` /
`CreateChat` 三个 200 + 完整回答。本模块与那次实测共用同一套请求形状与签名算法
（`core/aliyun_signer.py` 由官方固定参数测试向量钉住），但 **Python 这条路本身尚未对真
服务跑过** —— 上线后第一次真实对话就是它的首测。
排障顺序（按实测重排过，别一上来就怀疑密钥）：
  0. 泛化的 **503 `ServiceUnavailable`** → 十有八九**不是**阿里云故障，而是 `CreateChat`
     的入参类型错了：`variables` 里的 `timeStamp` 传 number 时阿里云回这个 503 而不是
     400（实测）。已由 `build_variables` + 单测钉住。
  1. `NoPermission` / `Forbidden.RAM` → 见 `ram_hint`。真因几乎总是**自建**数字员工。
  2. `SignatureDoesNotMatch` → 先跑 `tests/test_aliyun_signer.py`；全绿就不是算法问题，
     查系统时钟（>15 分钟偏差直接拒）。
  3. 404 `DigitalEmployeeNotExist` → 数字员工 **ID**（大小写敏感）或地域不对。
     ⚠️ 最常见的填错法是把**显示名称**当 ID 填进来。
  4. 连接超时 → worker Lambda 到 aliyuncs.com 的出网。

🔒 日志纪律（docs/LOGGING_STANDARD.md）：
  · `access_key_secret` 绝不进日志、不进异常、**连长度都不记**（由 `core/aliyun_signer` 保证）
  · 阿里云返回的 `message` **绝不外泄**（它会回显客户的输入）—— 只用 `code`
  · `workspace` 值里嵌着阿里云账号 UID → **不记**（本模块只把它放进请求体）
  · `requestId` / `traceId` 只写进卡片给用户自己排查，**不进日志**
  · 用户问题原文不进日志

ARCC 未查询（MCP server 本次会话连不上）—— 按标准做法处理：凭据只读内存、只走 HTTPS、
地域取值限定在枚举内（endpoint 主机名是拼出来的，见 `starops_host` 那段 SSRF 说明）。
"""
from __future__ import annotations

import codecs
import json
import logging
import os
import re
import time
import urllib.error
import urllib.request

from core.aliyun_config import (DEFAULT_STAROPS_REGION, STAROPS_REGIONS,
                                load_aliyun_credentials)
from core.aliyun_signer import build_url, roa_path, sign_request
from core.devops_chat import Sink
from core.net import safe_urlopen
from core.starops_sse import create_starops_parser

logger = logging.getLogger(__name__)

#: STAROps 的 API 版本（`x-acs-version`）。逐字来自官方 OpenAPI 元数据。
STAROPS_API_VERSION = "2026-04-28"

#: 数字员工 ID / workspace / project 的形状。阿里云未公布规则，这里只挡住"明显不是名字"
#: 的东西（空、带斜杠/空白/`:`，说明客户粘错了整行）。员工 ID 会被拼进 URL 路径 ——
#: 真正的编码由 `roa_path()` 负责，这道校验是为了**早失败、报得准**。
EMPLOYEE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
WORKSPACE_RE = EMPLOYEE_RE

#: 「thread 已经没了」的错误码形状。用于**一次**透明重建：thread 被阿里云侧删掉/过期后，
#: 留着旧 threadId 下一轮会原样再坏一次（客户看到的是"这个会话永久坏了"）。
#: 与 `core/devops_chat.py::_STALE_RE` 同一用意。
THREAD_GONE_RE = re.compile(r"NotFound|NotExist|Invalid.*Thread|Thread.*Invalid|Expired|Gone",
                            re.I)

#: 权限类错误 → 触发 `ram_hint`，给出**具体那条策略**。
RAM_ERR_RE = re.compile(r"Forbidden|NoPermission|NotAuthorized|AccessDenied|Unauthorized", re.I)

#: 官方策略 `AliyunSTAROpsReadOnlyAccess` 把 `starops:CreateThread` / `starops:CreateChat`
#: 的资源限定在 `acs:starops:*:*:digitalemployee/apsara-*`（逐字来自 `ram:GetPolicy`）。
#: 所以「员工 ID 以 `apsara-` 开头」就是「内置员工 / 官方策略够用」的判据。ARN 匹配大小写
#: 敏感，这里刻意**不加** `re.I` —— 写成 `Apsara-` 的员工在阿里云那边同样对不上前缀。
_BUILTIN_EMPLOYEE_RE = re.compile(r"^apsara-")

#: 非流式请求（CreateThread / GetDigitalEmployee）的超时（秒）。这些是毫秒级的小调用，
#: 卡住 15s 还没回就没有再等的意义 —— 早失败早给话术。
_UNARY_TIMEOUT_SEC = 15.0

#: 错误响应体的读取上限：出错时对方可能回一大坨 HTML（网关/WAF 页面），
#: 全读进来只是浪费内存 —— 我们只要那个 `code`。
_ERR_BODY_MAX = 4096

#: 每次 `read1()` 要的字节数。给大一点没坏处（`read1` 拿到多少给多少，不会等着攒满）。
_READ_CHUNK = 16384

#: 应急开关。与 `NOTIOPS_DISABLE_DEVOPS_AGENT` 同一形状：这条路会在**客户自己的阿里云
#: 账号**里触发真实的巡检动作（烧客户的 AI 额度），出问题时要有一个不用改代码、不用重新
#: 打包就能关掉的闸门。默认关闭（= 功能开着）。
_DISABLED = str(os.environ.get("NOTIOPS_DISABLE_STAROPS") or "").lower() in ("1", "true", "yes")


def _safe_err(e: Exception) -> str:
    """只回异常**类型名**，绝不回原始 message / 响应体（可能含客户输入或凭据片段）。"""
    return type(e).__name__


def _env_int(name: str, default: int) -> int:
    try:
        n = int(str(os.environ.get(name) or "").strip())
        return n if n > 0 else default
    except (TypeError, ValueError):
        return default


def _max_wait_sec() -> int:
    """单轮对话的最长等待（秒）。worker Lambda 平台硬顶 900s，保守 840s —— 与
    `core/devops_chat.py` 同一口径。超时不算失败：已流出的正文照样发出去。"""
    return _env_int("NOTIOPS_STAROPS_MAX_WAIT_SEC", 840)


def _stall_sec() -> int:
    """「一个字节都没来」的容忍窗（秒）。**只在首个 chunk 之前**生效 —— 数字员工真干活时
    可能有很长的单个工具调用（实测单次 Bash 26.6s，串起来更久），那种安静不许被当成卡死。"""
    return _env_int("NOTIOPS_STAROPS_STALL_SEC", 120)


def starops_host(region: str) -> str:
    """endpoint 主机名。地域不在允许清单里就**抛** —— 绝不回落到默认地域：
    静默回落会让客户在 Admin 里选的东西与实际请求的目标不一致（见「不许静默降级」）。
    这同时是一道允许清单式的 **SSRF 闸门**：主机名是拼出来的，而请求由 IM worker 的
    执行角色发出。"""
    r = str(region or "")
    if r not in STAROPS_REGIONS:
        raise ValueError(f"starops_unsupported_region:{r or 'empty'}")
    return f"starops.{r}.aliyuncs.com"


def starops_err_code(status: int, text: str) -> str:
    """从阿里云的错误响应里**只**取错误码。

    🔒 `message` 一律丢掉：阿里云会把客户传的参数原样回显在 message 里，把它转给用户等于
       把输入反射回聊天窗（docs/LOGGING_STANDARD.md：只报 code 和异常类型名）。
       解析不出来就用 `http_<状态码>` —— 永远给得出一个能对着查的短码。
    """
    s = str(text or "")[:_ERR_BODY_MAX]
    try:
        j = json.loads(s)
        if isinstance(j, dict):
            code = str(j.get("Code") or j.get("code") or "").strip()
            if code:
                return code
    except Exception:  # noqa: BLE001 — 不是 JSON（网关 HTML 页面之类）→ 退到状态码
        pass
    return f"http_{status}"


class StarOpsError(Exception):
    """阿里云侧的失败。`message` **只含错误码**（见 `starops_err_code`）。"""

    def __init__(self, code: str, status: int = 0):
        super().__init__(code)
        self.code = code
        self.status = status


def build_starops_request(*, action: str, method: str, path_template: str,
                          path_params: dict | None = None, query: dict | None = None,
                          body_obj=None, creds: dict, region: str,
                          date=None, nonce: str = "") -> dict:
    """组一个已签名的 STAROps 请求。**纯函数**（`date`/`nonce` 可注入）→ 可离线单测。

    返回 `{"url", "headers", "body"}`。`body` 是**字符串**（见
    `core/aliyun_signer.py` 文件头 ⚠️5：签名用的 hash 与真正发出去的字节必须同一串，
    所以序列化只发生在这一处）。
    """
    host = starops_host(region)
    canonical_uri = roa_path(path_template, path_params or {})
    body = "" if body_obj is None else json.dumps(body_obj, ensure_ascii=False,
                                                  separators=(",", ":"))
    signed = sign_request(
        method=method, host=host, canonical_uri=canonical_uri, query=query, body=body,
        action=action, version=STAROPS_API_VERSION,
        access_key_id=creds.get("accessKeyId") or "",
        access_key_secret=creds.get("accessKeySecret") or "",
        security_token=creds.get("securityToken") or "",
        date=date, nonce=nonce,
    )
    return {"url": build_url(host=host, canonical_uri=canonical_uri, query=query),
            "headers": signed["headers"], "body": body}


def _send_headers(headers: dict) -> dict:
    """把 `host` 从发送头里去掉：urllib 会自己按 URL 填 `Host`，手动再塞一份可能重复。
    签名里仍然签了 host —— 线上真正发出去的 Host 与被签的值一致，所以签名不受影响。"""
    return {k: v for k, v in (headers or {}).items() if k.lower() != "host"}


def _http_error_code(e: urllib.error.HTTPError) -> str:
    """从 `HTTPError` 里取错误码。`HTTPError` 自己就是个响应对象，可以读正文。"""
    body = ""
    try:
        body = (e.read(_ERR_BODY_MAX) or b"").decode("utf-8", "replace")
    except Exception:  # noqa: BLE001 — 读不到正文就只用状态码
        pass
    return starops_err_code(getattr(e, "code", 0) or 0, body)


def _unary(*, creds: dict, region: str, action: str, method: str, path_template: str,
           path_params: dict | None = None, query: dict | None = None, body_obj=None,
           opener=None, timeout: float = _UNARY_TIMEOUT_SEC) -> dict:
    """一次非流式调用。返回解析好的 JSON。失败抛 `StarOpsError`（message 只含错误码）。

    `opener` 是测试接缝（默认 `core.net.safe_urlopen`）—— 与本仓库既有做法一致：
    单测注入一个假 opener，不需要起 HTTP server。
    """
    req_info = build_starops_request(action=action, method=method,
                                    path_template=path_template, path_params=path_params,
                                    query=query, body_obj=body_obj, creds=creds, region=region)
    data = req_info["body"].encode("utf-8") if req_info["body"] else None
    req = urllib.request.Request(req_info["url"], data=data,
                                 headers=_send_headers(req_info["headers"]), method=method)
    open_url = opener or safe_urlopen
    try:
        with open_url(req, timeout=timeout) as resp:
            raw = (resp.read() or b"").decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        code = _http_error_code(e)
        logger.warning("[starops] %s failed code=%s status=%s", action, code,
                       getattr(e, "code", 0))
        raise StarOpsError(code, getattr(e, "code", 0) or 0) from None
    except Exception as e:  # noqa: BLE001 — 网络/超时/DNS
        code = _safe_err(e)
        logger.warning("[starops] %s failed code=%s", action, code)
        raise StarOpsError(code) from None
    try:
        parsed = json.loads(raw or "{}")
    except Exception:  # noqa: BLE001
        return {}
    return parsed if isinstance(parsed, dict) else {}


def get_digital_employee(*, creds: dict, region: str, employee: str, opener=None) -> dict:
    """预检：这个数字员工存在吗。**便宜且指向明确** —— ID/地域写错时给"找不到这个数字
    员工"，而不是让客户对着 CreateChat 的 404 猜是 ID 错、地域错还是没权限。"""
    return _unary(
        creds=creds, region=region, opener=opener,
        action="GetDigitalEmployee", method="GET",
        # ⚠️ 中划线：`/digital-employee/{name}`。同一个产品里 thread 系列是驼峰
        #    `/digitalEmployee/{name}/thread` —— 阿里云自己不自洽，逐字抄，别统一。
        path_template="/digital-employee/{name}", path_params={"name": employee},
    )


def create_thread(*, creds: dict, region: str, employee: str, title: str = "",
                  variables: dict | None = None, opener=None) -> str:
    """新建一段会话（thread）。返回 threadId。"""
    body: dict = {"title": (str(title or "NotiOps"))[:80]}
    if variables:
        body["variables"] = variables
    r = _unary(
        creds=creds, region=region, opener=opener,
        action="CreateThread", method="POST",
        path_template="/digitalEmployee/{name}/thread", path_params={"name": employee},
        body_obj=body,
    )
    tid = str(r.get("threadId") or "")
    if not tid:
        raise StarOpsError("InvalidResponse")
    return tid


def stop_chat(*, creds: dict, region: str, employee: str, thread_id: str, opener=None) -> bool:
    """请对方停止本轮生成（`action:"stop"`）。**尽力而为**：只在我们已经放弃等待时调用，
    目的是别让数字员工在客户账单上继续烧 AI 额度。语义未经实测，所以失败只记码、
    不影响已经给出的回答。"""
    try:
        _unary(
            creds=creds, region=region, opener=opener,
            action="CreateChat", method="POST", path_template="/chat",
            body_obj={"digitalEmployeeName": employee, "threadId": thread_id, "action": "stop"},
        )
        return True
    except StarOpsError as e:
        logger.warning("[starops] stop failed code=%s", e.code)
        return False
    except Exception as e:  # noqa: BLE001
        logger.warning("[starops] stop failed code=%s", _safe_err(e))
        return False


def build_variables(*, locale: str = "", region: str = "", workspace: str = "",
                    project: str = "", now: float | None = None) -> dict:
    """拼 `variables`。控制台会带上一串上下文，数字员工的内置技能靠它们定位"查哪儿" ——
    缺了 workspace，ECS 巡检那类技能会以"什么都查不到"收场（症状极难归因）。

    空值一律**不发**（而不是发空串）：发空串等于告诉对方"就是空的"，可能覆盖数字员工
    自己的默认规则。

    ⚠️ 所有值必须是**字符串**。2026-09-13 对 cn-beijing 真服务实测：`timeStamp` 传 number
    时 CreateChat 一律回 503 `ServiceUnavailable`（不是 400），文案是泛化的
    "temporary failure of the server" —— 看着像阿里云故障，实际是入参类型错。
    同一把密钥、同一地域，只把 timeStamp 换成字符串就 200。以后往这里加字段，
    数字/布尔都要先 `str()`。
    （⚠️ 实测只覆盖了 `timeStamp` 这一个字段；"任何 number 都会 503"是推断，别当实证写。）

    🔒 `workspace` 的值里嵌着阿里云账号 UID → 只进请求体，绝不进日志。
    """
    t = time.time() if now is None else float(now)
    out = {
        "language": "en" if locale == "en" else "zh",
        # 时区固定 Asia/Shanghai：STAROps 是阿里云的服务、时间轴按北京时间读最不容易误判
        # （Lambda 的 TZ 是 UTC，跟着它走会让"刚才那波报错"对不上客户看到的时间）。
        "timeZone": "Asia/Shanghai",
        "timeStamp": str(int(t)),
    }
    if region:
        out["region"] = region
    if workspace:
        out["workspace"] = workspace
    if project:
        out["project"] = project
    return out


def load_starops_config() -> dict:
    """读并校验 STAROps 所需的配置。

    失败时回 `{"ok": False, "reason": …}`，调用方必须**当场失败**并把客户指到 Admin
    「多云」页 —— 不许"跳过阿里云那部分继续答"（那是静默降级）。

    成功时回 `{"ok", "creds", "region", "employee", "workspace", "project",
    "inspect_region"}`。
    """
    if _DISABLED:
        return {"ok": False, "reason": "disabled"}
    c = load_aliyun_credentials()
    if not c:
        return {"ok": False, "reason": "no_credentials"}
    employee = str(c.get("staropsEmployee") or "").strip()
    if not employee:
        return {"ok": False, "reason": "no_employee"}
    if not EMPLOYEE_RE.match(employee):
        return {"ok": False, "reason": "bad_employee"}
    region = str(c.get("staropsRegion") or DEFAULT_STAROPS_REGION)
    if region not in STAROPS_REGIONS:
        return {"ok": False, "reason": "bad_region"}
    workspace = str(c.get("staropsWorkspace") or "").strip()
    project = str(c.get("staropsProject") or "").strip()
    if workspace and not WORKSPACE_RE.match(workspace):
        return {"ok": False, "reason": "bad_workspace"}
    if project and not WORKSPACE_RE.match(project):
        return {"ok": False, "reason": "bad_project"}
    return {
        "ok": True,
        "creds": {"accessKeyId": c["accessKeyId"], "accessKeySecret": c["accessKeySecret"]},
        "region": region,
        "employee": employee,
        "workspace": workspace,
        "project": project,
        # 被巡检的地域（≠ 接口地域）。见 core/aliyun_config.py 文件头那段 ⚠️。
        "inspect_region": str(c.get("regionId") or ""),
    }


def availability() -> dict:
    """便宜的可用性探测，给 `/agent starops` 那条切换命令当闸门用。

    ⚠️ **只读本地配置、不打阿里云**（与 `bff/web-chat/starops_chat.mjs::starOpsAvailability`
       同一取舍）：签名 + 跨境往返几百毫秒起，而这条探测在每次切换时都会被调用；真正
       "配得对不对"由 `run_starops_chat` 的预检在对话时给出**更具体**的话术。
       代价说清楚：配好了但员工 ID 写错 → 这里仍然显示"可用"，直到用户真的问一句。

    🔒 只回 `ok` / `reason` / `region` / `employee`。**绝不回 workspace**
       （值里嵌着阿里云账号 UID），也绝不回任何凭据片段。
    """
    try:
        cfg = load_starops_config()
    except Exception as e:  # noqa: BLE001
        # 探测本身挂了（Secrets Manager 抖动/限流）→ **放行**。宁可让用户问一句看到真实
        # 报错，也不要因为一次抖动把功能藏起来（与 web 侧同一取舍）。
        logger.warning("[starops] availability probe failed: %s", _safe_err(e))
        return {"ok": True, "reason": "probe_error", "employee": "", "region": ""}
    if not cfg.get("ok"):
        return {"ok": False, "reason": str(cfg.get("reason") or ""), "employee": "", "region": ""}
    return {"ok": True, "reason": "", "employee": cfg["employee"], "region": cfg["region"]}


def configured() -> bool:
    """`core/agent_chat.configured()` / `core/devops_agent.configured()` 的同名同形版本，
    给 `platforms/common/pref_commands.py` 当切换闸门。"""
    return bool(availability().get("ok"))


def not_configured_text(reason: str, en: bool) -> str:
    """「去配一下」的话术。**说清楚缺哪一项** —— 一句笼统的"未配置"会让客户把已经填好的
    AccessKey 又重填一遍。与 web 侧 `notConfiguredText` 逐条对齐。"""
    where = ("Admin -> Multi-cloud -> Alibaba Cloud" if en
             else "管理后台 →「多云」→ 阿里云")
    table = {
        "disabled": (
            "STAROps 对话已被运维开关临时关闭（`NOTIOPS_DISABLE_STAROPS`）",
            "STAROps chat is temporarily disabled by an operator switch "
            "(`NOTIOPS_DISABLE_STAROPS`)",
        ),
        "no_credentials": (
            "还没有填阿里云 AccessKey（AccessKey ID + Secret 两个都要）",
            "the Alibaba Cloud AccessKey is not set (both the ID and the Secret are required)",
        ),
        # 🔴 说「ID」不说「名称」：控制台里要复制的是员工 ID（内置员工形如 `apsara-ops`，
        #    实测）。它的**显示名称**是另一个字段（`GetDigitalEmployee` 的
        #    `displayName` ≠ `name`）—— 客户按"名称"去填显示名，换回来的是一个语义为空的
        #    404，我们这边只能报"连不上"。文案与 Admin 页的字段标签必须是同一个词。
        "no_employee": (
            "还没有填 STAROps **数字员工 ID**",
            "the STAROps **digital employee ID** is not set",
        ),
        "bad_employee": (
            "填的 STAROps 数字员工 ID 格式不对（只允许字母、数字、`.`、`-`、`_`）",
            "the STAROps digital employee ID has an invalid format "
            "(letters, digits, `.`, `-`, `_` only)",
        ),
        "bad_region": (
            f"填的 STAROps 接口地域不在支持范围内（只有 {' / '.join(STAROPS_REGIONS)}）",
            f"the STAROps API region is not supported (only {' / '.join(STAROPS_REGIONS)})",
        ),
        "bad_workspace": ("填的 workspace 名称格式不对",
                          "the workspace name has an invalid format"),
        "bad_project": ("填的 project 名称格式不对",
                        "the project name has an invalid format"),
    }
    zh, en_txt = table.get(str(reason or ""),
                           ("阿里云配置不完整", "the Alibaba Cloud configuration is incomplete"))
    if reason == "disabled":
        # 这一条不是"去配一下"，别把客户指到 Admin 页去改一个改不了的东西。
        return (f"\n⚠️ {en_txt}.\n" if en else f"\n⚠️ {zh}。\n")
    return (f"\n⚠️ Cannot talk to STAROps yet: {en_txt}. Set it in **{where}**, then ask again.\n"
            if en else
            f"\n⚠️ 还不能跟 STAROps 对话：{zh}。请到 **{where}** 填好后再问一次。\n")


def create_thread_fail_text(en: bool, code: str) -> str:
    """`CreateThread` 失败时的第一句话。**权限类和非权限类必须分开说。**

    🔴 2026-09-14 加。原先无论什么错都是「请稍后重试，或换回普通对话」—— 而权限被拒时紧接着
    还会补一段 `ram_hint`（点名缺哪条策略）。两句话放在一起是自相矛盾的：前一句让人等一会儿
    再试，后一句让人去改 RAM。客户会先选便宜的那条（重试），而重试一万次也不会好。用户本人
    就是这么踩的：原样拿到「创建 STAROps 会话失败（NoPermission）。请稍后重试」。

    抽成纯函数是为了**能被测到** —— `run_starops_chat` 要真跑起 Secrets Manager + 三个阿里云
    接口才走得到那个分支。`bff/web-chat/starops_chat.mjs::createThreadFailText` 是它的**逐行
    对照实现**，改一边必须同时改另一边。
    """
    # 退路（`/agent devops`）**必须留着** —— 去掉的只有那句"稍后重试"。权限没配好期间
    # 客户还得干活，不能把人堵死在这儿。
    if RAM_ERR_RE.search(str(code or "")):
        return (f"\n⚠️ Failed to create the STAROps thread ({code}) -- this is a PERMISSIONS "
                "problem, so retrying will not help. You can switch back with "
                "`/agent devops` for now.\n" if en else
                f"\n⚠️ 创建 STAROps 会话失败（{code}）—— 这是**权限**问题，重试不会好。"
                "可以先用 `/agent devops` 回到普通对话。\n")
    return (f"\n⚠️ Failed to create the STAROps thread ({code}). Retry later, or switch back "
            "with `/agent devops`.\n" if en else
            f"\n⚠️ 创建 STAROps 会话失败（{code}）。请稍后重试，或换回普通对话（`/agent devops`）。\n")


def _ram_policy_json(employee: str) -> str:
    """自建员工那条自定义策略的**完整可复制正文**（围栏 JSON）。

    🔴 为什么错误信息里要放一整段 JSON、而不是用散文描述它：2026-09-14 用户原话 —— 上一版
    把处方写成一段话（"Action 只放这两个、Resource 两条都写"），**可读性不强**，要照它拼出
    一份 RAM 策略得先在脑子里翻译一次，而那一步正是客户最容易漏掉半条 ARN 的地方，漏掉的
    表现就是原来那个 403、一模一样。给一段能整段粘进 RAM 控制台的正文，把翻译整个去掉。

    这份形状 **2026-09-14 在真账号上端到端跑通过**（`cn-beijing`，自建员工，三个接口全
    200）。ARN 刻意用 `acs:starops:*:*:` —— **跑通的就是这个形状**；把地域 / 账号 ID 填成
    具体值是进一步收窄，我们**没实测过**，所以错误信息里不发那一版。

    只要三个 Action：`GetDigitalEmployee`（`Get*`）、`CreateThread`、`CreateChat` —— 停止
    生成走的是 `CreateChat` + `body.action:"stop"`，不是另一个 RAM Action，所以这份策略是
    **自足**的（不挂官方那条也能跑；挂了也不冲突）。

    ⚠️ 用 `json.dumps` 生成而不是拼字符串：员工名是客户填的自由文本，拼字符串一旦遇到引号
    就产出一份**语法坏掉的 JSON**，而客户会照着粘、然后卡在 RAM 控制台的报错上。
    `bff/web-chat/starops_chat.mjs::ramPolicyJson` 用 `JSON.stringify(doc, null, 2)` 产出
    **逐字节相同**的文本 —— 两边的判据可以互相对照。
    """
    arn = "acs:starops:*:*:digitalemployee/" + str(employee)
    doc = {
        "Version": "1",
        "Statement": [
            {"Effect": "Allow", "Action": ["starops:Get*", "starops:List*"], "Resource": "*"},
            {
                "Effect": "Allow",
                "Action": ["starops:CreateChat", "starops:CreateThread"],
                "Resource": [arn, arn + "/*"],
            },
        ],
    }
    # 收尾**留一个空行**：紧贴围栏闭合的下一行会被一部分渲染器并进代码块的尾巴，而这里紧
    # 跟着的就是「两条 ARN 都要写」那句 —— 那句被吞掉，客户又只写一条。
    return "\n\n```json\n" + json.dumps(doc, indent=2, ensure_ascii=False) + "\n```\n\n"


def ram_hint(en: bool, employee: str, code: str = "") -> str:
    """权限失败时补一句**具体缺什么** —— 而且要按「内置 / 自建」分开说，因为修法完全不同。

    ✅ 2026-09-14 真因**已定**（同一副 AK、同一个自建员工，按两条 ARN 重配之后三个接口全
    200、拿到完整回答）：缺的就是**子资源那条 ARN**（`…/digitalemployee/<员工名>/*`）。当天
    并列的另一种解释（"那条策略压根没生效"）不再是开放问题 —— 但两处控制台自查仍然留在
    文案里：它们各自都能单独造成一模一样的 403。

    实测（2026-09-13）：自建员工（ID 不以 `apsara-` 开头）在只挂官方策略时 `CreateThread`
    直接 403 `NoPermission`，真因是官方策略里那条资源 ARN 前缀，**补 `ram:PassRole`
    治不了**。把客户往 `PassRole` 上引的代价很实在：他会去改一个不相干的授权，改完还是
    403，然后怀疑产品坏了。

    `ram:PassRole` 只在**错误码自己提到 RAM / PassRole** 时才补一句，并且**明说我们没实测
    过**：官方权限配置页写着「和数字员工对话时需要 PassRole」，但 `AliyunSTAROpsFullAccess`
    里的 `PassRole` 是限定到服务关联角色 `AliyunServiceRoleForSTAROps` 的，不是员工自己的
    `roleArn`；我们手上只有内置员工，无法证实自建员工到底需不需要它。
    """
    builtin = bool(_BUILTIN_EMPLOYEE_RE.match(str(employee or "")))
    parts: list[str] = []
    if builtin:
        parts.append(
            "\n\nThis looks like a permissions gap. `" + employee + "` is a built-in digital "
            "employee, so one official policy is the whole grant: check that the RAM user "
            "owning this AccessKey has `AliyunSTAROpsReadOnlyAccess` attached (it already "
            "carries `starops:CreateThread` / `starops:CreateChat`). Account-wide read-only "
            "is not needed and does not help here."
            if en else
            "\n\n这看起来是权限没给够。`" + employee + "` 是**内置**数字员工，官方那一条策略"
            "就够：请确认这副 AccessKey 所属的 RAM 用户挂了 `AliyunSTAROpsReadOnlyAccess`"
            "（它自己就含 `starops:CreateThread` / `starops:CreateChat`）。挂账号级只读既不"
            "必要、也治不了这一条。")
    else:
        parts.append(
            "\n\nThis is a permissions gap, and the cause is precise: `" + employee + "` does "
            "not start with `apsara-`, so it is a CUSTOM digital employee, and the official "
            "`AliyunSTAROpsReadOnlyAccess` policy only grants `starops:CreateThread` / "
            "`starops:CreateChat` on `digitalemployee/apsara-*`. Attach one more custom policy "
            "to the SAME RAM user -- paste this as-is (verified end to end against a real "
            "account on 2026-09-14):"
            if en else
            "\n\n这是权限没给够，原因很具体：`" + employee + "` 不以 `apsara-` 开头，是"
            "**自建**数字员工，而官方策略 `AliyunSTAROpsReadOnlyAccess` 只把 "
            "`starops:CreateThread` / `starops:CreateChat` 授到 `digitalemployee/apsara-*`。"
            "请给**同一个 RAM 用户**再加一条自定义策略，下面这段可以**整段直接复制**"
            "（2026-09-14 在真账号上按这个形状端到端跑通过）：")
        parts.append(_ram_policy_json(employee))
        # 两条 ARN 缺一条就是原来那个 403 —— 这一句是**已实测的因果**，不是猜测，所以要留。
        parts.append(
            "Both resource ARNs are required: the second one is the employee's sub-resources "
            "(threads), and we measured that leaving it out is still refused. Then make sure "
            "the policy is actually GRANTED to that RAM user (creating it is not enough), and "
            "that the version now in effect is this one -- Alibaba Cloud creates a NEW version "
            "on every edit. Do not widen `Resource` to `*`."
            if en else
            "两条 ARN **都要写**：第二条是这个员工的子资源（会话），实测少了它仍然被拒。"
            "粘好之后确认两件事：这条策略确实**授权给**了那个 RAM 用户（只「创建」不算），"
            "以及**当前生效的版本**就是这一版（阿里云每次编辑都新建一个版本）。"
            "别把 `Resource` 放宽成 `*`。")
    if re.search(r"RAM|PassRole", str(code or ""), re.I):
        parts.append(
            " If the extra policy is already in place and the error still mentions "
            "RAM/PassRole, Alibaba Cloud's permission-configuration page says chatting with a "
            "digital employee needs `ram:PassRole` on the role that employee uses -- scope it "
            "to that role, never `*`. We have NOT verified that one ourselves."
            if en else
            " 如果那条自定义策略已经加好、错误里仍然带 RAM/PassRole 字样：阿里云的权限配置"
            "页说和数字员工对话需要对**该员工所用角色**的 `ram:PassRole`，请限定到那个角色、"
            "不要写 `*`。⚠️ 这一条我们**没有实测过**。")
    return "".join(parts) + "\n"


def _widen_read_timeout(resp, seconds: float) -> bool:
    """首字节到了之后，把底层 socket 的读超时放宽到 `seconds`（见文件头 ⚠️c）。

    走的是 `HTTPResponse.fp`（`BufferedReader`）→ `.raw`（`SocketIO`）→ `._sock` 这条
    CPython 里稳定多年的层级。**拿不到就回 False**，由调用方如实记一条日志并退回"整条流
    用同一个超时"的口径 —— 那样最坏的后果是一个超长工具调用被判超时，比静默改语义好。
    """
    try:
        sock = resp.fp.raw._sock
    except Exception:  # noqa: BLE001
        return False
    try:
        sock.settimeout(float(seconds))
        return True
    except Exception:  # noqa: BLE001
        return False


def stream_chat(*, creds: dict, region: str, employee: str, thread_id: str, text: str,
                variables: dict | None = None, sink, en: bool = False,
                max_wait_sec: int = 0, stall_sec: int = 0, opener=None,
                message_id: str = "") -> dict:
    """发一轮消息并把 SSE 实时喂给 sink。**本函数是这条链路的风险中心**，故独立可测
    （`opener` 可注入一个吐手写字节流的假响应）。

    返回解析器状态 + `{"timed_out", "stalled", "http_code"}`。
    `done` = 收到过 `stream_done`。**没收到就是不完整的一轮** —— 我们没有实现续传
    （官方 schema 里有 `action:"reconnect"`，但我们既没实现也没实测），所以只能如实告诉
    用户这轮不完整，**绝不**把重连的内容拼到半截答案后面（那会造出一个看起来完整、实则
    中间少一段的答案，比明说失败糟得多）。
    """
    max_wait = int(max_wait_sec or _max_wait_sec())
    stall = int(stall_sec or _stall_sec())
    req_info = build_starops_request(
        creds=creds, region=region,
        action="CreateChat", method="POST", path_template="/chat",
        body_obj={
            "digitalEmployeeName": employee,
            "threadId": thread_id,
            "action": "create",
            **({"variables": variables} if variables else {}),
            "messages": [{
                "messageId": message_id or f"notiops-{int(time.time() * 1000)}",
                "role": "user",
                "contents": [{"type": "text", "value": str(text or "")}],
            }],
        },
    )
    headers = _send_headers(req_info["headers"])
    # `accept` 不在签名头集合里（只签 x-acs-* / host / content-type），加它不影响签名。
    headers["accept"] = "text/event-stream"
    req = urllib.request.Request(req_info["url"], data=req_info["body"].encode("utf-8"),
                                 headers=headers, method="POST")

    parser = create_starops_parser(
        sink, en=en,
        # 解析器的告警只记**内容形状**（未知类型名 / 版本号），不含用户文本，可以进日志。
        on_warn=lambda m: logger.warning("[starops] wire: %s", m),
    )
    dec = codecs.getincrementaldecoder("utf-8")()
    timed_out = False
    stalled = False
    http_code = ""
    got_bytes = False
    t0 = time.monotonic()
    open_url = opener or safe_urlopen

    def _state() -> dict:
        # 展开放在前面：`done` 等字段的**唯一权威**是解析器状态，不许被局部变量盖住。
        return {**parser.state, "timed_out": timed_out, "stalled": stalled,
                "http_code": http_code}

    resp = None
    try:
        # 首字节前用 `stall` 当 socket 超时 —— 这正好是"一个字节都没来"的语义。
        resp = open_url(req, timeout=float(stall))
        while True:
            if time.monotonic() - t0 >= max_wait:
                timed_out = True
                break
            chunk = resp.read1(_READ_CHUNK)
            if not chunk:
                break
            if not got_bytes:
                got_bytes = True
                # 首字节到了 → 撤掉卡死判定，把读超时放宽到剩余的整轮预算。
                left = max(1.0, max_wait - (time.monotonic() - t0))
                if not _widen_read_timeout(resp, left):
                    logger.warning("[starops] cannot widen read timeout; "
                                   "a single tool call longer than %ss will be judged stuck",
                                   stall)
            parser.push(dec.decode(chunk))
            if parser.state.get("done"):
                break                        # stream_done：不等对方关连接
        parser.push(dec.decode(b"", True))    # 冲掉解码器里残留的半个字符
    except urllib.error.HTTPError as e:
        http_code = _http_error_code(e)
        logger.warning("[starops] CreateChat failed code=%s status=%s", http_code,
                       getattr(e, "code", 0))
    except TimeoutError:
        # socket 超时。首字节前 = 卡死；之后 = 我们已经把超时放宽到剩余预算，所以只可能
        # 是撞上了整轮墙钟。
        if got_bytes:
            timed_out = True
        else:
            stalled = True
    except Exception as e:  # noqa: BLE001 — 真的网络错
        http_code = _safe_err(e)
        logger.warning("[starops] stream error %s", http_code)
    finally:
        if resp is not None:
            try:
                resp.close()
            except Exception:  # noqa: BLE001
                pass
        parser.end()                          # 收尾：吐未收口的思考块、报未返回的工具
    return _state()


def run_starops_chat(text: str, *, locale: str = "en", session: dict | None = None,
                     emit=None, max_wait_sec: int | None = None,
                     stall_sec: int | None = None, opener=None) -> dict:
    """「STAROps 对话」主流程（IM 侧）。**NotiOps 侧 0 token**。

    与 `core/devops_chat.py::run_devops_chat` **同形**，调用方（`platforms/*/caps.py`）
    因此几乎可以逐行照抄那一支：

    · `session` 进 = 上一轮存的 `{"thread_id","employee","region"}`（`None` = 新会话）
    · 返回 `{"reply","steps","session","employee","ok","usage","reset_session",
       "console_home"}`
    · `session` 出 = 这一轮**实际用的** thread（可能是新建的）→ 调用方落库
    · `reset_session=True` = 这个 thread 已经没了，调用方要**清掉**那一行

    `emit(kind, payload)` 可选：worker 拿它节流刷卡片（`text` / `step` / `progress`）。
    """
    en = str(locale or "") == "en"

    def dv(zh: str, en_txt: str) -> str:
        return en_txt if en else zh

    sink = Sink(emit=emit)
    # NotiOps 侧不烧 token —— 每条退出路径都回同一个 usage（IM 页脚据此不显示 token）。
    usage = {"totalTokens": 0, "cycles": 0, "direct": True}
    sess_in = session or {}

    def out(*, ok: bool, employee: str = "", sess: dict | None = None,
            reset: bool = False) -> dict:
        return {
            "reply": sink.reply,
            "steps": sink.steps,
            "session": sess or {},
            "employee": employee,
            "ok": ok,
            "usage": usage,
            "reset_session": reset,
            # DevOps Agent 那支会给一个控制台首页链接。STAROps 控制台的 URL 我们**没有
            # 实测过**，不编 —— 编错的链接比没有链接更糟（客户点进去看到 404，会以为
            # 是自己账号没开通）。
            "console_home": "",
        }

    cfg = load_starops_config()
    if not cfg.get("ok"):
        sink.say(not_configured_text(str(cfg.get("reason") or ""), en))
        return out(ok=False)

    creds = cfg["creds"]
    region = cfg["region"]
    employee = cfg["employee"]
    base = {"creds": creds, "region": region, "employee": employee, "opener": opener}

    # 页脚署名要带上**数字员工 ID 的值**：这条回答是"客户账号里的哪一个数字员工"答的 ——
    # 一个阿里云账号可以有多个员工，纳管范围与答案质量完全不同，所以这是读答案时的必要
    # 坐标。（这一位**不许**放 AWS 账号 ID，那是跨云假信息；见 im_footer 里的 🔴。）
    # 🔒 只回 `employee`。**绝不回 `workspace`**（它内嵌阿里云账号 UID，是管理员专属值）。
    sink.progress(dv("正在连接 STAROps…", "Connecting to STAROps…"))

    # ── 预检 ──
    # ID/地域错、或权限没给够时，这一步的错误比 CreateChat 的错误**指向明确得多**。
    # 一次 GET，几十毫秒，换来的是"客户知道该改哪个字段"。
    try:
        emp = get_digital_employee(**base)
        label = str(emp.get("displayName") or emp.get("name") or employee)
        sink.step(dv(f"已连接数字员工「{label}」（{region}）",
                     f'Connected to digital employee "{label}" ({region})'))
    except StarOpsError as e:
        code = e.code
        sink.say(dv(
            f"\n⚠️ 连不上 STAROps 数字员工 `{employee}`（{code}，地域 {region}）。请确认："
            "填的是控制台里的**数字员工 ID**（不是显示名称）且大小写一致、它就在这个地域、"
            "且这副 AccessKey 有 STAROps 的读取权限。\n",
            f"\n⚠️ Could not reach the STAROps digital employee `{employee}` ({code}, region "
            f"{region}). Check that this is the digital employee ID from the console (not its "
            "display name) with matching case, that it lives in this region, and that the "
            "AccessKey has STAROps read permissions.\n"))
        if RAM_ERR_RE.search(code):
            sink.say(ram_hint(en, employee, code))
        return out(ok=False, employee=employee)

    variables = build_variables(locale=locale, region=cfg["inspect_region"],
                                workspace=cfg["workspace"], project=cfg["project"])

    # ── 多轮上下文：复用同一个 threadId ──
    # STAROps 的对话历史挂在 threadId 上，"接着上一句问"必须复用它。数字员工或接口地域
    # 变了就不能复用（老 thread 在新目标上不存在）—— 与 core/ddb_state 那段 ⚠️ 同一条。
    thread_id = (str(sess_in.get("thread_id") or "")
                 if (sess_in.get("employee") == employee and sess_in.get("region") == region)
                 else "")
    reused = bool(thread_id)

    def new_thread() -> str:
        # CreateThread 的 variables 只认 workspace / project（元数据里就这两个字段）。
        meta = {}
        if cfg["workspace"]:
            meta["workspace"] = cfg["workspace"]
        if cfg["project"]:
            meta["project"] = cfg["project"]
        return create_thread(**base, title=dv("NotiOps 对话", "NotiOps chat"),
                             variables=meta or None)

    if not thread_id:
        sink.progress(dv("正在创建会话…", "Creating the thread…"))
        try:
            thread_id = new_thread()
        except StarOpsError as e:
            sink.say(create_thread_fail_text(en, e.code))
            if RAM_ERR_RE.search(e.code):
                sink.say(ram_hint(en, employee, e.code))
            return out(ok=False, employee=employee)

    def sess_out() -> dict:
        return {"thread_id": thread_id, "employee": employee, "region": region}

    prelude = sink.reply       # 真正开始对话前已经写进卡片的内容（目前恒为空，留作将来）
    sink.progress(dv("已发送，STAROps 正在处理…", "Sent -- STAROps is working…"))

    res = stream_chat(**base, thread_id=thread_id, text=text, variables=variables,
                      sink=sink, en=en, max_wait_sec=int(max_wait_sec or 0),
                      stall_sec=int(stall_sec or 0))

    # 复用的 thread 已经不在了 → **透明**重建一次再问（对用户无感）。
    # 只在这一轮**一个字都还没吐**时才做，否则重试的内容会接在半截答案后面。
    if (reused and sink.reply == prelude and res.get("http_code")
            and THREAD_GONE_RE.search(str(res["http_code"]))):
        logger.warning("[starops] thread gone (%s) - creating a new one and retrying",
                       res["http_code"])
        sink.step(dv("上一段会话已失效，正在新建会话重试（不带之前的上下文）…",
                     "The previous thread is gone -- starting a new one and retrying "
                     "(without the earlier context)…"))
        try:
            thread_id = new_thread()
            res = stream_chat(**base, thread_id=thread_id, text=text, variables=variables,
                              sink=sink, en=en, max_wait_sec=int(max_wait_sec or 0),
                              stall_sec=int(stall_sec or 0))
        except StarOpsError as e:
            logger.warning("[starops] recreate_thread_failed code=%s", e.code)

    # ── 收尾话术：每一种坏法都要**说实话** ──
    reset = False
    code = str(res.get("http_code") or "")
    if code:
        sink.say(dv(f"\n\n⚠️ STAROps 未能完成本次回答（{code}）。",
                    f"\n\n⚠️ STAROps could not complete this answer ({code})."))
        if RAM_ERR_RE.search(code):
            sink.say(ram_hint(en, employee, code))
        # 会话已经不可用 → 让调用方丢掉它，好让"再问一次"真的有意义。
        if THREAD_GONE_RE.search(code):
            reset = True
            sink.say(dv("\n\n已丢弃这个会话的上下文，**直接再问一次**即可（会从一段新会话"
                        "开始）。",
                        "\n\nThe stored thread has been discarded -- **just ask again** "
                        "(it will start a fresh thread)."))
    elif res.get("stalled"):
        s = int(stall_sec or _stall_sec())
        sink.say(dv(f"\n\n⚠️ STAROps 在 {s} 秒内一个字节都没返回，本轮判定为卡住。请再问一次。",
                    f"\n\n⚠️ STAROps sent nothing at all within {s}s -- treating this turn as "
                    "stuck. Please ask again."))
    elif res.get("timed_out"):
        w = int(max_wait_sec or _max_wait_sec())
        sink.say(dv(f"\n\n⏳ 本轮等待超过 {w} 秒，先返回已生成的部分。",
                    f"\n\n⏳ This turn exceeded {w}s; returning what was generated so far."))
        # 我们不再等了，但对方还在跑、还在烧客户的 AI 额度 → 尽力让它停下。
        stop_chat(**base, thread_id=thread_id)
    elif not res.get("done"):
        # 连接结束但没有 `stream_done`。**必须说出来**：我们没有实现续传，把重连内容拼上去
        # 会造出一个"看起来完整、中间少一段"的答案。
        sink.say(dv("\n\n⚠️ 与 STAROps 的连接提前结束，**本轮回答可能不完整**（上面已经显示"
                    "的部分是真实返回的内容）。可以再问一次，或到 STAROps 控制台看这段会话"
                    "的完整记录。",
                    "\n\n⚠️ The connection to STAROps ended early, so **this answer may be "
                    "incomplete** (what is shown above is what actually came back). Ask again, "
                    "or open this thread in the STAROps console for the full record."))
    elif not sink.reply:
        sink.say(dv("\n（STAROps 本轮没有返回内容，请换个说法再试。）\n",
                    "\n(STAROps returned no content this turn -- try rephrasing.)\n"))

    # 过程行尾行：本轮耗时 + 请求标识。requestId / traceId 只给用户自己排查用
    # （🔒 不进日志），STAROps 工单里报这两个值能直接定位。
    dur = res.get("duration_ms") or 0
    rid = str(res.get("request_id") or "")
    if dur > 0 or rid:
        secs = f"{dur / 1000:.1f}s" if dur > 0 else ""
        tail = f" · requestId {rid}" if rid else ""
        sink.step(dv(f"本轮耗时 {secs}{tail}", f"Took {secs}{tail}"))

    return out(ok=not code, employee=employee, sess=sess_out(), reset=reset)


__all__ = [
    "EMPLOYEE_RE",
    "RAM_ERR_RE",
    "STAROPS_API_VERSION",
    "THREAD_GONE_RE",
    "StarOpsError",
    "WORKSPACE_RE",
    "availability",
    "build_starops_request",
    "build_variables",
    "configured",
    "create_thread",
    "create_thread_fail_text",
    "get_digital_employee",
    "load_starops_config",
    "not_configured_text",
    "ram_hint",
    "run_starops_chat",
    "starops_err_code",
    "starops_host",
    "stop_chat",
    "stream_chat",
]
