"""
Skills 读取（agent 侧）—— 从 S3 读客户自定义 skill，注入对话。

与 BFF（bff/web-chat/skills.mjs）和 IM 端（core/skill_registry.py）**共享同一份 S3 数据**：
  bucket = SKILLS_BUCKET（notiops 的 dataBucket），前缀 skills/
  skills/<id>/meta.json + skills/<id>/versions/<ver>.md

两种调用方式都靠这里：
  - 自然语言匹配：list_skill_index() 给出"name + description"目录，注入 system，模型自行判断套用。
  - 显式 /skill：load_skill_body(skill_id) 取某个 skill 全文，强制注入本轮。

只读、失败安全：任何错误返回空，不抛（不能因 skill 读取失败而毁掉对话）。
带短 TTL 缓存，避免每轮都 LIST+GET。
"""
from __future__ import annotations

import json
import logging
import os
import re
import time

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)


def _env(name: str, default: str = "") -> str:
    """读 env，把未被部署脚本替换的占位符（形如 __FOO__）当成未设置。

    agentcore.json 出厂是占位符（__SKILLS_BUCKET__），由 deploy_agent.sh 注入真值。
    漏注入时非空占位符会骗过 `if not _BUCKET`，让 S3 调用撞不存在的桶（NoSuchBucket）。
    归一化为空串 → configured() 返回 False，功能优雅降级为"未配置"。与 reports.py 一致。
    """
    v = os.environ.get(name, default).strip()
    if v.startswith("__") and v.endswith("__"):
        return ""
    return v


_BUCKET = _env("SKILLS_BUCKET")
_PREFIX = "skills"
_s3 = None
_CACHE_TTL = int(os.environ.get("SKILL_CACHE_TTL", "60"))
_index_cache: tuple[float, list[dict]] | None = None  # (ts, [{skill_id,name,description}])


def configured() -> bool:
    return bool(_BUCKET)


def _client():
    global _s3
    if _s3 is None:
        _s3 = boto3.client("s3")
    return _s3


def _meta_key(sid: str) -> str:
    return f"{_PREFIX}/{sid}/meta.json"


def _ver_key(sid: str, ver: str) -> str:
    return f"{_PREFIX}/{sid}/versions/{ver}.md"


def _get_json(key: str):
    try:
        obj = _client().get_object(Bucket=_BUCKET, Key=key)
        return json.loads(obj["Body"].read().decode("utf-8"))
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
            return None
        logger.warning("skills: get_json %s failed: %s", key, e)
        return None
    except Exception as e:  # noqa: BLE001
        logger.warning("skills: get_json %s error: %s", key, e)
        return None


def list_skill_index() -> list[dict]:
    """返回启用中的 skill 目录：[{skill_id, name, description}]（不含正文，省 token）。
    带 TTL 缓存。失败/未配置 → []。"""
    global _index_cache
    if not _BUCKET:
        return []
    now = time.time()
    if _index_cache and now - _index_cache[0] < _CACHE_TTL:
        return _index_cache[1]
    out: list[dict] = []
    try:
        paginator = _client().get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=_BUCKET, Prefix=f"{_PREFIX}/", Delimiter="/"):
            for cp in page.get("CommonPrefixes", []) or []:
                sid = cp["Prefix"].replace(f"{_PREFIX}/", "").rstrip("/")
                if not sid or sid == "_audit":
                    continue
                meta = _get_json(_meta_key(sid))
                if not meta or meta.get("status") == "archived":
                    continue
                out.append({
                    "skill_id": meta.get("skill_id", sid),
                    "name": meta.get("name", sid),
                    "description": meta.get("description", ""),
                })
    except Exception as e:  # noqa: BLE001
        logger.warning("skills: list index failed: %s", e)
        return []
    _index_cache = (now, out)
    return out


def load_skill_body(skill_id: str, version: str | None = None) -> dict | None:
    """取某个 skill 的 {name, description, body, version}。
    version 缺省取 latest；指定且存在则取该版本（用于"用某个历史版本运行"）。失败/不存在 → None。"""
    if not _BUCKET or not skill_id:
        return None
    meta = _get_json(_meta_key(skill_id))
    if not meta:
        return None
    ver = meta.get("latest_version", "1.0.0")
    if version and any(v.get("version") == version for v in meta.get("versions", [])):
        ver = version
    try:
        obj = _client().get_object(Bucket=_BUCKET, Key=_ver_key(skill_id, ver))
        body = obj["Body"].read().decode("utf-8")
    except Exception as e:  # noqa: BLE001
        logger.warning("skills: load body %s failed: %s", skill_id, e)
        body = ""
    return {"name": meta.get("name", skill_id),
            "description": meta.get("description", ""),
            "version": ver,
            "body": body}


