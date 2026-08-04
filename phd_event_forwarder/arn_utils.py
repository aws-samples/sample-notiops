"""ARN 解析工具函数。"""


def extract_region_from_sns_arn(arn: str) -> str | None:
    """从 SNS Topic ARN 中提取 Region。

    ARN 格式: arn:aws:sns:{region}:{account}:{topic}
    返回第 4 段（0-indexed 第 3 段）。

    无效 ARN 返回 None。
    """
    if not arn or not isinstance(arn, str):
        return None
    parts = arn.split(":")
    if len(parts) < 6:
        return None
    if parts[0] != "arn" or parts[2] != "sns":
        return None
    region = parts[3]
    if not region:
        return None
    return region
