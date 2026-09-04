"""投递目标模型 + `resolve_inspection_targets()`（R11b.2）。

## 为什么必须新建

`shared/report_delivery` 的路由层是**按发起会话回帖**：
`_resolve_chat_target(incident_id, task_id)` 去 Conversations 表点查
`incident#<id>` / `task#<id>`，命中才有目标。巡检是 cron，没有人发起过会话，
那两个 key 都不存在（而且会话行只有 24h TTL）→ 恒返回 `None` →
命中「report stored but not delivered」早退 → **报告永远投不出去**。

lambda4 的 `notify_chat_ids`（Secrets Manager 里一串逗号分隔的 chat_id）
也不能用：它是全局广播，没有账号维度 —— 而 R11b.3 要求「一个 chat 只看到
自己账号的 finding」。

```
insp cron ──► 算完 ──► resolve_inspection_targets()  ◄── inspchat#target 各行
                          │
                          ├─ enabled=false          ─► rejected(DISABLED)
                          ├─ accounts 为空          ─► rejected(NO_ACCOUNTS)
                          ├─ 平台不认识              ─► rejected(UNKNOWN_PLATFORM)
                          ├─ 单 sink 平台有 ≥2 目标 ─► rejected(AMBIGUOUS_ROUTING)
                          └─ 其余                    ─► targets
```

## 🔴 `AMBIGUOUS_ROUTING`：这一条是隐私边界，不是洁癖

钉钉的 `send_report(chat_id=...)` **完全忽略** `chat_id` —— 自定义机器人的
webhook URL 本身就绑定一个群（`dingtalk_sender.py` 的 docstring 原话：要发
多个群就配多套 sender）。于是 `SK=dingtalk#<chat_id>` 里的 chat_id 对现有
sender 没有意义。

两个 dingtalk 目标 + 各自 `accounts[]` 的后果不是「消息发重了」，而是
**A 组的账号 finding 出现在 B 组的群里** —— R11b.3 的可见性隔离直接被击穿，
且发出去收不回来。所以单 sink 平台一旦有 ≥2 个启用目标，**整个平台的目标
全部拒掉**，而不是「保留第一个」：保留任何一个都等于把某一组的内容投进那个
共享群。

⚠️ 一个 dingtalk 目标是**允许**的（哪怕它只看一个账号）—— 单 sink 单内容，
只是把范围收窄，不会泄漏。

## 缺字段的方向：过量投递可自愈，静默漏投不可

| 字段 | 缺失时 | 理由 |
|---|---|---|
| `severity_min` | 当 `INFO`（全推） | 少推是静默的，客户永远不知道有 MEDIUM |
| `locale` | 当 `zh` | 见下 |
| `enabled` | 当 `true` | 手写行常常只写 platform/chat_id/accounts |
| `accounts` | **拒掉** | 空清单是「这个 chat 什么都看不到」的字面意思 |

⚠️ `locale` 兜底 `zh` 而不是 `report_handler._resolve_locale` 的 `en`：
那个兜底是给排障链路的（`locale_resolver` 查不到会话时），而巡检**没有会话**
所以恒走兜底 —— 照抄 `en` 的表现就是中文客户天天收英文报告（R11b.10 的 ⚠️
原文说的正是这件事）。
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Iterable, Mapping

from inspection.domain.overview import SEVERITY_ORDER

PLATFORMS: tuple[str, ...] = ("feishu", "slack", "dingtalk")
"""认识的三个平台。与 `shared/report_delivery/_load_sender` 的分支一致。

⚠️ 没有 Teams / 企业微信 —— `platforms/` 下只有这三个，全仓零命中。
加平台要先有 sender，否则目标行看着是启用的而消息掉进真空。
"""

SINGLE_SINK_PLATFORMS: frozenset[str] = frozenset({"dingtalk"})
"""sender **不按 chat_id 路由**的平台（见上面的 `AMBIGUOUS_ROUTING`）。

⚠️ 这是对现有 sender 能力的陈述，不是配置项。哪天给 dingtalk_sender 加了
per-target webhook，就把它从这里删掉 —— 而不是在广播层加分支。
"""

ALL_ACCOUNTS = "*"
"""`accounts: ["*"]` = 全部账号。与 `bff/web-chat/account_visibility.mjs`
的 `putVisibility(kind, id, ["*"])` 同一个约定（R11b.2 原文）。"""

LOCALES: tuple[str, ...] = ("zh", "en")
DEFAULT_LOCALE = "zh"
DEFAULT_SEVERITY_MIN = "INFO"

_SK_SEP = "#"
"""SK 的段分隔符。**与 `adapters/keys.SEP` 必须一致**，有元断言锁住。

