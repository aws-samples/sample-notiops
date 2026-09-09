"""钉钉出站的**会话层** —— 会话内走 `sessionWebhook`，会话外委托给 `shared/`。

下面是逐条在钉钉开放平台上核实过的**结论**，以及几个容易写错的点。

── 三条出站机制 ───────────────────────────────────────────────────────────────
| # | 机制                                        | 支持 @ | 需要 token | 实现在哪 |
| 1 | 回调报文里带的 `sessionWebhook`             | ✅     | ❌         | **本文件** |
| 2 | `POST /v1.0/robot/groupMessages/send`       | ❌     | ✅         | `shared/dingtalk_api.py` |
| 3 | `POST /v1.0/robot/oToMessages/batchSend`    | ❌     | ✅         | `shared/dingtalk_api.py` |

**`sessionWebhook` 的有效期是 ≈90 分钟**（官方示例报文里
`sessionWebhookExpiredTime - createAt = 5,402,586 ms`），不是仓库里旧注释写的
「~5 分钟」。90 分钟 > Lambda 的 15 分钟上限 ⇒ **worker 里的每一次回复都不需要
access_token**。机制 2/3 只有两个用途：报告回写（几十分钟后由**另一个 Lambda**投递）
和 `sessionWebhook` 真过期时的兜底。

── 为什么机制 2/3 不在这个文件里 ───────────────────────────────────────────────
因为报告投递那个 Lambda **import 不到 `platforms/`**：
`infra/lib/notiops-backend-stack.ts` 给它的 asset 排除列表里有 ``"platforms/**"``。
凭证读取 / token 缓存 / `msgParam` 上限 / 机制 2/3 全部搬到了
`shared/dingtalk_api.py`（两边都能 import），这里只 re-export 一层薄壳，让本目录里
既有的 `sender.load_credentials()` / `sender.send_group()` 这些调用点不用改。
**别把它们复制回来** —— 15000 字节 / 20 个 userId 这类硬上限一旦两份漂移，表现是
整条消息发不出去而不是报错。理由完整版见 `shared/dingtalk_api.py` 文件头。

── 为什么不复用 `app/dingtalk_utils.get_access_token()` ────────────────────────
那份读的是 Fargate 形态的**两个**secret（`DINGTALK_APP_KEY_ARN` /
`DINGTALK_APP_SECRET_ARN`）。Lambda 形态与飞书对齐，只有**一个**secret
（`notiops/im-bot-dingtalk`，JSON 里 `app_key` / `app_secret`）。硬凑成一个函数
就得在里面判"到底哪种环境"，那正是最容易静默取到空值的写法。两条路径各读自己的。

── 日志纪律（`docs/LOGGING_STANDARD.md`）───────────────────────────────────────
· `sessionWebhook` **本身就是凭证** —— 绝不进日志、绝不进任何文件、也不记它的长度。
· `app_secret` / `app_key` 同上，**连长度都不记**。
· 用户问题原文不进日志。这里只记 `errcode` 和异常**类型名**。
"""
from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
from dataclasses import dataclass, field

from shared import dingtalk_api
from shared.dingtalk_api import (  # noqa: F401  (re-export: 见文件头「为什么不在这里」)
    MAX_MSG_PARAM_BYTES,
    MAX_OTO_USERS,
    PLATFORM,
    app_secret,
    card_template_id,
    get_access_token,
    load_credentials,
    save_route,
    send_group,
    send_oto,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 本轮会话上下文
# ---------------------------------------------------------------------------
@dataclass
class Session:
    """一次入站回调带来的、能用来回复的全部东西。

    ⚠️ `webhook` **是凭证**：这个对象绝不进日志、绝不 `repr()` 到别处。
    `ImMessage` 是共享契约（三平台同一份），不给它加钉钉专属字段 —— 所以放在这里，
    由 `lambda_worker` 在规范化时 `bind()`、handler 返回前 `clear()`。
    """
    webhook: str = ""
    expires_ms: int = 0
    conversation_id: str = ""
    is_direct: bool = True
    staff_id: str = ""
    robot_code: str = ""
    #: 群里回复时要 @ 回原提问人（只有机制 1 支持）。
    at_user_ids: list[str] = field(default_factory=list)

    def webhook_usable(self) -> bool:
        """`sessionWebhook` 还能用吗。

        `expires_ms == 0`（报文里没带过期时刻）→ 当**可用**：官方报文一直带这个字段，
        真缺了说明形状变了，此时"试一次机制 1，失败再兜底"比"直接放弃、每条回复都去
        换 token"更省也更可能成功。
        """
        if not self.webhook:
            return False
        if self.expires_ms <= 0:
            return True
        return self.expires_ms > int(time.time() * 1000)


_SESSION_LOCK = threading.Lock()
_session = Session()


def bind(session: Session) -> None:
    """绑定本轮会话。**不是 thread-local** —— 进度心跳跑在 daemon 线程里，
    thread-local 会让它拿到一个空 Session 从而静默发不出进度。"""
    global _session
    with _SESSION_LOCK:
        _session = session


def current() -> Session:
    with _SESSION_LOCK:
        return _session


def clear() -> None:
    """handler 返回前调用。Lambda 会复用执行环境 —— 不清就会把上一条消息的
    `sessionWebhook` 留给下一次调用（跨会话串消息，且**静默**）。"""
    global _session
    with _SESSION_LOCK:
        _session = Session()


# ---------------------------------------------------------------------------
# 机制 1 + 会话内回复入口
# ---------------------------------------------------------------------------
def send_session(webhook: str, *, title: str, text: str,
                 at_user_ids=()) -> bool:
    """机制 1：POST 到回调带来的 `sessionWebhook`。无需鉴权，**支持 @**。"""
    if not webhook or not (text or title):
        return False
    body = {
        "msgtype": "markdown",
        "markdown": {"title": title or " ", "text": text or " "},
        "at": {"atUserIds": [u for u in at_user_ids if u], "isAtAll": False},
    }
    try:
        resp = dingtalk_api.post_json(
            webhook, json.dumps(body, ensure_ascii=False).encode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as e:
        logger.warning("dingtalk session reply failed: %s", type(e).__name__)
        return False
    code = int(resp.get("errcode") or 0)
    if code:
        # errmsg 是钉钉自己的文案，不含我们的凭证也不含用户原话 —— 可以记。
        logger.warning("dingtalk session reply errcode=%s errmsg=%s",
                       code, resp.get("errmsg"))
        return False
    return True


def reply(*, title: str, text: str, at_user: str = "",
          session: Session | None = None) -> bool:
    """会话内回复的**唯一入口**：能用 `sessionWebhook` 就用它，否则走服务端 API。

    `at_user` 只在机制 1 上生效 —— 机制 2/3 不支持 @，兜底时会静默丢掉 @。
    这不是降级隐藏：@ 的作用只是"提醒那个人看一眼"，正文照样完整送到，而且兜底本身
    已经是 90 分钟之后的极少数情况。
    """
    s = session or current()
    if s.webhook_usable():
        at = [a for a in ([at_user] if at_user else s.at_user_ids) if a]
        if send_session(s.webhook, title=title, text=text, at_user_ids=at):
            return True
        logger.warning("dingtalk: session webhook failed, falling back to server API")
    else:
        logger.info("dingtalk: session webhook unusable, using server API")
    if s.is_direct:
        return send_oto([s.staff_id], title=title, text=text,
                        robot_code=s.robot_code)
    return send_group(s.conversation_id, title=title, text=text,
                      robot_code=s.robot_code)
