# API 参考

所有接口需 Cognito JWT 认证。

## API 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/dashboard/summary` | 大盘概览 |
| GET | `/api/dashboard/pipeline` | 各阶段统计 |
| GET | `/api/waste-report` | 闲置资源列表 |
| GET | `/api/waste-report/export` | CSV 导出 |
| GET | `/api/waste-report/:id` | 实例详情 |
| GET | `/api/optimization-report` | 容量优化资源列表 |
| GET | `/api/optimization-report/export` | 容量优化 CSV 导出 |
| GET | `/api/optimization-report/:id` | 容量优化资源详情 |
| GET/POST/PATCH/DELETE | `/api/whitelist` | 白名单管理（含批量操作） |
| GET/POST/PUT/DELETE | `/api/threshold-config` | 阈值配置 |
| GET/POST/PUT/DELETE | `/api/target-accounts` | 目标账户管理 |
| GET | `/api/ec2-underutilized` | EC2 低利用率列表 |
| GET | `/api/ec2-underutilized/export` | EC2 低利用率 CSV 导出 |
| GET | `/api/ec2-underutilized/:id` | EC2 低利用率详情 |
| GET | `/api/rds-health-check` | RDS AI 巡检报告列表 |
| GET | `/api/rds-health-check/latest` | 最新 RDS summary 报告 |
| GET | `/api/rds-health-check/:id` | RDS 巡检报告详情 |
| POST | `/api/rds-health-check/trigger` | 手动触发 RDS AI 巡检 |
| DELETE | `/api/rds-health-check/batch` | 批量删除 RDS 巡检报告 |
| GET/PUT | `/api/rds-health-check/config` | RDS AI 巡检配置（Prompt / Model ID） |
| GET | `/api/rds-health-check/models` | 可用模型列表（provider-aware：`provider=litellm` 时返回 LiteLLM 模型，否则返回 Bedrock 模型） |
| GET | `/api/elasticache-health-check` | ElastiCache AI 巡检报告列表 |
| GET | `/api/elasticache-health-check/latest` | 最新 ElastiCache summary 报告 |
| GET | `/api/elasticache-health-check/:id` | ElastiCache 巡检报告详情 |
| POST | `/api/elasticache-health-check/trigger` | 手动触发 ElastiCache AI 巡检 |
| DELETE | `/api/elasticache-health-check/batch` | 批量删除 ElastiCache 巡检报告 |
| GET/PUT | `/api/elasticache-health-check/config` | ElastiCache AI 巡检配置 |
| GET | `/api/elasticache-health-check/models` | 可用模型列表（provider-aware，与 RDS 共用 `_get_models`） |
| GET/POST/PATCH/DELETE | `/api/health-check-whitelist` | AI 巡检白名单管理（`VALID_RESOURCE_TYPES`: rds / ec2 / elasticache / ebs） |
| GET | `/api/health-check-whitelist/instances` | 被巡检的实例列表（排除已在白名单中的） |
| POST | `/api/health-check-whitelist/batch` | 批量添加白名单条目 |
| DELETE | `/api/health-check-whitelist/batch` | 批量删除白名单条目 |
| POST | `/api/pipeline/trigger` | 手动触发数据采集 |
| GET | `/api/pipeline/status` | 采集执行状态 |
| GET/PUT | `/api/notification-config` | 飞书定时推送通知配置（仅飞书，拒绝非 feishu platform） |
| POST | `/api/notification-config/test` | 发送测试通知消息（仅飞书） |
| POST | `/api/cost-anomaly/save` | 保存 Lambda5 成本异常分析结果（UPSERT） |
| GET/PUT | `/api/agent-config` | Agent 模型 ID 动态配置（SSM Parameter Store） |
| GET | `/api/agent-config/models` | 可选模型列表（provider-aware：ListInferenceProfiles + ListFoundationModels 合并 / LiteLLM 模型） |
| GET/POST/PUT/DELETE | `/api/devops-agent/accounts` | DevOps Agent 多账户管理（CRUD + 上车模板 / 测试连接 / 启用） |
| GET | `/api/devops-agent/investigations` | DevOps Agent 调查历史（列表 + 详情；详情返回 `report_content`，从 S3 `report_md_key` 读取，旧行 `summary_raw` 兼容回退） |
| GET/PUT | `/api/devops-agent/config` | DevOps Agent Summarizer 模型 ID / Prompt 配置 |
| GET | `/api/system-config/llm-provider` | 当前 LLM Provider + LiteLLM 概况（api_key 脱敏） |
| PUT | `/api/system-config/llm-provider` | 切换 Provider（写 SSM Parameter，bedrock / litellm） |
| PUT | `/api/system-config/litellm-config` | 更新 LiteLLM 凭证（base_url / api_key / default_model）。base_url 禁止指向内网地址（localhost / RFC-1918 / link-local / .internal / .local），防止 SSRF |
| POST | `/api/system-config/litellm-test` | LiteLLM 拨号测试（不入库） |
| GET | `/api/system-config/litellm-models` | 从 LiteLLM Proxy `/v1/models` 拉取可用模型列表（过滤 dev fixture / 非 chat 模型） |
| GET | `/api/system-config/bedrock-models` | 从 Bedrock SDK 拉取原生模型列表（不跟随全局 Provider，始终返回 Bedrock 模型） |

