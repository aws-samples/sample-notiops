# NotiOps — Deployment Guide

> ⚠️ **Disclaimer**: This is sample code, for non-production usage. You should work with your security and legal teams to meet your organizational security, regulatory and compliance requirements before deployment. It is provided for educational/reference purposes and is not a production-ready product.

> 🌐 **Language**: [中文](DEPLOYMENT.md) · [English](DEPLOYMENT.en.md)
>
> **Audience**: Ops / DevOps engineers deploying this system for the first time.
>
> **Expected duration**: **~30 min via §0 Quick Deploy** / ~2 hours for the full walkthrough.
>
> **Companion docs**:
> - [USER_GUIDE.en.md](USER_GUIDE.en.md) — end-user usage guide
> - [DEPLOYMENT_ONECLICK.en.md](DEPLOYMENT_ONECLICK.en.md) — **the other path**: read that one if you only want Web Chat and don't want a local toolchain

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
- §14 [Customer CUR Dashboard + cost-agent MCP](#14-customer-cur-dashboard--cost-agent-mcp-optional) (optional) — line-item CUR for **someone else's** accounts, via your own MCP Lambda

---

## 0. Quick Deploy (TL;DR)

> For "get it running first, read details later". All commands assume you've already finished §2 Prerequisites. The web console (browser chat) deploys by default and is the product's main entry; IM (Feishu / Slack) is an optional supplement — only walk §3 Register IM Apps if you want to enable it.

> 💡 **Just want to try Web Chat?** Then you can skip this whole document.
> [DEPLOYMENT_ONECLICK.en.md](DEPLOYMENT_ONECLICK.en.md) is a path that needs **nothing installed
> locally and no access keys**: download one CloudFormation template from the Release, upload it in
> the console, stack done in ~4.5 minutes. The trade-off is that it deploys **Web Chat only** — no IM
> bots, no daily inspection, and no inspection backend (the inspection dashboard entry is still
> there in Web Chat, but nothing writes to it on that path, so opening it fails to load).
> Want those, come back here and run `setup.sh`
> (both paths create the same admin username, `admin`, so doing one then the other is fine).

### 0.1 One-command deploy

```bash
./setup.sh
```

The first run is **interactive**: confirm AWS account + region → (optional) PHD event forwarding → **pick which IM platforms to deploy (default `0` = skip, web UI only; pick Feishu / Slack only if you want IM)** → build the frontend (there is only one: Web Chat's `frontend/chat-app`) → deploy the Web Chat Agent (AgentCore Runtime) → CDK bootstrap → CDK synth → CDK deploy `--all`. **Web Chat + the backend agent deploy by default.** IM credentials are **not** collected here — CDK creates **empty** secrets, and you fill them in *after* deploy (see §4 / §5).

> **About DingTalk**: the DingTalk adapter code (`platforms/dingtalk/`) is retained, but v1 `setup.sh` doesn't surface the option → `enabledPlatforms` never includes `dingtalk` → `ImStack` creates no DingTalk Lambda / webhook, no cost. v2 ships the dual-robot credential flow.

Two stacks land (one shot via `cdk deploy --all`; three when you pick an IM platform — `ImStack` is added):
- `NotiOpsBackendStack` — shared backend (DDB, 8 Lambdas, S3 report bucket, EventBridge rules)
- `WebChatStack` — the browser-based agentic AI assistant (**deployed by default**; BFF Lambda + Function URL, single DDB table `notiops-web-chat`, static frontend, notification handler)
- `ImStack` (only when IM is selected) — **the only path for IM**: one API Gateway HTTP API plus one Lambda pair (ingress + worker) per platform, plus a progress Lambda, the dependency Layer and the de-duplication table. After deploy, paste the webhook URL it outputs into the IM platform console — see [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md)

> ℹ️ **`BotStack` (ECS Fargate long connection) was retired on 2026-09-03** (IM refactor M2).
> `infra/bin/app.ts` no longer instantiates it — so **no VPC is needed, and neither is finch / docker**.
> `infra/lib/bot-stack.ts` and the three Dockerfiles stay in the repo as the long-connection rollback
> path (referenced by no app); `teardown.sh` still deletes `BotStack` by name so accounts installed
> before M2 clean up completely.

Re-running `./setup.sh` only patches deltas (existing stacks go through `cdk diff`).

### 0.1.1 After deploy: what works out of the box vs what needs one more step

Once `setup.sh` finishes, split features into two buckets — **don't mistake "only inspection needs it" config for "the whole product needs it":**

| | Whole product **works out of the box** (no extra config) | **Only** these features need one more step |
|---|---|---|
| **Feature** | Web Chat: AWS Q&A · investigation · cost analysis · Support cases · Skills · notifications (Health / alert push) | Idle-resource detection + **automatic cost inspection** (notiops daily scan) |
| **Default target** | **The deploy account itself**, usable right after login | Must add `Account ID + Role ARN + Region` under the Dashboard "Target Accounts" page |
| **If not configured** | — | Inspection **idles** (no accounts to scan), but **Web Chat is completely unaffected** |

> In one line: **just chatting in Web Chat → log in and go, nothing to configure**; to use **idle / automatic cost inspection** (or the future proactive-sentinel cross-account scheduled scans) → you then add accounts under "Target Accounts". Cross-account inspection also needs a read-only `notiops-idle-detection-role` pre-created in the target account — for Organizations, use `./setup.sh --multi-account` to roll it out via StackSets (including DevOps/PHD event forwarding), or onboard in one click from the console "Account Onboarding (Organizations)" page; for non-org setups, manually deploy [`infra/member-account-onboarding.yaml`](../infra/member-account-onboarding.yaml) in the target account.

### 0.1.2 Deploy mode: single-account (default) vs multi-account `--multi-account`

**Decide the mode before running `setup.sh`** — it determines how CDK bakes the cross-account gate at deploy time. **Switching after deploy requires a redeploy** (it is not a runtime toggle).

| | **Single-account (default)** | **Multi-account** `./setup.sh --multi-account` |
|---|---|---|
| **How to trigger** | Just `./setup.sh` | `./setup.sh --multi-account`, run in the **Organizations management account** — or in a member account registered as a **CloudFormation StackSets delegated administrator** |
| **Who it's for** | Using NotiOps in **this account only** (most trials / single-account customers) | Managing many accounts under Organizations and wanting **cross-member-account** inspection / investigation / event forwarding |
| **Cross-account gate** | Locked to the deploy account (`LOCKED_ACCOUNT_ID` = this account); the Web console's multi-account selector lists only this account | Gate unlocked (`LOCKED_ACCOUNT_ID` empty, using `aws:PrincipalOrgID` to allow the whole org); console can onboard / switch member accounts |
| **Member-account resources** | Not rolled out | Rolled out automatically to member accounts via **StackSets** (read-only role + DevOps/PHD event forwarding) |
| **Features affected** | All Web Chat features work out of the box for **this account** | Additionally unlocks: cross-account **idle/cost inspection**, cross-account **incident investigation**, cross-account **PHD/DevOps event forwarding**, and the console "Account Onboarding (Organizations)" page |

**Why isn't multi-account the default?** Multi-account mode requires the current identity to be the **Organizations management account** (or its **StackSets delegated administrator**), touches StackSets, and rolls out resources to member accounts — unnecessary and higher-privilege for the vast majority who just want to try it in a single account. Single-account is the least-privilege, fastest path to a working deployment, so it is **off by default**; add `--multi-account` explicitly when you need it.

**Already deployed single-account and now want multi-account?** Re-run `./setup.sh --multi-account` in the Organizations management account (or a StackSets delegated-admin account) — the incremental CDK update rewrites the gate and rolls out member-account resources. If the Web console shows "This deployment does not have Organizations multi-account mode enabled. Redeploy with `./setup.sh --multi-account` from the management account (or a StackSets delegated-admin account)", that is exactly this signal — you are on a single-account deployment and need to re-run with `--multi-account` from the management account (or delegated admin). **This cannot be toggled from the console.**

> Not sure which to pick? **Get single-account working first**, confirm Web Chat is usable, then re-run `--multi-account` from the management account (or delegated admin) once you actually have a cross-account need. The two don't conflict — multi-account is a superset.

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

CDK deploys three stacks in one shot via `cdk deploy --all` (four when you pick an IM platform — `ImStack` is added). **Web Chat (the browser-based main entry) and the AgentCore agent that backs it deploy by default** — `setup.sh` first builds the chat-app frontend, runs `scripts/deploy_agent.sh` to deploy the agent, then runs `cdk deploy --all`:

| Stack (CDK name) | Required | Contents |
|---|---|---|
| **`notiops-*`** | ✅ Required | 8 Lambdas (`notiops-inspection-scheduler` / `-executor` / `-reconciler` / `-push`, `notiops-cost-analyzer`, `notiops-notifier`, `notiops-push-handler`, `notiops-phd-forwarder`), shared DDB tables, S3 report bucket, EventBridge rules (5 IM push rules + 10 web notification rules + notiops schedules), agent-trigger Role (for STS AssumeRole) |
| **`WebChatStack`** | ✅ Deployed by default | The browser-based agentic AI assistant (**the product's main entry**): BFF Lambda (`notiops-web-chat-bff`) + Function URL (`AWS_IAM`), single DDB table `notiops-web-chat` (sessions/messages + notification inbox), static frontend (chat-app), notification handler. The BFF gets the previous step's agent Runtime ARN injected via `-c agentRuntimeArn` |
| **`ImStack`** | Only when IM is selected | **The production path for IM**: one **API Gateway HTTP API** per platform (the public entry point, a `$default` catch-all route) plus one Lambda pair — ingress (validates the signature and hands off asynchronously, `reservedConcurrentExecutions=10`) + worker (does the real work, 900s) — plus the shared dependency Layer and a de-duplication table. Its `FeishuWebhookUrl` / `SlackWebhookUrl` outputs are the request URLs you paste into the IM platform console (see [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md)) |
| ~~**`BotStack`**~~ | ❌ **Retired (2026-09-03)** | It used to be: VPC + public subnets, ECS Cluster (512 CPU / 1024 MB per task), ECR repo, one Fargate Service per selected platform, pricing + cost MCP sidecars per task, Task Role, Security Group. After IM refactor M2, `infra/bin/app.ts` **no longer instantiates it**, so fresh installs get no VPC / ECS / ECR and need no finch / docker. The source (`infra/lib/bot-stack.ts` + three Dockerfiles) is deliberately kept in the repo as the long-connection rollback path — rolling back means `new BotStack(...)` again, which is far cheaper than rebuilding VPC/ECS and the images from scratch. Accounts installed before M2 still have the stack: `teardown.sh` deletes it by name, or delete it on its own with `aws cloudformation delete-stack --stack-name BotStack` (it publishes **no CFN exports**, so no other stack can be importing it) |

**Deployment order** (handled automatically by `./setup.sh`):
```
./setup.sh (interactive: region / optional PHD / [IM skipped by default])
   → build the frontend (only one: `frontend/chat-app`) → deploy Web Chat Agent → cdk deploy --all
(optional) to enable IM: §3 Register an IM app first, then re-run setup.sh and pick the platform
```

Credential flow: `setup.sh` **does not collect IM credentials** — it only sets the `enabledPlatforms` flag based on your selection. CDK creates **empty** secrets (`notiops/im-bot-feishu` / `notiops/slack-bot-token` / `notiops/slack-signing-secret`); after deploy you fill them in under Web Chat admin console → "IM Integration" (all four Feishu credentials on one form), or directly in Secrets Manager (see §4.2 — webhook mode needs **no** service restart). CDK stacks always reference the secrets by ARN. **Nothing is persisted to disk locally.**

---

## 2. Prerequisites

### 2.1 Required tools

| Item | Requirement | Check |
|---|---|---|
| AWS CLI v2 | ≥ 2.13 (Bedrock support) | `aws --version` |
| ~~AWS SAM CLI~~ | ~~≥ 1.100~~ | ~~`sam --version`~~ *(retired — CDK deploy doesn't need SAM CLI)* |
| Node.js | ≥ 22 | `node --version` *(CDK runtime)* |
| ~~Container build tool~~ | ~~finch (recommended) / docker~~ | — *(**no longer required** as of 2026-09-03 — see the note below)* |
| jq | any version | `jq --version` |
| Python 3.12+ (local builds) | — | `python3 --version` |
| **uv** | any version | `uv --version` |

> ⚠️ **uv is not optional** (`curl -LsSf https://astral.sh/uv/install.sh | sh`, or `brew install uv`).
> `agentcore deploy` invokes `uv pip install` **unconditionally** when it packages the agent's Python
> dependencies. Missing it does not stop the deployment with an error — it **silently degrades**:
> the agent deployment fails → no Runtime ARN → the BFF falls back to echo, while the web side
> deploys fine and the script still prints the Chat URL. What the customer experiences is
> "deployment succeeded, but every question just echoes my message back".
> `setup.sh` now blocks on this during preflight (unless `SKIP_AGENT=true`).
> Note that uv's official installer puts the binary in `~/.local/bin`, which is often not on PATH in
> non-interactive shells — open a new shell after installing.

> ℹ️ **A container build tool (finch / docker) is no longer required as of 2026-09-03**, including for IM.
> The only thing that ever needed one was the five `ContainerImage.fromAsset("../")` calls in the old
> `BotStack` (ECS Fargate long-connection containers), and IM moved entirely to Webhook + Lambda
> (`ImStack`) in refactor M2 — `infra/bin/app.ts` no longer instantiates `BotStack`. The IM Python
> dependency Layer is cross-downloaded by `scripts/build_im_layer.sh` using
> `pip --platform manylinux2014_x86_64 --only-binary=:all:`, which needs no container.
> Side benefit: `cdk synth` no longer hashes the whole repo root as a Docker build context
> (measured 594s → 12s).
> ⚠️ If a Docker asset is ever reintroduced, this note, `setup.sh`'s preflight, and
> `publish/README.public.{zh,en}.md` all have to change back together.

### 2.2 AWS account preparation

- **AWS account**: admin or equivalent permissions
- ~~**VPC**~~: **no longer needed** — IM runs on Webhook + Lambda (`ImStack`), so there is no ECS Fargate task and therefore no VPC / public subnet requirement (2026-09-03, IM refactor M2). Only the `infra/lib/bot-stack.ts` long-connection rollback path needs one
- **AWS DevOps Agent**: enabled (required for deep investigation). **No need to bring your own Agent Space** — CDK auto-creates one named `notiops-devops-<account>` in your account (see §5.3.5); you don't pre-create one or supply a space id
- **Bedrock**: the model behind the catalogue's **default_model** is enabled in your region (Bedrock console → Model access). Today that is **xAI Grok 4.6** (`global.xai.grok-4.6`); enable the others too (Claude Sonnet 5 / Opus 5 / Haiku 4.5, Nova Pro, DeepSeek, GLM 5, the GPT-5.6 family) if you want users to be able to switch

### 2.3 Region selection

Different components have different region constraints — plan ahead:

| Component | Allowed regions | Notes |
|---|---|---|
| **AWS DevOps Agent service** | **`us-east-1` only** | AWS service constraint (single-region preview) |
| **Shared backend Lambda stack** | **strongly recommended `us-east-1`** | Polls DevOps Agent journal API; cross-region adds latency and IAM complexity |
| **Feishu / Slack IM stack (`ImStack`)** | any AWS region | No hard constraint; pick what's nearest your users. The webhook HTTP API lives in this region |
| **Bedrock** | any region with `claude-sonnet-4-6` enabled | Override via `BedrockRegion` parameter; can differ from the runtime region |
| **DDB / S3** | follows the Lambda region | Created in the same region as the stack |

**Simplest deploy**: the `setup.sh` region menu defaults to `1) ap-northeast-1` (Tokyo); just press Enter to use it. DevOps Agent service capabilities still assume `us-east-1` (see the table above).

**Multi-region**: the IM stack in (say) `ap-southeast-1` for proximity, Lambda + DevOps Agent stay in `us-east-1`. The `DevOpsAgentRegion` CFN parameter (default `us-east-1`) controls which region appears in the IAM Resource ARN for journal-read permissions.

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

> **Mind the order**: the Request URL **can only be filled in after the deployment
> finishes** — that URL is produced by `ImStack` and does not exist yet. So this section
> only covers "create the app + set the scopes + collect the keys"; the two steps that
> fill in the URL live in **[IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §1** (run
> after deploy). Symptom of getting it backwards: Feishu sends a verification request the
> instant you save the URL, and with the keys not yet in the secret it reports
> "verification failed" — which looks like a wrong URL.

1. Visit the [Feishu Open Platform](https://open.feishu.cn/) and sign in with an enterprise admin account
2. **Developer Console → Create Enterprise Self-Built App** → fill in a name (e.g. NotiOps)
3. **App Features → Bot → Enable**, set the bot display name
4. **Permissions → Batch import/export permissions** → import the JSON below. **The
   first 11 are required** — the three `cardkit:*` ones drive the cards (progress cards,
   case cards, buttons); miss them and messages arrive but no card can be sent. Miss
   `im:message.group_at_msg:readonly` and `@bot` in a group arrives with no text. The
   last one, `im:message.reaction:write`, is **optional** (see the note below):

   ```json
   {
     "scopes": {
       "tenant": [
         "cardkit:card:read",
         "cardkit:card:write",
         "cardkit:template:read",
         "im:chat",
         "im:chat.access_event.bot_p2p_chat:read",
         "im:message",
         "im:message.group_at_msg:readonly",
         "im:message.p2p_msg:readonly",
         "im:message:readonly",
         "im:message:send_as_bot",
         "im:resource",
         "im:message.reaction:write"
       ],
       "user": []
     }
   }
   ```

   ℹ️ `im:message.reaction:write` (added 2026-09-03) is used only to put a 👀 reaction on
   the user's message **before** the "thinking" card, moving the "got it" acknowledgement
   into the millisecond range. **It works without it** — the call returns a non-zero code,
   the ingress log gets one WARNING, the answer is unaffected, you just lose the instant
   acknowledgement. Scopes ship with the version: after adding it, go back to step 8 and
   **publish a new version**.

5. **Events & Callbacks → Encryption Strategy** → collect the two keys (in webhook mode
   these are the **only** authentication mechanism, and both must be non-empty):
   - **Encrypt Key**: supply your own random string, ≥32 chars recommended — `openssl rand -hex 24`
   - **Verification Token**: shown right on that page — **copy it**
6. **Events & Callbacks → Event Configuration** → set the delivery mode to **"Send events
   to developer server"** and subscribe to `im.message.receive_v1` (receive user
   messages). **Leave the Request URL empty for now** and fill it in after deploy (see the
   ordering note above)
7. **Events & Callbacks → Callback Configuration** → likewise set the delivery mode to
   **"Send callbacks to developer server"** and subscribe to `card.action.trigger` (every
   card button depends on it; miss it and buttons do nothing). The Request URL is again
   filled in after deploy, and it is **the same URL as in step 6**
8. **Versioning & Release → Create new version** → submit for release (self-built app admin can self-approve)
9. **Save** the App ID + App Secret + the two keys from step 5 — `setup.sh` does **not**
   ask for credentials; after deploy, fill them in under **Web Chat admin console →
   "IM Integration"** — all four credentials (App ID / App Secret / Encrypt Key /
   Verification Token) sit on one form and Save writes them into the
   `notiops/im-bot-feishu` secret (you can also edit that secret directly, see §5). See
   §4 / §5 and [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md)
10. **Add the bot to your channel.** If you want proactive push (Health / alerts, etc.) delivered to a group, grab that group's `chat_id` first:

```bash
# First fetch a tenant_access_token
curl -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
  -H 'Content-Type: application/json' \
  -d '{"app_id":"'$FEISHU_APP_ID'","app_secret":"'$FEISHU_APP_SECRET'"}'

# List chats and note the target chat_id (starts with oc_)
curl 'https://open.feishu.cn/open-apis/im/v1/chats' \
  -H 'Authorization: Bearer <tenant_access_token>' | jq '.data.items[]'
```
Later put this `chat_id` into the Feishu secret's `notify_chat_ids` (or configure it under Web Chat admin → "IM Integration") — it is **not** a `setup.sh` prompt (optional; leave empty to disable push delivery).

### 3.2 Slack App

> Same as §3.1: the **Request URL is filled in only after the deployment finishes**. All
> three places that need it are in [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §2.

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From scratch**
2. ⚠️ **Do not enable Socket Mode** — it is **mutually exclusive** with webhooks; with it
   on, Slack stops sending requests to the Request URL and the bot looks completely dead.
   You also do **not** need an App-Level Token (`xapp-...`)
3. **OAuth & Permissions → Bot Token Scopes** → add:
   - `app_mentions:read` / `channels:history` / `channels:read` / `chat:write` / `chat:write.public`
   - `groups:history` / `im:history` / `im:write` / `users:read`
   - `commands` — slash commands (`/devops`, `/case`, …); miss it and you get `dispatch_failed`
   - `reactions:write` — **optional**, puts a 👀 reaction on the question first (instant
     ack). Miss it and you only lose the reaction; the log shows
     `reactions.add error=missing_scope`
4. **Basic Information → App Credentials → Signing Secret** → copy it. In webhook mode
   this is the **only** request-authentication mechanism (it replaces the App Token of the
   Socket Mode era)
5. **Event Subscriptions → Enable Events: ON** → **Subscribe to bot events**:
   - `app_mention` / `message.channels` / `message.groups` / `message.im`
   - Request URL is filled in after deploy
6. **Install App → Install to Workspace**, grab the Bot Token (`xoxb-...`)
7. **Save** the Bot Token + Signing Secret — `setup.sh` does **not** ask for credentials;
   after deploy, put them into the `notiops/slack-bot-token` /
   `notiops/slack-signing-secret` secrets. See §4 / §5 and
   [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §2
8. In the target channel run `/invite @YourBot`, then open the channel settings panel to copy the **Channel ID** (`C...`). To enable proactive push, put this Channel ID in the notification settings (it is **not** a `setup.sh` prompt)

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

> The DingTalk robot **needs no public ingress**: Stream Mode is an outbound long-poll initiated by the bot. ⚠️ But the thing that used to host that long poll (`BotStack`'s ECS task) was retired on 2026-09-03 — landing DingTalk now requires a webhook adapter first (M4, not done yet).

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

> **Agent Space id is not a prompt** — CDK auto-creates `notiops-devops-<account>` (see §5.3.5); you don't supply one.

### 4.2 Where IM credentials live / when you fill them

At deploy time CDK creates **empty** IM secrets; you fill the credentials in **after deploy**, two ways (the script's completion banner also points here):
- **Option A (recommended)**: log in to Web Chat (admin) → left menu "More → Inspections & Reports" opens the console → "Settings → Notifications" → fill them in
- **Option B**: update the secret below directly. **Nothing needs restarting** — IM runs on
  Lambda and reads credentials at cold start, so a secret change takes effect on the next
  cold start (to force it now, wait a few minutes or touch a Lambda environment variable to
  cycle the instances). ⚠️ The `aws ecs update-service --force-new-deployment` line from
  older docs only matters for the **rollback-only** `BotStack` long-connection containers;
  in webhook mode nothing you do to them has any effect.

CDK stacks always reference the secrets by ARN. **No credential files on the local disk.**

| Auto-created Secret (empty initially) | Purpose |
|---|---|
| `notiops/im-bot-feishu` | Feishu bot credentials (single secret, JSON: `app_id` / `app_secret` / `verification_token` / `encrypt_key` / `notify_chat_ids`). ⚠️ In webhook mode `encrypt_key` **and** `verification_token` are **both required** — miss either and the ingress function crashes on cold start (see [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §1.2) |
| `notiops/slack-bot-token` | Slack bot token (`xoxb-`) |
| `notiops/slack-signing-secret` | Slack signing secret — **the only request-authentication mechanism in webhook mode**; required |
| `notiops/slack-app-token` | Slack app-level token (`xapp-`, Socket Mode). **Unused** in webhook mode; only needed if you roll back to the `BotStack` long connection |
| `notiops/bedrock-api-key` | Bedrock API Key (cross-account model-invocation auth; populated manually post-deploy, leave empty to use IAM) |
| `notiops/litellm-config` | LiteLLM credentials (JSON: `base_url` / `api_key` / `default_model`; only if you use LiteLLM) |

> DingTalk secrets (`notiops/dingtalk-app-key` / `notiops/dingtalk-app-secret`) are **NOT created by CDK** — bot-stack references them but you must `create-secret` manually (⏳ v2 wires this into `setup.sh`). There is **no `bot-stack-*/` secret prefix, and no `notiops/devops-agent-config`** (Agent Space id and other metadata live in the DDB onboard record + CDK context, not a secret).

### 4.3 Optional overrides (change defaults)

Edit `infra/cdk.json` directly, or pass `-c key=value` to `cdk deploy`:

| Context | Default | Notes |
|---|---|---|
| `allowedOrigins` | (empty = all origins) | Comma-separated CORS allow-list, e.g. `https://d123.cloudfront.net` |
| `organizationId` | (empty) | Non-empty = multi-account (Organizations) mode |
| `inspectionReportLocale` | (empty = follow `DEFAULT_LOCALE`) | Language of the inspection **findings text**; one global value (`setup.sh` derives it from `$INSPECTION_REPORT_LOCALE`) |
| `monthlyLimitSeconds` | `-1` (= unlimited) | Monthly seconds budget guard for the inspection executor |
| `opsAlertEmail` | (empty) | Ops alert email (SNS subscription) |
| `webBaseUrl` | (empty) | Site root for the "view details / view all" deep links in inspection pushes; empty = no deep links |
| `reportsCdnDomain` | (empty) | Serve report downloads from your own CDN domain; empty = fall back to presigned URLs (dead after 12h) |
| `skipPhd` | `false` | `true` = do not create the PHD forwarder |
| `phdLinkedAccounts` | (empty) | Member accounts PHD should watch (comma-separated) |
| `oamSinkArn` | (empty) | Reuse an existing OAM sink instead of creating one |
| `costAgentMcpUrl` / `costAgentFunctionArn` | (empty) | Your self-hosted cost-agent MCP — the data source behind the four CUR sheets under FinOps; leave it unset and those four entries do not appear at all (see `requiresEnv`) |
| `agentRuntimeArn` | (empty) | ARN of an already-deployed Web Chat AgentCore Runtime |
| `operatorAppAlreadyEnabled` | `false` | ⚠️ **Never pass this by hand** — passing `true` makes the stack assume the Operator App is already enabled and skip enabling it |

For the IM side (`enabledPlatforms` / `imAllowedChatIds`) see the `ImStack` context
table in §14. `infra/cdk.json`'s `context` block contains **no** entries for any of
these keys — pass them with `-c` on the command line, or add them to `cdk.json`
yourself.

> 🔴 **Six of the seven keys this table used to list do not exist at all**
> (`bedrockModelId` / `agenticChatMode` / `awsMcpMode` / `enableMcpPricing` /
> `defaultLocale` / `defaultLlmProvider`), and the default `bedrockModelId` value it
> printed (`us.anthropic.claude-sonnet-4-6`) has not been the default model for a
> while either (it is `global.xai.grok-4.6` now, and the effective value comes from
> the DDB model catalogue rather than a deploy-time parameter). They were pre-M2 keys
> feeding the `BotStack` Fargate container, and that stack is retired — criterion:
> `git grep -n <key> -- infra/` returns zero hits for every one of them. See the
> matching warning in §14.

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

1. Dependency check: `node` ≥ 22 / `npm` / `npx cdk` / `aws` / `jq` / `python3` / `uv` (**exits immediately if uv is missing** — otherwise a failed agent deployment silently degrades Web Chat to echo mode; not checked when `SKIP_AGENT=true`). **No container build tool is required at all** since 2026-09-03 (IM refactor M2) — see §2.1
2. Lets you pick a deploy Profile from your local `~/.aws` profile list (or keep the current one)
3. `aws sts get-caller-identity` to detect the account, prompts you to confirm
4. Lets you pick a deploy region from 6 options (default `ap-northeast-1`; includes a "custom input" choice)
5. (Optional) asks whether to deploy PHD event forwarding (default `Y`)
6. Asks which IM platforms to deploy (**default `0` = skip, web UI only**; `1` Feishu / `2` Slack, multi-select). **Only sets the `enabledPlatforms` flag — does not collect credentials**
7. **`[1/4]` Build the frontend** — builds only the Web Chat frontend (`frontend/chat-app`). The old admin console (`frontend/frontend-app`) and the old REST API behind it were retired on 2026-09-04 in this release; the directory no longer exists in the repo and `setup.sh` no longer builds it. This step also copies `config/capabilities.json` / `config/eol-dates.json` into `bff/web-chat/` (the capability manifest's single source of truth lives in `config/`, but the Lambda only packages `bff/web-chat/`) and installs the BFF dependencies (`npm ci --omit=dev`)
8. **Deploy the Web Chat Agent** — runs `scripts/deploy_agent.sh` to deploy the Strands agent onto AgentCore Runtime and get the Runtime ARN (injected into WebChatStack via `-c agentRuntimeArn`; `SKIP_AGENT=true` skips it and the BFF falls back to echo)
9. **`[2/4]` Install Lambda deps** (boto3 / powertools / jinja2, `--platform manylinux2014_x86_64` for Linux binaries). **If you selected IM**, it also runs `scripts/build_im_layer.sh` to build the IM dependency layer (`lark-oapi` / `slack-sdk` / `boto3`, manylinux wheels too). A failure here **aborts on the spot** rather than skipping quietly — with packages missing from the layer, `ImStack` fails at synth time anyway
10. CDK bootstrap (if the target account + region isn't bootstrapped yet; reused if already bootstrapped + healthy)
11. **`[3/4]`** CDK synth → IAM consistency check → **CDK deploy `--all`** (`NotiOpsBackendStack` + **`WebChatStack`**; plus **`ImStack`** if you selected IM). **No image builds at all any more** — `BotStack` is retired (see §0.1)
12. **CUR + Athena FinOps data source** guidance (detect / reuse / create new, see §13)
13. **Create the Cognito `admin` user + temp password** (first deploy) and add it to the admin group
14. **`[4/4]`** Writes outputs to `cdk-outputs.json` and prints a **Web-Chat-first** completion banner (Web Chat URL + `admin` login credentials at the top)

Total time: ~10-15 min on first run (mostly CDK deploy + agent deploy; add the step-9 IM dependency-layer build if you selected IM — a `pip --platform manylinux2014_x86_64 --only-binary=:all:` cross-download of wheels, **no container image build**). Re-runs only patch deltas, ~3-5 min.

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
npx cdk deploy ImStack       # IM side (Feishu / Slack webhook + Lambda)

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

#### 5.3.3 The web app (operator app) is enabled automatically — nothing to click

The console step "Agent Space → Access → Operator access → **Configure web app**" (the API is `aidevops:EnableOperatorApp`) is **done by CDK at the same time it creates the space**; you don't click it. That adds one role, `notiops-agent-webapp-<account_id>` (trusts `aidevops.amazonaws.com`, carries the AWS managed policy `AIDevOpsOperatorAppAccessPolicy`), disabled and deleted together with the space when you delete the stack. In multi-account mode the member-account StackSet (`infra/member-devops-agent.yaml`) enables it too — otherwise onboarding N accounts would mean signing into N member-account consoles and clicking once in each.

**Symptom when it hasn't been enabled**: starting an investigation, connecting to one, DevOps Chat and publishing a skill all fail with `Invalid or unregistered domain` (an error that points nowhere near "you missed a button"). The only spaces that can still hit this are **spaces created before this version** and **spaces you created by hand** — for those, click Configure web app once in the console.

> ⚠️ **Upgrading an existing deployment to this version** (the space already exists and its web app was enabled by hand in the console): this property goes from absent to present, so CloudFormation will call Enable once while the service already considers it enabled. **This case has not been tested yet** (idempotent, or a conflict?). If the `NotiOpsBackendStack` update fails because of it, run `aws devops-agent disable-operator-app --agent-space-id <space id> --region <region>` and re-run `./setup.sh` — the web app domain is derived from the space id, so disabling and re-enabling **does not change the URL**.

#### 5.3.4 Recommended minimal verification

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

#### 5.3.5 Why we don't reuse your existing space

The CDK template uses `CfnAgentSpace` to **create a new one**, by design:

- ✅ **Zero configuration**: a fresh customer running `./setup.sh` gets Agent Space + Trigger Role + Association automatically wired
- ❌ **Side effect**: customers with existing spaces have to re-do that space's configuration in the new one (this section)

A future capability ("support reusing an existing Agent Space") would have `setup.sh` ask "do you have an existing Agent Space to reuse?" interactively. **Not supported today.**

### 5.4 Upgrading an installed environment: cross-stack Export retirement preflight (setup.sh does it for you)

**Upgrades only — a fresh install never hits this.** If you installed an older version and re-run `./setup.sh` to upgrade, you may hit:

```
Export NotiOpsBackendStack:ExportsOutputFnGetAttFrontendCDNF4E135DEDomainNameBF02A209
cannot be deleted as it is in use by WebChatStack
```

`NotiOpsBackendStack` then goes to `UPDATE_ROLLBACK_COMPLETE` and `WebChatStack` / `ImStack` are SKIPPED.

**Why**: Method B is three stacks (main + WebChatStack + ImStack), and every value passed between them (Cognito pool id, reports CDN domain, …) becomes a CDK-generated **CFN Export**. When a version drops a cross-stack parameter (this one drops `idleConsoleUrl`, retired together with the old console), the new main stack has to **delete** that export — but the **old** WebChatStack still installed on your account still holds an `Fn::ImportValue`, and CloudFormation refuses. `cdk deploy --all` updates main first, so that's the wall you hit first.

**⚠️ Key point: plainly re-running does NOT self-heal.** CloudFormation treats `UPDATE_ROLLBACK_COMPLETE` as a normal settled state and CDK will not delete-and-recreate, so ten more `--all` runs produce the same error.

**What you have to do: nothing — just re-run `./setup.sh`.** As of this version, `setup.sh` runs a preflight before `cdk deploy --all` ([scripts/export_retire_plan.py](../scripts/export_retire_plan.py) — read-only `describe-stacks` plus the local cloud assembly; it changes no resources) with four possible verdicts:

| Verdict | Meaning | What setup.sh does |
|---|---|---|
| `SKIP` | Fresh install, or this version deletes no deployed export (**the vast majority of upgrades**) | Proceeds straight to `--all`, byte-for-byte the old behaviour |
| `REORDER <stack>…` | This version retires an export | Deploys the consumer stack(s) **first** with `cdk deploy <stack> --exclusively` to release the reference, **then** `--all` |
| `WAIT <status>` | Main stack is mid-change (`UPDATE_IN_PROGRESS`, …) | Aborts and asks you to re-run once it settles — any decision made now would be stale |
| `FALLTHROUGH …` | The same version both retires **and** adds an export, and a consumer needs the added one | Warns loudly, then continues in the normal order (see below) |

**Already stuck in `UPDATE_ROLLBACK_COMPLETE`?** Just re-run `./setup.sh` — the preflight detects it and reorders automatically. To do it by hand:

```bash
cd infra
# 1. Update the consumer stack alone so it stops importing the export being deleted.
#    ⚠️ --exclusively is mandatory: without it CDK deploys the dependency (main) first,
#       i.e. exactly the order that fails.
#    ⚠️ Pass the full set of -c flags (copy them from the setup.sh line) — one missing
#       flag synthesizes a different template.
npx cdk deploy WebChatStack --exclusively --require-approval never -c enabledPlatforms=feishu
# 2. Then the full deploy
npx cdk deploy --all
```

**What about `FALLTHROUGH`?** Reordering cannot save that version (consumer-first fails with `No export named … found`; main-first fails on the export deletion). The correct answer is to **split it into two releases**: ship the retirement first, then the addition. A CI gate in this repo (`cfn-export-gate` plus [infra/exports.golden.json](../infra/exports.golden.json)) blocks such a version before it reaches `main`, so as a deployer you should essentially never see it.

> 📌 **Method A (one-click deploy) is unaffected**: it is a **single stack** (`NotiOps`) with no cross-stack references and therefore no CFN Exports — the failure mode does not exist structurally, so Method A needs no equivalent preflight step. This is not a feature gap (the **web functionality** of both paths remains identical).

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

### 6.1 The webhook endpoint is alive (only if you enabled IM)

> §6.1-6.3 **apply only if you enabled an IM platform (Feishu / Slack)**. For web-only deploys you can skip all of them.

IM runs on an **API Gateway HTTP API + Lambda webhook** — there is no long-lived container to look
at, so the criterion is "the URL exists + there are logs":

```bash
# The URL (this is exactly what you paste into the Feishu / Slack console)
aws cloudformation describe-stacks --stack-name ImStack --region $AWS_REGION \
  --query 'Stacks[0].Outputs[?OutputKey==`FeishuWebhookUrl`||OutputKey==`SlackWebhookUrl`]' \
  --output table
```

> ℹ️ **There are no containers any more**: the `BotStack` ECS Fargate long-connection
> containers were retired on 2026-09-03 (IM refactor M2), and fresh installs create no
> VPC / ECS / ECR. Rolling back to the long connection now means adding `new BotStack(...)`
> back into `infra/bin/app.ts`, running `cdk deploy BotStack`, and only then switching the IM
> platform console back to long connection / Socket Mode. Accounts installed before M2 may
> still have `BotStack` around at `desiredCount=1` (running and billing) — delete the whole
> stack to stop paying, or scale it to 0 first:
>
> ```bash
> aws ecs update-service --cluster <BotStack cluster> \
>   --service <FeishuBotService> --desired-count 0 --region $AWS_REGION
> ```

### 6.2 A message was received and processed

`@bot` something in a group, then read both Lambda log groups (Feishu shown; for Slack
replace `feishu` with `slack`):

```bash
aws logs tail /aws/lambda/notiops-im-ingress-feishu --region $AWS_REGION --since 5m
aws logs tail /aws/lambda/notiops-im-worker-feishu  --region $AWS_REGION --since 5m
```

| Symptom | What it means |
|---|---|
| both have logs | ✅ working |
| ingress yes, worker no | signature check passed but the async handoff failed — read the ingress error |
| `401 (signature/token)` in ingress | the two keys do not match the console; back to [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §1.2 |
| neither has logs | Feishu / Slack never sent it — is the delivery mode still on long connection / Socket Mode? |

### 6.3 End-to-end

In the channel, @ the bot:
```
@NotiOps list all EC2 instances in IAD
```

Expected:
1. Within seconds, a **🚀 Start Investigation** edit card appears (three input fields + 💡 LLM dimension hint)
2. Click **🚀 Dispatch Investigation** → the card updates to **✅ Dispatched, ⏳ Investigation starting**
3. A few seconds later, an **🔭 Investigation Started** card + progress updates
4. After 1–3 minutes, **one** **✅ NotiOps Report** card lands in the original channel (its first line is
   "🎯 Investigation target · <your question>", with three buttons underneath: 📊 View full report /
   🔍 Investigation trace / 🆘 Escalate to AWS Support — the report card should carry **no**
   "🔬 Open this investigation"; that one belongs to the progress card)

Then try a plain question that is **not** an investigation (it goes to the DevOps chat path, e.g.
`@NotiOps list every S3 bucket with its size`):

5. Within **1–2 seconds**, a **🤔 Thinking · Ns elapsed** card appears (this is the criterion — a card, immediately)
6. Body text and ⚙️ progress lines refresh on that same card, and the elapsed seconds in the title keep
   climbing (roughly every 2s for the first 30s, slower after that — see
   [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §6.2)
7. When it finishes (possibly minutes later) the card settles into the answer plus two buttons

⚠️ "It took several minutes to answer" is **not** a failure. There is exactly one criterion:
**did the thinking card show up immediately after you sent the question?** The user-facing wording is in
[IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §6 — don't file it as a regression.

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

> For Feishu you can also put the target group into the `notify_chat_ids` field of the `notiops/im-bot-feishu` secret, or configure it under Web Chat admin → "IM Integration".

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

### 8.1 Configuration changes

Edit the corresponding context in `infra/cdk.json`, then `npx cdk deploy <stack>`. ~2 min:

| Change | Edit which context | Deploy which stack |
|---|---|---|
| Edit chat_id allowlist | `imAllowedChatIds` (comma-separated) | `ImStack` |
| Add / remove IM platforms | `enabledPlatforms` (`none` = deploy no IM side at all) | `ImStack` |
| Toggle a single push event source | `enable*Push` family | `NotiOpsBackendStack` |

> ⚠️ **No longer context-driven** as of M2 (2026-09-03): chitchat mode, MCP mode, default language,
> default LLM. Those keys (`agenticChatMode` / `awsMcpMode` / `defaultLocale` / `defaultLlmProvider`)
> only ever fed the `BotStack` Fargate containers; with that stack retired, passing them **has no
> effect** (silently ineffective). Today: the mode flags are hard-coded in
> `infra/lib/constructs/im-core.ts`; **language** switches per conversation with `@bot 中文` /
> `@bot english` (`core/locale_resolver.py`); **default LLM** is the `default_model` an admin sets in
> the Web console's model catalogue, which any user can override for one conversation with
> `@bot model <alias>` (`core/llm_pref_resolver.py`). Full detail in §11.1.

### 8.2 Deploy new code

```bash
git pull
./setup.sh            # cdk deploy --all (no image builds any more)
```

`setup.sh` skips unchanged resources on re-runs and only patches the diff.

### 8.3 Force a fresh set of Lambda instances (no config change)

IM runs on Lambda, so there is **no "restart the task"** — a changed Secret takes effect on the next
cold start. To cycle every live instance right now (e.g. you just fixed a credential and want to
verify), touch an environment variable (any value change replaces the instances):

```bash
aws lambda update-function-configuration --region $AWS_REGION \
  --function-name notiops-im-worker-feishu \
  --environment "Variables={FORCE_ROLL=$(date +%s)}"
```

⚠️ That command **replaces** the whole environment map — read the existing `Variables` with
`get-function-configuration` first and pass them all back, don't send a single key. The safer move is
just `cdk deploy ImStack`. (On pre-M2 installs that still have ECS, the equivalent was
`aws ecs update-service --force-new-deployment`.)

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
| **L2 disable a whole conversation tier** | Edit `agenticChatMode: "disabled"` → `cdk deploy ImStack` | chitchat / general_qa paths |
| **L3 take IM from webhook back to long connection** | ⚠️ **No longer "minutes" after M2 (2026-09-03)** — `BotStack` is not instantiated by `infra/bin/app.ts` any more, so you first add `new BotStack(...)` back, install finch/docker, and `cdk deploy BotStack` (which creates VPC/ECS/ECR and builds images), then set the Feishu / Slack console delivery mode back to long connection / Socket Mode. Pre-M2 installs (stack still present) stay minutes-level: switch the delivery mode + `aws ecs update-service --desired-count 1 ...` | Single platform; ~20 min on fresh installs, minutes on pre-M2 installs ([IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §1.6) |
| **L4 turn the bot off entirely** | webhook mode: `aws lambda put-function-concurrency --reserved-concurrent-executions 0` (the ingress starts 429-ing everything at once); long-connection mode: `aws ecs update-service --desired-count 0 ...` | Single platform, instant |
| **L5 delete the stack** | `cd infra && npx cdk destroy <stack-name>` | Entire stack |

> ⚠️ Stack deletion removes ECR / IAM / SG / ECS. **The DDB tables and S3 report bucket are NOT deleted** (`removalPolicy: RETAIN`) — clean them up manually if needed. By design, every AWS resource created by this project carries the `auto-delete=no` tag to protect it from automated cleanup jobs.
>
> To remove the **whole environment** (as opposed to rolling back one stack), don't run
> `cdk destroy` stack by stack — use `./teardown.sh` in the repository root. It deletes
> the stacks in reverse dependency order and cleans up the non-CDK leftovers (CUR report
> definition, the one-shot EventBridge schedule, the WebSearch gateway, the 30-day
> recovery window on the secrets, orphaned log groups). Start with
> `./teardown.sh --dry-run`; the default keeps the three RETAIN'd tables, and
> `--delete-everything` wipes them too.

---

## 10. Top 5 Deployment Errors

| Symptom | Likely cause | Diagnose / fix |
|---|---|---|
| **Access denied on Secrets Manager** — during CDK deploy (creating the empty secrets) or later when you fill in IM credentials | Deploy user lacks Secrets Manager permission | `aws iam attach-user-policy --policy-arn arn:aws:iam::aws:policy/SecretsManagerReadWrite` |
| **`ImStack` fails at synth complaining the Layer is missing packages** | `scripts/build_im_layer.sh` wasn't run, or it failed | Re-run `bash scripts/build_im_layer.sh` (it cross-downloads with `pip --platform manylinux2014_x86_64 --only-binary=:all:` — **no container needed**) |
| **Bot doesn't respond to @ — worker logs show `auth failed`** | Wrong IM credentials / wrong Secret payload | `aws secretsmanager get-secret-value --secret-id <name>` and compare to the original credential; fix it and wait for the next cold start (no redeploy needed) |
| **Bot dispatch succeeds but the report doesn't return to the channel** | report-handler Lambda doesn't have IM credentials | Verify the Secret ARNs in the Lambda env match those in `ImStack`; re-run `cdk deploy NotiOpsBackendStack` |
| **`Bedrock InvokeModel` AccessDeniedException** | Task role lacks permission / model not enabled in region | Add `bedrock-runtime:InvokeModel` to IAM, or Bedrock console → Model access |

---

## 11. Full CDK Context Reference

All tunable parameters live under the `context` block in `infra/cdk.json`. After editing, run `cd infra && npx cdk deploy <stack>`.

### 11.1 ImStack (IM platform stack)

`ImStack` reads exactly **three** context keys (`infra/lib/im-stack.ts`):

| context key | Default | Description |
|---|---|---|
| `enabledPlatforms` | `feishu` | IM platforms to enable (comma-separated, e.g. `feishu,slack`). `none` = the whole `ImStack` is not instantiated (`infra/bin/app.ts`); platforms not listed get no Lambda / webhook at all |
| `imAllowedChatIds` | (empty) | chat_id allowlist (comma-separated; empty = no restriction). Injected as `ALLOWED_CHAT_IDS` on the worker |
| `organizationId` | (empty) | Non-empty = multi-account (Organizations) mode, same semantics as `NotiOpsBackendStack` |

> ⚠️ **These keys stopped doing anything after M2 (2026-09-03)** — don't copy them from older docs:
> `bedrockModelId` / `bedrockRegion` / `agenticChatMode` / `defaultLlmProvider` / `gptRegion` /
> `awsMcpMode` / `enableMcpPricing` / `defaultLocale` / `allowedChatIds`.
> They only ever fed the `BotStack` Fargate container environment, and that stack is retired. The IM
> equivalents are now **hard-coded in `infra/lib/constructs/im-core.ts`** (`AGENTIC_CHAT_MODE=enabled`,
> `AWS_MCP_MODE=docs_only`, `AWS_MCP_PRICING_ENABLED=false` / `AWS_MCP_COST_ENABLED=false` — there is no
> sidecar for a Lambda to talk to). **Model** is resolved at runtime: per-chat / per-DM `@bot model <alias>`
> → the DDB model catalogue's `default_model` (`core/llm_pref_resolver.py`, see
> [USER_GUIDE.en.md §7](USER_GUIDE.en.md#7-model-selection-bot-model)); **locale** comes from
> `core/locale_resolver.py`'s user / DM / thread / incident records, falling back to `en` when there is
> none (`DEFAULT_LOCALE` is not injected). Passing these `-c` flags neither errors nor takes effect —
> that is **silently ineffective**, which is exactly why they're listed here.

### 11.2 NotiOpsBackendStack (shared backend + push)

| context key | Default | Description |
|---|---|---|
| `agentSpaceId` | (auto) | DevOps Agent space id. **No need to supply one** — CDK auto-creates `notiops-devops-<account>` (see §5.3.5); this context is for advanced override only |
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
| **Agent Runtime** | Bedrock AgentCore Runtime hosting the Strands agent (default model **Claude Sonnet 5**, taken from the catalogue's `default_model`). Deployed as a CodeZip by `scripts/deploy_agent.sh`, which emits a **Runtime ARN** |
| **BFF Lambda** | Node 20 Lambda (`notiops-web-chat-bff`) with a **Function URL** (`AuthType=AWS_IAM`) that responds to the frontend via **SSE streaming**; it calls the Agent Runtime and also handles deterministic operations directly (case creation `/actions/execute`, the `/support/services` catalog, etc.) |
| **Frontend** | React / Vite single-page app, statically hosted |
| **Auth** | Cognito (reuses the notiops user pool) + Identity Pool; the frontend gets temporary credentials and **SigV4-signs** requests to the Function URL |
| **Data** | CDK `WebChatStack` creates the single DDB table `notiops-web-chat` (sessions/messages + the persistent notification inbox in the `notif#` segment, 90-day TTL, account-shared) |

The data plane is **strictly read-only** end to end: the hard boundary is a read-only IAM role, and on top of it sit tool-level read-only enforcement (`READ_OPERATIONS_ONLY` + a curated read-only MCP allow list), a command-level denylist, and a read-only system prompt (see [TECHNICAL_DESIGN.en.md](TECHNICAL_DESIGN.en.md) §5.3 for the full make-up of this defense in depth). Web Chat does not relax any of it.

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

- **On by default** (5 — highest operational value, manageable noise): AWS Health / CloudWatch Alarm / Cost Anomaly / Trusted Advisor / GuardDuty
- **Off by default** (5 — turn on with `-c webNotif<Id>=on`): Backup / EC2 Spot / Auto Scaling / RDS / Config
  - Why off: either high volume that floods the inbox (Backup fires per job, Spot, RDS), or it needs a paid service enabled first and is noisy compliance chatter (Config)

> ⚠️ **3 of the 5 on-by-default sources also depend on something on the customer's side** — the rule is enabled, but without the prerequisite no events arrive. The frontend empty state names the reason, so it doesn't get mistaken for NotiOps being broken:
>
> | Source | Prerequisite |
> |---|---|
> | GuardDuty | GuardDuty must be **enabled** in the account (paid). Until then there is no detector and no findings; an enabled rule costs nothing and starts working the moment GuardDuty is enabled, no redeploy needed |
> | Cost Anomaly | A **cost anomaly monitor** must exist in Cost Explorer first (free); and events are emitted only in `us-east-1` |
> | Trusted Advisor | Needs a **Business+ / Enterprise / Unified Operations** support plan; and events are emitted only in `us-east-1` |

> ⚠️ **Cost Anomaly and Trusted Advisor are global services that only emit EventBridge events in `us-east-1`**
> (TA: [docs](https://docs.aws.amazon.com/awssupport/latest/user/cloudwatch-events-ta.html); Cost Anomaly emits in its home region, normally `us-east-1`).
> Deploy NotiOps in another region and those two rules exist but **never fire** — `cdk synth/deploy` prints an explicit warning.
> To receive them: deploy NotiOps in `us-east-1`, or add a cross-region forwarding rule in `us-east-1` that ships the events to your deployment region.
> Don't need them? `-c webNotifCostAnomaly=off -c webNotifTrustedAdvisor=off` and the warning goes away.

> 📌 **Both deployment paths ship this whole set, from one shared definition.** The event-source definitions (10 sources, defaults, rule names, rule descriptions, Lambda env) live in
> [`infra/lib/constructs/web-notif-sources.ts`](../infra/lib/constructs/web-notif-sources.ts), and `setup.sh`'s
> `notiops-backend-stack.ts` and the one-click `notiops-webchat-standalone-stack.ts` **import the same file**
> (check ⑤ in `scripts/test_oneclick_parity.py` pins that nobody copies the list back into a stack).
> **The one intentional difference is how you turn a source off**: the `-c webNotif<Id>=off` above only applies to `setup.sh`.
> One-click has no `-c`, so you Disable the `notiops-web-notif-*` rule in the **EventBridge console** instead — the template does not
> manage a rule's enabled state, so that manual change is not reverted by a version upgrade.
> The customer-facing write-up for one-click is [DEPLOYMENT_ONECLICK.en.md §2.9](DEPLOYMENT_ONECLICK.en.md#29-notifications-inbox).

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
| **Every question comes back as `Got it — you said: … (Echo — AGENT_RUNTIME_ARN not set …)`** | **The agent was never deployed** and the BFF is on its echo fallback. Chain: `deploy_agent.sh` failed → no Runtime ARN → `WebChatStack` got an empty `AGENT_RUNTIME_ARN` → [bff/web-chat/index.mjs](../bff/web-chat/index.mjs) echoes. **One command fixes it: `bash scripts/fix_web_chat_echo.sh --region <region>`** (read-only diagnosis → prints the verdict → after you confirm: installs uv / pins the CLI / restores the CDK harness / redeploys the agent / injects the ARN into the BFF, carrying over the live `organizationId` and CORS allowlist). By hand: **first suspect is a missing `uv`** (see §2.1) → install uv → `DEPLOY_REGION=<region> bash scripts/deploy_agent.sh` → `cd infra && npx cdk deploy WebChatStack --exclusively -c agentRuntimeArn=<ARN>`. Verify: `aws lambda get-function-configuration --function-name <web-chat-bff> --query 'Environment.Variables.AGENT_RUNTIME_ARN'` must be non-empty |
| **Same symptom, but `uv` IS installed** | Second suspect: the **agentcore CLI version drifted**. `@aws/agentcore` ships roughly weekly, and `agentcore deploy`'s "Sync CDK dependencies" step **rewrites the in-repo, git-tracked** `agent-build/NotiOpsWebChat/agentcore/cdk/package.json` (bumping `@aws/agentcore-cdk`), which then no longer matches the in-repo `lib/cdk-stack.ts` → `tsc` fails → deploy dies in seconds, and **re-running does not self-heal**. The real error only exists in the CLI's own log: `tail -80 "$(ls -t agent-build/NotiOpsWebChat/agentcore/.cli/logs/deploy/*.log \| head -1)"`. Fix: `npm install -g @aws/agentcore@0.24.2` + `git checkout -- agent-build/NotiOpsWebChat/agentcore/cdk/package.json agent-build/NotiOpsWebChat/agentcore/cdk/package-lock.json` + `rm -rf agent-build/NotiOpsWebChat/agentcore/cdk/node_modules`, then re-run `deploy_agent.sh` — that whole sequence is exactly what `bash scripts/fix_web_chat_echo.sh` does. (Since v1.0.15 `deploy_agent.sh` hard-stops on both states before deploying) |
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

---

## 14. Customer CUR Dashboard + cost-agent MCP (optional)

> How this differs from §13: §13 queries **this deployment account's own** CUR (which NotiOps creates for you). This section connects **someone else's CUR table** — a customer's, or several payers' (the TAM scenario) — at line-item granularity, through a separate cost-agent MCP Lambda. Leave it unconfigured and the FinOps page simply doesn't show the 4 CUR sheets and chat doesn't mount the customer-CUR tools; nothing else changes (fail-closed).

### 14.1 What it adds

| Capability | Where | Notes |
|---|---|---|
| 4 CUR dashboard sheets | FinOps page: Cost trend (cross-filtering) / Credit / Extended Support / Savings Plans | BFF caches per day; instant after the daily warmup |
| Ask about customer spend in chat | Just ask in the conversation ("customer's total spend in July") | The agent reaches the MCP's 45 CUR tools through 2 meta-tools (`list_cost_tools` / `call_cost_tool`) |
| Inline charts | Any answer with >=3 data points gets a chart | The tool return carries `display_hint`; the frontend renders a ```chart fence |

### 14.2 Deploy the cost-agent MCP Lambda (customer-specific, prerequisite)

This Lambda's code lives in a **separate repository** (Python, streamable-http MCP over a Lambda Function URL, `AuthType=AWS_IAM`) — not in this repo; ask the maintainer for the address. One Lambda per customer; all the per-customer difference lives in environment variables:

| Environment variable | Meaning | Example |
|---|---|---|
| `CUR_TABLE` | The customer's CUR table (db.table) | `customer_cur_data.customer_all` |
| `PARTITION_STYLE` | Partition layout: `year-month` / `billing-period` / `flat` | `year-month` |
| `ATHENA_WORKGROUP` / `ATHENA_OUTPUT` | Query workgroup / result location (empty = follow the workgroup) | `primary` |
| `CUR_ACCESS_KEY_ID/SECRET/TOKEN` | Temporary credentials for cross-account queries; leave empty to use the execution role in-account | — |

> ⚠️ Measure caveat: the 45 tools' SQL was tuned against a reference customer (multi-payer, EDP, heavy SP/ODCR use). The basic tools (totals / trend / dimension breakdowns / SP / RI / Extended Support) work as-is on a new table; a few derived measures (LOB tag mapping, the historical window in SP `per_vcpu_rate`) are worth reviewing against your customer's CUR structure before you hand them over.

### 14.3 Wiring it into NotiOps (both deployment paths are IaC; you supply two values)

You supply exactly **two values**, and they must come as a pair: a Function URL does not contain the function ARN, and `lambda:InvokeFunctionUrl` can only be granted per resource — so filling in only one half deploys a data source that *looks* installed and 403s on every call, where the 403 is visible only in CloudTrail. Both paths therefore block that half-configuration **before anything is created**.

| | How you supply it | Where "only one half" is caught |
|---|---|---|
| Path A (one-click CFN) | Parameters page → *Optional: your own CUR data source* → `CostAgentMcpUrl` + `CostAgentFunctionArn` (you can also add them later via a stack update) | `CostAgentArnRequiredWithUrl` (a CfnRule — parameter-validation time, the stack is never created) |
| Path B (setup.sh) | `COST_AGENT_MCP_URL=... COST_AGENT_FN_ARN=... ./setup.sh` | setup.sh's preflight check, **before** the ~20-minute agent deploy |

Once supplied, both paths wire up all four pieces automatically (no manual steps remain):

1. **Agent (chat)**: runtime env var `COST_AGENT_MCP_URL` + the execution role's `InvokeCostAgentMcp` (`lambda:InvokeFunctionUrl`).
2. **BFF (dashboard data)**: the same env var + `InvokeCostAgentMcp` + S3 read/write on the cache prefix (`CurDashCache`).
3. **Cache lifecycle**: 3-day expiry on the data bucket's `cur-dash-cache/` prefix.
4. **Daily warmup**: EventBridge rule `CurDashWarmup`.

> ⚠️ **Upgrade note**: these used to be manual (the old §14.3/§14.4 in v1.0.x). CDK now **owns** the BFF env var and that rule — the next deploy **overwrites** any `COST_AGENT_MCP_URL` you set by hand with the parameter value. So when you upgrade, pass the URL *and* the function ARN to setup.sh (or fill in the one-click parameters); otherwise your manual configuration is reset to empty and the 4 sheets silently disappear (their capability nodes are dropped by `requiresEnv`). Delete any EventBridge rule you created by hand, or the warmup runs twice a day.

**IAM is two-sided**: the identity side (both roles) is now IaC. The **resource policy still lives on the cost-agent side** — that's your own separate deployment, not in this repo — and must allow those two roles to invoke its Function URL. Field-tested trap: the identity policy must **not** carry a `lambda:FunctionUrlAuthType` Condition; with it, every call 403s.

### 14.4 What happens when the data source is down (the degradation chain never blocks the whole tool)

This is an **external** dependency, so it is fail-soft at four layers, and every degradation is **stated out loud** (a silent degradation is worse than an error — CE's aggregated numbers passing themselves off as CUR line-item numbers would have the customer reconciling against the wrong figures):

| Layer | Situation | What the customer sees |
|---|---|---|
| Deploy time | Parameters not supplied | The capability **does not exist, by design**: the 4 `nav:finops:cur-*` nodes are dropped by `requiresEnv` (no menu entry that does nothing when clicked); the agent mounts zero tools |
| BFF | MCP unreachable / timing out | Only those 4 sheets say "temporarily unavailable" (HTTP 200 + `available:false`); the rest of the page is unaffected |
| Agent | MCP unreachable / timing out | The answer still comes: **customer CUR (line-item) → CE MCP (aggregated, deploy account) → `call_aws` / `aws_readonly`**, and it says which source and which measure it fell back to |
| Agent | 2 consecutive transport failures | A 10-minute circuit breaker fast-fails instead of waiting out 300s every turn — *that* wait is what actually blocks the whole tool |

A single tool's **logical error** (bad arguments) does not trip the breaker: the data source is alive, so the model is left to fix its arguments and retry. Covered by `tests/test_cost_agent_mcp_failsoft.py` and `bff/web-chat/tests/cur_dashboard_failsoft.test.mjs`.

What the warmup does: on `{"source":"notiops.curdash.warmup"}` the BFF queries all 4 panels concurrently for the default window (T-33 to T-3 — the last 3 days of CUR aren't complete, so the window is closed early) and writes the day's cache, so the first person to open it during the day gets it instantly. The cron is `cron(0 22 * * ? *)` (22:00 UTC = 06:00 Beijing) — **the cache key's date basis is UTC+8**, so if you change the timezone you must change both. To verify, send the same payload manually with `aws lambda invoke --invocation-type Event`; the log should show `curdash warmup: cube:fulfilled credit:fulfilled es:fulfilled sp:fulfilled`.

### 14.5 Troubleshooting

| Symptom | Cause |
|---|---|
| The 4 sheets say "data source not configured" | The BFF is missing `COST_AGENT_MCP_URL`, or IAM isn't through |
| MCP calls keep returning 403 | The identity policy carries a `FunctionUrlAuthType` Condition (remove it); or the resource policy doesn't list the calling role |
| First open of the day still takes 1-5 minutes | The warmup didn't run, or the timezone is misaligned — the cache key's date basis is UTC+8 and the EventBridge cron must match it; check the BFF log's warmup line |
| Warmup reports all-rejected | Usually an Athena failure on the MCP side (expired cross-account credentials, etc.); the BFF log carries a per-panel reason |
