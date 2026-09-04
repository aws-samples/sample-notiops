"""IM ingress 的**保活探测**识别 —— 飞书 / Slack 共用一份。

── 为什么需要保活 ───────────────────────────────────────────────────────────
两个 ingress 函数的冷启动是 **十几秒**（`import lark_oapi` / `slack_sdk` + boto3 +
一次 GetSecretValue）。构建期预编译字节码（见 `scripts/build_im_layer.sh` 的
「预编译字节码」那段 + `infra/lib/constructs/im-core.ts` 里 ingress 那段长注释）省掉了
"每次冷启动重编译整个只读层"这一段，但 **2026-09-03 现网实测：init 仍然撞 Lambda 那条
10s INIT 硬上限**（`Init Duration: 9999.31 ms / Status: timeout`，随后被挪进首发 invoke
重跑 `Duration: 12555.00 ms`，端到端 ~22.5s）。当初写在这里的 2.9~5.4s 是构建期估算，
**现网没有证实**；剩下的大头是 `import lark_oapi` 自己（9128 个模块的 unmarshal + exec，
预编译只省掉其中"编译"那一段）。所以冷启动**远远盖不住 3s** —— IM 平台对 webhook 的
超时是 **~3s 硬上限**：

  · 飞书「事件与回调 → 事件配置」保存请求地址时的 URL challenge；
  · 飞书 `card.action.trigger`（用户点卡片按钮）；
  · Slack Events API / Interactivity。

也就是说：**只要容器冻结过，用户下一次操作大概率超时**。2026-09-02 现网实测到的形态 ——
第一次点「保存」飞书报「请求 3 秒超时」（`Init Duration: 8441.81 ms`），立刻再点一次
就成功（`Duration: 2.34 ms`）。卡片按钮走的是同一条路，只是没有"再点一次"这个自然
补救动作，用户看到的是「操作失败」。所以预编译之后这条保活规则**依旧是主要防线**，
不是"以前需要现在不需要"。

所以 `im-core.ts` 给每个 ingress 挂一条 EventBridge `rate(4 minutes)` 规则，常量
input 就是 `{"notiops_warmup": true}`。四分钟是"比 Lambda 回收空闲容器更勤"的经验值。

── 诚实的边界 ───────────────────────────────────────────────────────────────
保活只保住 **1 个** 执行环境。真并发（多个群同时来事件、或调查进度卡片批量刷新）
仍然会扩容出冷容器，那些请求照旧可能超时。这条规则解决的是**绝大多数**场景
（单人操作、低频事件），不是数学上的消除。要彻底消除只有 provisioned concurrency
（2048MB 常驻 ≈ $21/月），不适合作为开源默认值 —— 见 docs/IM_WEBHOOK_SETUP.md。

── 为什么判「顶层键」而不是 body ────────────────────────────────────────────
⚠️ 这是本模块唯一的安全要点。EventBridge 直接 invoke Lambda，常量 input **就是**
整个 `event`；而公网请求经 API Gateway payload 2.0 进来时，攻击者能控制的只有
`event["body"]`（一个**字符串**）以及 header —— 顶层键是 API Gateway 自己写的
（`version` / `rawPath` / `requestContext` / …）。所以只认顶层 `notiops_warmup`，
并且额外要求这个事件**不长得像 HTTP 事件**：两条合起来意味着公网无法构造出
能命中这条早返回的请求。

绝不能改成"看 body 里有没有这个键" —— 那就等于开了一个免验签的公开端点，
虽然它只是 return，但它会成为一条**绕过验签的既有分支**，下一个人往里加东西时
不会注意到这件事。
"""
from __future__ import annotations

# EventBridge 常量 input 里的哨兵键。改名要同时改 `im-core.ts` 里两条规则的
# `events.RuleTargetInput.fromObject({...})` —— 那是这个字符串的唯一另一处。
_SENTINEL = "notiops_warmup"

# API Gateway（payload 2.0）/ Function URL 事件必有的顶层键。命中任意一个就说明
# 这是**公网请求**，不是 EventBridge 的保活跳动。
_HTTP_EVENT_KEYS = ("requestContext", "rawPath", "routeKey", "version", "headers")


def is_warmup(event: object) -> bool:
    """True 当且仅当这是我们自己的 EventBridge 保活探测。

    永不抛异常（ingress 的第一行就调它，抛了就等于把冷启动问题换成 500）。
    """
    if not isinstance(event, dict):
        return False
    if event.get(_SENTINEL) is not True:
        return False
    # 顶层带 HTTP 事件特征 → 不是保活。见文件头「为什么判顶层键」。
    return not any(k in event for k in _HTTP_EVENT_KEYS)


def response() -> dict:
    """保活的返回值。EventBridge 不看返回值，给一个明确的形状便于在日志/测试里辨认。"""
    return {"statusCode": 200, "body": "warm"}
