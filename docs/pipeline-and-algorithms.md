# 流水线与算法

本篇只回答一件事：**NotiOps 后台有哪几条定时流水线、各自被什么触发、跑完产出什么、代码在哪。**

| 想看别的 | 去哪 |
|----------|------|
| 成本异常的评分数学（四因子权重、置信度分级、下钻口径） | [cost-anomaly-algorithm.md](cost-anomaly-algorithm.md) —— 本篇**不重复**，只讲它在流水线里的位置 |
| 整体组件与数据流 | [architecture.md](architecture.md) |
| 部署步骤 | [DEPLOYMENT.md](DEPLOYMENT.md)（方式 B）· [DEPLOYMENT_ONECLICK.md](DEPLOYMENT_ONECLICK.md)（方式 A） |

## 0. 适用范围：方式 A 不装本篇任何一条流水线

NotiOps 有两条部署路径，本篇三条流水线**只属于方式 B**：

| | 方式 A（一键 CloudFormation） | 方式 B（`setup.sh`） |
|---|---|---|
| 部署形态 | 单栈静态模板，免本地工具链、免 AKSK | CDK 多栈 |
| 装什么 | 最小底座（Cognito + `notiops-config` + 数据桶）+ Web Chat（BFF / 前端 / CDN）+ AgentCore Runtime，IM 三件套按 CFN 条件 `InstallIm` 可选加装 | 上述全部 + 后端栈（4 张具名表 + 本篇三条流水线） |
| 资源巡检（哨兵） | ❌ 不建 `notiops-inspection` 表、不建 4 个 `notiops-inspection-*` Lambda、不建 `notiops-inspection-tasks` 队列与那 3 条 rate 规则 | ✅ |
| 每日成本异常 | ❌ 不建 `notiops-cost-analyzer`，也没有 `notiops-daily-cost-analysis` 规则 | ✅ |
| 每日消息推送 | ❌ 不建 `notiops-notifier`，也没有 `notiops-daily-notification` 规则 | ✅ |

> ⚠️ **方式 A 的 BFF 仍然带着 `INSPECTION_TABLE` 环境变量** —— 两条路径共用同一个
> `infra/lib/constructs/web-chat-core.ts`，那里无条件注入它（还有
> `INSPECTION_SCHEDULER_FUNCTION` / `INSPECTION_EXECUTOR_FUNCTION`），且巡检相关的
> 4 条 IAM 语句照样挂在 BFF 角色上。IAM 本身无害（授权一个不存在的 ARN 不产生任何权限），
> 但**别把它读成「方式 A 支持巡检」**。

> 📌 「两条路径的 **web 功能**必须完全一致」是本项目的铁律。本篇三条是**后端批处理
> 流水线**、不是 web 功能，但它们在方式 A 上的缺席**确实**在 web 侧留下一处已知缺口，
> 这里如实写清而不含糊过去：
>
> `authz.mjs` 的 `PRESET_ROLES` 里 `role:finops` / `role:support` / `role:viewer` 都含
> `nav:inspection:*`。`visibleTree()` **确实有**一道数据源可用性判据
> （`envConfigured(node.requiresEnv)`，`nav:finops:cur-*` 那几个 subtab 就是靠它在没配
> `COST_AGENT_MCP_URL` 时整块不下发），但 `config/capabilities.json` 里
> `nav:inspection` 及其全部子节点**都没有声明 `requiresEnv`**；而且即使声明成
> `INSPECTION_TABLE` 也拦不住 —— 那个变量在两条路径上都被无条件注入。所以方式 A 上
> 这些角色的用户会看到「资源巡检」tab，点进去是 `ddb_error` 加载失败面板 ——
> HTTP 200、不是 403，也不会自动隐藏。现成的收口手段是管理页的**模块开关**
> （`nav:inspection` 是 level=tab 且非 alwaysOn/adminOnly，`admin.mjs` 的
> `apiGetModules` 已把它列为可关）—— 需要人手关一次。要做成自动的，得先让方式 A 别再
> 无条件注入那个变量（或换一个能区分拓扑的变量），再给节点声明 `requiresEnv`，并与
> `authorize()` 同步改，那是一个独立改动。相关注释见 `web-chat-core.ts` 里
> `INSPECTION_TABLE` 上方那段（⚠️ 那段仍写着「visibleTree 里没有任何 env 判据」，
> 现在已经有了，判据本身不是缺的那一块）。
>
> 另一条不构成缺口的差异（方式 A 单栈无跨栈 Export）见 [DEPLOYMENT.md](DEPLOYMENT.md) §5.4。

