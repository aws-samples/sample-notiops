#!/usr/bin/env python3
"""
IAM 权限一致性检查（CDK synth 后自动运行）。

从 CloudFormation 模板中提取所有 IAM Role 的权限关系，交叉验证：
1. AssumeRole Policy ↔ Trust Policy 双向一致性
2. Agent 容器禁止直连数据库
3. AgentCore Runtime Role 关键权限完整性
4. SQL 表名/字段名一致性（从 schema-init 自动提取）

用法：
  cd infra && npx cdk synth --quiet && python scripts/check-iam-consistency.py
  cd infra && python scripts/check-iam-consistency.py --check 2   # 只跑检查 2
  cd infra && python scripts/check-iam-consistency.py --json       # JSON 输出（CI 友好）

环境变量：
  IAM_CHECK_TEMPLATE  覆盖模板路径（默认 cdk.out/NotiOpsBackendStack.template.json）
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path


# ============================================================
# UI 语言（双语输出）
# 继承 setup.sh 导出的 UI_LANG（zh/en）；单独跑时默认英文，面向全球客户。
# L("<中文>", "<English>") 按 UI_LANG 返回对应语言（仅影响提示文案，数据/逻辑不变）。
# ============================================================
_ZH = os.environ.get("UI_LANG", "en") == "zh"


def L(zh: str, en: str) -> str:
    return zh if _ZH else en


# ============================================================
# 结果收集器
# ============================================================
@dataclass
class CheckResult:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    passes: list[str] = field(default_factory=list)

    @property
    def error_count(self) -> int:
        return len(self.errors)

    def ok(self, msg: str) -> None:
        self.passes.append(msg)

    def err(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)


def red(msg: str) -> None:
    print(f"\033[31m{msg}\033[0m")


def green(msg: str) -> None:
    print(f"\033[32m{msg}\033[0m")


def yellow(msg: str) -> None:
    print(f"\033[33m{msg}\033[0m")


def print_result(result: CheckResult) -> None:
    for msg in result.passes:
        green(f"  ✅ {msg}")
    for msg in result.warnings:
        yellow(f"  ⚠️  {msg}")
    for msg in result.errors:
        red(f"  ❌ {msg}")


# ============================================================
# 模板加载与解析工具
# ============================================================
def get_template_path() -> str:
    return os.environ.get(
        "IAM_CHECK_TEMPLATE", "cdk.out/NotiOpsBackendStack.template.json"
    )


def load_template(path: str) -> dict:
    if not os.path.exists(path):
        red(L(f"❌ 模板文件不存在: {path}", f"❌ Template file not found: {path}"))
        red(L("   请先运行: npx cdk synth --quiet", "   Run first: npx cdk synth --quiet"))
        sys.exit(1)
    with open(path) as f:
        return json.load(f)


def get_roles(template: dict) -> dict[str, dict]:
    return {
        k: v["Properties"]
        for k, v in template.get("Resources", {}).items()
        if v.get("Type") == "AWS::IAM::Role"
    }


def get_policies(template: dict) -> dict[str, dict]:
    return {
        k: v["Properties"]
        for k, v in template.get("Resources", {}).items()
        if v.get("Type") == "AWS::IAM::Policy"
    }


def role_display_name(props: dict, logical_id: str) -> str:
    return props.get("RoleName", f"(auto:{logical_id[:30]})")


def collect_policy_statements(role_id: str, role_props: dict, policies: dict) -> list:
    """收集一个 Role 的所有 Policy Statement（inline + 独立 Policy 资源）。"""
    stmts = []
    for pol in role_props.get("Policies", []):
        stmts.extend(pol.get("PolicyDocument", {}).get("Statement", []))
    for _pid, pprops in policies.items():
        for rr in pprops.get("Roles", []):
            if isinstance(rr, dict) and rr.get("Ref") == role_id:
                stmts.extend(pprops.get("PolicyDocument", {}).get("Statement", []))
                break
    return stmts


def collect_all_actions(stmts: list) -> set[str]:
    actions = set()
    for stmt in stmts:
        a = stmt.get("Action", [])
        if isinstance(a, str):
            a = [a]
        actions.update(a)
    return actions


def extract_assume_target_role_names(stmts: list) -> list[str]:
    """从 sts:AssumeRole Statement 中提取目标 Role 名称（字符串 ARN 中的）。"""
    names = []
    for stmt in stmts:
        actions = stmt.get("Action", [])
        if isinstance(actions, str):
            actions = [actions]
        if "sts:AssumeRole" not in actions:
            continue
        resources = stmt.get("Resource", [])
        if isinstance(resources, (str, dict)):
            resources = [resources]
        for r in resources:
            if isinstance(r, str):
                m = re.search(r":role/(.+)$", r)
                if m:
                    names.append(m.group(1))
    return names


def extract_trust_refs(trust_doc: dict) -> set[str]:
    """从 AssumeRolePolicyDocument 中提取所有被信任的 Role 逻辑 ID。

    支持 Ref、Fn::GetAtt、Fn::Join、Fn::Sub。
    """
    refs: set[str] = set()
    for stmt in trust_doc.get("Statement", []):
        principal = stmt.get("Principal", {})
        aws_principals = principal.get("AWS", [])
        if isinstance(aws_principals, (str, dict)):
            aws_principals = [aws_principals]
        for p in aws_principals:
            _extract_refs_recursive(p, refs)
    return refs


def _extract_refs_recursive(obj: object, refs: set[str]) -> None:
    if isinstance(obj, dict):
        if "Fn::GetAtt" in obj:
            refs.add(obj["Fn::GetAtt"][0])
        elif "Ref" in obj:
            refs.add(obj["Ref"])
        elif "Fn::Join" in obj:
            for part in obj["Fn::Join"][1]:
                _extract_refs_recursive(part, refs)
        elif "Fn::Sub" in obj:
            # Fn::Sub 格式: ["arn:...${Resource.Arn}...", {"Resource": ...}]
            # 或纯字符串: "arn:...${Resource.Arn}..."
            sub_val = obj["Fn::Sub"]
            template_str = sub_val[0] if isinstance(sub_val, list) else sub_val
            if isinstance(template_str, str):
                # 提取 ${LogicalId.Arn} 或 ${LogicalId} 引用
                for m in re.finditer(r"\$\{(\w+?)(?:\.\w+)?\}", template_str):
                    refs.add(m.group(1))
            # 如果有第二个参数（变量映射），递归解析
            if isinstance(sub_val, list) and len(sub_val) > 1:
                for v in sub_val[1].values():
                    _extract_refs_recursive(v, refs)
        else:
            for v in obj.values():
                _extract_refs_recursive(v, refs)
    elif isinstance(obj, list):
        for item in obj:
            _extract_refs_recursive(item, refs)


# ============================================================
# 检查 1: AssumeRole Policy ↔ Trust Policy 一致性
# ============================================================
def check_assume_role_consistency(template: dict) -> CheckResult:
    r = CheckResult()
    roles = get_roles(template)
    policies = get_policies(template)

    name_to_id = {
        rprops.get("RoleName"): rid
        for rid, rprops in roles.items()
        if rprops.get("RoleName") and isinstance(rprops.get("RoleName"), str)
    }

    for rid, rprops in roles.items():
        rn = role_display_name(rprops, rid)
        stmts = collect_policy_statements(rid, rprops, policies)
        targets = extract_assume_target_role_names(stmts)

        for target_name in targets:
            if "*" in target_name:
                continue
            target_id = name_to_id.get(target_name)
            if not target_id:
                continue

            trust_doc = roles[target_id].get("AssumeRolePolicyDocument", {})
            trusted_refs = extract_trust_refs(trust_doc)

            if rid in trusted_refs:
                r.ok(L(f"{rn} → AssumeRole → {target_name}（Trust Policy 已配置）",
                       f"{rn} → AssumeRole → {target_name} (Trust Policy configured)"))
            else:
                r.err(L(
                    f"权限断裂: {rn} 的 Policy 允许 AssumeRole {target_name}，"
                    f"但 {target_name} 的 Trust Policy 不信任 {rn}。"
                    f"修复: {target_name}.assumeRolePolicy.addStatements(...)",
                    f"Broken permission: {rn}'s policy allows AssumeRole {target_name}, "
                    f"but {target_name}'s Trust Policy does not trust {rn}. "
                    f"Fix: {target_name}.assumeRolePolicy.addStatements(...)"
                ))
    return r


# ============================================================
# 检查 2: Agent 容器禁止直连数据库
# ============================================================
def check_agent_no_direct_db() -> CheckResult:
    r = CheckResult()
    agent_dir = Path("..") / "agent"
    if not agent_dir.exists():
        r.warn(L("agent/ 目录不存在，跳过", "agent/ directory not found, skipping"))
        return r

    # 精确匹配 from shared.db — 不误报 from shared.config 等
    db_patterns = [
        re.compile(r"from\s+shared\.db\b"),
        re.compile(r"import\s+shared\.db\b"),
        re.compile(r"from\s+shared\s+import\s+db\b"),
    ]
    # 额外检查直接 psycopg / DB 连接
    conn_patterns = [
        re.compile(r"import\s+psycopg"),
        re.compile(r"from\s+psycopg"),
        re.compile(r"""connect\s*\(.*(?:host|dbname|port)"""),
    ]

    found = False
    for py_file in agent_dir.rglob("*.py"):
        if "__pycache__" in str(py_file):
            continue
        with open(py_file) as f:
            for i, line in enumerate(f, 1):
                stripped = line.strip()
                if stripped.startswith("#"):
                    continue
                for pat in db_patterns + conn_patterns:
                    if pat.search(stripped):
                        r.err(f"{py_file}:{i}: {stripped}")
                        found = True
                        break

    if not found:
        r.ok(L("agent/ 目录无直连数据库导入（shared.db / psycopg）",
               "No direct DB imports in agent/ (shared.db / psycopg)"))
    return r


# ============================================================
# 检查 3: AgentCore Runtime Role 关键权限
# ============================================================

# 完整的必需权限清单（对齐 agentcore-stack-extension.ts）
RUNTIME_REQUIRED_ACTIONS = [
    # Bedrock 模型调用
    # bedrock:InvokeModel 同时覆盖 Converse API
    # bedrock:InvokeModelWithResponseStream 同时覆盖 ConverseStream API
    "bedrock:InvokeModel",
    "bedrock:InvokeModelWithResponseStream",
    # AgentCore Memory
    "bedrock-agentcore:CreateEvent",
    "bedrock-agentcore:ListEvents",
    "bedrock-agentcore:GetMemory",
    "bedrock-agentcore:RetrieveMemoryRecords",
    # Workload Identity
    "bedrock-agentcore:GetWorkloadAccessToken",
    # STS 跨账户
    "sts:AssumeRole",
    # Lambda invoke（API 中转）
    "lambda:InvokeFunction",
    # 可观测性
    "cloudwatch:PutMetricData",
    "xray:PutTraceSegments",
    "logs:CreateLogStream",
    "logs:PutLogEvents",
    # ECR
    "ecr:GetAuthorizationToken",
    "ecr:BatchGetImage",
]


def check_runtime_role_permissions(template: dict) -> CheckResult:
    r = CheckResult()
    roles = get_roles(template)
    policies = get_policies(template)

    # 找 AgentCore Runtime Role
    runtime_role_id = None
    for rid, rprops in roles.items():
        trust = rprops.get("AssumeRolePolicyDocument", {})
        for stmt in trust.get("Statement", []):
            svc = stmt.get("Principal", {}).get("Service", "")
            if svc == "bedrock-agentcore.amazonaws.com":
                runtime_role_id = rid
                break
        if runtime_role_id:
            break

    if not runtime_role_id:
        r.warn(L("未找到 AgentCore Runtime Role（可能 skipRuntime=true）",
                 "AgentCore Runtime Role not found (possibly skipRuntime=true)"))
        return r

    stmts = collect_policy_statements(runtime_role_id, roles[runtime_role_id], policies)
    all_actions = collect_all_actions(stmts)

    for action in RUNTIME_REQUIRED_ACTIONS:
        if action in all_actions:
            r.ok(action)
        else:
            r.err(L(f"AgentCore Runtime Role 缺少 {action}",
                    f"AgentCore Runtime Role is missing {action}"))

    # 检查 AssumeRole 目标是否包含 notiops-idle-detection-role
    targets = extract_assume_target_role_names(stmts)
    if any("notiops-idle-detection-role" in t for t in targets):
        r.ok(L("AssumeRole 目标包含 notiops-idle-detection-role",
               "AssumeRole targets include notiops-idle-detection-role"))
    else:
        r.err(L("AssumeRole 目标不包含 notiops-idle-detection-role（cost_explorer_query 将失败）",
                "AssumeRole targets do not include notiops-idle-detection-role (cost_explorer_query will fail)"))

    return r


# ============================================================
# 检查 4: SQL 表名/字段名一致性（从 schema-init 自动提取）
# ============================================================

# 表 → 字段名映射：哪些表用 report_date，哪些用 monitoring_date
# 如果代码查的是 report_date 表却用了 monitoring_date，就是 bug
REPORT_DATE_TABLES = {"waste_report", "rds_health_report", "elasticache_health_report",
                      "optimization_report",
                      "cost_anomaly_result", "cost_anomaly_summary"}
MONITORING_DATE_TABLES = {"rds_monitoring_data", "elasticache_monitoring_data",
                          "ec2_trusted_advisor_data"}

# 表 → 实例字段名：RDS/ElastiCache 用 instance_class，EC2 用 instance_type
INSTANCE_CLASS_TABLES = {"waste_report", "rds_monitoring_data", "elasticache_monitoring_data"}
INSTANCE_TYPE_TABLES = {"ec2_trusted_advisor_data"}


def _extract_sql_strings(py_file: Path) -> list[tuple[int, str]]:
    """从 Python 文件中提取多行字符串中的 SQL 片段（三引号内的内容）。

    返回 [(行号, sql_text), ...]。
    """
    results = []
    content = py_file.read_text()
    # 匹配三引号字符串（含 SQL 关键字的）
    for m in re.finditer(r'"""(.*?)"""|\'\'\'(.*?)\'\'\'', content, re.DOTALL):
        sql = m.group(1) or m.group(2)
        if not sql:
            continue
        # 只关注包含 SQL 关键字的字符串
        sql_upper = sql.upper()
        if not any(kw in sql_upper for kw in ("SELECT", "INSERT", "UPDATE", "DELETE", "FROM")):
            continue
        # 计算起始行号
        start_line = content[:m.start()].count("\n") + 1
        results.append((start_line, sql))
    return results


def _check_sql_field_in_context(
    sql: str, wrong_field: str, correct_field: str, table_set: set[str]
) -> str | None:
    """检查 SQL 中是否在特定表的上下文中使用了错误字段名。

    返回错误描述或 None。
    """
    sql_lower = sql.lower()
    if wrong_field not in sql_lower:
        return None
    # 检查 SQL 是否引用了 table_set 中的表
    for table in table_set:
        if table in sql_lower:
            return L(f"SQL 查询 {table} 时使用了 '{wrong_field}'（应为 '{correct_field}'）",
                     f"SQL query on {table} uses '{wrong_field}' (should be '{correct_field}')")
    return None


def check_sql_consistency() -> CheckResult:
    r = CheckResult()

    # 硬编码的表名拼写错误（无论上下文都是错的）
    always_wrong = [
        ("rds_health_reports", "rds_health_report"),  # 复数 → 单数
        ("elasticache_health_reports", "elasticache_health_report"),  # 复数 → 单数
        ("waste_reports", "waste_report"),
        ("cost_anomaly_results", "cost_anomaly_result"),
        ("cost_anomaly_summarys", "cost_anomaly_summary"),
    ]

    scan_dirs = [
        "../lambda4_notifier", "../api", "../lambda3_health_checker",
        "../lambda5_cost_analyzer", "../agent",
    ]

    # 1. 检查表名拼写错误
    for wrong, correct in always_wrong:
        found = False
        for d in scan_dirs:
            dp = Path(d)
            if not dp.exists():
                continue
            for py_file in dp.rglob("*.py"):
                if "__pycache__" in str(py_file):
                    continue
                for line_no, sql in _extract_sql_strings(py_file):
                    if wrong in sql.lower():
                        r.err(L(f"{py_file}:{line_no}: 表名 '{wrong}' 应为 '{correct}'",
                                f"{py_file}:{line_no}: table name '{wrong}' should be '{correct}'"))
                        found = True
        if not found:
            r.ok(L(f"无错误表名 '{wrong}'", f"No wrong table name '{wrong}'"))

    # 2. 上下文感知的字段名检查
    # 在查 report_date 表时不应出现 monitoring_date
    field_checks = [
        ("monitoring_date", "report_date", REPORT_DATE_TABLES),
        ("instance_type", "instance_class", INSTANCE_CLASS_TABLES),
    ]

    for wrong_field, correct_field, tables in field_checks:
        found = False
        for d in scan_dirs:
            dp = Path(d)
            if not dp.exists():
                continue
            for py_file in dp.rglob("*.py"):
                if "__pycache__" in str(py_file):
                    continue
                for line_no, sql in _extract_sql_strings(py_file):
                    err_msg = _check_sql_field_in_context(sql, wrong_field, correct_field, tables)
                    if err_msg:
                        r.err(f"{py_file}:{line_no}: {err_msg}")
                        found = True
        if not found:
            r.ok(L(f"无上下文错误的 '{wrong_field}'",
                   f"No context-wrong '{wrong_field}'"))

    return r


# ============================================================
# Main
# ============================================================
CHECKS = {
    1: (L("AssumeRole Policy ↔ Trust Policy 一致性",
          "AssumeRole Policy ↔ Trust Policy consistency"), None),  # needs template
    2: (L("Agent 容器禁止直连数据库",
          "Agent container must not connect directly to the DB"), check_agent_no_direct_db),
    3: (L("AgentCore Runtime Role 关键权限",
          "AgentCore Runtime Role critical permissions"), None),  # needs template
    4: (L("SQL 表名/字段名一致性",
          "SQL table/column name consistency"), check_sql_consistency),
}


def main() -> None:
    parser = argparse.ArgumentParser(
        description=L("IAM 权限一致性检查", "IAM permission consistency check"))
    parser.add_argument("--check", type=int,
                        help=L("只运行指定编号的检查（1-4）", "run only the numbered check (1-4)"))
    parser.add_argument("--json", action="store_true",
                        help=L("JSON 输出（CI 友好）", "JSON output (CI-friendly)"))
    args = parser.parse_args()

    template_path = get_template_path()
    print(L("🔍 IAM 权限一致性检查", "🔍 IAM permission consistency check"))
    print(L(f"   模板: {template_path}", f"   Template: {template_path}"))
    print()

    template = load_template(template_path)
    total_errors = 0
    json_output: dict[str, dict] = {}

    checks_to_run = [args.check] if args.check else [1, 2, 3, 4]

    for check_num in checks_to_run:
        if check_num not in CHECKS:
            red(L(f"❌ 未知检查编号: {check_num}", f"❌ Unknown check number: {check_num}"))
            sys.exit(1)

        name, fn = CHECKS[check_num]
        print(L(f"── 检查 {check_num}: {name} ──", f"── Check {check_num}: {name} ──"))

        if check_num == 1:
            result = check_assume_role_consistency(template)
        elif check_num == 3:
            result = check_runtime_role_permissions(template)
        else:
            assert fn is not None
            result = fn()

        if not args.json:
            print_result(result)
        json_output[f"check_{check_num}"] = {
            "name": name,
            "errors": result.errors,
            "warnings": result.warnings,
            "passes": result.passes,
        }
        total_errors += result.error_count
        print()

    if args.json:
        json_output["summary"] = {"total_errors": total_errors}
        print(json.dumps(json_output, ensure_ascii=False, indent=2))
    else:
        print("════════════════════════════════════════")
        if total_errors > 0:
            red(L(f"❌ 发现 {total_errors} 个问题，请修复后再部署",
                  f"❌ Found {total_errors} issue(s); fix before deploying"))
        else:
            green(L("✅ 所有检查通过", "✅ All checks passed"))

    sys.exit(1 if total_errors > 0 else 0)


if __name__ == "__main__":
    main()
