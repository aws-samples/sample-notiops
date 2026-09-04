"""要巡检哪些 region（2026-08-27）。

## 为什么需要这个模块

在这之前巡检的 region 是执行 Lambda 的 `AWS_REGION` —— 那个变量由 AWS 注入、
**等于 Lambda 自己所在的 region、不可配**。于是任何不在部署 region 的资源
从来没被看到过：

```
验证账号       4 台 RDS 全在 us-east-1，系统部署在 ap-northeast-1
  → load_resources 在 ap-northeast-1 里 describe → 0 台
  → expected.instances = 0
  → completeness = 0 ÷ 0 = 1
  → run status = success
  → 看板显示「跑过了、没风险」
```

整条链路零错误码、零告警、零日志。客户在「移出巡检范围」里看到的也是
「RDS / Aurora 0」+「这个账号里没有可排除的资源」（BFF 那侧犯的是同一个错）。

## 判据

`ec2:DescribeRegions` 默认只回**本账号已启用**的 region —— opt-in 的
（如 ap-east-1 / me-south-1）要显式启用才出现。没启用的 region 里不可能有资源，
所以不需要额外过滤。

⚠️ 用**目标账号自己的**凭证枚举，不是部署账号的。opt-in 集合是按账号启用的：
拿部署账号的名单套到成员账号上，会在成员账号没启用的 region 上白跑一遍
describe（拿到 `AuthFailure`），也会漏掉成员账号单独启用的 region。
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


class RegionDiscoveryError(RuntimeError):
    """region 枚举失败。**不降级** —— 见 `list_scan_regions` 的说明。"""


def list_scan_regions(
    session,
    *,
    home: str,
    errors: list[str] | None = None,
) -> list[str]:
    """这个账号要巡检的全部 region，已排序。

    Args:
        session: 目标账号的 boto3 Session（部署账号用自身角色，成员账号是
            AssumeRole 之后的那个）。
        home: 本系统自己所在的 region —— 只用来建 EC2 客户端发这一次调用，
            **不是**「要扫的 region」。
        errors: 非空时把降级痕迹 append 进去（会落进 run 记录的 `skipped`）。

    Raises:
        RegionDiscoveryError: 枚举失败或返回空列表。

    🔴 **失败时抛，不回落成 `[home]`。**

    回落看起来更健壮，实际是让上面 docstring 里那个缺陷**静默复活**：只扫部署
    region、run 记录 success、`expected.instances` 是那一个 region 的数字，
    而客户以为覆盖了全部。而且 `errors` 里那一行只有翻 run 记录才看得到 ——
    没人会为一次「成功」的巡检去翻。

    ⚠️ 抛出去的代价是这个账号本轮没有巡检，但 run 记录里会有 `failed` 与原因，
    reconciler 的缺行判定也会看到。两者都是可见的信号，而回落没有任何信号。
    """
    try:
        ec2 = session.client("ec2", region_name=home)
        resp = ec2.describe_regions(AllRegions=False)
    except Exception as e:                                    # noqa: BLE001
        if errors is not None:
            errors.append("regions:describe_failed")
        raise RegionDiscoveryError(
            f"枚举 region 失败（ec2:DescribeRegions，home={home}）："
            f"{type(e).__name__}: {e}。"
            "缺这个权限只能扫部署 region，而那是静默漏采 —— 本轮放弃。"
            "部署账号的权限在 notiops-backend-stack.ts 的 lambdaRole，"
            "成员账号的在 notiops-idle-detection-role-<部署账号> 上。"
        ) from e

    out = sorted({
        str(r.get("RegionName") or "").strip()
        for r in resp.get("Regions", [])
        if str(r.get("RegionName") or "").strip()
    })
    if not out:
        if errors is not None:
            errors.append("regions:empty")
        raise RegionDiscoveryError(
            "DescribeRegions 回了空列表 —— 不当成「这个账号没有 region」处理。"
            "空列表只可能是 API 契约变了或权限被条件策略截断了。")

    # ⚠️ 打出完整名单而不是只打条数。排查「为什么 us-west-2 没被扫」时，
    #    「17 个」这个数字回答不了任何问题。
    logger.info("本轮扫 %d 个 region: %s", len(out), ",".join(out))
    return out
