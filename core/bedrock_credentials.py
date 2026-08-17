"""IM 侧 Bedrock API Key 注入 —— 把 Admin 配的 Key 施加到 IM bot 的 bedrock 客户端上。

为什么不能照抄 webchat（`agent-build/.../model/load.py::_build_bedrock_model`）：
webchat 每请求新建一个 BedrockModel（AgentCore 单会话进程），所以它只需在构造前 set/pop
一次 env。IM 侧在两个维度上不同：

  1. **缓存的客户端**：8 个模块级 `core/lazy_boto.LazyClient("bedrock-runtime")` 单例，
     首次使用时构造一次、之后一直复用。所以「每请求 set env」对它们无效——除非同时重建。
  2. **多会话并发**：飞书/Slack 进程里，入站消息 handler + 每次派发的后台线程 +
     进度轮询 daemon 会**并发**调用 Bedrock。任何「set env + 重建」都必须串行化。

两者都在这里处理：
  · `_ensure_env()`  —— 注册为 lazy_boto 的**构造前钩子**。每个 bedrock-runtime 客户端
    构造前（首建或重建）都会先跑它，把 `AWS_BEARER_TOKEN_BEDROCK` 摆正。botocore 在构造时
    快照 token provider、每请求再读 env 决定签名，两者必须一致，否则 NoAuthTokenError
    硬失败而非静默回退 IAM（见 core/lazy_boto 与 scripts/test_lazy_bedrock_client.py）。
    这一步保证「构造时 env 正确」，与调用入口无关（覆盖全部 8 个模块）。
  · `refresh()`    —— 在每条 IM 消息 / 每轮轮询前调用。若 Key 相比上次**变了**（轮换 /
    清空 / 首次），就 `reset_all("bedrock-runtime")` 让缓存客户端下次使用时重建；重建时钩子
    施加新 Key。加锁、幂等：Key 没变就是廉价 no-op。

Key 是**进程级、全会话共用**（一个 Secret、一个全局 credential_mode），所以并发下把它 set
成同一个值是良性的；真正要串行化的是「变化时的重建」，由 `refresh()` 的锁保证。

⚠️ Key 是凭证：本模块任何路径都不得把它写日志 / 进回复 / 进异常（spec R5.5）。
IM 专用，不进 agent-build（webchat 走 load.py）。
"""
from __future__ import annotations

import os
import threading

from core import lazy_boto
from core import llm_config

_BEARER = "AWS_BEARER_TOKEN_BEDROCK"
_SERVICE = "bedrock-runtime"

_lock = threading.Lock()
_installed = False
# 上次施加到 env 的 Key（None = IAM 模式）。用哨兵区分「从未施加」与「施加过 None」，
# 使进程启动后的第一次 refresh() 一定会走一遍设置 + 重建，把状态对齐。
_UNSET = object()
_applied_key: object = _UNSET


def _ensure_env() -> None:
    """构造前钩子：让 `AWS_BEARER_TOKEN_BEDROCK` 反映当前 Key。

    读 `get_bedrock_api_key()`（TTL 缓存；credential_mode!=api_key / 读失败 / 未启用 → None）。
    有 Key → 设置；无 Key → pop（回退 IAM，且清掉长驻进程里上一代的残留）。
    不加锁：设成全局同一个值是良性的，锁留给 refresh() 的重建路径（热路径保持无锁）。
    """
    key = llm_config.get_bedrock_api_key()
    if key:
        os.environ[_BEARER] = key
    else:
        os.environ.pop(_BEARER, None)