## 1. 三条流水线一览

```
① 资源巡检（哨兵）        rate 15min ─▶ scheduler ─SQS─▶ executor ─▶ DevOps Agent 判读
                          rate 1h    ─▶ reconciler（对账兜底）
                          rate 15min ─▶ push（工作日时段窗口投 IM）

② 每日成本异常            cron 01:15 UTC ─▶ notiops-cost-analyzer ─▶ 配置表 ─▶ Web 看板 / ③ 复用

③ 每日消息推送            cron 02:00 UTC ─▶ notiops-notifier ─▶ 飞书群
```

后端栈（`infra/lib/notiops-backend-stack.ts`）里与这三条相关的 EventBridge 规则共 **5 条**：

| 规则名 | 调度 | 目标 Lambda | 规格 |
|--------|------|-------------|------|
| `notiops-inspection-scheduler` | `rate(15 minutes)` | `notiops-inspection-scheduler` | 256MB / 120s |
| `notiops-inspection-reconciler` | `rate(1 hour)` | `notiops-inspection-reconciler` | 256MB / 5min |
| `notiops-inspection-push` | `rate(15 minutes)` | `notiops-inspection-push` | 512MB / 5min |
| `notiops-daily-cost-analysis` | `cron(15 1 * * ? *)` | `notiops-cost-analyzer` | 512MB / 15min |
| `notiops-daily-notification` | `cron(0 2 * * ? *)` | `notiops-notifier` | 256MB / 10min |

`notiops-inspection-executor`（1024MB / 15min）**没有定时规则** —— 它是 SQS 消费者。
CUR finalizer（代码在 `lambda6_cur_finalizer/`，CDK 没给它物理函数名，日志组是
`/aws/lambda/notiops-cur-finalizer`）也没有 —— 它由一条**一次性** EventBridge Scheduler
触发（见 §3.3）。

> ⚠️ 定时规则的**周期**写在 CDK 里，但资源巡检的**具体时刻**存 DynamoDB —— 客户改巡检
> 时间不需要重新部署。代价是调度粒度 = 15 分钟，UI 必须把可选时刻限制成 15 分钟整数倍
> （见 `inspection/domain/schedule.py` 的 `TICK_MINUTES`）。成本异常与消息推送这两条仍是
> 写死的 cron。

## 2. 资源巡检（哨兵）

四个 Lambda + 一条 SQS 队列 + 领域层 `inspection/`。产出落 `notiops-inspection` 表，
被 Web Chat 巡检看板、IM 推送、每日消息（§4）三处消费。

```
EventBridge rate(15min)
      │
      ▼
notiops-inspection-scheduler ──SendMessageBatch──▶ notiops-inspection-tasks (SQS)
  · 读定时配置（DDB，不是每客户一条 Rule）                          │
  · due_runs()：本 tick 该跑哪些 (类型 × 账号) + 补跑              │ batchSize=1
  · 查判读额度 → 预算档位 Tier                                     │ maxConcurrency=3
  · 快照配置 → config_version                                      ▼
  · 抢 run 锁（DDB 条件写，抢不到就跳过）            notiops-inspection-executor
                                                          │
                                     ┌────────────────────┴────────────────────┐
                                     ▼                                          ▼
                          notiops-inspection 表                     DevOps Agent（判读）
                          （finding / 序列 / run 记录）                        │
                                     ▲                                          │
                     EventBridge 事件 │                    Investigation Completed│
                                     └── notiops-devops-callback ◀───────────────┘

EventBridge rate(1h)   ─▶ notiops-inspection-reconciler   补主路径丢事件 + 查采集缺口
EventBridge rate(15min)─▶ notiops-inspection-push         只在推送时段窗口里真的投递
```

