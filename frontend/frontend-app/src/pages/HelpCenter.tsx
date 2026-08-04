/**
 * 帮助中心页面 — 简洁版，突出功能一览、数据流向和白名单机制。
 */
import {
  Box,
  ColumnLayout,
  Container,
  ExpandableSection,
  Header,
  SpaceBetween,
} from "@cloudscape-design/components";

export default function HelpCenter() {
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description="快速了解系统功能与数据流向">
        帮助中心
      </Header>

      {/* ── 功能一览 ── */}
      <Container header={<Header variant="h2">功能一览</Header>}>
        <ColumnLayout columns={3} variant="text-grid">
          <div>
            <Box variant="h3">📊 RDS / ElastiCache 闲置检测</Box>
            <Box variant="p" color="text-body-secondary">
              四阶段流水线自动识别闲置资源，生成闲置报告与月度节省估算。每天 00:00 UTC 自动执行。
            </Box>
          </div>
          <div>
            <Box variant="h3">📦 容量优化分析</Box>
            <Box variant="p" color="text-body-secondary">
              对非闲置资源执行容量审计，识别存储/内存过度配置的实例，按月度成本排序。
            </Box>
          </div>
          <div>
            <Box variant="h3">🖥️ EC2 低利用率检测</Box>
            <Box variant="p" color="text-body-secondary">
              通过 Trusted Advisor 双数据源合并，提供 rightsizing、Graviton 迁移、终止等优化建议。
            </Box>
          </div>
          <div>
            <Box variant="h3">🤖 RDS AI 智能巡检</Box>
            <Box variant="p" color="text-body-secondary">
              基于 Amazon Bedrock（Claude）自动生成 RDS 健康巡检报告，支持自定义 Prompt 和模型选择。
            </Box>
          </div>
          <div>
            <Box variant="h3">🔔 定时通知推送</Box>
            <Box variant="p" color="text-body-secondary">
              每天 02:00 UTC 自动推送巡检报告摘要和高价值闲置资源 Top 5 到飞书群，通过 Secrets Manager 配置 notify_chat_ids 即可启用。
            </Box>
          </div>
          <div>
            <Box variant="h3">💬 IM 机器人（飞书/Slack）</Box>
            <Box variant="p" color="text-body-secondary">
              通过飞书或 Slack 机器人自然语言对话查询闲置资源、触发采集、管理白名单，支持私聊和群聊 @。
            </Box>
          </div>
          <div>
            <Box variant="h3">🛡️ 消息去重与幂等保护</Box>
            <Box variant="p" color="text-body-secondary">
              IM Bot Relay 两层持久化去重：DynamoDB 条件写入拦截 webhook 重试 + Powertools 幂等状态机保护异步路径。Feature Flag 可独立开关，降级时宁可重复不丢消息。
            </Box>
          </div>
        </ColumnLayout>
      </Container>

      {/* ── 数据流向 ── */}
      <Container header={<Header variant="h2">数据流向</Header>}>
        <SpaceBetween size="m">
          <Box variant="p">
            系统每天 00:00 UTC 由 EventBridge 自动触发，通过 STS AssumeRole 访问目标账户。
          </Box>

          <Container header={<Header variant="h3">Lambda1-Collector（每天 00:00 UTC）</Header>}>
            <SpaceBetween size="xs">
              <Box variant="p"><strong>RDS / ElastiCache 四阶段采集：</strong></Box>
              <Box variant="p" padding={{ left: "l" }}>
                阶段一：资源发现 + 白名单过滤（零 API 费用）<br />
                阶段二：海选采集 → 全量入库 → 识别 Candidate<br />
                阶段三：仅对 Candidate 精选采集深度指标
              </Box>
              <Box variant="p"><strong>EC2 Trusted Advisor 采集：</strong></Box>
              <Box variant="p" padding={{ left: "l" }}>
                经典版 + Cost Optimization Hub 双数据源 → LEFT JOIN 合并 → 入库
              </Box>
              <Box variant="p">⬇ 采集完成后异步调用 Lambda2-Analyzer</Box>
            </SpaceBetween>
          </Container>

          <Container header={<Header variant="h3">Lambda2-Analyzer</Header>}>
            <ColumnLayout columns={2} variant="text-grid">
              <div>
                <Box variant="p"><strong>路径 A — 闲置检测</strong></Box>
                <Box variant="p" color="text-body-secondary">
                  Candidate → 峰值否决 → 隐形负载检查 → 评分 → 闲置报告
                </Box>
              </div>
              <div>
                <Box variant="p"><strong>路径 B — 容量优化</strong></Box>
                <Box variant="p" color="text-body-secondary">
                  非 Candidate → 容量审计（存储/内存） → 优化报告
                </Box>
              </div>
            </ColumnLayout>
          </Container>

          <Container header={<Header variant="h3">Lambda3-HealthChecker（每天 01:30 UTC / 手动触发）</Header>}>
            <Box variant="p">
              读取 RDS 监控数据 → AI 巡检白名单过滤 → CSV 格式化 → Bedrock 生成巡检报告
            </Box>
          </Container>

          <Box variant="p" color="text-body-secondary">
            所有数据存储在 RDS PostgreSQL 中，前端通过 API Gateway + Cognito JWT 认证访问。
          </Box>
        </SpaceBetween>
      </Container>

      {/* ── 白名单机制 ── */}
      <Container header={<Header variant="h2">白名单机制</Header>}>
        <SpaceBetween size="m">
          <Box variant="p">
            系统有两套独立的白名单，作用于不同环节：
          </Box>

          <ColumnLayout columns={2} variant="text-grid">
            <div>
              <Box variant="h3">闲置检测白名单</Box>
              <Box variant="p" color="text-body-secondary">
                管理页面：「白名单管理」
              </Box>
              <ul>
                <li>RDS/ElastiCache：白名单实例在阶段一被过滤，不采集指标，零 API 费用</li>
                <li>EC2：resource_type=ec2 的白名单实例不出现在低利用率报告中</li>
                <li>白名单实例不会出现在闲置报告、优化报告和数据大盘中</li>
                <li>支持设置有效期（天数），到期后自动移出白名单；也可设为永久</li>
                <li>支持批量移入白名单（可指定有效天数）、批量移除</li>
                <li>点击「剩余有效期」可逐个修改有效期或设为永久</li>
              </ul>
            </div>
            <div>
              <Box variant="h3">AI 巡检白名单</Box>
              <Box variant="p" color="text-body-secondary">
                管理页面：「RDS AI 巡检 → 设置 → 巡检白名单」
              </Box>
              <ul>
                <li>白名单实例的监控数据不会发送给 Bedrock 模型</li>
                <li>按 instance_id + account_id 精确匹配</li>
                <li>仅影响 AI 巡检报告，不影响闲置检测流程</li>
                <li>支持设置有效期（天数），到期后自动移出白名单；也可设为永久</li>
                <li>支持批量添加/移除，点击「剩余有效期」可修改有效期</li>
              </ul>
            </div>
          </ColumnLayout>
        </SpaceBetween>
      </Container>

      {/* ── 详细说明（折叠） ── */}
      <Container header={<Header variant="h2">详细说明</Header>}>
        <SpaceBetween size="m">
          <ExpandableSection headerText="判定算法详解">
            <SpaceBetween size="s">
              <Box variant="p">
                <strong>峰值否决</strong>：7 天 CPU 峰值超过阈值（默认 50%）→ 排除（避免误判周期性任务）
              </Box>
              <Box variant="p">
                <strong>隐形负载检查</strong>：
              </Box>
              <ul>
                <li>RDS：IOPS 总和 &gt; 500 或 WriteIOPS &gt; 100 → 排除</li>
                <li>ElastiCache：Evictions &gt; 0、请求总数 &gt; 1000、连接峰值 &gt; 100 → 排除</li>
              </ul>
              <Box variant="p">
                <strong>闲置评分</strong>：CPU（40%）+ 连接数（30%）+ 存储/内存（30%）= 0~100 分
              </Box>
              <Box variant="p">
                <strong>价值评分</strong>：闲置评分 × 规格权重（xlarge+=1.5, medium/large=1.0, small-=0.5）× 连续天数因子
              </Box>
            </SpaceBetween>
          </ExpandableSection>

          <ExpandableSection headerText="EC2 Trusted Advisor 采集细节">
            <SpaceBetween size="s">
              <Box variant="p">
                双数据源：经典版（Qch7DwouX1）提供 CPU/网络指标 + Cost Optimization Hub（c1z7kmr00n）提供优化建议，
                以 Instance ID + Region 为键 LEFT JOIN 合并。
              </Box>
              <Box variant="p">
                前提条件：AWS Enterprise/Business Support 计划 + Cost Optimization Hub 已启用。
                无 Support 计划的账户会自动跳过，不影响其他功能。
              </Box>
              <Box variant="p">
                Support API 仅在 us-east-1 可用，系统自动处理。超时保护确保不影响 RDS/ElastiCache 采集。
              </Box>
            </SpaceBetween>
          </ExpandableSection>

          <ExpandableSection headerText="RDS AI 巡检说明">
            <SpaceBetween size="s">
              <Box variant="p">
                Lambda3-HealthChecker 读取 RDS 监控数据，格式化为 CSV 后调用 Bedrock InvokeModel 生成中文巡检报告。
              </Box>
              <Box variant="p">
                模型选择：必须使用推理配置文件 ID（如 apac.anthropic.claude-sonnet-4-...），前缀含义：
              </Box>
              <ul>
                <li>JP — 数据仅在日本处理，合规最严格</li>
                <li>APAC — 数据在亚太区域处理</li>
                <li>Global — 全球路由，延迟最低</li>
              </ul>
              <Box variant="p">
                Token 超过 100K 时自动按账户分批调用，最后合并为汇总报告。
              </Box>
              <Box variant="p">
                <strong>跨账户 Bedrock 调用</strong>：支持通过 STS AssumeRole 调用其他 AWS 账户的 Bedrock 模型。
                在「RDS AI 巡检 → 设置 → 模型选择」中勾选「使用跨账户 Bedrock（AssumeRole）」，输入目标账户中具有 Bedrock 调用权限的 IAM Role ARN。
                禁用时系统自动清除配置并回退到默认 IAM 凭证。
              </Box>
            </SpaceBetween>
          </ExpandableSection>

          <ExpandableSection headerText="跨账户采集设置">
            <SpaceBetween size="s">
              <Box variant="p">
                通过 STS AssumeRole 实现。管理账户的 notiops-idle-detection-role 由 CDK 自动创建。
                其他目标账户需手动创建同名 Role，信任管理账户的 Lambda 执行 Role。
              </Box>
              <Box variant="p">
                所需权限：rds:Describe*、elasticache:Describe*、cloudwatch:GetMetric*、support:DescribeTrustedAdvisor*
              </Box>
              <Box variant="p">
                在「设置 → 目标账户」页面注册账户 ID、Role ARN 和要扫描的 Region 列表。
              </Box>
            </SpaceBetween>
          </ExpandableSection>

          <ExpandableSection headerText="阈值配置">
            <SpaceBetween size="s">
              <Box variant="p">
                通过「设置 → 阈值配置」管理，RDS 和 ElastiCache 各有独立阈值。
              </Box>
              <Box variant="p">
                <strong>闲置检测（路径 A）</strong>：候选 CPU/连接数阈值、峰值否决、IOPS/WriteIOPS、驱逐数、请求总数、连接峰值
              </Box>
              <Box variant="p">
                <strong>容量优化（路径 B）</strong>：存储空闲率、CPU 最大值否决、Swap 上限、内存利用率上限
              </Box>
              <Box variant="p">
                EC2 使用 Trusted Advisor 数据，不依赖自定义阈值。支持 Tag 级覆盖。
              </Box>
            </SpaceBetween>
          </ExpandableSection>

          <ExpandableSection headerText="API 费用估算">
            <Box variant="p">
              白名单资源零 API 费用。500 实例/月约 $1.01（海选 N×6 + 精选 C×7 查询，$0.01/1000 查询）。
              CloudWatch API 费用产生在目标账户，Lambda/数据库费用产生在管理账户。
            </Box>
          </ExpandableSection>

          <ExpandableSection headerText="消息去重与幂等保护机制">
            <SpaceBetween size="s">
              <Box variant="p">
                飞书 webhook 重试 × Lambda 多实例 × Lambda 异步调用重试，同一消息最多可能被处理 12 次。系统通过两层持久化去重解决：
              </Box>
              <Box variant="p"><strong>第一层（同步路径）— DynamoDB 条件写入</strong></Box>
              <Box variant="p" padding={{ left: "l" }}>
                收到 webhook 后，对 DynamoDB im-bot-dedup 表执行 PutItem + attribute_not_exists(message_id) 条件写入。<br />
                首次写入成功 → 继续处理；条件失败 → 重复消息，直接返回 200。<br />
                记录自动设置 5 分钟 TTL，DynamoDB 自动清理过期数据。
              </Box>
              <Box variant="p"><strong>第二层（异步路径）— Powertools 幂等状态机</strong></Box>
              <Box variant="p" padding={{ left: "l" }}>
                异步处理函数使用 AWS Lambda Powertools @idempotent_function 装饰器。<br />
                DynamoDB im-bot-idempotency 表维护 INPROGRESS → COMPLETE 状态机。<br />
                防止 Lambda 异步重试和多实例并发导致的重复处理。
              </Box>
              <Box variant="p"><strong>Feature Flags（环境变量）</strong></Box>
              <ul>
                <li>DEDUP_ENABLED — 第一层 DynamoDB 去重开关（默认 true）</li>
                <li>IDEMPOTENCY_ENABLED — 第二层 Powertools 幂等开关（默认 true）</li>
                <li>RETRY_ON_SEND_FAILURE — 降级重发开关（默认 false）</li>
              </ul>
              <Box variant="p"><strong>降级策略</strong></Box>
              <Box variant="p" padding={{ left: "l" }}>
                DynamoDB 不可用时放行消息（宁可重复不丢消息），记录 WARNING 日志。<br />
                Powertools 持久层异常时跳过幂等保护，直接执行业务逻辑。<br />
                Lambda 异步重试已关闭（retryAttempts: 0, maxEventAge: 5min）。
              </Box>
            </SpaceBetween>
          </ExpandableSection>

          <ExpandableSection headerText="飞书机器人配置">
            <SpaceBetween size="s">
              <Box variant="p">
                1. 打开 <a href="https://open.feishu.cn" target="_blank" rel="noopener noreferrer">飞书开放平台</a> → 创建或进入企业自建应用<br />
                2. 左侧「凭证与基础信息」→ 记下 App ID 和 App Secret<br />
                3. 左侧「事件与回调」→「加密策略」→ 记下 Verification Token 和 Encrypt Key（没有则留空）<br />
                4. 去 AWS Secrets Manager，找到 notiops/im-bot-feishu Secret，填入 JSON：
              </Box>
              <Box variant="code">
                {`{
  "app_id": "cli_xxxxxxxx",
  "app_secret": "xxxxxxxx",
  "verification_token": "xxxxxxxx",
  "encrypt_key": "",
  "notify_chat_ids": "oc_xxx,oc_yyy"
}`}
              </Box>
              <Box variant="p" color="text-body-secondary">
                notify_chat_ids 为可选字段，填入后系统每天 02:00 UTC 自动推送通知到指定群。多个群用逗号分隔。不填则不推送。
              </Box>
              <Box variant="p">
                5. 回到飞书 →「事件与回调」→「事件订阅」→ 请求地址填入 setup.sh 输出的飞书 Webhook URL → 飞书自动验证 ✅<br />
                6. 点「添加事件」→ 搜索并添加 im.message.receive_v1（接收消息）<br />
                7. 左侧「应用能力」→ 开启「机器人」<br />
                8. 创建应用版本并发布上线
              </Box>
            </SpaceBetween>
          </ExpandableSection>

          <ExpandableSection headerText="定时通知推送配置">
            <SpaceBetween size="s">
              <Box variant="p">
                系统每天 02:00 UTC 自动推送巡检报告和闲置资源通知到飞书群（Lambda4-Notifier）。
              </Box>
              <Box variant="p"><strong>执行时序：</strong></Box>
              <Box variant="p" padding={{ left: "l" }}>
                00:00 UTC — Lambda1 跨账户资源采集 + 闲置判定<br />
                01:30 UTC — Lambda3 RDS AI 智能巡检报告生成<br />
                02:00 UTC — Lambda4 查询当天数据 → 推送通知到飞书
              </Box>
              <Box variant="p"><strong>通知内容：</strong></Box>
              <ul>
                <li>RDS 巡检报告摘要 — 各账户的实例数、严重/警告/关注数量</li>
                <li>闲置资源概览 — 闲置资源总数、预估月度节省金额</li>
                <li>Top 5 高价值闲置资源 — 按月度节省金额降序排列</li>
              </ul>
              <Box variant="p"><strong>启用方法：</strong></Box>
              <Box variant="p">
                在 AWS Secrets Manager 中，向飞书（notiops/im-bot-feishu）的 Secret 添加 notify_chat_ids 字段即可。
                多个群用逗号分隔。不填或留空则不推送通知。
              </Box>
              <Box variant="p" color="text-body-secondary">
                如果当天既没有巡检报告也没有闲置资源数据，系统会自动跳过通知，不会发送空消息。
              </Box>
            </SpaceBetween>
          </ExpandableSection>
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}