> 顶层 16 个 `handle_*` 入口函数在 `api/handler.py::ROUTE_MAP` 中注册，具体 sub-routes 由各 handler 内部分发。完整分发逻辑参考 `api/routes/` 对应文件。

## 前端页面

| 路径 | 功能 |
|------|------|
| `/login` | Cognito 登录 |
| `/` | 数据大盘（Dashboard），手动采集触发 |
| `/waste-report` | 闲置资源报告总览 |
| `/waste-report/rds` | RDS 闲置资源 |
| `/waste-report/elasticache` | ElastiCache 闲置资源 |
| `/waste-report/:id` | 实例详情 + 判定过程 |
| `/waste-report/ec2` | EC2 低利用率报告 |
| `/optimization-report` | 容量优化报告总览 |
| `/optimization-report/rds` | RDS 容量优化 |
| `/optimization-report/elasticache` | ElastiCache 容量优化 |
| `/rds-health-check` | RDS AI 巡检报告列表 |
| `/rds-health-check/:id` | RDS 巡检报告详情 |
| `/rds-health-check/settings` | RDS 巡检设置（Prompt / Model） |
| `/elasticache-health-check` | ElastiCache AI 巡检报告列表 |
| `/elasticache-health-check/:id` | ElastiCache 巡检报告详情 |
| `/whitelist` | 白名单管理 |
| `/settings/thresholds` | 阈值配置 |
| `/settings/accounts` | 目标账户管理 |
| `/settings/ai-config` | AI 配置 Tab 页（Agent 模型 / DevOps Agent Summarizer / LLM Provider 管理） |
| `/settings/notifications` | 定时推送通知配置 |
| `/settings/devops-agent-accounts` | DevOps Agent 多账户管理（上车 / 测试连接 / 启用） |
| `/devops-agent-investigations` | DevOps Agent 调查历史列表 + 详情（markdown 渲染） |
| `/help` | 帮助中心 |

> 页面文件位于 `frontend/frontend-app/src/pages/`。

## 阈值配置

通过 Dashboard「阈值配置」页面管理（对应 `/api/threshold-config`）。阈值按资源类型分别维护，支持 Tag 级覆盖。

### RDS 阈值

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `candidate_cpu` | 2.0% | CPU 低于此值视为疑似闲置 |
| `candidate_connections` | 5 | 连接数低于此值视为疑似闲置 |
| `peak_cpu_veto` | 50.0% | 7 天峰值 CPU 高于此值 → 排除 |
| `iops` | 500 | 读 IOPS 高于此值 → 排除 |
| `write_iops` | 1000 | RDS WriteIOPS 高于此值 → 排除 |
| `free_storage_pct` | 0.40 | 存储空闲率阈值（路径 B：容量优化） |
| `cpu_max_veto` | 50 | CPU 最大值否决阈值（路径 B） |

### ElastiCache 阈值

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `candidate_cpu` | 2.0% | CPU 低于此值视为疑似闲置 |
| `candidate_connections` | 5 | 连接数低于此值视为疑似闲置 |
| `peak_cpu_veto` | 50.0% | 7 天峰值 CPU 高于此值 → 排除 |
| `evictions` | 0 | Evictions 大于此值 → 排除 |
| `requests_sum` | 1000 | 请求总量高于此值 → 排除 |
| `swap_max_gb` | 0.01 GB | Swap 使用超过此值 → 排除（路径 B） |
| `memory_util_max` | 30 | 内存利用率高于此值 → 排除（路径 B） |
| `conn_max` | 10 | 最大连接数高于此值 → 排除（路径 B） |

> 默认值来源：`lambda1_collector/threshold.py::_FALLBACK_DEFAULTS`。实际运行时优先读 `threshold_config` 表，未配置时 fallback 到这套默认值。