### 2.1 调度 —— `lambda_inspection_scheduler/handler.py`

两类独立轮次（`inspection/domain/schedule.py::RunType`）：

| 轮次 | 值 | 判什么 |
|------|----|--------|
| 高负载 | `high` | 阈值越线 + 慢性高位 |
| 闲置与成本 | `idle` | 闲置评分 + 容量超配 + 结构性风险 |

- 默认触发时刻 `02:00 UTC`（`ScheduleConfig.at_utc`），可改；错过后允许在 `catch_up_hours`
  （默认 6 小时）内补跑。
- 判据是「配置时刻落在本 tick 窗口内 **且** 今天这个 (类型, 账号) 还没有 `running` / `success`
  的 run 记录」。`partial` / `failed` 故意不拦，那正是该补跑的信号。
- run 记录四态：`running` / `success` / `partial` / `failed`。
- 账号清单来自配置表的 `da#<account>` 行（`inspection/adapters/accounts.py`，走 GSI1 不 Scan）；
  `enabled` 字段缺省视为**启用**。
- 手动触发走同一个入口，事件里带 `manual_trigger`。

### 2.2 执行 —— `lambda_inspection_executor/handler.py`

一条 SQS 消息 = 一个 `(run_type, account, data_date)`。`batchSize=1`、`maxConcurrency=3`；
队列 `visibilityTimeout` 16 分钟（必须 ≥ 执行 Lambda 的 15 分钟 timeout），投递 3 次仍失败
进 `notiops-inspection-dlq`（保留 14 天）。

事件源映射开了 `ReportBatchItemFailures`，所以 handler 顶层捕获一切异常并逐条记失败 ——
整批重投的代价是重复付 `GetMetricData`、重复派判读。抢不到锁**不算失败**。

编排顺序在 `inspection/pipeline.py`（这一层**不建 client、不取当前时间、不写库** ——
`clients` 与 `today` 都是入参，所以端到端能在 CI 里跑；纯函数在 `inspection/domain/`）：

```
① load_resources    describe RDS + ElastiCache → ResourceAttrs
② enrich            memory_bytes（ec2 规格）+ max_connections（参数组）
③ apply_exclusions  排除清单过滤 ——【在拉指标之前】
④ load_refdata      引擎 EOL + RDS CA 证书
⑤ collect_metrics   GetMetricData 7 天日粒度 × 按族的统计量
⑥ 结构性风险         纯属性，不依赖 ⑤ → scan_structural + 指纹去重
⑦ 闲置与容量         依赖 ⑤ → apply_vetoes → score_idle / scan_capacity
```

③ 的位置是刻意的：**先过滤再拉数**。反过来会为客户明确说了「别看这个」的资源付
`GetMetricData` 的钱，而那笔钱在账单上看不出是浪费的。

任何一步的 AWS 调用失败都**降级而不抛**，降级痕迹落在 `InspectionResult.skipped` 与
`gaps` 里 —— 不静默。

### 2.3 采集与费用模型 —— `inspection/adapters/metrics_repo.py`

```
GetMetricData 按【请求的指标数】计费，不按返回的数据点数
  ⇒ 拉 1 天与拉 7 天价格完全相同
但每个统计量是【独立的 MetricDataQuery，各自计费】
  ⇒ 4 个统计量 = 4 倍指标数。这是最容易漏乘的因子。
```

所以一次就拉够窗口（7 天），不做增量。三条实现约束：

1. **批大小 ≤ 400 query**（不用 API 上限 500），默认 8 个批并发（`DEFAULT_MAX_WORKERS`）。
   串行是**跑不完**而不是慢：500+500 规模约 158 批 × 2.3 秒 ≈ 6 分钟/账号。
2. **零数据点要上报，不能静默跳过** —— 「拉了没数据」是一条可观测性缺口。
3. **维度按指标查表**（`inspection/domain/metrics_meta.py`）：少数卷级指标只有集群维度。

