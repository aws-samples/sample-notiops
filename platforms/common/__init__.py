"""Transport-agnostic IM layer (IM 重构 / M0).

三个 IM 平台（飞书 / Slack / 钉钉）今天各自在 `platforms/<p>/app/main.py` 里重复了同一套
"收到一条消息之后怎么决定干什么"的逻辑。M0 把这套逻辑抽到这里，平台侧只剩两件事：

  1. **事件适配** —— 把平台原生事件对象规范成 :class:`~platforms.common.im_types.ImMessage`
     / :class:`~platforms.common.im_types.ImAction`；
  2. **能力实现** —— 实现 :class:`~platforms.common.im_types.Caps` 协议（发文本、发卡片、
     改卡片、以及七个能力各自的渲染）。

**决策**在这一层且完全确定性（0 token）；**渲染**留在平台层，因为卡片 schema 三家互不相同
（飞书 v2 card / Slack Block Kit / 钉钉 markdown）。硬要统一渲染只会得到一个谁都不好用的
最小公倍数。

分层：`ingress` 只做鉴权 / 去重 / 快速 ack，能力实现放各平台自己的 `caps.py`。
"""
