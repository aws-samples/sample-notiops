"""开案例卡上那个「开到哪个账号」下拉 —— 选项与回传值的**唯一**实现。

为什么单独一份（2026-09-07）：开案例是本产品**唯一的写操作**，而在这之前目标账号是
*隐式*的 —— 由 `/account` 的会话偏好在渲染卡片那一刻定下来，卡上只有一行说明文字。
2026-09-07 现网实测到的故障正是这个形态：卡片上写着账号 A，案例开在了账号 B
（`_create_form_card` 的按钮漏了 `case_account_id`），而这种错**只能靠事后去看工单
落在哪**才发现。把目标账号做成一个显式的、客户亲手点过的下拉，这一类错就没有藏身处了。

飞书与 Slack 各有一份表单构造代码（一个是卡片 `select_static`，一个是 modal
`static_select`），但「有哪些账号可选 / 回传值怎么收」必须是同一份 —— 与
`platforms/common/im_footer.py` 同一个理由：两份逐字相同的副本，改一边漏一边的症状是
「同一个部署里飞书能开到成员账号、Slack 只能开到部署账号」，谁也不会同时看两端。

两条不变量：

1. **`options()` 返回空列表 = 不渲染下拉。** 只有一个账号可选（单账号部署 / 注册表里
   没有别的启用账号 / 连部署账号号都拿不到）时，一个只有一项的下拉是纯噪音。这时行为与
   加这个下拉**之前**逐字相同（走卡片自带的 `case_account_id` 章）。

2. **`resolve_choice()` fail-closed。** 回传的账号号不在允许集里就返回 `None`
   （= 拒绝这次提交），**绝不**回落到部署账号。回落是"静默降级"里最坏的一种：
   客户看到"提交成功"，工单却开在了另一个账号下。
"""
from __future__ import annotations

from core import i18n
from core import im_accounts

#: 选项标签里账号号与名字之间的分隔符（与落款 `im_footer.SEP` 视觉一致）。
_SEP = " · "

#: Slack `static_select` 的 option text 上限是 75 字符，飞书没有更紧的限制 ——
#: 取两者里紧的那个，两端的选项文案才不会一边被截一边不被截。
MAX_LABEL = 75


def _label(account_id: str, name: str, locale: str, *, is_deploy: bool) -> str:
    """一条选项的显示文案：`<12 位账号号>[ · <名字或"部署账号">]`。

    号码放**最前面**（不是名字）：客户要确认的是"开到哪个账号"，而名字是 Web 端登记时
    随便填的一个字符串，两个账号取同名并不违法。号码才是无歧义的那个。
    """
    tail = (i18n.t("account.list_tag_deploy", locale) if is_deploy
            else (name or "").strip())
    label = f"{account_id}{_SEP}{tail}" if tail else account_id
    return label[:MAX_LABEL]


def options(locale: str = "zh", *, deploy: str = "") -> list[tuple[str, str]]:
    """下拉选项 `[(账号号, 显示文案), …]`。**空列表 = 调用方不要渲染下拉。**

    顺序：部署账号第一，其余按账号号排序。与 `/account` 的清单同一个顺序
    （`pref_commands._account_rows`），两处看到的账号排列一致。

    `deploy` 由调用方传进来（**别在这里解析**）：org 模式下
    `im_accounts.deploy_account_id()` 底下是一次 STS，而开案例这条路上调用方本来就
    已经拿到过它了。拿不到（空串）→ 返回 `[]`：连"默认开在哪"都说不清的时候，给一个
    下拉只会让客户在两个都不确定的选项之间猜。

    单账号部署（`is_locked()`）直接返回 `[]` —— 那种部署里注册表就算有别的账号也切不
    过去（§4.1 的闸门），列出来等于给一个点了会被拒的选项。
    """
    d = (deploy or "").strip()
    if not d:
        return []
    if im_accounts.is_locked():
        return []
    opts: list[tuple[str, str]] = [(d, _label(d, "", locale, is_deploy=True))]
    for it in sorted(im_accounts.list_selectable(),
                     key=lambda x: str(x.get("account_id") or "")):
        acct = str(it.get("account_id") or "").strip()
        if not acct or acct == d:
            continue
        name = str(it.get("account_name") or "")
        opts.append((acct, _label(acct, name, locale, is_deploy=False)))
    # 只有部署账号本身 → 一项的下拉，不值得渲染。
    return opts if len(opts) >= 2 else []


def initial_index(opts: list[tuple[str, str]], current: str,
                  *, deploy: str = "") -> int:
    """飞书 `select_static` 的 `initial_index`（**1-based**，见
    `case_flow.service_and_type_elements` 上方那段注释：写成 0-based 会默认选中下一项）。

    `current` 是卡片渲染那一刻的会话账号（空 = 部署账号）—— 默认值必须是它，
    这样"什么都不动直接提交"的行为与加下拉**之前**完全一样。
    """
    want = (current or "").strip() or (deploy or "").strip()
    for i, (acct, _lbl) in enumerate(opts):
        if acct == want:
            return i + 1
    return 1


def allowed_ids() -> set[str]:
    """允许开案例的账号集合。**复用 `im_accounts.allowed_accounts()`**，不在这里
    第二次拼"部署账号 + 注册表" —— 两份实现迟早对"谁算允许"给出不同答案。

    那个函数拿不到部署账号时返回哨兵 `"none"`，于是这个集合里没有任何 12 位数字，
    下面 `resolve_choice` 一律拒绝。这正是想要的 fail-closed。
    """
    return {a for a in im_accounts.allowed_accounts().split(",") if a}


def resolve_choice(picked: str, *, stamped: str = "",
                   deploy: str = "") -> str | None:
    """把下拉回传的值收成一个可执行的账号号。

    返回值：
      * `str` —— 目标账号号，**空串 = 部署账号**（`ImMessage.account_id` 的契约）。
      * `None` —— **拒绝这次提交**（回传了一个不在允许集里的账号号）。

    三条分支，每一条都对着一种错法：

    1. `picked` 为空（下拉没渲染 / 老卡片 / 客户端没回传）→ 用卡片自带的 `stamped`
       章。这是**向后兼容**：本次改动之前发出去的卡片没有 `account_select`，而它们
       的章就是当时唯一可能的归属，所以缺省值天然正确。
    2. `picked` 等于部署账号 → 归一成 `""`。不是为了省事：`""` 才是全链路（落款、
       `_account_banner`、`support_client`）认的"部署账号"表示法，传具体号码会让
       单账号客户的卡片上多出一条本来没有的账号横幅。
    3. `picked` 是别的号码 → **必须在 `allowed_ids()` 里**，否则 `None`。
       这里不做"退回部署账号"的兜底：那会把"你选的账号不让开"变成"已在另一个账号
       开好了"，而客户看到的是一句"提交成功"。
    """
    p = (picked or "").strip()
    if not p:
        return (stamped or "").strip()
    d = (deploy or "").strip()
    if d and p == d:
        return ""
    if p not in allowed_ids():
        return None
    return p


__all__ = ["MAX_LABEL", "allowed_ids", "initial_index", "options",
           "resolve_choice"]