统计量集合是 `("Minimum", "Average", "Maximum", "p95")`，但**实际发出去的按族查表决定** ——
`AWS/ElastiCache` 不支持百分位，对它请求 p95 会拿到空数组**并照样计费**。

窗口是 `[today − 7, today)`，**不含今天**（今天的日桶还没满）。

### 2.4 判定算法要点

**闲置侧**（`inspection/domain/scoring/`）：

```
候选实例 ─┬─ peak_veto            7 天峰值越线 → 否决
          ├─ hidden_load_check    隐形负载（IOPS / 驱逐 / 请求数）→ 否决
          └─ 通过 ─▶ score_idle ─▶ rank_cross_service
```

被否决的**也留在结果里并带原因** —— 只返回通过的那些，UI 就无法回答「我这台明显没人用，
为什么不在闲置清单里」。

维度权重（`scoring/idle.py`）：

| 服务 | 权重 |
|------|------|
| RDS | cpu 0.40 · connections 0.30 · storage 0.20 · iops 0.10 |
| ElastiCache | cpu 0.35 · memory 0.35 · requests 0.30 |

某维度取不到数时该维度丢弃并重归一化，同时给排序打一个置信度折扣（`idle.value_score`
的 `available_weight`）—— 不拿 0 当「完全闲置」。

```
value_score = idle_score × 规格权重 × 连续天数因子 × 可用维度折扣
```

- 规格权重（`inspection/domain/specs.py::instance_size_weight`）：含 `xlarge` = 1.5，
  `nano`/`micro`/`small` = 0.5，其余 = 1.0。
- 连续天数因子：`max(1.0, 1.0 + (连续低位天数 − 1) × 0.1)`，0 天与 1 天都得 1.0。

**容量超配**（`scoring/capacity.py`，语义是 rightsizing）：RDS 查存储超配、ElastiCache 查内存超配。

**结构性风险**（`inspection/domain/structural/`，纯属性、零指标，与闲置同在 `idle` 轮跑）七条：

| 规则码 | 含义 |
|--------|------|
| `gp2_volume` | 应迁 gp3 |
| `burstable_in_prod` | 生产用 T 系 |
| `single_az_in_prod` | 生产库单 AZ |
| `backup_disabled` | 自动备份未开 |
| `no_read_replica` | 无只读副本 |
| `ca_cert_expiring` | RDS CA 证书临期（默认提前 90 天报） |
| `engine_eol` | 引擎大版本 EOL（默认提前 180 天报） |

另有两个**不由属性扫描产出**的规则码：`no_capacity_metadata`（拿不到规格 → 按百分比的判定
对这台无效，固定 INFO，**不派判读**）与 `unsupported_engine`。它们必须产出 finding 而不是
静默跳过 —— 「没有内存告警」和「内存健康」在看板上长得一样。

**高负载阈值**在 `inspection/domain/thresholds.py`（提成配置，不再像老系统那样写死在提示词正文里）。
分级是 `inspection/domain/severity.py` 的 headroom 四档：

| 档 | 判据 |
|----|------|
| CRITICAL | `headroom ≤ 0.10` **且** 实例 tier ∈ {tier1, prod} |
| HIGH | `headroom ≤ 0.20`，或 `headroom ≤ 0.35` 且 MTTR ≥ 5 天 |
| MEDIUM | `headroom ≤ 0.35` |
| INFO | 其余 · 结构性 · 数据不足 |

`headroom ≤ 0` 表示当前值已越过阈值（`is_breached`），但**越线本身不等于 CRITICAL** ——
非生产档的越线止步 HIGH。`headroom is None`（比例判据对该指标不适用）落 INFO 而不是 CRITICAL，
判它的是绝对值判据。

### 2.5 判读派发 —— 确定性规则算完，才轮到 LLM

严重度与命中判据**全部由确定性规则决定**，DevOps Agent 只负责解释「为什么」和「安不安全」，
且不允许改严重度。派发量经四层收敛，顺序固定：

