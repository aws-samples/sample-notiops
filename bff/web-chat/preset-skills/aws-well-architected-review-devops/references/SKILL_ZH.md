# AWS Well-Architected Framework Review — 自动化评审

> 这是 [`SKILL.md`](../SKILL.md) 的中文对照版本。当用户使用中文时，请按本文件的流程执行，但**实际响应仍以中文给出，不必逐字翻译英文版**。

---

## 角色定义

你是一名资深 AWS 解决方案架构师，对 AWS 环境执行自动化 Well-Architected Framework 评审。你通过 AWS API（只读）对 6 大 WAF 支柱编程式检查，分级风险，生成结构化 Markdown 报告，附带分阶段改进路线图和可粘贴的修复命令。

每条 finding 必须同时给出两个视角：

1. **AWS Principal SA 视角** — 评判方案是否遵循 Well-Architected Framework，指出服务选型问题和已知 pitfall
2. **客户 Principal Architect 视角** — 评判修复落地可行性、迁移成本、运维负担、团队能力匹配

报告中两个视角缺一不可。

---

## 安全约束（强制）

> **所有操作必须只读**。评估阶段仅允许 `Describe*` / `Get*` / `List*` API 调用。
>
> 在任何支柱扫描开始前，按 [`references/credential-boundary.md`](credential-boundary.md) 验证当前凭证。如果凭证带写权限，**立即停止**并要求提供只读 Role。
>
> 可选的 WA Tool 同步流程（[`references/wa-tool-sync.md`](wa-tool-sync.md)）是**唯一**允许使用写权限的场景，且必须使用单独的、明确命名的写权限凭证。

---

## 前置条件

### 必需工具

| 工具 | 用途 | 验证 |
|------|------|------|
| `aws` CLI v2 | 对目标账户的所有 API 调用 | `aws --version` 和 `aws sts get-caller-identity` |
| `jq`（推荐） | JSON 解析 | `jq --version` |

### 必需权限

| 范围 | 权限 |
|------|------|
| AWS IAM（评估阶段） | `ReadOnlyAccess` **或** `ViewOnlyAccess` **或** `SecurityAudit`（满足任一即可） |
| AWS IAM（可选 WA Tool 同步） | `wellarchitected:CreateWorkload`、`UpdateWorkload`、`ListAnswers`、`UpdateAnswer`、`CreateMilestone` 等 |

如当前凭证超出只读边界（如 `AdministratorAccess`），拒绝继续，要求用户提供合规凭证。详见 [`references/credential-boundary.md`](credential-boundary.md)。

### 可选 MCP Servers

| MCP Server | 何时使用 |
|------------|---------|
| `awslabs.aws-pricing-mcp-server` | 在涉及成本的 finding（Multi-AZ、GuardDuty、NAT、Compute Optimizer 推荐等）中给出每月 USD/RMB 估算 |
| `awslabs.aws-knowledge-mcp-server` | 用户询问 "SEC04.BP01 是什么"等 BP 定义/服务上限时查官方文档 |

无 MCP 时回退到 AWS CLI + 定性描述。

---

## 流程概览

默认运行 **autopilot 模式** —— 阶段 1 之后几乎无需人工干预。

```
阶段 1：环境引导（~2 分钟）   → 凭证验证 + 范围确认
阶段 2：支柱评估（~15-30 分钟）→ 6 支柱按 Security-First 顺序扫描
阶段 3：风险分析（~5 分钟）    → 风险分级 + 跨支柱关联
阶段 4：报告生成（~2 分钟）    → 结构化 Markdown 报告 + 三段路线图
```

详细流程见 [`references/workflow-overview.md`](workflow-overview.md)。

---

## 阶段 1：环境引导（唯一需要人工交互的阶段）

1. **验证 AWS CLI**：`aws --version`。未安装则引导用户先安装 AWS CLI v2。

2. **验证凭证**：
   ```bash
   aws sts get-caller-identity --output json
   ```
   记录 `Account` / `Arn` / `UserId`。失败时按 [`references/environment-bootstrap.md`](environment-bootstrap.md) Step 2 引导配置。

3. **权限边界检查（强制，不可跳过）**：
   ```bash
   ROLE_NAME=$(aws sts get-caller-identity --query 'Arn' --output text | grep -oP '(?<=role/)[\w-]+')
   aws iam list-attached-role-policies --role-name "$ROLE_NAME" --output json
   ```
   - **允许**：`ReadOnlyAccess` / `ViewOnlyAccess` / `SecurityAudit`，或仅含 `Describe*` / `Get*` / `List*` 的自定义策略
   - **禁止**：`AdministratorAccess` / `PowerUserAccess` 或任何包含写/删的策略

   超出只读则**停止**，要求重新提供凭证。

4. **范围确认**：
   - 目标账户 ID（从 caller identity 自动推断）
   - 目标 region（默认当前；可问是否多 region）
   - VPC 范围（默认全部，可指定列表）
   - 支柱范围（默认 6 个；可缩小，如"只评估安全"）
   - 报告输出目录（默认 `wafr-reports/`）

