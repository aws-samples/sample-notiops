"""Kill switch —— 不改代码、不重新部署就能停掉巡检（R11c.1）。

## 为什么存 DDB 而不是环境变量

env 改动要重新部署 Lambda。kill switch 的价值恰恰在于**出事那一刻**能立刻
拉停 —— 那时没人想跑一遍 CDK。没有它，唯一的止损手段是去删 EventBridge
Rule，而删掉的 Rule 事后要靠记忆恢复（老系统那 5 条 cron 的参数就只存在
于 CDK 代码里）。

## 三个 kill switch + 一个功能开关

R11c.1 写了三个：`inspection.enabled` / `push_enabled` / `da_enabled`。
这里只实现第一和第三个。

✅ **`push_enabled` 已接线**。它此前刻意缺席，理由是「造一个
没有消费点的开关比不造更危险 —— 出事时有人拉了它，以为推送停了，而推送照旧
发」。现在消费点在 `lambda_inspection_push/handler.py`，**在算完之后、投递
之前**早退，所以它是三个开关里唯一「不影响任何数据」的那个。

## 存储形状

抄 `shared/phd_config.py` 的 appconfig 惯例（同一张 `notiops-config` 表）：

```
PK = "appconfig#inspection"
SK = "enabled" | "da_enabled" | "push_enabled" | "llm_intro"
config_value = "0" / "false" / "1" / "true"     也接受原生 bool / 数字
```

## 读失败 = fail-OPEN（继续巡检）

⚠️ 这个取舍的方向与「kill switch 应当保守」的直觉相反，理由：

- fail-CLOSED 意味着一次 DDB 抖动就**静默**停掉整个产品，而客户看不到任何
  错误 —— 只会以为「今天没有风险」。那比开关失灵严重得多。
- 巡检本身要往同一张库写 run 记录。DDB 真坏了，fail-closed 挡下来的那一轮
  反正也跑不完，挡与不挡的结果一样。

所以分两种情形，且**必须区分**：

```
行不存在（从没配过）   → 当 True，安静       ← 常态，全新部署就是这样
读抛异常（DDB 有问题）  → 当 True，记 ERROR   ← 要人来看
```

两者记同一个日志级别会让「没配过」天天刷 ERROR，于是真的 DDB 故障被淹掉。

## 怎么拉

没有 UI —— 刻意的：一个藏在权限体系后面的止损按钮，在出事时可能正好因为
登录/鉴权链路本身有问题而点不开。CLI 一行：

```bash
# 停掉整个巡检（调度不再 fan-out，执行器也丢弃队列里的存量消息）
aws dynamodb update-item --region ap-northeast-1 --table-name notiops-config \
  --key '{"PK":{"S":"appconfig#inspection"},"SK":{"S":"enabled"}}' \
  --update-expression 'SET config_value = :v' \
  --expression-attribute-values '{":v":{"S":"0"}}'

# 只停 AI 判读派发（规则判定、finding 状态机、报告照跑）
aws dynamodb update-item --region ap-northeast-1 --table-name notiops-config \
  --key '{"PK":{"S":"appconfig#inspection"},"SK":{"S":"da_enabled"}}' \
  --update-expression 'SET config_value = :v' \
  --expression-attribute-values '{":v":{"S":"0"}}'

# 只停 IM 推送（照常算、照常落库，不投递 —— 灰度第 ② 段就是这个状态）
aws dynamodb update-item --region ap-northeast-1 --table-name notiops-config \
  --key '{"PK":{"S":"appconfig#inspection"},"SK":{"S":"push_enabled"}}' \
  --update-expression 'SET config_value = :v' \
  --expression-attribute-values '{":v":{"S":"0"}}'

# 恢复：把 "0" 换成 "1"
```

两行都由 `infra/lambda/seed-data/seed-data.json` 预置成 `"1"`，目的是**可发现**
—— 一个必须在事故当中凭记忆手写 PK/SK 才能创建的行不是可用的 kill switch。
seed 用 `attribute_not_exists(PK)` 条件写，所以重跑 `setup.sh` **不会**把你
刚拉停的开关悄悄改回去。
"""

from __future__ import annotations

import logging
from enum import Enum
from typing import Any

logger = logging.getLogger(__name__)

PK = "appconfig#inspection"
"""与 `shared/phd_config.py` 的 `appconfig#phd` 同族，同一张 config 表。"""