```
① rollup       同一集群内多数成员同向同幅 → 集群层出 1 条，不出 N 条
                                              → inspection/domain/rollup.py
② 命中过滤     未命中规则的不派发               → 各条规则自己
③ top-N 截断   每账号每轮上限，超限的【留到下一轮】，不丢弃 ┐ inspection/domain/
④ 三重配额     每账号 / 全局 / 每 (账号, 指标)             ┘ dispatch.py
```

排序键 = `(severity 档位, headroom 升序, idle_score 降序, instance_id)`。最后那个决胜键不是
可省的 —— 少了它同分两条的顺序取决于 dict 遍历，「同输入同输出」就守不住。

四层之外，`inspection/domain/gating.py` 还在**每条 finding** 上串了三道闸，顺序有意义：

```
① playbook 命中？   → 给确定性结论，不调 DA（免费且更准，所以排最前）
② N 天内同情形？    → 沿用上次结论 + 标注增量（默认 7 天 `CONCLUSION_REUSE_DAYS`，
                       并按 DA 的 verdict 分档 `REUSE_DAYS_BY_VERDICT`）
③ Tier 放行？       → budget.Tier.allows()
```

② 就是「同一条问题不每天重买一次判读」那道闸。形态哈希只吃
`sha256(hit_reason 集合 已排序 | severity 档位)`，**不含指标数值**（含了的话 CPU 从 91%
变 92% 就成「新情形」，复用永不触发），但**含 severity 档位**（不含的话 MEDIUM 升到
CRITICAL 会被当成同一情形而复用旧结论，「情况恶化了」在报告上完全看不出来）。

**预算护栏**是环境变量 `MONTHLY_LIMIT_SECONDS`；缺省 `-1` = 上限未知，那时护栏**不启用**
且不打 `DaQuotaUsedRatio` 指标 —— 明示「额度没被监控」（P3 那条 Alarm 会停在
`INSUFFICIENT_DATA`），而不是假装健康。要开就在 `setup.sh` 前设
`INSPECTION_MONTHLY_LIMIT_SECONDS`。

> ⚠️ 别把 `domain/gating.py` 与 `domain/journal_gate.py` 弄混：后者不是派发闸门，而是
> **skill 加载门禁**——DA 是靠对 skill description 做模型匹配来加载正文的，「没加载上」
> 是常态可能且从外面看不出来（报告照样出，只是退化成 DA 的通用发挥）。它靠 journal 里
> `skills.bundles` 是否为空来判定并标记判读质量降级。

判读提示词是两份 skill，**不是 DDB 里的一段文本**：

| 文件 | skill name | 覆盖 `hit_reason` |
|------|-----------|-------------------|
| `inspection/skills/high-load/SKILL.md` | `inspection-high-load` | `threshold_high` / `chronic_high` |
| `inspection/skills/cost-idle/SKILL.md` | `inspection-cost-idle` | `idle` / `structural` |

两份的「输入契约 + 六条硬边界 + 输出信封」是同一份拷贝，单一来源在
`inspection/skills/_shared/GUARDRAILS.md`，由 `scripts/sync_inspection_skills.py` 在 CI 里
钉住（**不要直接改 SKILL.md 里 BEGIN/END 之间的内容**）。上传到巡检专用 agent space 走
`scripts/upload_inspection_skills.py`（`setup.sh` 里跑一次）+ executor 里的 `ensure_skills`
惰性兜底（从不抛，失败落 `skipped`）。

### 2.6 判读回填 —— `notiops-devops-callback`

DevOps Agent 判完发 EventBridge 事件，回调 Lambda 按 `agent_space_id` 判出这是巡检还是排障
（`inspection/domain/callback_route.py`），巡检那支走 `inspection/callback_apply.py`：

```
收到 Investigation Completed
  ↓ 拿到 long_report
  ↓ get_dispatch(task_id) 查这个 task 装了哪些 finding
  ↓ parse_sections 按 `## <finding_id>` 切开
  ↓ attach_judgment 逐条挂到 finding 行