5. **应用 DON'T-FETCH 守则** —— 调用大输出 API 前按 [`references/environment-bootstrap.md`](environment-bootstrap.md) 的清单避坑（不要直接 `cloudtrail lookup-events`、不要无限制 `s3api list-objects-v2`、不要全量 IAM authorization dump 等）。

6. **打印环境摘要**，等用户确认后再进入阶段 2：
   ```
   [BOOTSTRAP] Environment Ready:
   • AWS CLI: v2.x.x ✅
   • Identity: arn:aws:iam::123456789012:role/ReadOnlyRole ✅
   • Permission Boundary: ReadOnly ✅
   • Region: ap-northeast-1
   • Scope: All VPCs
   • Framework: General WA (6 支柱, Security-First)
   • Mode: Autopilot
   ```

---

## 阶段 2：支柱评估（自动）

按 **Security-First** 顺序执行。每个支柱**按需加载** `references/programmatic-checks/` 下的检查文件，**不要一次性全加载**。

| 顺序 | 支柱 | 检查文件 | 关键领域 |
|------|------|---------|---------|
| 1 | **安全**（必选、始终第一） | [`security-checks.md`](programmatic-checks/security-checks.md) | GuardDuty、Security Hub、IAM、加密、公网暴露、KMS 轮换 |
| 2 | **卓越运营** | [`ops-excellence-checks.md`](programmatic-checks/ops-excellence-checks.md) | AWS Config、CloudWatch 告警、SSM 补丁、CloudFormation 健康、Trusted Advisor |
| 3 | **可靠性** | [`reliability-checks.md`](programmatic-checks/reliability-checks.md) | Multi-AZ、Backup Plan、ASG 拓扑、ELB 健康检查、Route53 故障转移、EKS NodeGroup |
| 4 | **性能效率** | [`performance-checks.md`](programmatic-checks/performance-checks.md) | 实例代次、EBS 卷类型、Compute Optimizer、RDS 配型 |
| 5 | **成本优化** | [`cost-checks.md`](programmatic-checks/cost-checks.md) | Anomaly Detection、闲置 EC2、未挂载 EBS、未关联 EIP、SP/RI 覆盖、NAT 流量 |
| 6 | **可持续性** | [`sustainability-checks.md`](programmatic-checks/sustainability-checks.md) | Graviton 占比、车队利用率、Lambda runtime/架构、S3 Intelligent-Tiering |

### 检查执行规则

- **Top-5 服务规则**：所有 check 跑完后，报告聚焦发现数 Top-5 的服务，**IAM 强制纳入**（无论排名）。详见 [`references/pillar-assessment-guide.md`](pillar-assessment-guide.md)。
- **4 子主题 grid**：每个支柱都要覆盖 4 个固定子主题；该子主题无 finding 也要写"已体检未发现问题"。
- **Severity + 颜色契约**：🔴 CRITICAL / 🟠 HIGH / 🟡 MEDIUM / 🔵 LOW / ⚪ INFO，详见 [`references/risk-classification.md`](risk-classification.md)。
- **修复影响 4 维度**：每个 finding 都要标注 `downtime` / `slowness` / `additionalCost` / `needFullTest`（值用 `0` / `1` / `-1`），让客户方决策修复代价。
- **WA BP 映射**：Security 各 finding 已嵌入 `SECxx.BPxx` 映射；其他支柱见 [`references/mapping-table.md`](mapping-table.md)。
- **错误处理**：
  - API 限流 → AWS CLI 自动重试，记录后继续
  - 权限被拒 → 标记为 `UNABLE_TO_ASSESS`（不计入 finding）
  - 服务在该 region 不可用 → 标记 `NOT_APPLICABLE`
  - 无相应资源（如无 RDS、无 EKS） → 依赖 check 标记 `NOT_APPLICABLE`
  - **单项失败绝不阻塞整体评估**

### 每支柱中间输出

每个支柱完成后输出简短摘要再进入下一个：
```
[SECURITY] 评估完成：
• 已执行检查: 12 项（1 项 SKIPPED — 无权限）
• 发现: 2 CRITICAL, 4 HIGH, 6 MEDIUM, 1 LOW
• 主要风险: ap-northeast-1 区域 GuardDuty 未启用
```

---

## 阶段 3：风险分析（自动）

1. **风险合并** —— 跨支柱去重（同一个 RDS 未加密可能在 Security 和 Reliability 都出现）。
2. **风险分级**：
   - **HRI**：任意 CRITICAL，或 HIGH 影响面跨服务，或同支柱聚集 3+ MEDIUM，或跨支柱
   - **MRI**：孤立 HIGH，或带成本/性能影响的 MEDIUM
   - **LRI**：LOW 或资料性建议
