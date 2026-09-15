"""多云（客户自己的阿里云 STAROps 数字员工）在 **IM 侧**的可见性开关。

产品决策 2026-09-15：多云先**不对外**。整条实现留在仓里（`core/starops_chat.py`、
`core/starops_sse.py`、`core/aliyun_config.py`、三家 `caps.py` 里的 `elif starops:`、
`pref_commands` 的别名表、DDB 的 `imsochat#` 段、8 个测试文件全都不动），只把**客户
看得见的推荐入口**摘掉。翻回 `VISIBLE = True` 就整套回来，不需要改任何一行逻辑。

── 这个模块只管一件事：**说什么**，不管**能做什么** ──────────────────────────
`VISIBLE = False` 之后：
  · `/help` 菜单里不再有 starops 那一格；
  · `/agent` 的用法行、以及打错参数时的「可用: …」不再列 starops。
但 `/agent starops` **依然能打通** —— `_AGENT_ALIASES` / `AGENT_ARG_WORDS` /
`starops_chat.configured()` 那道闸门全部原样保留。

这是**有意**的，不是漏改：
  · 我们要的是"不再向客户推销这条路"，不是"把已经配好的客户的东西弄坏"。已经在管理
    后台填过 AccessKey 的部署（含我们自己的现网）还在用它，藏掉入口的同时把执行路径
    也掐掉，等于一次静默的功能回退 —— 那比多一条没写进菜单的命令糟得多。
  · 反过来，**没**配阿里云的部署打 `/agent starops` 拿到的是
    `agent.starops_not_configured`（拒绝且不写偏好），不会切到一条死路上。
所以「菜单里没有、硬打还能用」这个组合在这里是正确答案，而不是不一致。

── 为什么用「孪生 key」而不是在渲染处拼字符串 ──────────────────────────────
`help.row.agent` 有 **6 个**渲染点（三家 `caps.py` + 三家 `app/main.py`，都是对
`nl_router.HELP_COMMANDS` 的泛型循环），`agent.usage` 有 2 个。要是在每个渲染点做
"把 starops 那一小段切掉"的字符串手术，就有 8 处各自会漂移的正则，而且中英两套文案的
句子结构不同（顿号 vs `·`），切不干净的症状是**发给客户一句话中间少半截**。

所以改成：i18n 里同一条文案存两份 —— 基线 key（不含 starops，当前发的就是它）和
`<key>.multicloud`（含 starops，逐字保留原文，以后翻回来直接用）。这里只负责**选 key**，
一个函数调用，渲染点不含任何条件分支。

⚠️ 只有 `_TWINNED` 里的 key 有 `.multicloud` 孪生。`i18n.t()` 对不存在的 key 是
**把 key 本身发给用户**（见 `core/i18n.py::t`），所以绝不能对任意 key 拼后缀 ——
`help.row.web.multicloud` 会变成客户菜单里的一行乱码。`_TWINNED` 与 i18n 的一致性由
`tests/test_multicloud_gate.py` 钉住。

⚠️ Web 端有**另一份**同名开关（`frontend/chat-app/src/featureFlags.ts` 的
`MULTICLOUD_UI`），因为那是另一个运行时。两边必须一起翻，否则会出现「网页里没有、
IM 里还在推荐」这种自相矛盾的产品。
"""

from __future__ import annotations

#: 多云入口在 IM 侧是否可见。见模块 docstring —— 它只控制**文案**，不控制执行路径。
VISIBLE = False

#: 有 `.multicloud` 孪生文案的 key。**只有**这几个能拼后缀。
_TWINNED = frozenset({
    "help.row.agent",
    "agent.usage",
    "agent.unknown",
})


def key(base: str) -> str:
    """按当前可见性挑 i18n key：可见且有孪生 → `<base>.multicloud`，否则原样。

    对 `_TWINNED` 之外的 key 一律原样返回（而不是抛异常）—— 这个函数在渲染路径上，
    多云可见性是个产品开关，不该有能力把一条 `/help` 变成一次 500。
    """
    return f"{base}.multicloud" if VISIBLE and base in _TWINNED else base


def help_row_key(feature: str) -> str:
    """`/help` 菜单里 `feature` 那一行的 i18n key。

    6 个渲染点全都是 `for feat, _en, _zh in nl_router.HELP_COMMANDS` 的泛型循环，
    所以这里对**每一个** feature 都要能回答，不只是 `agent`。
    """
    return key(f"help.row.{feature}")


def agent_usage_key() -> str:
    """`/agent` 用法行的 i18n key。"""
    return key("agent.usage")


def agent_unknown_key() -> str:
    """`/agent <打错的参数>` 时那句「可用: …」的 i18n key。"""
    return key("agent.unknown")
