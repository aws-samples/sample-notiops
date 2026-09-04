"""飞书卡片的**统一宽度**（2026-09-03 / B8 第 6 项）。

问题:「📝 Report Summary」那张卡设了 `width_mode: "fill"`,占满聊天框;别的卡都没设,
走默认宽度,于是同一个会话里卡片宽窄不一,窄卡里的表格/长 code 还会被挤到换行。

飞书的宽度只有三档(`compact` / `default` / `fill`),**没有"再宽 20%"这种档位**——
所以按需求里"最好所有面板宽度统一"的那条来做:全部 `fill`,与已经最宽的那张对齐。

为什么要一个函数而不是各处写字面量:卡片有三十多处 `"config": {...}`,分散在
`platforms/feishu/*` 与 `shared/report_delivery/feishu_sender.py`。漏一处**不会报错**,
只是那张卡又变窄 —— 正是这次要修的现象。所以统一走这里,并由
`tests/test_im_card_width.py` 断言那些模块里不再有裸的 `"config": {` 字面量。

⚠️ 本模块只许用标准库(实际上零 import):它会被 ingress 侧的模块间接拉到,而 ingress
有 10s INIT 硬上限。
"""
from __future__ import annotations

#: 三档里最宽的一档。改这个值会同时改掉所有卡片的宽度 —— 这正是它存在的意义。
CARD_WIDTH_MODE = "fill"


def card_config(**overrides) -> dict:
    """卡片 `config` —— 先铺上统一宽度，再叠调用方自己的键。

    `overrides` 里的键会覆盖同名默认键（包括 `width_mode` 本身，留给将来真有一张卡
    必须窄的场景），但那种覆盖属于例外：测试会盯住"没有调用方在覆盖 width_mode"。
    """
    return {"width_mode": CARD_WIDTH_MODE, **overrides}
