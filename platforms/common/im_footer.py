"""IM 卡片落款 —— 飞书与 Slack **共用这一份实现**（不再是两份"逐字对齐"的副本）。

落款回答三个问题，一行说完：**这一轮走的哪条路 / 用的哪个模型 / 问的哪个 AWS 账号。**

── 为什么搬到 common/ ────────────────────────────────────────────────────────
`platforms/feishu/im_cards.usage_footer` 与 `platforms/slack/im_blocks.usage_footer`
原本是两份逐字相同的实现，靠 `tests/test_im_agent_card_parity.py` 盯着不许漂。那份
测试的存在本身就说明这是个已知会复发的坑（一边改了另一边没改 = 同一个部署里飞书说
走了模型、Slack 说没花钱，而谁也不会同时看两端）。落款是一段**纯字符串**，两个平台
没有任何形状差异 —— 与卡片结构不同，它没有"必须各写一份"的理由。所以这里把它收成
一份，两个平台的 `usage_footer` 退化成薄转发。漂移从"靠测试发现"变成"结构上不可能"。

⚠️ 两个平台的 `usage_footer` 入口**保留**：`caps.py` 的纯文本兜底路径直接调它们，
   而那两处调用点是各平台自己的（飞书 `reply_text` / Slack `reply_text`）。

── 账号那一段（2026-09-07，多账号）───────────────────────────────────────────
IM 侧支持 `/account` 切账号之后，「这条回答是基于哪个账号的」不再是废话 —— 群里
任何人都能把整个会话切到另一个已启用的账号，而卡片上原本一个字都看不出来。

三条口径：
  1. **账号号一定是具体的 12 位数字，不是"当前账号"这种废话。** 拿不到就整段不显示 ——
     显示一个没有账号号的「账号: (部署账号)」等于什么都没说。
  2. **部署账号要标出来。** 只显示号码时客户还得自己回忆"这个号是不是我的部署账号"。
  3. **落款渲染函数自己绝不去解析账号。** `deploy` 必须由调用方**每轮传一次**：
     `core.im_accounts.deploy_account_id()` 在 org 模式下要走一次 STS，而落款函数
     会被 `LiveCard.flush` 每几秒调一次（进度 PATCH）—— 在这里解析等于把一次
     AWS 调用塞进渲染循环。
"""
from __future__ import annotations

from core import i18n

#: 落款各段之间的分隔符 —— 与 `router.direct_no_token` 自带的那个 `·` 同一个风格。
SEP = " · "


def route_line(locale: str, *, agent: str = "devops", usage=None) -> str:
    """「哪条路 / 哪个模型」那一段。

    两条路两套说法，故意不含糊：
      · `devops`  → `router.direct_no_token`（直连，NotiOps 侧 0 token）；
      · `notiops` → `router.agent_model`，报 `usage["modelId"]`（`core.agent_chat`
        用 `llm_config.resolve()` 算出的**实际生效**模型 id）。拿不到就退
        `router.agent_model_unknown`（只报 agent 名）—— **绝不能**退成"无模型消耗"
        那句：那是把"不知道"说成"没花钱"。

    判据是 `agent != "notiops"` 而不是 `== "devops"`：以后加第三个 agent 时不会
    **默认**开始声称花钱。

    ⚠️ **用量刻意不出现在这里**（2026-09-06 产品决策）：`usage` 里 `totalTokens` /
    `cycles` 照样是实测值、照样进日志与指标，只是先不给客户看。要重新露出来就在这
    一行拼回去（一处改动，两个平台同时生效），链路不用动。
    """
    if agent != "notiops":
        return i18n.t("router.direct_no_token", locale)
    model = str((usage or {}).get("modelId") or "").strip()
    if not model:
        return i18n.t("router.agent_model_unknown", locale)
    return i18n.t("router.agent_model", locale, model=model)


def account_line(locale: str, *, account: str = "", deploy: str = "") -> str:
    """「问的哪个账号」那一段。拿不到具体账号号 → **空串**（调用方整段不拼）。

    `account` 空 = 部署账号（`platforms/common/im_types.py::ImMessage.account_id`
    的契约）。`deploy` 是部署账号号，用来做两件事：`account` 为空时补上号码、
    以及判断要不要盖「部署账号」那个章。

    两个都为空只可能是 `deploy_account_id()` 拿不到（STS 失败）。那时**什么都不说** ——
    编一句「账号: 部署账号」是在用一句没有信息量的话冒充有信息量。
    """
    acct = str(account or "").strip()
    dep = str(deploy or "").strip()
    shown = acct or dep
    if not shown:
        return ""
    key = "router.account_deploy" if (dep and shown == dep) else "router.account"
    return i18n.t(key, locale, account=shown)


def usage_footer(locale: str, *, agent: str = "devops", usage=None,
                 account: str = "", deploy: str = "") -> str:
    """整条落款。段与段之间 `SEP`；账号那段拿不到就自然消失（不留空的分隔符）。

    `account` / `deploy` 都不传时输出与加账号之前**逐字相同** —— 所以既有调用点
    （以及只关心模型那一段的判据）不受影响。
    """
    parts = [route_line(locale, agent=agent, usage=usage)]
    acct = account_line(locale, account=account, deploy=deploy)
    if acct:
        parts.append(acct)
    return SEP.join(parts)


__all__ = ["SEP", "account_line", "route_line", "usage_footer"]