⚠️ 写成字面量而不是 `from inspection.adapters import keys`：domain 层不得
依赖 adapters（`test_inspection_scoring.py::test_domain_layer_has_no_io`
锁住了这条分层约束）。`domain/scope.py` 与 `domain/dto.py` 的
`key` 属性用的是同一个办法。
"""


class RejectReason(str, Enum):
    """目标被排除的原因。**必须是枚举**而不是一句 log 文本。

    ⚠️ 「今天为什么这个群没收到」是 Phase 10 上线后最高频的问题。
    原因只落在 log 里意味着每次都要去翻 CloudWatch；枚举能被计数、
    能进 run 记录、能在管理页上显示成「3 个目标被跳过」。
    """

    DISABLED = "disabled"
    UNKNOWN_PLATFORM = "unknown_platform"
    NO_CHAT_ID = "no_chat_id"
    NO_ACCOUNTS = "no_accounts"
    AMBIGUOUS_ROUTING = "ambiguous_routing"


_REJECT_TEXT_ZH: dict[RejectReason, str] = {
    RejectReason.DISABLED: "已停用",
    RejectReason.UNKNOWN_PLATFORM: "平台不认识（没有对应 sender，消息会掉进真空）",
    RejectReason.NO_CHAT_ID: "缺 chat_id，这一行投不出去",
    RejectReason.NO_ACCOUNTS: "可见账号清单为空 —— 按字面意思该 chat 看不到任何东西",
    RejectReason.AMBIGUOUS_ROUTING: (
        "该平台的 sender 不按 chat_id 路由（单 webhook 绑一个群），"
        "配了多个目标会把别的账号的 finding 发进同一个群"
    ),
}


def reject_text(reason: RejectReason) -> str:
    """给运维看的中文原因。缺一档就返回枚举值本身，不抛。"""
    return _REJECT_TEXT_ZH.get(reason, reason.value)


def _severity_rank(severity: str) -> int:
    """越小越严重。认不出的档排最后（= 最不严重），与
    `overview.FindingBrief.sort_key` 的处理一致。"""
    try:
        return SEVERITY_ORDER.index(str(severity or "").strip().upper())
    except ValueError:
        return len(SEVERITY_ORDER)


@dataclass(frozen=True)
class ChatTarget:
    """一个投递目标 = `inspchat#target` 表里的一行。"""

    platform: str
    chat_id: str
    accounts: tuple[str, ...] = ()
    locale: str = DEFAULT_LOCALE
    severity_min: str = DEFAULT_SEVERITY_MIN
    enabled: bool = True
    note: str = ""

    @property
    def key(self) -> str:
        """日志/计数里用的稳定标识。与 `keys.chat_sk()` 同形状。"""
        return f"{self.platform}#{self.chat_id}"

    @property
    def sees_all_accounts(self) -> bool:
        return ALL_ACCOUNTS in self.accounts

    def sees(self, account_id: str) -> bool:
        """这个 chat 能不能看到该账号（R11b.3 的判定原语）。"""
        if self.sees_all_accounts:
            return True
        return str(account_id or "").strip() in self.accounts

    def accepts(self, severity: str) -> bool:
        """严重度够不够门槛。`severity_min` 认不出时**放行**。

        ⚠️ 放行而不是拦住：拼错一个字母（`CRITCAL`）拦住的话，
        那个 chat 从此一条都收不到，而没有任何东西会报错。
        放行的表现是收到比预期多的条目 —— 客户会说「太吵了」，
        于是配置错误被发现。
        """
        return _severity_rank(severity) <= _severity_rank(self.severity_min)


@dataclass(frozen=True)
class ResolvedTargets:
    """`resolve_inspection_targets()` 的结果。"""

    targets: tuple[ChatTarget, ...] = ()
    rejected: tuple[tuple[ChatTarget, RejectReason], ...] = ()
    warnings: tuple[tuple[str, str], ...] = ()
    """`(target.key, 说明)` —— 已放行但配置可疑的。

    ⚠️ 与 `rejected` 分开：被拒的一条都收不到（要立刻修），
    有警告的照常收（可以慢慢修）。合成一个字段会让前者被后者淹掉。
    """

    @property
    def is_empty(self) -> bool:
        return not self.targets


def target_from_item(item: Mapping[str, Any]) -> ChatTarget:
    """DDB 行 → `ChatTarget`。**从不抛** —— 坏行由 resolve 阶段拒掉。

    `platform` / `chat_id` 优先取行上的字段，缺了才从 SK 兜底解析
    （手写的行常常只有键）。
    """
    platform = str(item.get("platform") or "").strip().lower()
    chat_id = str(item.get("chat_id") or "").strip()
    if not platform or not chat_id:
        # `<platform>#<chat_id>`，只切第一个分隔符（chat_id 允许含 `#`）。
        head, _, tail = str(item.get("SK") or "").partition(_SK_SEP)
        platform = platform or head.strip().lower()
        chat_id = chat_id or tail.strip()

    raw_accounts = item.get("accounts")
    if isinstance(raw_accounts, str):
        # 手写行常写成逗号分隔的一串（lambda4 的 notify_chat_ids 就是这个形状）
        parts: Iterable[Any] = raw_accounts.split(",")
    elif isinstance(raw_accounts, (list, tuple, set, frozenset)):
        parts = raw_accounts
    else:
        parts = ()
    accounts = tuple(dict.fromkeys(
        str(a).strip() for a in parts if str(a).strip()))

    locale = str(item.get("locale") or "").strip().lower()
    if locale not in LOCALES:
        locale = DEFAULT_LOCALE

    severity_min = str(item.get("severity_min")
                       or DEFAULT_SEVERITY_MIN).strip().upper()

    raw_enabled = item.get("enabled")
    if raw_enabled is None:
        enabled = True
    elif isinstance(raw_enabled, str):
        enabled = raw_enabled.strip().lower() not in ("0", "false", "no", "")
    else:
        enabled = bool(raw_enabled)

    return ChatTarget(
        platform=platform, chat_id=chat_id, accounts=accounts,
        locale=locale, severity_min=severity_min, enabled=enabled,
        note=str(item.get("note") or ""),
    )


def resolve_inspection_targets(
    items: Iterable[Mapping[str, Any]],
    *,
    single_sink_platforms: frozenset[str] = SINGLE_SINK_PLATFORMS,
    known_platforms: tuple[str, ...] = PLATFORMS,
) -> ResolvedTargets:
    """`inspchat#target` 的原始行 → 可投递目标 + 被拒清单（R11b.2）。

    纯函数：不读 DDB、不调 sender。`single_sink_platforms` 走参数而不是
    直读常量，这样测试能证明「多目标整平台拒掉」这条逻辑本身，
    而不是绑死在 dingtalk 上。

    ⚠️ 顺序稳定（按 `platform` 在 `known_platforms` 里的位置，再按 chat_id）——
    投递顺序不稳会让「昨天先收到的今天后收到」，排查投递延迟时无从下手。
    """
    parsed = [target_from_item(it) for it in items]

    targets: list[ChatTarget] = []
    rejected: list[tuple[ChatTarget, RejectReason]] = []
    warnings: list[tuple[str, str]] = []

    for t in parsed:
        if not t.chat_id:
            rejected.append((t, RejectReason.NO_CHAT_ID))
        elif t.platform not in known_platforms:
            rejected.append((t, RejectReason.UNKNOWN_PLATFORM))
        elif not t.enabled:
            rejected.append((t, RejectReason.DISABLED))
        elif not t.accounts:
            rejected.append((t, RejectReason.NO_ACCOUNTS))
        else:
            targets.append(t)
            if _severity_rank(t.severity_min) >= len(SEVERITY_ORDER):
                warnings.append((
                    t.key,
                    f"severity_min={t.severity_min!r} 不是四档之一"
                    f"（{'/'.join(SEVERITY_ORDER)}），本轮按全推处理",
                ))

    # 🔴 单 sink 平台：≥2 个启用目标 → 整平台拒掉（见模块 docstring）。
    #    ⚠️ 只数**通过前面校验的**目标 —— 把已停用的行也数进去会让
    #    「停用了一个、留一个」这种正常配置被判成冲突。
    for platform in single_sink_platforms:
        same = [t for t in targets if t.platform == platform]
        if len(same) > 1:
            targets = [t for t in targets if t.platform != platform]
            rejected.extend((t, RejectReason.AMBIGUOUS_ROUTING) for t in same)

    def _order(t: ChatTarget) -> tuple[int, str]:
        try:
            rank = known_platforms.index(t.platform)
        except ValueError:
            rank = len(known_platforms)
        return (rank, t.chat_id)

    targets.sort(key=_order)
    rejected.sort(key=lambda pair: (_order(pair[0]), pair[1].value))
    return ResolvedTargets(
        targets=tuple(targets),
        rejected=tuple(rejected),
        warnings=tuple(sorted(warnings)),
    )