_CJK = "一-鿿"
# 太常见、区分度低的词不参与相关性判断（避免"检查/系统/当前/成本"等通用词把无关问题拉进来）。
# 这些词在很多 skill 描述里都出现，单凭它们命中会误触发（如"savings plans 当前覆盖率"曾因"当前"
# 误中"本月成本异常分析"）。区分度低 = 不能作为"这个 skill 相关"的信号。
_STOP = {
    # 英文通用/疑问/连接词
    "the", "and", "for", "with", "what", "how", "why", "when", "where", "which", "your", "you",
    "are", "is", "of", "to", "a", "an", "in", "on", "or", "my", "me", "do", "does", "can", "current",
    "aws", "cloud", "data", "use", "using", "get", "show", "list", "help", "please", "now",
    # 中文通用/疑问/语气/连接
    "我", "的", "了", "是", "有", "和", "与", "在", "吗", "呢", "吧", "啊", "什么", "怎么", "如何",
    "区别", "关系", "请", "帮", "帮我", "一个", "这个", "那个", "可以", "需要", "检查", "系统",
    "问题", "当前", "目前", "现在", "多少", "情况", "一下", "看看", "告诉", "我的", "给我",
    # 高频但低区分度的领域通用词（出现在多个 skill 里，不足以指向某一个）
    "成本", "费用", "分析", "服务", "数据", "查询", "报告", "本月", "上月", "月份", "账号", "账户",
    "资源", "使用", "用量", "优化", "建议", "详细", "完整",
}
# 2-gram 切分会把"当前的覆盖率"切出"前的/率是/的覆"等噪声半词；这些跨词边界的 2-gram 无意义，
# 也要过滤（只保留落在停用词表/真实词内的）。这里用"任一字是单字停用词则丢弃该 2-gram"近似。
_CHAR_STOP = set("的了是有和与在吗呢吧啊请帮我你他她它这那个可以是多率是前盖")


def _keywords(text: str) -> set[str]:
    """从一段文本里抽取用于相关性判断的关键词：英文单词（≥3 字母）+ 中文 2-gram。
    过滤停用词 + 含停用字的噪声 2-gram，提升区分度。"""
    text = (text or "").lower()
    out: set[str] = set()
    for w in re.findall(r"[a-z0-9][a-z0-9\-]{2,}", text):
        if w not in _STOP:
            out.add(w)
    for run in re.findall(f"[{_CJK}]{{2,}}", text):
        for i in range(len(run) - 1):
            bg = run[i:i + 2]
            if bg in _STOP:
                continue
            # 跨词边界的噪声 2-gram（含常见虚字）丢弃，降低误重叠
            if bg[0] in _CHAR_STOP or bg[1] in _CHAR_STOP:
                continue
            out.add(bg)
    return out


def relevant_skills(user_text: str, idx: list[dict] | None = None) -> list[dict]:
    """相关性闸门（防误触发的核心，代码层而非靠模型自觉）：只返回**与用户本轮问题
    有实质性关键词重叠**的 skill。无重叠 → 不注入 → 物理上不可能误触发，且省 token。

    判定（收紧版，防"当前/成本"这类通用词误命中）：skill 的**区分性信号**是它的
    skill_id 与 name（描述太啰嗦、通用词多）。规则：
      - 命中 skill_id 或 name 的关键词 → 算相关（强信号）；
      - 只命中 description（没碰 id/name）→ 需 **≥2 个不同词**重叠才算（弱信号要更多证据）。
    """
    idx = idx if idx is not None else list_skill_index()
    if not idx or not user_text:
        return []
    ukw = _keywords(user_text)
    if not ukw:
        return []
    hits = []
    for s in idx:
        strong = _keywords(f"{s.get('skill_id','')} {s.get('name','')}")  # 区分性信号
        weak = _keywords(s.get("description", ""))                          # 描述（含通用词）
        if ukw & strong:
            hits.append(s)
        elif len(ukw & weak) >= 2:
            hits.append(s)
    return hits


def skills_directive(active_index: list[dict] | None = None, user_text: str | None = None) -> str:
    """自然语言匹配用：把 skill 目录（name + description）压成一段注入 system 的指令。
    空目录 → 空串（不注入、不占 token）。

    **相关性闸门**：传入 user_text 时，先用 relevant_skills() 过滤——只把与本轮问题
    有关键词重叠的 skill 注入。无关问题 → 空串 → 物理上不可能误触发（不靠模型自觉）。
    这是防止「普通问题误套 skill」的根本修法，同时对通用对话零 token 开销。

    设计要点：即便相关，自动匹配仍要克制——默认正常回答，只有具体操作请求与 skill
    专门场景高度吻合才套用。自动套用时**不**自报「正在使用 Skill」（那只在显式 /skill 时说）。"""
    idx = active_index if active_index is not None else list_skill_index()
    if user_text is not None:
        idx = relevant_skills(user_text, idx)
    if not idx:
        return ""
    lines = [f"- /{s['skill_id']}（{s['name']}）：{s['description']}" for s in idx[:30]]
    return (
        "[系统提示 · 自定义 Skills 目录（仅供参考，**默认不要使用**）：\n"
        + "\n".join(lines)
        + "\n\n使用规则（务必克制，宁可不用）：\n"
          "1. **默认正常回答用户的问题**，不要套用任何 skill。\n"
          "2. 只有当用户的**具体操作请求**与上面某个 skill 的**专门场景高度吻合**时，"
          "才按该 skill 行事（例如用户要求「巡检我的 RDS」恰好匹配一个 RDS 巡检 skill）。\n"
          "3. **通用知识、概念解释、技术原理、对比、闲聊、与某 skill 主题无关的问题 → 绝不套用**，"
          "正常回答即可。判断不确定时，一律按「不套用」处理。\n"
          "4. 自动套用时**不要**说「正在使用 Skill」之类的话，自然地按该 skill 处理即可"
          "（只有用户用 /<skill_id> 显式指定时，才在开头声明正在使用哪个 skill）。\n"
          "5. 这段目录是后台参考信息，**绝不要主动复述、列举或向用户提起有哪些 skill**。]\n\n"
    )
