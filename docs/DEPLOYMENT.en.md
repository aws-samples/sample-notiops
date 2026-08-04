# NotiOps — Deployment Guide

> ⚠️ **Disclaimer**: This is sample code, for non-production usage. You should work with your security and legal teams to meet your organizational security, regulatory and compliance requirements before deployment. It is provided for educational/reference purposes and is not a production-ready product.

> 🌐 **Language**: [中文](DEPLOYMENT.md) · [English](DEPLOYMENT.en.md)
>
> **Audience**: Ops / DevOps engineers deploying this system for the first time.
>
> **Expected duration**: **~30 min via §0 Quick Deploy** / ~2 hours for the full walkthrough.
>
> **Companion docs**:
> - [USER_GUIDE.md](USER_GUIDE.md) — end-user usage guide

**Version**: v3.0 · 2026-06-09 (post-fusion CDK rewrite)

> Deploy entry point: `./setup.sh` (interactive CDK deploy). The original `deploy.sh` / SAM workflow has been retired.

---

## Table of Contents

- **§0 [Quick Deploy (TL;DR)](#0-quick-deploy-tldr)** — skip the prose, just run this
- §1 [Deployment Architecture](#1-deployment-architecture)
- §2 [Prerequisites](#2-prerequisites)
- §3 [Register IM Apps](#3-register-im-apps) (Feishu / Slack)
- §4 [Configuration & IM Credentials](#4-configuration--im-credentials)
- §5 [One-Command Deploy `setup.sh`](#5-one-command-deploy-setupsh)
- §6 [Smoke Tests](#6-smoke-tests)
- §7 [Enable / Tune Push Mode](#7-enable--tune-push-mode)
- §8 [Day-2 Operations](#8-day-2-operations)
- §9 [Rollback Strategy](#9-rollback-strategy)
- §10 [Top 5 Deployment Errors](#10-top-5-deployment-errors)
- §11 [Full Parameter Reference](#11-full-parameter-reference)
- **§12 [Web Chat Deployment](#12-web-chat-deployment)** — the browser-based agentic AI assistant, independent of the IM bot
- **§13 [CUR + Athena FinOps Data Source](#13-cur--athena-finops-data-source)** — cost-detail data source for the FinOps dashboard (optional; two paths: reuse an existing CUR = ready in minutes / new CUR = ~24h first delivery)

---

## 0. Quick Deploy (TL;DR)

> For "get it running first, read details later". All commands assume you've already finished §2 Prerequisites. The web console (browser chat) deploys by default and is the product's main entry; IM (Feishu / Slack) is an optional supplement — only walk §3 Register IM Apps if you want to enable it.

### 0.1 One-command deploy

```bash
./setup.sh
```

The first run is **interactive**: confirm AWS account + region → (optional) PHD event forwarding → **pick which IM platforms to deploy (default `0` = skip, web UI only; pick Feishu / Slack only if you want IM)** → build frontends (admin console + chat-app) → deploy the Web Chat Agent (AgentCore Runtime) → CDK bootstrap → CDK synth → CDK deploy `--all`. **Web Chat + the backend agent deploy by default.** IM credentials are **not** collected here — CDK creates **empty** secrets, and you fill them in *after* deploy (see §4 / §5).

> **About DingTalk**: `bot-stack.ts` still defines `DingtalkBotService` (adapter code retained), but v1 `setup.sh` doesn't surface the option → `enabledPlatforms` never includes `dingtalk` → DingTalk task `desiredCount=0`, doesn't run, no Fargate cost. v2 ships the dual-robot credential flow.

Three stacks land (one shot via `cdk deploy --all`):
- `NotiOpsBackendStack` — shared backend (DDB, 5 Lambdas, S3 report bucket, EventBridge rules)
- `WebChatStack` — the browser-based agentic AI assistant (**deployed by default**; BFF Lambda + Function URL, single DDB table `notiops-web-chat`, static frontend, notification handler)
- `BotStack` — IM bot platform stack (VPC, ECS Cluster at 512 CPU / 1024 MB per task, one Fargate Service per selected platform + ECR; **each task bundles pricing + cost MCP sidecars**). **If no IM is selected, this stack still deploys but every bot runs at `desiredCount=0` — no containers, no cost.**

Re-running `./setup.sh` only patches deltas (existing stacks go through `cdk diff`; images rebuild only if changed).

### 0.1.1 After deploy: what works out of the box vs what needs one more step

Once `setup.sh` finishes, split features into two buckets — **don't mistake "only inspection needs it" config for "the whole product needs it":**

| | Whole product **works out of the box** (no extra config) | **Only** these features need one more step |
|---|---|---|
| **Feature** | Web Chat: AWS Q&A · investigation · cost analysis · Support cases · Skills · notifications (Health / alert push) | Idle-resource detection + **automatic cost inspection** (notiops daily scan) |
| **Default target** | **The deploy account itself**, usable right after login | Must add `Account ID + Role ARN + Region` under the Dashboard "Target Accounts" page |
| **If not configured** | — | Inspection **idles** (no accounts to scan), but **Web Chat is completely unaffected** |

> In one line: **just chatting in Web Chat → log in and go, nothing to configure**; to use **idle / automatic cost inspection** (or the future proactive-sentinel cross-account scheduled scans) → you then add accounts under "Target Accounts". Cross-account inspection also needs a read-only `notiops-idle-detection-role` pre-created in the target account — for Organizations, use `./setup.sh --multi-account` to roll it out via StackSets (including DevOps/PHD event forwarding), or onboard in one click from the console "Account Onboarding (Organizations)" page; for non-org setups, manually deploy [`infra/member-account-onboarding.yaml`](../infra/member-account-onboarding.yaml) in the target account.

### 0.2 Verify

**Primary verification — open Web Chat (the single main entry)**: when the script finishes it prints the Web Chat URL plus the `admin` user and a temporary password (and calls it "the single main entry"). Open that URL in a browser, log in as `admin` with the temp password (change it on first login), ask anything (e.g. "list EC2 in this account") and you should get a reply.

```
Open the Web Chat URL printed at the end of the script → log in as admin / temp password → send a question
```

**Only if you enabled an IM platform** (Feishu / Slack), also @bot in the channel to verify:

```bash
# In your Feishu / Slack channel, @bot a message (fill that platform's credentials first — see §4 / §5):
@NotiOps hello
```

Expect a reply within seconds. If nothing → §6 Smoke Tests / §10 Troubleshooting.

✅ **Done**.

---

## 1. Deployment Architecture

CDK deploys three stacks in one shot via `cdk deploy --all`. **Web Chat (the browser-based main entry) and the AgentCore agent that backs it deploy by default** — `setup.sh` first builds the chat-app frontend, runs `scripts/deploy_agent.sh` to deploy the agent, then runs `cdk deploy --all`:

| Stack (CDK name) | Required | Contents |
|---|---|---|
| **`notiops-*`** | ✅ Required | 5 Lambdas (collector / analyzer / health-checker / notifier / cost-analyzer), shared DDB tables, S3 report bucket, EventBridge rules (6 push sources + notiops schedules), agent-trigger Role (for STS AssumeRole) |
| **`WebChatStack`** | ✅ Deployed by default | The browser-based agentic AI assistant (**the product's main entry**): BFF Lambda (`notiops-web-chat-bff`) + Function URL (`AWS_IAM`), single DDB table `notiops-web-chat` (sessions/messages + notification inbox), static frontend (chat-app), notification handler. The BFF gets the previous step's agent Runtime ARN injected via `-c agentRuntimeArn` |
| **`BotStack`** | ✅ Deployed (IM optional) | VPC + public subnets, ECS Cluster (512 CPU / 1024 MB per task), ECR repo, one Fargate Service per selected IM platform (v1: Feishu / Slack), **each task bundles pricing + cost MCP sidecars**, Task Role, Security Group. **If no IM is selected the stack still deploys, but every bot runs at `desiredCount=0` — no containers, no cost** |

**Deployment order** (handled automatically by `./setup.sh`):
```
./setup.sh (interactive: region / optional PHD / [IM skipped by default])
   → build frontends (admin console + chat-app) → deploy Web Chat Agent → cdk deploy --all
(optional) to enable IM: §3 Register an IM app first, then re-run setup.sh and pick the platform
```

Credential flow: `setup.sh` **does not collect IM credentials** — it only sets the `enabledPlatforms` flag based on your selection. CDK creates **empty** secrets (`notiops/im-bot-feishu` / `notiops/slack-bot-token` / `notiops/slack-app-token`); after deploy you fill them in via the Web Chat admin console "Notifications" settings, or directly in Secrets Manager followed by a forced restart of the matching ECS service (see §4). CDK stacks always reference the secrets by ARN. **Nothing is persisted to disk locally.**

---

## 2. Prerequisites

### 2.1 Required tools

| Item | Requirement | Check |
|---|---|---|
| AWS CLI v2 | ≥ 2.13 (Bedrock support) | `aws --version` |
| ~~AWS SAM CLI~~ | ~~≥ 1.100~~ | ~~`sam --version`~~ *(retired — CDK deploy doesn't need SAM CLI)* |
| Node.js | ≥ 22 | `node --version` *(CDK runtime)* |
| Container build tool | finch (recommended) / docker | `finch version` |
| jq | any version | `jq --version` |
| Python 3.12+ (local builds) | — | `python3 --version` |

### 2.2 AWS account preparation

- **AWS account**: admin or equivalent permissions
- **VPC**: any VPC capable of running ECS Fargate + ≥ 2 AZs of public subnets (**only needed if you enable the IM bot** — Fargate tasks reach IM APIs over the public internet; ignore for web-only)
- **AWS DevOps Agent**: enabled (required for deep investigation). **No need to bring your own Agent Space** — CDK auto-creates one named `notiops-devops-<account>` in your account (see §5.3.4); you don't pre-create one or supply a space id
- **Bedrock**: the `us.anthropic.claude-sonnet-4-6` inference profile is enabled in your region (Bedrock console → Model access)

### 2.3 Region selection

Different components have different region constraints — plan ahead:

| Component | Allowed regions | Notes |
|---|---|---|
| **AWS DevOps Agent service** | **`us-east-1` only** | AWS service constraint (single-region preview) |
| **Shared backend Lambda stack** | **strongly recommended `us-east-1`** | Polls DevOps Agent journal API; cross-region adds latency and IAM complexity |
| **Feishu / Slack ECS bot stack** | any AWS region | No hard constraint; pick what's nearest your users |
| **Bedrock** | any region with `claude-sonnet-4-6` enabled | Override via `BedrockRegion` parameter; can differ from the runtime region |
| **DDB / S3 / ECR** | follows Lambda / ECS region | Created in the same region as the stack |

**Simplest deploy**: the `setup.sh` region menu defaults to `1) ap-northeast-1` (Tokyo); just press Enter to use it. DevOps Agent service capabilities still assume `us-east-1` (see the table above).

**Multi-region**: ECS bot in (say) `ap-southeast-1` for proximity, Lambda + DevOps Agent stay in `us-east-1`. The `DevOpsAgentRegion` CFN parameter (default `us-east-1`) controls which region appears in the IAM Resource ARN for journal-read permissions.

### 2.4 IAM deployment permissions

The deploying IAM user / role needs:
- `cloudformation:*` (deploy / rollback)
- `iam:*` + `ecr:*` + `ecs:*` + `lambda:*` (create stack resources)
- `secretsmanager:*` (create secrets)
- `dynamodb:CreateTable`, `s3:CreateBucket`, `events:PutRule`

> 💡 **Production safety**: every AWS resource created by this project carries the `auto-delete=no` tag by default to protect it from automated cleanup jobs.

---

## 3. Register IM Apps

> Skip the subsection that doesn't apply if you're only deploying one platform.

### 3.1 Feishu enterprise self-built app

1. Visit the [Feishu Open Platform](https://open.feishu.cn/) and sign in with an enterprise admin account
2. **Developer Console → Create Enterprise Self-Built App** → fill in a name (e.g. NotiOps)
3. **App Features → Bot → Enable**, set the bot display name
4. **Events & Callbacks → Long Connection** → **Enable long-connection mode** (no public endpoint required)
5. **Subscribe to events** (click + to add):
   - `im.message.receive_v1` — receive user messages
   - `card.action.trigger` — card button click callbacks
6. **Permissions → Add permissions**:
   - `im:message` / `im:message:send_as_bot` / `im:message:reply` / `im:chat` / `im:chat:readonly`
7. **Versioning & Release → Create new version** → submit for release (self-built app admin can self-approve)
8. **Save** the App ID + App Secret — `setup.sh` does **not** ask for credentials; after deploy, fill them in via the **Web Chat admin console "Notifications" settings** (or edit the `notiops/im-bot-feishu` secret directly and force-restart the ECS service). See §4 / §5
9. **Add the bot to your channel.** If you want proactive push (Health / alerts, etc.) delivered to a group, grab that group's `chat_id` first:

```bash
# First fetch a tenant_access_token
curl -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
  -H 'Content-Type: application/json' \
  -d '{"app_id":"'$FEISHU_APP_ID'","app_secret":"'$FEISHU_APP_SECRET'"}'

# List chats and note the target chat_id (starts with oc_)
curl 'https://open.feishu.cn/open-apis/im/v1/chats' \
  -H 'Authorization: Bearer <tenant_access_token>' | jq '.data.items[]'
```
Later put this `chat_id` into the Feishu secret's `notify_chat_ids` (or configure it in the Web Chat admin "Notifications" settings) — it is **not** a `setup.sh` prompt (optional; leave empty to disable push delivery).

### 3.2 Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From scratch**
2. **Settings → Socket Mode** → enable, generate an App-Level Token (scope `connections:write`)
3. **OAuth & Permissions → Bot Token Scopes** → add:
   - `app_mentions:read` / `channels:history` / `channels:read` / `chat:write` / `chat:write.public`
   - `groups:history` / `im:history` / `im:write` / `users:read`
4. **Event Subscriptions → Enable Events: ON** → **Subscribe to bot events**:
   - `app_mention` / `message.channels` / `message.groups` / `message.im`
5. **Install App → Install to Workspace**, grab the Bot Token (`xoxb-...`)
6. **Save** the Bot Token + App Token — `setup.sh` does **not** ask for credentials; after deploy, fill them in via the **Web Chat admin console "Notifications" settings** (or edit the `notiops/slack-bot-token` / `notiops/slack-app-token` secrets directly and force-restart the ECS service). See §4 / §5
7. In the target channel run `/invite @YourBot`, then open the channel settings panel to copy the **Channel ID** (`C...`). To enable proactive push, put this Channel ID in the notification settings (it is **not** a `setup.sh` prompt)

### 3.3 DingTalk Internal H5 App — **v2 only**

> ⏳ **DingTalk is not exposed in v1**. `setup.sh` doesn't show a DingTalk option; even if you register the app following the steps below, there's nowhere to paste the credentials. The instructions stay here as v2 preview reading.
>
> Adapter code + sender are fully preserved in `platforms/dingtalk/` and `shared/report_delivery/dingtalk_sender.py`. v2 unlocks `setup.sh` interactive credential capture + dual-robot configuration automation.

1. Visit [open-dev.dingtalk.com](https://open-dev.dingtalk.com/) → pick your enterprise → **应用开发 → 钉钉应用** (App Development → DingTalk Apps)
2. **Create app**: choose **Internal H5 app** type. Do NOT pick "custom robot — webhook only" — that's a one-way robot that can't receive replies.
3. In the app detail page:
   - **Credentials & Basic Info** → copy **AppKey** / **AppSecret** (⏳ v2 only: you'll put these into a manually-created DingTalk secret then; v1 `setup.sh` collects no IM credentials)
   - **Capabilities → Robot** → enable → set message-receive mode to **Stream Mode**
   - **Permissions** → add at minimum: `Robot receive messages` / `Robot send messages` / `IM group message read/write`
4. **Publish the app** (visible inside your enterprise is enough; no need to publish to the marketplace)
5. **Add the robot to the target group**: in the group → group settings → group robots → add robot → pick the app you just published
6. **(Optional but required for Lambda → DingTalk report writeback)** Add a SECOND robot — a **custom robot** (自定义机器人) — to the same group, coexisting with the H5-app robot:
   - In the target group: **群设置 → 群机器人 → 添加机器人 → 自定义** (group settings → group robots → add → custom)
   - Pick **加签 (HMAC sign)** as the security setting (recommended) — copy the generated secret
   - Copy the webhook URL + (recommended) the 加签 secret — `./setup.sh` will prompt for both at deploy time, just paste them in (⏳ v2 only; v2 writes them to the manually-created DingTalk secret)
   - **Skipping this step**: Phase 1 chat / dispatch still works, but **investigation reports won't auto-write back to the DingTalk group**; users must visit Operator Home directly.
   - Why TWO robots: DingTalk splits inbound vs outbound across two robot classes. The **H5-app Stream-Mode robot** receives + replies (using the per-message `session_webhook`); the **custom robot** receives the AWS Lambda push (using its own webhook URL). Both live in the same group; from the user's perspective it's one bot.

> The DingTalk robot **needs no public ingress**, identical to Feishu / Slack: Stream Mode is an outbound long-poll initiated from the bot's ECS task. Friendly to your IT security review.

---

## 4. Configuration & IM Credentials

CDK deployment doesn't need `bootstrap.env` — `./setup.sh` walks you through the deploy parameters on first run (account / region / whether to deploy PHD / whether to pick an IM platform). **Note: `setup.sh` collects no IM credentials** — CDK only creates **empty** IM secrets, and you fill them in *after* deploy (see §4.2).

### 4.1 What setup.sh asks you for

| Category | Item | Notes |
|---|---|---|
| **AWS Profile** | Deploy profile | Pick from your local `~/.aws` profile list, or keep the current one |
| **AWS** | Account ID | Auto-detected from `aws sts get-caller-identity`; just confirm |
| | Region | 6 options (`ap-northeast-1` [default] / `us-east-1` / `us-west-2` / `eu-west-1` / `ap-southeast-1` / custom input); DevOps Agent service capabilities assume `us-east-1`, other stacks can be anywhere |
| **Push (PHD)** | Deploy PHD event forwarding | Defaults to `Y`; the `--phd` flag handles linked-account-side forwarding |
| **Multi-account** | Business account allowlist | Triggered separately via `--multi-account`; single-account by default |
| **IM platforms** (optional, skipped by default) | Choice | `0` skip (default, web UI only) / `1` Feishu / `2` Slack (multi-select). **Only sets the `enabledPlatforms` flag — no credential prompt** |

> **Agent Space id is not a prompt** — CDK auto-creates `notiops-devops-<account>` (see §5.3.4); you don't supply one.

### 4.2 Where IM credentials live / when you fill them

At deploy time CDK creates **empty** IM secrets; you fill the credentials in **after deploy**, two ways (the script's completion banner also points here):
- **Option A (recommended)**: log in to Web Chat (admin) → left menu "More → Inspections & Reports" opens the console → "Settings → Notifications" → fill them in
- **Option B**: update the secret below directly, then force-restart the matching ECS service to load the new credentials:
  `aws ecs update-service --cluster <BotStack-cluster> --service <service> --force-new-deployment`

CDK stacks always reference the secrets by ARN. **No credential files on the local disk.**

| Auto-created Secret (empty initially) | Purpose |
|---|---|
| `notiops/im-bot-feishu` | Feishu bot credentials (single secret, JSON: `app_id` / `app_secret` / `verification_token` / `encrypt_key` / `notify_chat_ids`) |
| `notiops/slack-bot-token` | Slack bot token (`xoxb-`) |
| `notiops/slack-app-token` | Slack app-level token (`xapp-`, Socket Mode) |
| `notiops/bedrock-api-key` | Bedrock API Key (cross-account model-invocation auth; populated manually post-deploy, leave empty to use IAM) |
| `notiops/litellm-config` | LiteLLM credentials (JSON: `base_url` / `api_key` / `default_model`; only if you use LiteLLM) |

> DingTalk secrets (`notiops/dingtalk-app-key` / `notiops/dingtalk-app-secret`) are **NOT created by CDK** — bot-stack references them but you must `create-secret` manually (⏳ v2 wires this into `setup.sh`). There is **no `bot-stack-*/` secret prefix, and no `notiops/devops-agent-config`** (Agent Space id and other metadata live in the DDB onboard record + CDK context, not a secret).

### 4.3 Optional overrides (change defaults)

Edit `infra/cdk.json` directly, or pass `-c key=value` to `cdk deploy`:

| Context | Default | Notes |
|---|---|---|
| `bedrockModelId` | `us.anthropic.claude-sonnet-4-6` | LLM inference profile |
| `agenticChatMode` | `enabled` | `disabled` / `qa_only` / `enabled` |
| `awsMcpMode` | `docs_only` | `disabled` / `docs_only` |
| `enableMcpPricing` | `true` | Pricing MCP sidecar master switch |
| `defaultLocale` | `en` | `zh` / `en` |
| `defaultLlmProvider` | `claude` | `claude` / `nova` / `gpt` |
| `allowedOrigins` | (empty = all origins) | Comma-separated CORS allow-list, e.g. `https://d123.cloudfront.net` |

> **⚠️ Tighten CORS (recommended for production)**: every endpoint on both the REST API
> and the Web Chat Function URL is already authenticated (Cognito / AWS_IAM SigV4), so the
> browser CORS policy is not the primary trust boundary. The default therefore **falls back
> to all origins** (`*`) so the sample repo works out of the box without pre-knowing the
> CloudFront domain that is only generated at deploy time. Production deployments should
> narrow it explicitly: `cdk deploy ... -c allowedOrigins=https://<your-frontend-domain>`.
> When it is not set, `cdk synth`/`deploy` prints a warning nudging you to tighten it — this
> is a defense-in-depth best practice and does not affect functionality.

---

## 5. One-Command Deploy `setup.sh`

```bash
./setup.sh
```

After §2 prerequisites (and §3 IM-app registration only if you want IM), this single line is all you need.

### 5.1 What setup.sh actually does

1. Dependency check: `node` ≥ 22 / `npm` / `npx cdk` / `aws` / `jq` / `python3`. **The container build tool (`finch` or `docker`) is optional** — required only if you chose to deploy an IM platform (the IM bot's ECS image builds locally); not needed for web-only
2. Lets you pick a deploy Profile from your local `~/.aws` profile list (or keep the current one)
3. `aws sts get-caller-identity` to detect the account, prompts you to confirm
4. Lets you pick a deploy region from 6 options (default `ap-northeast-1`; includes a "custom input" choice)
5. (Optional) asks whether to deploy PHD event forwarding (default `Y`)
6. Asks which IM platforms to deploy (**default `0` = skip, web UI only**; `1` Feishu / `2` Slack, multi-select). **Only sets the `enabledPlatforms` flag — does not collect credentials**
7. **`[1/4]` Build frontends** — builds **both** the admin console (`frontend/frontend-app`) **and** the Web Chat frontend (`frontend/chat-app`)
8. **Deploy the Web Chat Agent** — runs `scripts/deploy_agent.sh` to deploy the Strands agent onto AgentCore Runtime and get the Runtime ARN (injected into WebChatStack via `-c agentRuntimeArn`; `SKIP_AGENT=true` skips it and the BFF falls back to echo)
9. **`[2/4]` Install Lambda deps** (boto3 / powertools / jinja2, `--platform manylinux2014_x86_64` for Linux binaries)
10. CDK bootstrap (if the target account + region isn't bootstrapped yet; reused if already bootstrapped + healthy)
11. **`[3/4]`** CDK synth → IAM consistency check → **CDK deploy `--all`** (`NotiOpsBackendStack` + `BotStack` + **`WebChatStack`**; the Docker build that pushes bot images to ECR fires only if you selected IM)
12. **CUR + Athena FinOps data source** guidance (detect / reuse / create new, see §13)
13. **Create the Cognito `admin` user + temp password** (first deploy) and add it to the admin group
14. **`[4/4]`** Writes outputs to `cdk-outputs.json` and prints a **Web-Chat-first** completion banner (Web Chat URL + `admin` login credentials at the top)

Total time: ~10-15 min on first run (mostly CDK deploy + agent deploy; add image build if you selected IM). Re-runs only patch deltas, ~3-5 min.

### 5.2 Specialized flows (when you don't need a full deploy)

| Task | Command |
|---|---|
| Deploy the PHD cross-account forwarder stack (run on the linked account) | `./setup.sh --phd` |
| Tear down the PHD stack above | `./setup.sh --phd --remove` |
| Configure the multi-account allowlist (so the bot can investigate cross-account) | `./setup.sh --multi-account` |

Common direct-CDK invocations:

```bash
cd infra

# Re-deploy after editing cdk.json context (no image rebuild)
npx cdk deploy --all

# Deploy a single stack
npx cdk deploy NotiOpsBackendStack
npx cdk deploy BotStack

# Diff to see what would change
npx cdk diff --all
```

### 5.3 ⚠️ Post-deploy must-read — Agent Space reconfiguration

After `./setup.sh` completes, CDK has **created a brand-new Agent Space** in your account (named `notiops-devops-<account_id>`). This space is **fresh and empty**, and the bot dispatches investigations **only against this one space** — it is **completely isolated** from any other Agent Spaces you already have in this account.

#### 5.3.1 Impact

If you already have other Agent Spaces (manually created or used by other projects), their configuration is **not** inherited by NotiOps. The new space comes with **only AWS-native service ReadOnly** (EC2 / RDS / Lambda / CloudWatch / Logs / IAM, via `AIDevOpsAgentAccessPolicy`); everything else needs to be reconfigured.

#### 5.3.2 What you may need to reconfigure

Walk through the list based on what your existing space has:

| Category | Affected? | How to reconfigure in the new space |
|---|---|---|
| **Third-party MCP servers** (Grafana / Datadog / Splunk / PagerDuty / Slack / Jira / GitHub / custom) | ✅ Yes | DevOps Agent Console → Agent Spaces → pick `notiops-devops-<account_id>` → MCP Servers → Add → enter endpoint + credentials |
| **Custom Skills / Playbooks** (your scripted diagnostic steps) | ✅ Yes | Same path → Skills → Import / re-create |
| **Extended IAM data sources** (DB ReadOnly / S3 ReadOnly / private service ReadOnly) | ✅ Yes | Find IAM Role `notiops-agent-primary-<account_id>` → add inline policy granting the required ReadOnly |
| **Cross-region resource access** | ✅ Yes | Primary role's default policy covers the deploy region only; verify other regions yourself |
| **Cross-account onboarding** (investigate resources in other business accounts) | ✅ Yes | Business accounts need a `notiops-agent-trigger-<account_id>` role deployed + a row registered in NotiOps's config DDB (use `./setup.sh --multi-account`, or the console "Account Onboarding" page) |
| **AWS-native ReadOnly** (EC2 / RDS / Lambda / CloudWatch ...) | ❌ Not affected | `AIDevOpsAgentAccessPolicy` is auto-attached, ready out of the box |

#### 5.3.3 Recommended minimal verification

```bash
# 1. Open the DevOps Agent Console, locate your new space
#    https://console.aws.amazon.com/aidevops/home#/agent-spaces
#    Name starts with `notiops-devops-` — that's the one NotiOps created

# 2. @bot the simplest AWS-native investigation, verify out-of-box permissions
#    @NotiOps list all EC2 instances in IAD
#    Card lands within seconds = deploy-account wiring is good

# 3. If you previously configured Grafana / custom skills in another space,
#    repeat: console → new space → re-add each item
```

#### 5.3.4 Why we don't reuse your existing space

The CDK template uses `CfnAgentSpace` to **create a new one**, by design:

- ✅ **Zero configuration**: a fresh customer running `./setup.sh` gets Agent Space + Trigger Role + Association automatically wired
- ❌ **Side effect**: customers with existing spaces have to re-do that space's configuration in the new one (this section)

A future capability ("support reusing an existing Agent Space") would have `setup.sh` ask "do you have an existing Agent Space to reuse?" interactively. **Not supported today.**

---

## 6. Smoke Tests

> 💡 **How to find the actual resource names from your deploy**:
> ```bash
> # ECS cluster / service
> aws ecs list-clusters --region $AWS_REGION
> aws ecs list-services --cluster <cluster-arn> --region $AWS_REGION
>
> # CloudWatch log groups (start with /ecs/ or /aws/lambda/)
> aws logs describe-log-groups --region $AWS_REGION \
>   --query 'logGroups[?contains(logGroupName, `bot`) || contains(logGroupName, `notiops`)].logGroupName'
>
> # CloudFormation stack outputs (also written to cdk-outputs.json)
> cat infra/cdk-outputs.json
> ```
> Throughout the rest of the document, `<cluster>` / `<service>` / `<log-group>` are placeholders — substitute the actual names you found above.

Run these immediately after deploying:

### 6.0 Web Chat console (main entry — verify this first)

> Web Chat is the product's main entry and deploys by default; this is the **most important step**. IM (§6.1-6.3) only matters if you enabled the corresponding platform.

1. Open the **Web Chat URL** printed in the script's completion banner (or `jq -r '.WebChatStack.ChatUrl' infra/cdk-outputs.json`)
2. Log in as `admin` / the temp password the script printed (change it on first login)
3. Confirm the left nav shows: Notifications / Investigate / FinOps / Cases / Skills / More
4. Send a question or investigation request (e.g. "investigate EC2 in IAD") — a reply within seconds means success

For the fuller Web Chat smoke test, see §12.6.

### 6.1 ECS task is up (only if you enabled IM)

> §6.1-6.3 **apply only if you enabled an IM platform (Feishu / Slack)**. For web-only deploys the BotStack bots run at `desiredCount=0`, so the commands below print `0 0` — that's expected.

```bash
aws ecs describe-services --region $AWS_REGION \
  --cluster <cluster> \
  --services <service> \
  --query 'services[0].deployments[0].[runningCount,desiredCount,rolloutState]' \
  --output text
# Expected: 1   1   COMPLETED
```

### 6.2 Long connection / Socket Mode established

```bash
aws logs tail <log-group> --region $AWS_REGION --since 5m | \
  grep -E "Lark connected|Bolt app is running"
```

### 6.3 End-to-end

In the channel, @ the bot:
```
@NotiOps list all EC2 instances in IAD
```

Expected:
1. Within seconds, a **🚀 Start Investigation** edit card appears (three input fields + 💡 LLM dimension hint)
2. Click **🚀 Dispatch Investigation** → the card updates to **✅ Dispatched, ⏳ Investigation starting**
3. A few seconds later, an **🔭 Investigation Started** card + progress updates
4. After 1–3 minutes, a **📝 Report Summary** + **✅ Report** header card lands in the original channel

If it fails → §10 [Top 5 Deployment Errors](#10-top-5-deployment-errors).

### 6.4 Verify language switching

```
language        # show current language
language en     # switch to English
language zh     # switch back to Chinese
请帮我切换到英文  # natural-language switch is also supported
```

---

## 7. Enable / Tune Push Mode

> **Push mode** = AWS service events automatically trigger investigations and the bot pushes results to the channel. **By default the push-mode lambda does not send cards after deploy** (`PushTargetChatId` left empty); it must be turned on explicitly.

### 7.1 Enable push (fill in the chat ID)

`setup.sh` **does not ask** for a push target chat id (it only asks whether to deploy PHD event forwarding). To turn push on, set the target chat id after deploy:

```bash
# Edit infra/cdk.json — set pushTargetChatIds.<platform> to the chat id
$EDITOR infra/cdk.json
cd infra && npx cdk deploy NotiOpsBackendStack
```

> For Feishu you can also put the target group into the `notify_chat_ids` field of the `notiops/im-bot-feishu` secret, or configure it in the Web Chat admin "Notifications" settings.

### 7.2 Tune push event sources

6 independent toggles, **3 on / 3 off by default**:

| Parameter | Default | Description |
|---|---|---|
| `EnableCloudWatchAlarmPush` | ✅ `true` | CloudWatch alarm transitions to ALARM |
| `EnableHealthPush` | ✅ `true` | AWS Health events |
| `EnableBackupPush` | ✅ `true` | Backup job FAILED / EXPIRED / ABORTED |
| `EnableGuardDutyPush` | `false` | GuardDuty findings (severity ≥ `GuardDutyMinSeverity`, default 7) |
| `EnableCostAnomalyPush` | `false` | Cost Anomaly Detection (requires a monitor) |
| `EnableTrustedAdvisorPush` | `false` | TA ERROR-status changes (requires Business+ Support) |

Edit the corresponding boolean in `infra/cdk.json`, then:

```bash
# Example: enable GuardDuty with threshold 8
# infra/cdk.json:
#   "enableGuardDutyPush": true,
#   "guardDutyMinSeverity": 8
cd infra && npx cdk deploy NotiOpsBackendStack

# Example: disable Health push
# infra/cdk.json: "enableHealthPush": false
cd infra && npx cdk deploy NotiOpsBackendStack
```

### 7.3 Fully silent (record events but don't post cards)

Set `pushTargetChatIds` to empty for every platform:

```bash
# infra/cdk.json:
#   "pushTargetChatIds": { "feishu": "", "slack": "" }
cd infra && npx cdk deploy NotiOpsBackendStack
# Lambda short-circuits incoming events; EventBridge rules remain so logs still show event volume
```

### 7.4 Test push

```bash
aws events put-events --region $AWS_REGION --entries '[{
  "Source": "aws.cloudwatch",
  "DetailType": "CloudWatch Alarm State Change",
  "Detail": "{\"alarmName\":\"deploy-test\",\"state\":{\"value\":\"ALARM\",\"reason\":\"smoke test\"}}"
}]'
# Expected: ⚠️ Proactive Observation card lands in the channel within seconds
```

---

## 8. Day-2 Operations

### 8.1 Configuration changes (no image rebuild needed)

Edit the corresponding context in `infra/cdk.json`, then `npx cdk deploy <stack>`. ~2 min via ECS rolling update (no image rebuild):

| Change | Edit which context | Deploy which stack |
|---|---|---|
| Toggle chitchat mode | `agenticChatMode` | `bot-stack` |
| Toggle MCP mode | `awsMcpMode` | `bot-stack` |
| Change default language | `defaultLocale` | `bot-stack` |
| Edit chat_id allowlist | `allowedChatIds` (JSON array) | `bot-stack` |
| Change default LLM | `defaultLlmProvider` | `bot-stack` |
| Toggle a single push event source | `enable*Push` family | `notiops` |

### 8.2 Deploy new code

```bash
git pull
./setup.sh            # rebuilds images + cdk deploy --all
```

`setup.sh` skips unchanged resources on re-runs and only patches the diff.

### 8.3 Force task restart (no config change)

```bash
aws ecs update-service --region $AWS_REGION \
  --cluster <cluster> \
  --service <service> \
  --force-new-deployment
```

See §6 top for how to find the actual resource names.

### 8.4 Inspect logs

```bash
# Live tail
aws logs tail <log-group> --since 5m --follow

# Common filter patterns
aws logs tail <log-group> --since 1h --filter-pattern "intent_classify"   # intent classification
aws logs tail <log-group> --since 1h --filter-pattern "change-request"    # change-request interception
aws logs tail <log-group> --since 1h --filter-pattern "progress tick"     # progress polling
aws logs tail <log-group> --since 1h --filter-pattern "locale="           # locale resolution
```

### 8.5 DDB state lookup

The DDB table name is set by CDK; check `cdk-outputs.json` (see §6 top). Below assumes you found the table to be `<conv-table>`:

```bash
# Inspect event state
aws dynamodb get-item --table-name <conv-table> \
  --key '{"lookup_key":{"S":"event#<event_id>"}}'

# Clear a stale DM lock (when a user's language switch "doesn't seem to take effect")
aws dynamodb delete-item --table-name <conv-table> \
  --key '{"lookup_key":{"S":"locale#dm#feishu:<user_id>"}}'
```

---

## 9. Rollback Strategy

| Level | Action | Impact |
|---|---|---|
| **L1 disable a single feature** | Edit `infra/cdk.json` (e.g. `enableHealthPush: false`) → `cdk deploy NotiOpsBackendStack` | Single event source, ~2 min |
| **L2 disable a whole conversation tier** | Edit `agenticChatMode: "disabled"` → `cdk deploy BotStack` | chitchat / general_qa paths |
| **L3 roll back to previous image** | `cdk deploy BotStack` (CDK will roll the ECS service to the previous ECR digest) | Single platform, ~2 min |
| **L4 turn the bot off entirely** | `aws ecs update-service --desired-count 0 ...` | Single platform, instant |
| **L5 delete the stack** | `cd infra && npx cdk destroy <stack-name>` | Entire stack |

> ⚠️ Stack deletion removes ECR / IAM / SG / ECS. **The DDB tables and S3 report bucket are NOT deleted** (`removalPolicy: RETAIN`) — clean them up manually if needed. By design, every AWS resource created by this project carries the `auto-delete=no` tag to protect it from automated cleanup jobs.

---

## 10. Top 5 Deployment Errors

| Symptom | Likely cause | Diagnose / fix |
|---|---|---|
| **Access denied on Secrets Manager** — during CDK deploy (creating the empty secrets) or later when you fill in IM credentials | Deploy user lacks Secrets Manager permission | `aws iam attach-user-policy --policy-arn arn:aws:iam::aws:policy/SecretsManagerReadWrite` |
| **CDK deploy reports `CannotPullContainerError`** | Main app image build failed / ECR push incomplete | `cd infra && npx cdk deploy BotStack` (CDK Asset rebuilds + re-pushes) |
| **Bot doesn't respond to @ — ECS logs show `auth failed`** | Wrong IM credentials / wrong Secret payload | `aws secretsmanager get-secret-value --secret-id <name>` and compare to the original credential; correct it and re-run `setup.sh` |
| **Bot dispatch succeeds but the report doesn't return to the channel** | report-handler Lambda doesn't have IM credentials | Verify the Secret ARNs in the Lambda env match those in BotStack; re-run `cdk deploy NotiOpsBackendStack` |
| **`Bedrock InvokeModel` AccessDeniedException** | Task role lacks permission / model not enabled in region | Add `bedrock-runtime:InvokeModel` to IAM, or Bedrock console → Model access |

---

## 11. Full CDK Context Reference

All tunable parameters live under the `context` block in `infra/cdk.json`. After editing, run `cd infra && npx cdk deploy <stack>`.

### 11.1 BotStack (IM bot platform stack)

| context key | Default | Description |
|---|---|---|
| `bedrockModelId` | `us.anthropic.claude-sonnet-4-6` | Bedrock inference profile |
| `bedrockRegion` | (deploy region) | Bedrock invocation region (can differ from the runtime region) |
| `agenticChatMode` | `enabled` | `disabled` / `qa_only` / `enabled` |
| `defaultLlmProvider` | `claude` | Default LLM alias: `claude` / `nova` / `gpt`. Any user can override with `@bot model <alias>` in-chat (no admin gate). See [USER_GUIDE.en.md §7](USER_GUIDE.en.md#7-model-selection-bot-model) |
| `gptRegion` | `us-east-2` | Region of the Bedrock Mantle Responses endpoint when `gpt` is in use. Allowed: `us-east-2` / `us-west-2` / `us-gov-west-1` |
| `awsMcpMode` | `docs_only` | `disabled` / `docs_only` |
| `enableMcpPricing` | `true` | Pricing MCP sidecar |
| `defaultLocale` | `en` | `zh` / `en` resolver fallback |
| `allowedChatIds` | `[]` | chat_id allowlist (empty array = no restriction) |
| `enabledPlatforms` | `feishu` | IM platforms to enable (comma-separated, e.g. `feishu,slack`). Platforms not listed get ECS Service `desiredCount=0` and don't start |

### 11.2 NotiOpsBackendStack (shared backend + push)

| context key | Default | Description |
|---|---|---|
| `agentSpaceId` | (auto) | DevOps Agent space id. **No need to supply one** — CDK auto-creates `notiops-devops-<account>` (see §5.3.4); this context is for advanced override only |
| `devOpsAgentRegion` | `us-east-1` | Region of the DevOps Agent service (used in IAM Resource ARN); today `us-east-1` only |
| `pushTargetChatIds` | `{}` | Per-platform target chat id; empty = Lambda short-circuits and posts no card |
| `enableCloudWatchAlarmPush` | `true` | CloudWatch alarm |
| `enableHealthPush` | `true` | AWS Health |
| `enableBackupPush` | `true` | Backup |
| `enableGuardDutyPush` | `false` | GuardDuty |
| `guardDutyMinSeverity` | `7` | Severity threshold |
| `enableCostAnomalyPush` | `false` | Cost Anomaly |
| `enableTrustedAdvisorPush` | `false` | Trusted Advisor |
| `reportUrlExpirationSeconds` | `604800` | Pre-signed URL TTL (7 days) |

> The report bucket is auto-created (named `notiops-report-${AccountId}-${Region}`, private + KMS-encrypted; no parameter required).

---

## 12. Web Chat Deployment

> **Web Chat** is NotiOps's browser-based agentic AI assistant. It is **independent** of the IM bot above — you can deploy the IM bot only, Web Chat only, or both. Web Chat reuses the notiops Cognito user pool for auth and the shared backend (config table, `core/push_event` normalizer, DevOps Agent).

### 12.1 Web Chat architecture

| Component | Description |
|---|---|
| **Agent Runtime** | Bedrock AgentCore Runtime hosting the Strands agent (default model Claude Sonnet 4.6). Deployed as a CodeZip by `scripts/deploy_agent.sh`, which emits a **Runtime ARN** |
| **BFF Lambda** | Node 20 Lambda (`notiops-web-chat-bff`) with a **Function URL** (`AuthType=AWS_IAM`) that responds to the frontend via **SSE streaming**; it calls the Agent Runtime and also handles deterministic operations directly (case creation `/actions/execute`, the `/support/services` catalog, etc.) |
| **Frontend** | React / Vite single-page app, statically hosted |
| **Auth** | Cognito (reuses the notiops user pool) + Identity Pool; the frontend gets temporary credentials and **SigV4-signs** requests to the Function URL |
| **Data** | CDK `WebChatStack` creates the single DDB table `notiops-web-chat` (sessions/messages + the persistent notification inbox in the `notif#` segment, 90-day TTL, account-shared) |

The data plane inherits the backend's **strict read-only** constraints (three layers of defense) throughout — Web Chat does not relax them.

### 12.2 Deployment order

Web Chat is two steps, orchestrated by `setup.sh` (or run manually):

```
scripts/deploy_agent.sh    # 1) agentcore deploy CodeZip → prints the Agent Runtime ARN
        │
        ▼  (feed the ARN to CDK)
cd infra && npx cdk deploy WebChatStack -c agentRuntimeArn=<ARN from step 1>
```

1. **`scripts/deploy_agent.sh`** — uses `agentcore deploy` to package the agent as a **CodeZip** and create / update the AgentCore Runtime, printing the **Runtime ARN**.
2. **CDK `WebChatStack`** — inject that ARN via `-c agentRuntimeArn=<ARN>` to create the BFF Lambda + Function URL + DDB table + notification handler.
3. **Frontend `config.json`** — after deploy, write the BFF Function URL (and more) into the frontend (see §12.4).

### 12.3 Key environment variables (BFF Lambda / handler)

| env | Description |
|---|---|
| `WEB_CHAT_TABLE` | DDB single-table name (`notiops-web-chat`), shared by sessions / messages / notification inbox |
| `AGENT_RUNTIME_ARN` | The AgentCore Runtime ARN from `deploy_agent.sh` (injected via `-c agentRuntimeArn`) |
| `SKILLS_BUCKET` | Skills storage S3 bucket (`skills/` prefix, shared with the IM side) |
| `DEVOPS_AGENT_SPACE_ID` | DevOps Agent Space id (used for deep investigation) |
| `REPORTS_CDN_DOMAIN` | CloudFront domain for online reports (HTML reports land in S3, CloudFront 7 days; presigned URL 12h fallback) |
| `CONFIG_TABLE` | The notiops config table (`notiops-config`), reused for configuration / notification-source toggles |
| `NOTIOPS_CROSS_ACCOUNT_ROLE` | Cross-account read-only role name (v1 defaults to the deploy account) |
| `LOCKED_ACCOUNT_ID` | The v1 locked deploy-account id (the multi-account selector defaults to this account) |

### 12.4 Frontend config.json injection

The frontend build artifact needs a `config.json` (injected at deploy time, not hard-coded):

| key | Source |
|---|---|
| `chatApiBase` | BFF Function URL (`WebChatStack` output) |
| `cognito` | Reuses the notiops user pool id / app client id / region |
| `identityPoolId` | Identity Pool id (issues temporary credentials for SigV4) |

### 12.5 Notification event sources (persistent inbox)

The **persistent inbox** of Web Chat's "Notifications" topic is fed by EventBridge → `notiops-web-notif-handler` (reuses the `core/push_event` normalizer, 5-minute dedup) → writes to the `notif#` segment of the `notiops-web-chat` table. Source toggles:

- **On by default**: CloudWatch Alarm / AWS Health / Backup
- **Off by default**: GuardDuty / Cost Anomaly / Trusted Advisor / RDS / Config

> Near real-time delivery is via **60s frontend polling** (not WebSocket, so there is up to ~60s latency); the left-nav red dot counts **inbox unread only**. The "Notifications" topic also has an **AWS Health Dashboard live view** that the BFF queries against the Health API in real time (not persisted); it requires a **Business+ / Enterprise Support** plan. Without one it degrades gracefully to console links, and the Health unhandled count is **not** rolled into the red dot.

### 12.6 Smoke tests

> **Where the login credentials come from**: on first deploy `setup.sh` creates a Cognito `admin` user and prints a **temp password** (in the completion banner: `👤 Login: admin / <temp password>`) — this is the entry account for the web console. Change it on first login. If the banner shows no password, the `admin` user already exists (password unchanged).

```
1. Open the Web Chat frontend URL in a browser → sign in via Cognito
2. Confirm the left nav shows: Notifications / Investigate / FinOps / Cases / Skills / More
3. Send an investigation request (e.g. "investigate EC2 in IAD"):
   → the main chat surfaces a "View investigation steps" entry; the right-side
     "Investigation Steps" docked panel grows in real time
   → on completion the main chat shows the root-cause conclusion + an HTML online report link
4. Create a case: go to the "Cases" topic, use the editable card to pick service /
   category / case type → preview → confirm
   (execution goes through the deterministic /actions/execute, not the LLM)
```

> **FinOps Agent deep analysis: coming soon, currently greyed out and disabled.** Both the "Investigate" and "FinOps" topics show the DevOps Agent toggle (off by default in FinOps, on by default in Investigate); the FinOps Agent deep-analysis toggle is **greyed out / unavailable** today with a "coming soon" hint — do not expect it to work during smoke tests.

### 12.7 Common pitfalls

| Symptom | Cause / fix |
|---|---|
| **`deploy_agent.sh` times out uploading the CodeZip** | Do **NOT** bundle `.venv` into the agent CodeZip (installed deps balloon to hundreds of MB and the S3 upload times out). Ship source + dependency manifest only and let the AgentCore side install deps |
| **The two stacks conflict / produce garbled artifacts when synth'd in parallel** | Do **NOT** synth the IM bot stack and `WebChatStack` **in parallel into the same `cdk.out/` directory**; run them separately or use different `--output` directories |
| **Frontend 403 / signature failure** | The Function URL is `AWS_IAM`; confirm the frontend obtained Identity Pool temporary credentials and SigV4-signed the request, and that `config.json`'s `chatApiBase` points to the correct Function URL |
| **Deep-investigation jump lands on the wrong tab** | The "Generate mitigation in the DevOps Agent console" button opens an operator app deep link (new tab); the console can't deep-link straight to the Root cause tab, so the copy tells the user to switch to the Root cause tab manually after it opens |

---

## 13. CUR + Athena FinOps Data Source

> **Optional feature.** Some FinOps dashboard cards (e.g. DevOps Agent invocation cost — `product_product_name='AWSDevOpsAgent'`) need **CUR line-item detail**; Cost Explorer's aggregated API can't return this dimension, so it must go through **Athena querying the CUR table**. This section is auto-guided by `setup.sh` after the main deploy completes.

### 13.1 Two paths: reuse an existing CUR (instant) vs create a new CUR (~24h)

> **Reuse an existing CUR**: if the account already has a qualifying CUR (data already delivered), setup.sh **synchronously invokes `lambda6_cur_finalizer`**, dynamically discovers/builds the Athena table, and reaches `READY` **within minutes** — no 24h wait. **Only the new-CUR path** incurs the ~24h first-delivery delay below.
>
> **Dynamic discovery, zero hardcode**: the finalizer uses the Glue API to match the real database/table by the report's S3 path (it no longer guesses the DB name via `report_name.lower()` — in practice AWS names the DB `athenacurcfn_<sanitized-name>`, which can't be guessed reliably), and it reads the partition keys to determine the structure (structure B: `year`/`month` partitions, whose values may be single-digit like `month=7`). Works for any customer's existing or newly-created CUR.

For a new CUR, AWS's official two-phase flow (see [official docs](https://docs.aws.amazon.com/cur/latest/userguide/cur-query-athena.html)) is:

```
setup.sh phase 1 (a few seconds)
  │
  ├─ Detect whether the account already has a qualifying CUR
  │     (Hourly + Include Resource IDs + Athena integration)
  │     └─ Yes → ask reuse vs. new; No → go straight to "new"
  │
  ├─ New: cur:PutReportDefinition
  │     · TimeUnit=HOURLY (the hourly granularity you asked for)
  │     · AdditionalSchemaElements=[RESOURCES] (include resource ID)
  │     · Format/Compression=Parquet, AdditionalArtifacts=[ATHENA]
  │     · New dedicated S3 bucket notiops-cur-<account_id>-<region>
  │       (AWS strongly recommends against reusing an existing bucket)
  │
  ├─ Write a DDB status record: table notiops-config,
  │   PK=cur-athena-status#<account_id>, status=PENDING
  │
  └─ Schedule a one-time EventBridge Scheduler (T+25h) → lambda6_cur_finalizer
  │
  ⏳ Wait 24 hours — AWS's first report delivery to S3 (hard delay, unavoidable)
  │
  ▼
lambda6_cur_finalizer (new: auto-fires at T+25h; reuse: invoked synchronously by setup.sh)
  │
  ├─ Idempotent: first use the Glue API to [dynamically discover by S3 Location]
  │     whether a CUR table already exists → if so, write READY directly, skip CFN
  ├─ Stale / rolled-back stack → delete then recreate (guarantees repeatable
  │     deploys, incl. StopCrawler to clean up a running crawler)
  ├─ Deploy AWS's crawler-cfn.yml (Glue Database + Crawler + 2 Lambdas + S3 notification) → run the crawler
  │     └─ crawler-cfn.yml not yet delivered (new-CUR only, occasional) → status set to DELAYED,
  │        re-run setup.sh to finish up
  └─ Use the Glue API to [dynamically discover the real db/table] (no DB-name guessing) → write DDB READY
        + athena_database + athena_table + year_month_partitioned
```

**FinOps dashboard behavior**: `not_configured` shows "Not configured, re-run setup.sh"; `PENDING`/`DELAYED` (new-CUR only, awaiting first delivery) shows "Initializing"; once `READY` it shows real Athena results (reusing an existing CUR is usually `READY` within minutes); `FAILED` shows a configuration-failure notice.

### 13.2 setup.sh interactive flow

After the main deploy (`npx cdk deploy --all`) completes, `setup.sh` will:

1. Check the DDB `notiops-config` table for an existing CUR/Athena status record for this account — skip if found (avoids duplicate creation)
2. If none: use `cur:describe-report-definitions` to detect whether the account already has a qualifying CUR (Hourly + Resource IDs)
   - Found → prompt the user: **0) Create a dedicated new one** (default, AWS-recommended) / **1) Reuse the existing one**
   - Not found → go straight to creating a new one
3. Reuse path (pick 1): **synchronously invoke `lambda6_cur_finalizer`** (data already available → dynamically discover / build the Athena table → write `READY`, no 24h wait)
4. New path: create the S3 bucket (with the bucket policy CUR's service needs to write) → `cur put-report-definition` → write DDB `PENDING` → `scheduler create-schedule` (one-time, `action-after-completion=DELETE`)

### 13.3 New AWS resources involved

| Resource | Purpose |
|---|---|
| S3 bucket `notiops-cur-<account_id>-<region>` | Dedicated CUR report delivery bucket (Parquet format) |
| CUR ReportDefinition `notiops-cur-report` | Hourly + Resource IDs + Athena integration |
| Lambda `notiops-cur-finalizer` (`lambda6_cur_finalizer`) | One-time: detects template delivery, deploys the Athena-integration CFN stack |
| IAM Role `notiops-cur-finalizer-role` | Lambda6 execution role: S3 read-only (any CUR bucket) + CFN Create/Delete/DescribeStackResources (scoped to `notiops-cur-athena-*`) + Glue create/delete/discover db & tables · Start/StopCrawler + Lambda create/delete · PutFunctionConcurrency + IAM create/delete Role (needed to deploy AWS's official Athena template) |
| IAM Role `notiops-cur-finalizer-scheduler-role` | Role EventBridge Scheduler assumes to invoke Lambda6 |
| EventBridge Scheduler (one-time, created dynamically by setup.sh) | Fires Lambda6 at T+25h, then auto-deletes (`action-after-completion=DELETE`) |
| DDB record (reuses the existing `notiops-config` table) | `PK=cur-athena-status#<account_id>`, tracks `PENDING/READY/DELAYED/FAILED` |
| CFN stack `notiops-cur-athena-<account_id>` (deployed by Lambda6) | AWS's own generated Athena-integration template: Glue Database + Crawler + 2 Lambdas + S3 notification |

### 13.4 Manual troubleshooting

If the FinOps dashboard still shows "initializing" after 24 hours:

```bash
# 1. Check the DDB status
aws dynamodb get-item --table-name notiops-config --region $AWS_REGION \
  --key '{"PK":{"S":"cur-athena-status#<account_id>"},"SK":{"S":"STATUS"}}'

# 2. If status=DELAYED, re-run setup.sh (it will re-detect and reschedule)
# 3. If status=FAILED, check the error field + Lambda6 CloudWatch logs:
aws logs tail /aws/lambda/notiops-cur-finalizer --region $AWS_REGION --since 2d

# 4. Manually confirm the CUR report has been delivered (crawler-cfn.yml
#    showing up in S3 means it has landed):
aws s3 ls s3://<CUR_BUCKET>/<report-prefix>/<report-name>/ --recursive | grep crawler-cfn
```

### 13.5 Permission reminder

The IAM identity running `setup.sh` additionally needs: `cur:PutReportDefinition` / `cur:DescribeReportDefinitions`, `s3:CreateBucket`, `scheduler:CreateSchedule`, `iam:PassRole` (to pass `notiops-cur-finalizer-scheduler-role`); plus the permissions to set up the Athena FinOps saved queries: `athena:GetWorkGroup` / `athena:UpdateWorkGroup` (to set the result output location on the primary workgroup) + `athena:ListNamedQueries` / `athena:BatchGetNamedQuery` / `athena:CreateNamedQuery`. The CDK-deployed `notiops-cur-finalizer-role` (see §13.3) and the Web Chat BFF role (which holds the `athena:*Query*` + `athena:ListNamedQueries`/`BatchGetNamedQuery`/`GetNamedQuery` needed to query CUR (Cost Deep Dive fetches saved queries), `glue:Get*`, CUR-bucket read-only, and on the results bucket `s3:GetBucketLocation` + `s3:GetObject`/`s3:PutObject` (`GetObject` for re-signing Deep Dive CSV downloads); Cost Deep Dive's AI insight needs `bedrock:InvokeModel` (Claude Sonnet inference profile), and same-day result caching needs `dynamodb:PutItem` on the `notiops-config` table — without `GetBucketLocation`, Athena errors with "Unable to verify/create the output bucket") need no additional manual grants.

Once the CUR is ready (within minutes when reusing an existing CUR), `setup.sh` automatically: ① sets the result output location on the primary workgroup (`s3://notiops-data-<account>-<region>/athena-results/`, not overwritten if already set) ② idempotently creates **6** Athena saved queries using the [dynamically-discovered db/table names] — `NotiOps - DevOps Agent Usage & Credit` (same measure as the dashboard's credit card), `NotiOps - EDP Commitment Attainment` (edit the annual commitment + contract start/end in `params` and run it directly), plus 4 **Cost Deep Dive** detail queries: `CloudWatch cost by usage type` / `Data Transfer by service` / `EC2 cost by instance type` / `S3 cost by storage class` (run on demand from the dashboard's "Cost Deep Dive" card). The dashboard's Commitments & Programs card "View SQL in Athena" link points here; each Cost Deep Dive scenario's SQL is also read from these saved queries (single source of truth, editable directly in the Athena console) — after the BFF runs it, it hands the real result rows to Bedrock for charts + insights and caches the day's result in the `notiops-config` table (clicking again the same day only re-signs the CSV download, without re-running SQL / re-calling AI).
