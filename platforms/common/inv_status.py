"""「问一条已有调查的进展」共享逻辑（IM 重构 / M3.1）—— 平台无关，**0 token**。

这条路径是为了修一个具体的现网 bug（2026-09-03 客户反馈）：用户拿着 bot 刚给出的
``[[investigation:<id>:标题]]`` 追问「现在什么状态」/「帮我监控它的实时进展」，每追问
一次就**再开一条新的付费调查**。根因有两处，都在 `core.nl_router`：strong-investigate
正则里有个裸 `\\binvestigation\\b`，以及 `classify()` 完全不认引用。路由修好之后，
"回读"这条路径需要自己的行为，就是本模块。

为什么放 `platforms/common/`：两个平台（M4 之后三个）**只有渲染和发送不一样**，
"查什么、怎么判断要不要接实时刷新、往 DDB 写什么" 一模一样。照旧写两遍的下场看
`im_cards.py` 文件头那段 —— 两处各写一遍卡片是 IM 侧最容易复发的一类漂移。

三种形态（`plan()` 的返回值），差别只在**要不要把这张新卡接到每分钟的进度 Lambda 上**：

  · ``"attach"``  —— 调查还没结束，而且这条调查现在**没有**任何一张卡在被刷
    （原卡过期 / 当时发失败 / 调查是 Web 端发起的）→ 落一行 `imtask#`，让
    `platforms/common/lambda_progress.py` 接着刷这张新卡。
  · ``"watching"`` —— 调查还没结束，但已经有一张卡在刷它 → **只回快照**。再接一张
    就是两张卡刷同一次调查（`core.ddb_state.link_im_investigation` 文档里那种纯噪音）。
  · ``"static"``  —— 已经终态（或者只有 execution_id、没有 task_id 可挂）→ 快照即全部。

⚠️ 这里**不写** `incident#` / `task#` 路由行（不调 `link_im_investigation`）。那两行决定
"最终报告卡发回哪个会话"，而这条路径面对的调查很可能已经有主了（IM 发起的那次已经落过
这两行）—— 覆盖掉等于把报告从原来那张卡上劫走。回读路径给的是进展 + 控制台链接，
报告仍然按它原本的去处投递。
"""
from __future__ import annotations

import logging

from core import ddb_state
from core import devops_agent
from core import i18n

logger = logging.getLogger(__name__)

#: 与 `platforms/common/lambda_progress.py::_FAILED_STATUSES` 同一口径（那边是进度
#: 轮询的终态渲染）。两处必须一致，否则同一条调查在快照卡上是绿的、在进度卡上是红的。
_FAILED_STATUSES = {"FAILED", "TIMED_OUT", "CANCELED", "SKIPPED"}

#: 快照里最多带几条过程行。全量 journal 可以有几十行，卡片放不下也没人读 ——
#: 取最近的若干条 + 控制台链接（完整过程在 Operator App 里）。
MAX_LINES = 8


def describe(ref_id: str, *, account_id: str = "", locale: str = "zh") -> dict:
    """查一条调查的当前状态。返回 `core.devops_agent.describe_investigation` 的原样结果。"""
    return devops_agent.describe_investigation(
        ref_id, account_id=account_id or None, locale=locale,
        max_lines=MAX_LINES)


def plan(info: dict) -> str:
    """决定这张快照卡要不要接上实时刷新 —— ``"attach"`` / ``"watching"`` / ``"static"``。"""
    if info.get("terminal"):
        return "static"
    task_id = str(info.get("task_id") or "")
    if not task_id:
        # 只有 execution_id（用户贴的是 `exe-…`）→ 进度 Lambda 的行必须带 task_id
        # 才能算 elapsed / 拼控制台链接，接不上，只能给快照。
        return "static"
    try:
        existing = ddb_state.find_im_task_by_task_id(task_id)
    except Exception as e:                        # noqa: BLE001
        # 查不动就退到"只给快照"这条更保守的路 —— 宁可少一张实时卡，也不要冒
        # 两张卡刷同一次调查的风险。
        logger.warning("inv_status.plan lookup failed: %s", type(e).__name__)
        return "watching"
    return "watching" if existing else "attach"


def card_state(info: dict) -> str:
    """映射到各平台渲染函数的 `state`（口径与 `lambda_progress._tick_one` 一致）。"""
    if not info.get("terminal"):
        return "running"
    return "failed" if str(info.get("status") or "") in _FAILED_STATUSES else "done"


def body(info: dict, locale: str, *, mode: str) -> str:
    """快照正文：标题 + 状态 + 最近若干条过程行 + 一句"这张卡会不会自己动"。

    `mode` 就是 `plan()` 的返回值；额外接受 ``"card_failed"`` —— 卡片没发出去、
    退化成纯文本时用（那时不能承诺"会自动刷新"，落点都没有）。
    """
    label = (str(info.get("title") or "").strip()
             or str(info.get("task_id") or "")
             or str(info.get("execution_id") or ""))
    parts = [i18n.t("im.investigate.status.header", locale,
                    title=label, status=str(info.get("status") or "?"))]
    lines = info.get("lines") or []
    if lines:
        # `_record_progress_line` 返回的行**自带**首尾换行 → 用 "".join，不要 "\n".join
        # （与 `lambda_progress._tick_one` 的 `rendered + "".join(new_lines)` 同一口径）。
        parts.append("".join(str(x) for x in lines).strip("\n"))
    else:
        parts.append(i18n.t("im.investigate.status.no_lines", locale))
    note = {
        "attach": "im.investigate.status.attached",
        "watching": "im.investigate.status.watching_elsewhere",
        "card_failed": "im.investigate.card_failed",
    }.get(mode, "")
    if note:
        parts.append(i18n.t(note, locale))
    return "\n\n".join(p for p in parts if p)


def attach(info: dict, *, platform: str, incident_id: str, chat_id: str,
           message_id: str, locale: str, user_id: str = "") -> bool:
    """把这张新卡接到每分钟的进度 Lambda 上。返回是否成功落行。

    先 `put_im_task`（游标为空）再 `update_im_task_cursor` 写入本次快照已经贴出去的
    `seen_ids` / `rendered` —— 少了第二步，进度 Lambda 下一轮会把这些行**当成新增行
    再贴一遍**（卡上出现两份相同的过程行）。
    """
    if not (incident_id and chat_id and message_id):
        logger.warning("inv_status.attach: missing routing fields — skipped")
        return False
    ddb_state.put_im_task(
        incident_id,
        platform=platform, chat_id=chat_id, message_id=message_id,
        locale=locale, account_id=str(info.get("account_id") or ""),
        task_id=str(info.get("task_id") or ""),
        execution_id=str(info.get("execution_id") or ""),
        agent_space_id=str(info.get("agent_space_id") or ""),
        user_id=user_id, title=str(info.get("title") or ""),
        console_url=str(info.get("console_url") or ""),
        console_home=str(info.get("console_home") or ""),
    )
    ddb_state.update_im_task_cursor(
        incident_id, list(info.get("seen_ids") or []),
        str(info.get("rendered") or ""),
    )
    return True
