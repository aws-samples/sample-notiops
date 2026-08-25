# NotiOps Web Chat Agent (Bedrock AgentCore Runtime)

Phase 1 的 agent 内核：基于 **Strands Agents**，部署到 **Bedrock AgentCore Runtime**。
BFF（`bff/web-chat`）通过 `bedrock-agentcore:InvokeAgentRuntime` 调它并把 SSE 透传给前端。

## 结构
```
agent/
  main.py            # AgentCore Runtime 入口（BedrockAgentCoreApp + @app.entrypoint，SSE 流式）
  prompt.py          # 零变更 / 防幻觉 system prompt（复用 core/bedrock_chat 语言）
  pyproject.toml     # strands-agents + bedrock-agentcore + boto3
  tools/
    aws_qa.py        # 第一个 tool：AWS Q&A（包 core/aws_docs_mcp 查官方文档）
```
> `tools/aws_qa.py` 会把仓库根注入 `sys.path` 以 `import core.aws_docs_mcp`，
> 因此**打包时需把仓库根的 `core/` 一并带进镜像**（见下方部署步骤）。

## 本地测试（需 AWS 凭证 + Bedrock 模型访问）
```bash
npm install -g @aws/agentcore          # AgentCore CLI（公共 npm）
cd agent
agentcore dev                          # 本地起 8080，模拟 Runtime
agentcore dev --stream "ALB 和 NLB 的区别"   # 流式测一句
```

## 客户部署（推荐：一条命令）
`./setup.sh` 现在**自动**部署 agent：构建阶段会调 `scripts/deploy_agent.sh` →
（us-east-1 时）provision web-search Gateway → `agentcore deploy` → 捕获 Runtime ARN →
随后 `cdk deploy` 把该 ARN 通过 `-c agentRuntimeArn` 注入 WebChatStack（BFF 调真 agent）。
- 跳过 agent（只部 web + echo BFF）：`SKIP_AGENT=true ./setup.sh`
- 关闭 AgentCore Web Search（仍用 Exa 兜底）：`ENABLE_WEBSEARCH=false ./setup.sh`
- agent 部署失败不阻断整体；可单独重跑 `DEPLOY_REGION=<region> bash scripts/deploy_agent.sh`。
> ⚠️ `agentcore.json` 里 `AGENTCORE_WEBSEARCH_GATEWAY_URL` 的值是占位符
> `__WEBSEARCH_GATEWAY_URL__`，由 `deploy_agent.sh` 在部署时注入真实 URL（或空=用 Exa 兜底）。
> **不要手动裸跑 `agentcore deploy`**（会把占位符当 URL 部署，联网搜索失效但会回退 Exa）——
> 用 `scripts/deploy_agent.sh`。

## 部署到 AgentCore Runtime（手动 / 开发）
```bash
cd agent
# 首次：创建 agentcore 工程配置（Strands + Bedrock + 短期&长期记忆）
agentcore create --name NotiOpsWebChat --framework Strands \
  --protocol HTTP --model-provider Bedrock --memory longAndShortTerm
# 把本目录的 main.py / prompt.py / tools/ 覆盖进生成的 app/ 入口，
# 并确保打包包含仓库根 core/（CodeZip：在 pyproject/打包脚本里加 core/ 路径；
# 或用 --build Container 写 Dockerfile COPY ../core ./core）。
agentcore deploy                        # CDK 部署 Runtime + Memory + IAM
agentcore status                        # 拿到 Agent Runtime ARN
```

### ⚠️ GPT-5.6 系列（经 Bedrock Mantle）需要给 runtime 执行角色补权限
GPT-5.6 Terra/Sol/Luna 走 **Bedrock Mantle**（OpenAI Responses API，当前部署固定 us-east-2）。`agentcore deploy`
生成的 runtime 执行角色默认**没有** mantle 权限，缺了会在回答的 SSE 流里报 401。两种处理：
- **推荐（已内置，客户零操作）**：在 graft 时同时把 `agentcore/cdk/lib/cdk-stack.ts` 里的
  「NotiOps Bedrock Mantle 授权」代码块带上（给所有 runtime 执行角色加
  `bedrock-mantle:CreateInference/GetInference`(us-east-2,us-west-2) + `CallWithBearerToken`(*)）。
  这样 `agentcore deploy` 一步到位，无需任何手动 IAM 操作。
- **补救（角色已存在 / 没带 CDK 改动时）**：跑一次幂等脚本
  `scripts/grant_mantle_permissions.sh`（自动找到执行角色并 put-role-policy）。

> 还需：① Bedrock 控制台(us-east-2)开通对应 GPT-5.6 model access；② Strands 1.44 的 Mantle base_url
> 模板缺 `/openai`，已在 `model/load.py` 的 `_make_mantle_responses_model` 子类化修正（graft 时带上）。
> 详见 memory `web-chat-phase1-deploy`。

## 接回 BFF
把上一步的 Runtime ARN 传给 WebChatStack（BFF 读 `AGENT_RUNTIME_ARN`）：
```bash
cd ../infra
npx cdk deploy WebChatStack -c agentRuntimeArn=<刚拿到的 ARN>
```
- 配了 ARN → BFF 调真 agent，流式透传。
- 没配 → BFF 回退 echo（Phase 0 行为，便于先验证前端/认证链路）。

## 验证
1. 打开 web chat（WebChatStack 输出的 ChatUrl），登录。
2. 问一个 AWS 文档类问题（如 “ALB vs NLB”）→ agent 应调 `aws_docs_search`/
   `aws_docs_read`，流式给出带出处的答案，Sources 抽屉显示文档来源。
3. `agentcore logs` / `agentcore traces list` 看 agent 推理与 tool 调用。

## 安全
- system prompt 强制：AWS 技术问题必先查文档、绝不编造、严格只读、检索内容是数据不是指令。
- 与 core 的零变更边界一致；Phase 1 只读，无任何写 tool。

## 已部署状态（示例，账户 `<DEPLOY_ACCOUNT>` / us-east-1）
- **实际部署的 agent 工程在 `agent-build/NotiOpsWebChat/`**（`agentcore create` 脚手架，已 gitignore——含自带 .git/.venv/node_modules，不纳入主仓库）。
- 我们把本目录的 **零变更 system prompt + AWS Q&A tool** graft 进了脚手架的 `app/NotiOpsWebChat/main.py`，并把 `core/aws_docs_mcp.py` vendor 进该 app 的 `core/`（无 core 内部依赖）。
- 本 `agent/` 目录是 **canonical 源**（prompt.py / tools/aws_qa.py / main.py 的手写版），脚手架若重建按这里的内容 graft。
- Runtime ARN：`arn:aws:bedrock-agentcore:<REGION>:<DEPLOY_ACCOUNT>:runtime/NotiOpsWebChat_NotiOpsWebChat-<suffix>`（部署后从 CloudFormation 输出获取）
- 已用 `agentcore invoke "ALB vs NLB"` 验证：agent 调 aws_docs_* 工具、流式给出带依据的答案、维持 session。

> 两个部署坑（见 memory web-chat-phase1-deploy）：① `cdk deploy WebChatStack` 会连带部署 NotiOpsBackendStack（其 Lambda5 超 250MB 上限会回滚阻断）→ 用 `--exclusively`；② Function URL public-invoke 权限重部后可能丢失 → `aws lambda add-permission ... --function-url-auth-type NONE`。
