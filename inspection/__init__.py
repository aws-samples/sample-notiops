"""资源巡检（inspection）—— 高负载 / 低利用率 / 结构性风险。

分层约定（spec R14.1）：

    domain/      纯函数，零 IO、零 boto3、零 mock 可测
    adapters/    与外界打交道（DDB / CloudWatch / 本地数据文件）
    （repository 与 handler 在 Phase 4 / Phase 5 加入）

v1 范围 = R2.1 高负载阈值 + R2.2 低利用率 + R2.4 结构性风险 + R2.6 慢性高位。
趋势判定不在 v1（留到 v1.1）。
"""
