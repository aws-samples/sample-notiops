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

── 🔴 STAROps 那一段（2026-09-14，多云）──────────────────────────────────────
第三条路（`/agent starops`）答的是**阿里云**资源。于是账号那一段在这条路上**必须
整段消失**，换成阿里云侧的坐标（数字员工 ID）：

  · 在一张讲阿里云的卡片上盖一个 12 位 **AWS** 账号号，是跨云假信息 —— 客户会以为
    这份阿里云巡检结论是"关于那个 AWS 账号的"。Web 端 2026-09-13 报过同一个 bug
    （STAROps 会话右上角还挂着 AWS 多账号选择器），这里是同一条口径的 IM 版。
  · 换上去的是**数字员工 ID**：一个阿里云账号可以有多个数字员工，纳管范围和答案
    质量完全不同，所以"这答案是哪个员工给的"是读答案时的必要坐标。
  · 🔒 这一位**只放 `employee`**，绝不放 `workspace` —— 后者内嵌阿里云账号 UID
    （管理员专属值，见 `docs/LOGGING_STANDARD.md`）。

同理 `route_line`：`router.direct_no_token` 的字面是「直连 **DevOps Agent**」，对这条
路来说是错的名字。判据从"不是 notiops 就说直连"细化成三分支 —— 原来那个
`agent != "notiops"` 只保证了"不会凭空宣称花钱"，保证不了"名字是对的"。
"""
from __future__ import annotations

from core import i18n

#: 落款各段之间的分隔符 —— 与 `router.direct_no_token` 自带的那个 `·` 同一个风格。
SEP = " · "

#: ⚠️ 这两个值必须与 `core.im_prefs.AGENT_NOTIOPS` / `AGENT_STAROPS` **逐字相等**，
#: 这里刻意写字面量而不是 import：`core.im_prefs` 会拉进 `core.ddb_state`（boto3 +
#: 建表资源），而落款是三个平台的**渲染**路径、还被纯渲染测试直接 import。
#: 对齐由 `tests/test_im_starops_footer.py` 一条断言盯着 —— 值改了会当场红。
_AGENT_NOTIOPS = "notiops"
_AGENT_STAROPS = "starops"


def route_line(locale: str, *, agent: str = "devops", usage=None) -> str:
    """「哪条路 / 哪个模型」那一段。

    三条路三套说法，故意不含糊：
      · `devops`  → `router.direct_no_token`（直连，NotiOps 侧 0 token）；
      · `notiops` → `router.agent_model`，报 `usage["modelId"]`（`core.agent_chat`
        用 `llm_config.resolve()` 算出的**实际生效**模型 id）。拿不到就退
        `router.agent_model_unknown`（只报 agent 名）—— **绝不能**退成"无模型消耗"
        那句：那是把"不知道"说成"没花钱"。
      · `starops` → `router.direct_starops`（直连阿里云 STAROps，NotiOps 侧 0 token，
        但**烧客户自己的阿里云 AI 额度**）。2026-09-14 加。

    未知 agent 仍然落 `devops` 那句（`router.direct_no_token`）：加第四条路时最坏也只是
    名字说旧了，**不会**凭空宣称花钱 —— 反过来（默认落 `agent_model`）才是不可接受的。
    ⚠️ 但"不会说花钱"**不等于**"名字是对的"：`router.direct_no_token` 的字面写着
    「直连 DevOps Agent」，所以每加一条直连路都必须在这里加一个分支，光靠那个否定判据
    会让新 agent 顶着 DevOps Agent 的名字（这正是 STAROps 这次要修的）。

    ⚠️ **用量刻意不出现在这里**（2026-09-06 产品决策）：`usage` 里 `totalTokens` /
    `cycles` 照样是实测值、照样进日志与指标，只是先不给客户看。要重新露出来就在这
    一行拼回去（一处改动，三个平台同时生效），链路不用动。
    """
    if agent == _AGENT_STAROPS:
        return i18n.t("router.direct_starops", locale)
    if agent != _AGENT_NOTIOPS:
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


def employee_line(locale: str, *, employee: str = "") -> str:
    """「哪个阿里云数字员工答的」那一段 —— 只在 `agent="starops"` 那条路上出现。

    拿不到 ID → **空串**（调用方整段不拼），口径与 :func:`account_line` 完全一致：
    「数字员工: (当前那个)」这种话没有信息量，不如不说。

    🔒 这里只许放数字员工 **ID**。两个不许：
      · 不许放 `workspace`（内嵌阿里云账号 UID，管理员专属值）；
      · 不许放显示名称（`displayName`）—— 客户要拿这个值回控制台/工单里对，
        而控制台里能唯一定位的是 ID。过程行里那句「已连接数字员工「显示名」」是给人看的，
        落款这一位是给人**抄**的，两者刻意不同。
    """
    emp = str(employee or "").strip()
    if not emp:
        return ""
    return i18n.t("router.employee", locale, employee=emp)


def usage_footer(locale: str, *, agent: str = "devops", usage=None,
                 account: str = "", deploy: str = "",
                 employee: str = "") -> str:
    """整条落款。段与段之间 `SEP`；第二段拿不到就自然消失（不留空的分隔符）。

    第二段是**互斥**的两种坐标，由 `agent` 决定，绝不同时出现：
      · `starops` → 数字员工 ID（阿里云），**账号那一段整段不渲染**（哪怕调用方传了
        `account` / `deploy`）—— 理由见模块头 🔴 那一段：在一张讲阿里云的卡片上盖
        AWS 账号号是跨云假信息。调用方照旧无脑传 `account=` / `deploy=` 也不会出错，
        这个开关只在这里一处。
      · 其它 → AWS 账号（原有行为，逐字不变）。

    `account` / `deploy` / `employee` 都不传时输出与加这三个参数之前**逐字相同** ——
    所以既有调用点（以及只关心模型那一段的判据）不受影响。
    """
    parts = [route_line(locale, agent=agent, usage=usage)]
    second = (employee_line(locale, employee=employee)
              if agent == _AGENT_STAROPS
              else account_line(locale, account=account, deploy=deploy))
    if second:
        parts.append(second)
    return SEP.join(parts)


__all__ = ["SEP", "account_line", "employee_line", "route_line", "usage_footer"]