def _on_after_call(http_response=None, parsed=None, **_kwargs) -> None:
    """botocore `after-call.bedrock-runtime` 处理器：识别 Key 被拒并失效缓存。

    挂在 `after-call` 而非 `after-call-error`：后者只在传输层抛异常时触发，
    而鉴权失败是**服务端正常返回**的 HTTP 响应，botocore 解析后才抛 ClientError
    ——`after-call-error` 收不到（已实测，botocore 1.43.19）。

    判据委托给 `llm_config.is_credential_rejected` —— webchat runtime 用同一份，
    别在这里再写一遍（那正是第一版把 403 一律排除、导致 Converse 侧失效永不触发的原因；
    实测死 Key 在 Converse 上是 403 + AccessDeniedException，不是 401）。

    只在确实施加了 Key 时才动作：IAM 模式下执行角色被拒与 Key 无关，
    误报会把 KeyAuthFail 指标变成噪声。判据用 env 里有没有 bearer token，
    因为那正是 botocore 每请求用来决定走 bearer 签名的开关。
    """
    if not os.environ.get(_BEARER):
        return
    status = getattr(http_response, "status_code", None)
    code = ""
    message = ""
    if isinstance(parsed, dict):
        err = parsed.get("Error")
        if isinstance(err, dict):
            code = err.get("Code") or ""
            message = err.get("Message") or ""
    if llm_config.is_credential_rejected(status, code, message):
        # invalidate_api_key() 自己发 KeyAuthFail 指标，且绝不记录 Key 内容（spec R5.5）。
        # message 只参与判断，不落日志 —— 它可能含账号 / 资源 ARN。
        # 下次 get_bedrock_api_key() 会重读 Secret；若 Key 真变了，refresh() 还会重建客户端。
        llm_config.invalidate_api_key()


def _attach_auth_listener(client) -> None:
    """构造后钩子：给新建的 bedrock-runtime 客户端挂 Key 失效监听。

    每个客户端挂一次。**botocore 不会**对同一个 `(event, handler)` 去重（实测：重复注册
    会让一次 401 触发两次失效）—— 真正防重复的是两件事：每个 client 有自己的事件系统副本，
    以及 `register_post_build_hook` 内部的 `fn not in fns`。所以别再加第二条注册路径。
    """
    client.meta.events.register(f"after-call.{_SERVICE}", _on_after_call)


def refresh() -> bool:
    """在每条 IM 消息 / 每轮轮询前调用。Key 变化时重建缓存的 bedrock 客户端。

    返回是否发生了重建（便于测试 / 观测）。Key 未变 → False（廉价 no-op，仅取一次缓存值 + 比较）。
    """
    key = llm_config.get_bedrock_api_key()
    global _applied_key
    with _lock:
        if key == _applied_key:
            return False
        # 变化了：先摆正 env，再重建缓存客户端（重建发生在 env 更新之后，构造钩子也会再摆一次）。
        if key:
            os.environ[_BEARER] = key
        else:
            os.environ.pop(_BEARER, None)
        lazy_boto.reset_all(_SERVICE)
        _applied_key = key
        return True


def install() -> None:
    """注册构造前/后钩子（幂等）。应在 IM 进程启动早期、任何 bedrock 客户端首次使用前调用。

    幂等既靠本模块的 `_installed`，也靠 `register_build_hook` / `register_post_build_hook`
    内部去重——两处都挡，免得多个平台入口各调一次导致重复注册。
    """
    global _installed
    if _installed:
        return
    lazy_boto.register_build_hook(_SERVICE, _ensure_env)
    lazy_boto.register_post_build_hook(_SERVICE, _attach_auth_listener)
    _installed = True


def _reset_state_for_tests() -> None:
    """测试专用：清空已安装标记与已施加 Key，并移除 env（不影响生产路径）。"""
    global _installed, _applied_key
    with _lock:
        _installed = False
        _applied_key = _UNSET
        os.environ.pop(_BEARER, None)


# 导入即安装钩子：只要本模块被 import（bedrock_chat 顶部会 import 它），钩子即就位，
# 保证在任何 bedrock 客户端首次构造前已注册。显式 install() 仍保留给平台启动处调用（幂等）。
install()

__all__ = ["refresh", "install"]