class Switch(str, Enum):
    """开关名。**值就是 DDB 的 SK**，改值等于换一行配置。"""

    INSPECTION = "enabled"
    """整个巡检停摆：调度器不再 fan-out，执行器不再处理存量消息。"""

    DA = "da_enabled"
    """只停 AWS DevOps Agent 判读派发；规则判定、finding 状态机、报告照跑，
    每条 finding 走 degraded 路径并注明原因（R11c.1 明写「继续出报告」）。"""

    PUSH = "push_enabled"
    """只停 IM 推送：照常算、照常落库，**不投递**（R11c.1）。

    🔴 早退位置是「**算完之后、投递之前**」，SHALL NOT 提前到「算之前」——
    R11c.7 的灰度第 ② 段是「全账号只写库不推送」，那一段要的正是
    照常算、照常落库、只是不投。提前早退等于把第 ② 段变成「什么都不做」。

    ⚠️ 拉停期间**不写推送状态**（`insppush#` 行）。写了的话开关恢复之后
    那些 finding 会被当成「已经推过」而跳过 —— 客户在开关期间的风险
    从此再也不会被推一次。
    """

    LLM_INTRO = "llm_intro"
    """总览报告的那段 LLM 导语（R9.3）。

    ⚠️ 这**不是** kill switch，是一个功能开关 —— R9.3 明写「导语 SHALL 可关闭
    且关闭后不影响任何数据」。关掉它之后确定性部分**逐字不变**，由
    `test_inspection_overview.py` 比对。放在同一个命名空间是因为它同样需要
    「不重新部署就能改」（导语措辞出问题时要能立刻停）。
    """


_FALSEY = frozenset({"0", "false", "no", "off", "disabled", "n", "f"})
"""判成 False 的字面量。

⚠️ 比对前先 `.strip().lower()`，**不照抄** `core/llm_config.py:394` 那种
`not in ("0", "false", "False")` 的字面量三元组 —— 那种写法下有人在控制台
里填 `FALSE` 或 ` false` 会被判成 True，而这是个 kill switch：
失灵的表现是「我明明关了它还在跑」，排查起来极其耗时。
"""


def _as_bool(value: Any, *, default: bool) -> bool:
    """DDB 属性值 → bool。空值/None 视为「未绑定」，落到 `default`。

    ⚠️ 空串按未绑定处理（与 `phd_config._query_config` 一致），不是「明确关掉」。
    DDB 里存不了真正的空，一个空串通常来自写入侧的 bug 或人手误清，
    把它读成 False 会让巡检因为一次误操作静默停摆。
    """
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    s = str(value).strip().lower()
    if not s:
        return default
    return s not in _FALSEY


def is_enabled(
    config_table: Any, switch: Switch | str, *, default: bool = True,
) -> bool:
    """读一个开关。

    `config_table` 是**调用方传进来的** DDB Table 资源，本模块不建 client ——
    ⚠️ 这不只是洁癖：CI 的 `inspection-tests` job 只装
    `pytest hypothesis botocore`，**故意不装 boto3**（判定层是纯函数）。
    在这里 `import boto3` 会让整个测试文件 collection error，
    而那个错**只在 CI 上出现**（本机装了 boto3）。

    表缺失（`config_table` 为 None）时返回 `default` —— 老部署可能还没有
    CONFIG_TABLE 这个 env。
    """
    name = switch.value if isinstance(switch, Switch) else str(switch or "").strip()
    if not name:
        raise ValueError("switch 名不能为空")
    if config_table is None:
        return default

    try:
        resp = config_table.get_item(Key={"PK": PK, "SK": name})
    except Exception as e:                     # noqa: BLE001
        # ⚠️ 绝不抛。开关读失败让整轮巡检异常退出，等于把一个「可选的
        #    止损手段」变成了「新的故障源」。
        logger.error(
            "读 kill switch 失败，按开启处理（fail-open）: switch=%s error=%s",
            name, e)
        return default

    item = (resp or {}).get("Item")
    if not item:
        # 常态：从没配过。**不记 ERROR** —— 天天刷会把真故障淹掉。
        return default

    value = item.get("config_value")
    if "config_value" not in item:
        # 行在但字段不在：写入侧的形状不对，值得看一眼，但仍 fail-open。
        logger.warning(
            "kill switch 行存在但缺 config_value，按开启处理: switch=%s keys=%s",
            name, sorted(item.keys()))
        return default

    enabled = _as_bool(value, default=default)
    if not enabled:
        # 关掉是罕见且重要的状态 —— 必须在日志里留一行，否则事后
        # 「那天为什么没巡检」只能靠猜。
        logger.warning("kill switch 处于关闭状态: %s=%r", name, value)
    return enabled