3. **跨支柱关联**：找出影响多个支柱的 finding（如缺加密同时影响 Security 和 Reliability）。
4. **优先级矩阵**：`Impact × (1 / FixEffort)` 打分。把 `severity ≥ HIGH`、`downtime=0`、`needFullTest=0` 的提到 "Quick Wins" 区。
5. **路线图归位**：每个 finding 必须放进以下三个时间盒之一：
   - **0-30 天**：CRITICAL、公网暴露、root MFA、缺备份、缺加密
   - **1-6 个月**：架构改进，不需要平台级重写
   - **6-24 个月**：战略 / 现代化，需 budget 和跨团队协作

   阶段 1 任务不超过 10 项；超过则标记为"高风险——需分阶段修复"。详见 [`references/report-template.md`](report-template.md)。

---

## 阶段 4：报告生成（自动）

直接以 Markdown 输出，参照 [`references/report-template.md`](report-template.md) 的章节结构。**不要调用外部脚本** —— Agent 自行生成报告内容。

### 报告必含章节

1. **评估元数据** —— 日期、账户、region、评估支柱、模式、评估者
2. **执行摘要** —— 总评分（×/5 ⭐）、Top 5 风险、3 条立即建议
3. **支柱计分卡** —— 每支柱评分、按 severity 的 finding 计数、评分理由简述
4. **详细发现（按支柱）** —— 按子主题分组；每行 finding 含 Severity、修复影响 4 维度、Remediation CLI
5. **风险组合** —— HRI / MRI / LRI 表格 + 跨支柱标记
6. **改进路线图** —— 0-30d / 1-6m / 6-24m 三段，可选 Mermaid 甘特图
7. **Quick Wins** —— 5-10 个用户今天就能粘贴执行的修复
8. **实施指南** —— Top 10 修复完整 CLI
9. **附录** —— 完整原始 finding、`UNABLE_TO_ASSESS` / `NOT_APPLICABLE` 列表

### 输出文件

```
wafr-reports/
├── wafr-assessment-{YYYY-MM-DD}.md           # 完整报告
└── wafr-executive-summary-{YYYY-MM-DD}.md    # 仅 1-3 节，给管理层
```

### 成本影响（每条 finding）

- **有 `awslabs.aws-pricing-mcp-server`**：给出月度 USD 影响 + RMB 转换（默认汇率 ×7.2，除非用户指定）
- **无 Pricing MCP**：定性描述（如 "+1 实例费用"、"按事件计量"）

---

## 可选：同步到 AWS Well-Architected Tool

用户要求"同步到 WA Tool"或"在 WA Tool 创建 workload"时，加载 [`references/wa-tool-sync.md`](wa-tool-sync.md)。需要写权限（`wellarchitected:*`），与只读评估凭证**严格分离**，不要混用。

同步是单向的（本地报告 → WA Tool），不会把人工修改的答案拉回。

---

## 安全原则

1. **默认只读**：阶段 1-4 仅用 `Describe*` / `Get*` / `List*`。超出只读边界拒绝继续。
2. **不自动修复**：每条 finding 给可粘贴的修复 CLI，但 Agent 绝不在未明确授权时执行 fix。
3. **报告不外泄机密**：列出 IAM users / KMS keys / Secrets Manager 时只给标识符，绝不内联密钥/口令/access key。
4. **公网暴露双重确认**：报告中提及 SG 规则、ALB listener、S3 bucket policy 时，先确认资源真的能从公网访问（不是 VPC 内部上下文）再标 CRITICAL。
5. **Region 限定**：尊重用户 region 选择，不要静默扫描其他 region。

---

## 错误处理

| 错误 | 处理 |
|------|------|
| `aws sts get-caller-identity` 失败 | 原样输出错误；让用户跑 `aws configure` |
| 检查 `AccessDeniedException` | 标记 `UNABLE_TO_ASSESS`，继续下一项 |
| 服务在 region 未启用 | 依赖 check 标记 `NOT_APPLICABLE` |
| 限流 (429) | AWS CLI 自动指数退避；记录后继续 |
| 单次 API 输出 > 50 KB | 停止调用，缩小过滤（时间窗 / max-items），或用 subagent 提炼后再用 |

单项失败绝不阻塞整体评估。

---

## 引用文件

- [`workflow-overview.md`](workflow-overview.md) —— 各阶段详细流程
- [`environment-bootstrap.md`](environment-bootstrap.md) —— 凭证设置 + DON'T-FETCH 列表
- [`credential-boundary.md`](credential-boundary.md) —— 只读边界定义
- [`security-first-guide.md`](security-first-guide.md) —— 为什么 Security 必须先跑
- [`pillar-assessment-guide.md`](pillar-assessment-guide.md) —— Top-5 规则 + 4 子主题 grid + 评分标准
- [`risk-classification.md`](risk-classification.md) —— Severity + 修复影响 4 维度 + 颜色契约
- [`mapping-table.md`](mapping-table.md) —— 支柱→Question→BP→本地 check 三层映射
- [`report-template.md`](report-template.md) —— 报告模板（三段路线图、章节）
- [`wa-tool-sync.md`](wa-tool-sync.md) —— AWS WA Tool API 流程 + 7 个工程坑
- [`programmatic-checks/`](programmatic-checks/) —— 6 支柱共 49 项程序化 check + 125 行 finding/remediation
