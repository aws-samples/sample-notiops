"""
阈值配置模块。
从 DynamoDB 加载按资源类型分开的阈值配置。
每种资源类型有独立的阈值参数（Map 存储），方便后续扩展 EC2、ELB 等。
"""

import logging
from dataclasses import dataclass, field

from shared.queries.threshold import get_thresholds, list_thresholds

logger = logging.getLogger(__name__)


@dataclass
class ThresholdConfig:
    """某种资源类型的阈值配置。"""
    config_id: int
    resource_type: str                          # 'rds' | 'elasticache' | ...
    thresholds: dict[str, float] = field(default_factory=dict)
    description: str = ""

    # 便捷访问方法 —— 带默认值兜底
    @property
    def candidate_cpu(self) -> float:
        return float(self.thresholds.get("candidate_cpu", 2.0))

    @property
    def candidate_connections(self) -> int:
        return int(self.thresholds.get("candidate_connections", 5))

    @property
    def peak_cpu_veto(self) -> float:
        return float(self.thresholds.get("peak_cpu_veto", 50.0))

    @property
    def iops(self) -> int:
        return int(self.thresholds.get("iops", 500))

    @property
    def evictions(self) -> int:
        return int(self.thresholds.get("evictions", 0))

    # 路径 A 新增阈值
    @property
    def write_iops(self) -> int:
        return int(self.thresholds.get("write_iops", 1000))

    @property
    def requests_sum(self) -> int:
        return int(self.thresholds.get("requests_sum", 1000))

    @property
    def conn_max(self) -> int:
        return int(self.thresholds.get("conn_max", 10))

    # 路径 B 容量审计阈值
    @property
    def free_storage_pct(self) -> float:
        return float(self.thresholds.get("free_storage_pct", 0.40))

    @property
    def cpu_max_veto(self) -> float:
        return float(self.thresholds.get("cpu_max_veto", 50.0))

    @property
    def swap_max_gb(self) -> float:
        return float(self.thresholds.get("swap_max_gb", 0.01))

    @property
    def memory_util_max(self) -> float:
        return float(self.thresholds.get("memory_util_max", 30.0))


# 硬编码兜底默认值
_FALLBACK_DEFAULTS: dict[str, ThresholdConfig] = {
    "rds": ThresholdConfig(
        config_id=0,
        resource_type="rds",
        thresholds={"candidate_cpu": 2.0, "candidate_connections": 5, "peak_cpu_veto": 50.0, "iops": 500, "write_iops": 1000, "free_storage_pct": 0.40, "cpu_max_veto": 50},
    ),
    "elasticache": ThresholdConfig(
        config_id=0,
        resource_type="elasticache",
        thresholds={"candidate_cpu": 2.0, "candidate_connections": 5, "peak_cpu_veto": 50.0, "evictions": 0, "requests_sum": 1000, "swap_max_gb": 0.01, "memory_util_max": 30, "conn_max": 10},
    ),
}


def load_threshold_configs() -> dict[str, ThresholdConfig]:
    """
    从 DynamoDB config 表加载所有资源类型的阈值配置。
    返回 {resource_type: ThresholdConfig} 映射。
    """
    items = list_thresholds()
    configs: dict[str, ThresholdConfig] = {}
    for item in items:
        # PK format: "threshold#<rt>"
        pk = item.get("PK", "")
        rt = pk.replace("threshold#", "") if pk.startswith("threshold#") else item.get("resource_type", "")
        thresholds = item.get("thresholds", {})
        # DynamoDB Map returns as dict; convert Decimal values to float
        converted_thresholds = {k: float(v) for k, v in thresholds.items()}
        configs[rt] = ThresholdConfig(
            config_id=0,
            resource_type=rt,
            thresholds=converted_thresholds,
            description=item.get("description", ""),
        )
    logger.info("Loaded threshold configs for %d resource types: %s", len(configs), list(configs.keys()))
    return configs


def get_threshold_for_resource_type(
    resource_type: str,
    configs: dict[str, ThresholdConfig],
) -> ThresholdConfig:
    """
    获取指定资源类型的阈值配置。
    如果数据库中没有该类型的配置，使用硬编码兜底默认值。
    """
    if resource_type in configs:
        return configs[resource_type]

    if resource_type in _FALLBACK_DEFAULTS:
        logger.warning("No DB config for %s, using fallback defaults", resource_type)
        return _FALLBACK_DEFAULTS[resource_type]

    # 完全未知的资源类型，返回一个通用默认
    logger.warning("Unknown resource_type %s, using generic fallback", resource_type)
    return ThresholdConfig(
        config_id=0,
        resource_type=resource_type,
        thresholds={"candidate_cpu": 5.0, "candidate_connections": 5, "peak_cpu_veto": 50.0},
    )