```

每一环失败都要**留痕而不是静默** —— 断掉的表现是「报告里有分析但 finding 旁边是空的」，
而那和「本轮没有风险」在看板上长得一样。

回调规则建了两条（default bus + custom bus），事件模式共用一份常量，见
`infra/lib/constructs/devops-callback.ts`。

### 2.7 对账 —— `lambda_inspection_reconciler/handler.py`

每小时一次，只回答一个问题：**已派发的判读任务，主路径的事件是不是丢了。**

- 逐账号查「已派发但判读没回来」的 finding，按 `task_id` 去重。
- 超 2 小时仍非终态 → `GetBacklogTask` 核实；已是终态就把降级原因挂到该 task 覆盖的每条 finding。
- 单次最多探 200 个 task（`MAX_PROBES_PER_RUN`）—— 上界不是性能考虑，是防成本与故障放大。
- 🔴 **绝不因「跑得久」判死任何任务**：判死重投会形成正反馈，额度烧光且永不收敛。全部判定
  在 `inspection/domain/dispatch_recon.py`（纯函数），本 Lambda 只做 IO。
- 顺带检查采集覆盖缺口。

**为什么是每小时而不是每天**：巡检报告是当天要交付的，改成每天会让「判读回不来」最长晚
一天才被发现。

### 2.8 推送 —— `lambda_inspection_push/handler.py`

每 15 分钟被唤醒，但**只在推送时段窗口里真的干活**。窗口判定在
`inspection/domain/push_policy.py::in_push_window`，默认：

| 项 | 默认值 |
|----|--------|
| 时刻 | `03:00 UTC`（= 巡检默认时刻 `02:00 UTC` 之后一小时） |
| 星期 | 工作日（周一～周五） |
| 窗口宽度 | 15 分钟（与 EventBridge 规则周期一致） |

时刻必须晚于巡检 —— 早于它的表现是每天推的都是**前一天**的结论，而客户看到的日期是今天。
`has_run_today` 那道闸是兜底。

链路：读时段配置 → 窗口判定（不在窗口就直接返回，且**不打点不记 warning**）→ kill switch
`inspection.enabled` → 解析投递目标 → 逐账号读 finding 与推送状态 → **今天没有 run 记录就跳过
该账号**（不推昨天的）→ 逐目标 `select_for_target()`（按账号切分 + `severity_min` + 节奏与
退避 + Top N + 深链）→ kill switch `push_enabled`（**算完之后、投递之前**，让灰度可以
「只写库不推送」）→ `broadcast()` 逐 chat 投递，一个失败不阻断 → `mark_pushed()` 只标真投
出去的那些。

> ⚠️ 前两步的顺序是刻意的：**窗口判定在 kill switch 之前**（handler 里有一段注释专门写这
> 件事，而模块顶部那张流程图把两者画反了 —— 以代码为准）。反过来会让拉停期间每 15 分钟
> 打一次点，一天 96 条把「该推却没推」那一次彻底淹掉；而「不在窗口」一天命中 95 次，所以
> 它那条早退路径是唯一**不打点**的，其余早退分支都要打点。

**为什么推送是独立 cron 而不是巡检跑完顺手发**：顺手发的话推送时刻 = 凌晨批处理时刻；
更麻烦的是巡检是逐账号 fan-out，顺手发意味着 50 个账号发 50 次，而模型是「一个 chat 一份摘要」。

深链要的 `WEB_BASE_URL` 空着**不是错误**：没配就不放链接。那个域名属于另一个栈，走 context
而不是跨栈引用，避免给共享后端栈加一条部署顺序依赖。

### 2.9 落库

全部落 `notiops-inspection` 表。键前缀集中在 `inspection/adapters/keys.py` 的 `Prefix` 枚举
（**加新前缀 SHALL 加在那里**，不在各 repository 里写字面量），并由 `assert_prefixes_disjoint()`
保证任意两个前缀不互为前缀 —— 否则按前缀扫序列的查询会顺带扫出排除清单行，而那种冲突肉眼看不出来。

## 3. 每日成本异常

### 3.1 触发与链路 —— `lambda5_cost_analyzer/handler.py`

`notiops-daily-cost-analysis`（`cron(15 1 * * ? *)`，即每天 01:15 UTC）→ `notiops-cost-analyzer`。

每个账户：

```
1. STS AssumeRole 取临时凭证
2. Cost Explorer GetCostAndUsage
     TimePeriod  近 30 天         Granularity DAILY
     Metrics     AmortizedCost    GroupBy     DIMENSION / SERVICE
