"""
Lambda3-HealthChecker 报告解析模块。
从 Bedrock 返回的 Markdown 报告中提取摘要数据，以及合并多份分批报告。
"""

import logging
import re

logger = logging.getLogger(__name__)


def parse_report_summary(report_content: str) -> dict:
    """从 Markdown 报告中解析执行摘要部分。

    提取 total_instances、critical_count、warning_count、attention_count。
    支持多种格式模式：
      - "Critical: N", "Warning: N", "Attention: N", "Total: N"
      - "🔴 Critical: N", "🟡 Warning: N" 等 emoji 前缀
      - "N 个严重问题", "N 个警告", "N 个关注" 中文模式
      - "高风险...| N", "需关注...| N", "正常...| N" Markdown 表格模式
      - "高风险: N", "需关注: N", "正常: N" 中文冒号模式
      - "Total Instances: N", "总实例数: N"

    Returns:
        {"total_instances": int, "critical_count": int,
         "warning_count": int, "attention_count": int}
    """
    result = {
        "total_instances": 0,
        "critical_count": 0,
        "warning_count": 0,
        "attention_count": 0,
    }

    if not report_content:
        logger.warning("Empty report content, returning zero counts")
        return result

    try:
        # --- total_instances ---
        total_patterns = [
            r'[Tt]otal\s*(?:[Ii]nstances)?\s*[:：]\s*(\d+)',
            r'总实例数\s*[:：]\s*(\d+)',
            r'(\d+)\s*个?\s*(?:实例|instances)',
            r'[Tt]otal\s*[:：]\s*(\d+)',
        ]
        for pattern in total_patterns:
            m = re.search(pattern, report_content)
            if m:
                result["total_instances"] = int(m.group(1))
                break

        # --- critical_count ---
        # Matches: "Critical: N", "🔴 Critical: N", "高风险: N", "🔥 高风险...| N",
        #          "N 个严重问题", "严重: N"
        critical_patterns = [
            r'🔴\s*[Cc]ritical\s*[:：]\s*(\d+)',
            r'[Cc]ritical\s*[:：]\s*(\d+)',
            r'🔥\s*高风险[^|]*\|\s*(\d+)',
            r'高风险[^|]*\|\s*(\d+)',
            r'高风险\s*[:：]\s*(\d+)',
            r'(\d+)\s*个?\s*严重(?:问题)?',
            r'严重\s*[:：]\s*(\d+)',
        ]
        for pattern in critical_patterns:
            m = re.search(pattern, report_content)
            if m:
                result["critical_count"] = int(m.group(1))
                break

        # --- warning_count ---
        # Matches: "Warning: N", "🟡 Warning: N", "需关注: N", "⚠️ 需关注...| N",
        #          "N 个警告", "警告: N"
        warning_patterns = [
            r'🟡\s*[Ww]arning\s*[:：]\s*(\d+)',
            r'[Ww]arning\s*[:：]\s*(\d+)',
            r'⚠️\s*需关注[^|]*\|\s*(\d+)',
            r'需关注[^|]*\|\s*(\d+)',
            r'需关注\s*[:：]\s*(\d+)',
            r'(\d+)\s*个?\s*警告',
            r'警告\s*[:：]\s*(\d+)',
        ]
        for pattern in warning_patterns:
            m = re.search(pattern, report_content)
            if m:
                result["warning_count"] = int(m.group(1))
                break

        # --- attention_count ---
        # Matches: "Attention: N", "🟠 Attention: N", "正常: N", "✅ 正常...| N",
        #          "N 个关注", "关注: N"
        attention_patterns = [
            r'🟠\s*[Aa]ttention\s*[:：]\s*(\d+)',
            r'[Aa]ttention\s*[:：]\s*(\d+)',
            r'✅\s*正常[^|]*\|\s*(\d+)',
            r'正常[^|]*\|\s*(\d+)',
            r'正常\s*[:：]\s*(\d+)',
            r'(\d+)\s*个?\s*关注',
            r'关注\s*[:：]\s*(\d+)',
        ]
        for pattern in attention_patterns:
            m = re.search(pattern, report_content)
            if m:
                result["attention_count"] = int(m.group(1))
                break

    except Exception:
        logger.warning("Failed to parse report summary, returning zero counts", exc_info=True)
        return {
            "total_instances": 0,
            "critical_count": 0,
            "warning_count": 0,
            "attention_count": 0,
        }

    return result


def merge_reports(
    reports: list[str],
    title: str = "RDS AI 智能巡检综合报告",
) -> str:
    """合并多份分批报告为一份完整报告。

    在顶部添加综合报告标题，每个批次报告添加编号标题。

    Args:
        reports: 各批次的 Markdown 报告内容列表。
        title: 综合报告标题，默认 "RDS AI 智能巡检综合报告" 保持向后兼容。

    Returns:
        合并后的完整 Markdown 报告。
    """
    if not reports:
        return ""

    if len(reports) == 1:
        return reports[0]

    sections: list[str] = [f"# {title}\n"]
    for i, report in enumerate(reports, start=1):
        sections.append(f"## 账户批次 {i}\n")
        sections.append(report)

    return "\n".join(sections)