3. 统计计算（日均、标准差、近 3 天均值、连续超阈天数、日环比）
4. 多因子评分 + 置信度分级
5. 异常服务下钻：同样的查询按 USAGE_TYPE 分组、Filter 到该 SERVICE
6. UPSERT 结果行 + 摘要行
```

候选池取 Top 20 服务 + 旁路候选（`_TOP_N_SERVICES`）；评分 **≥ 40** 才落库
（`_ANOMALY_SCORE_THRESHOLD`）。

评分公式在 `lambda5_cost_analyzer/scoring.py`：

```
anomaly_score = 0.30 × 统计偏离度 + 0.30 × 账号影响力 + 0.25 × 持续性 + 0.15 × 加速度
                （clamp 到 0–100）
```

> 四个因子各自的插值曲线、置信度分级、预计额外成本的算法，以及交互式 agent skill 与本条
> cron 路径在**阈值口径**上的差别（skill 展示阈值 70，cron 落库阈值 40），全部在
> [cost-anomaly-algorithm.md](cost-anomaly-algorithm.md)。本篇不复述。

默认部署形态下**只分析部署账号**：后端栈把 `LOCKED_ACCOUNT_ID` = 部署账号 ID 注入共享的
Lambda 环境，`shared/account_scope.py` 据它过滤账号清单。传 `-c organizationId=o-xxxx` 时
CDK 把该变量**置为空串**（不是删掉它），闸门随之解锁、恢复多账号采集，实际范围仍由配置表里
enabled 的账号决定。

> ⚠️ 这道闸门不是全局的：巡检那条路（§2）**刻意不接** `LOCKED_ACCOUNT_ID`，它的账号范围
> 只由配置表的 `da#` 行决定。见 `shared/account_scope.py` 里那条注释。

### 3.2 落库与读侧

写侧 `shared/queries/cost_anomaly.py`，落**配置表 `notiops-config`**：

```
结果行   PK = anomaly#<account_id>#<date>   SK = <service_name>
         GSI1PK = anomaly#<date>            GSI1SK = <score 左补零 12 位>
摘要行   PK = anomalysum#<account_id>       SK = <date>
         GSI1PK = anomalysum#<date>         GSI1SK = <projected 左补零 12 位>
```

读侧 `bff/web-chat/daily_anomaly.mjs`（FinOps 看板）。

> 🔴 键形状与 Python 写侧**逐字对齐**，两侧漂移的表现是页面永远「无数据」而 lambda5 明明
> 每天在写（与「算好了没人取」同族，只是隔了一种语言）。钉住它的是
> `bff/web-chat/tests/daily_anomaly.test.mjs` —— 它把 `.mjs` 与 `.py` 两份源码**都读进来**，
> 断言两边出现同一串键字面量；Python 写侧另有 `tests/queries/test_cost_anomaly.py`
> 走 moto 做读写回环。

> 这一条与 `costExplorer.anomalies`（AWS Cost Anomaly Detection 服务）是**两套引擎，不合并**：
> 前者要客户先配 monitor，本条自建基线不依赖它。合并的代价是两套口径的数字被加在一起，
> 客户对不上任何一边的控制台。界面上两张卡并排、各自标注来源。

### 3.3 一次性伴生：`lambda6_cur_finalizer`

不是定时流水线，但同属 FinOps 数据链，容易被误认为少了一条 cron：

```
setup.sh 建 CUR ReportDefinition
   └─▶ 同时用 aws scheduler create-schedule 建一条【一次性】schedule
         名字 notiops-cur-finalizer-<account_id>
         表达式 at(T+25h)   FlexibleTimeWindow OFF   完成后自动 DELETE
            └─▶ lambda6_cur_finalizer（256MB / 10min）
                  · 发现 CUR 数据路径
                  · 部署 AWS 官方 Athena 集成 CFN 模板
                    （栈名 notiops-cur-athena-<account_id>）
                  · 幂等下发 6 条 FinOps Athena 保存查询
                    （lambda6_cur_finalizer/athena_saved_queries.py）
```

为什么不在 CDK 里静态声明：每个客户账号的触发时间是动态的 T+25h，属于运行时数据而非部署时
常量。CDK 只负责建好可复用的调用角色（`notiops-cur-finalizer-scheduler-role`）并输出
`CurFinalizerFunctionArn` / `CurFinalizerSchedulerRoleArn` 两个值给 `setup.sh`。

数据就绪前 FinOps 仪表盘显示「数据初始化中」占位卡片。

## 4. 每日消息推送 —— `lambda4_notifier/handler.py`

`notiops-daily-notification`（`cron(0 2 * * ? *)`，即每天 02:00 UTC）→ `notiops-notifier`。

现在只有三段（`notify_chat_ids` 配在飞书 Secret 里）：

| 段 | 数据源 | 说明 |
|----|--------|------|
| 资源巡检 | `notiops-inspection` 表（`INSPECTION_TABLE`） | 每账号每类型今天跑没跑、未关闭 finding 的严重度分布、判读回来了几条 |
| 成本异常 | §3 的产数 | **不触发调查** |
| 过去 24h 调查汇总 | 调查记录 | —— |

「今天没跑」与「今天没风险」必须可区分 —— 空列表的几种含义在看板与消息里都不能混。

**刻意去掉的：健康告警自动触发调查。** 老链路对报告里的 critical 每天触发一次 DevOps Agent
调查，没有复用闸门，同 3 条 critical 会**每天重新买一次调查**。这个职责由 §2.5 的复用闸门 +
额度档位整体接管，不在通知 Lambda 里做第二套。

## 5. 不在本篇范围

以下路径**不是定时流水线**，只列出来避免误找：

- **事件驱动的主动观察推送**：`notiops-push-*` 系列 EventBridge 规则（Health / CloudWatch 告警 /
  Cost Anomaly / Trusted Advisor / GuardDuty …）→ `notiops-push-handler` → IM。全部默认
  `DISABLED`，需显式启用。定义单一来源在 `infra/lib/constructs/web-notif-sources.ts`。
- **Web 通知收件箱**：同一批事件源的另一个 sink，写 `notiops-web-chat` 表的 `notif#` 段，
  前端轮询。方式 A 与方式 B 都有。
- **AWS Health 事件转发**：`notiops-phd-forwarder`（128MB / 90s）。
- **IM 机器人**：API Gateway **HTTP** API（`$default` catch-all 路由）+ Lambda ingress，
  见 [im-bot-interaction.md](im-bot-interaction.md) 与 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md)。
  **每个启用的 IM 平台各带一条 `rate(4 minutes)` 保活规则**（飞书 / Slack 的 ingress 各一条，
  常量 input 是哨兵 `{"notiops_warmup": true}`，handler 第一行早返回）—— 审计 EventBridge
  规则清单时会看到它们，但那是防冷启动，不是流水线。定义在 `infra/lib/constructs/im-core.ts`。
- **客户 CUR 仪表盘缓存预热**：`web-chat-core.ts` 里一条 `cron(0 22 * * ? *)` 规则
  （UTC 22:00 = 北京 06:00，与 `cur_dashboard.mjs` 的 UTC+8 缓存 key 基准配套）→ BFF。
  与本篇三条流水线无关。两条路径的建法不同但都不算缺口：方式 A 的 cost-agent MCP URL
  是**部署期参数**（恒真）所以规则恒建，参数留空时预热每天空转一次（BFF 见 URL 为空
  立即返回 not-configured，不发任何 AWS 调用）；方式 B 只在传了 `-c costAgentMcpUrl`
  时才建这条规则。
