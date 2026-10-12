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
- §3 [Register IM Apps](#3-register-im-apps) (Feishu / Slack / DingTalk)
- §4 [Configuration & IM Credentials](#4-configuration--im-credentials)
- §5 [One-Command Deploy `setup.sh`](#5-one-command-deploy-setupsh)
- §6 [Smoke Tests](#6-smoke-tests)
- §7 [Enable / Tune Push Mode](#7-enable--tune-push-mode)
- §8 [Day-2 Operations](#8-day-2-operations)
- §9 [Rollback Strategy](#9-rollback-strategy)
- §10 [Top 5 Deployment Errors](#10-top-5-deployment-errors)
- §11 [Full CDK Context Reference](#11-full-cdk-context-reference)
- **§12 [Web Chat Deployment](#12-web-chat-deployment)** — the browser-based agentic AI assistant, independent of the IM bot
- **§13 [CUR + Athena FinOps Data Source](#13-cur--athena-finops-data-source)** — cost-detail data source for the FinOps dashboard (optional; two paths: reuse an existing CUR = ready in minutes / new CUR = ~24h first delivery)
- §14 [Customer CUR Dashboard + cost-agent MCP](#14-customer-cur-dashboard--cost-agent-mcp-optional) (optional) — line-item detail from one CUR table for chat and 4 dashboard sheets; NotiOps deploys the cost MCP server for you, or points at one you already run

---

## 0. Quick Deploy (TL;DR)

> For "get it running first, read details later". All commands assume you've already finished §2 Prerequisites. The web console (browser chat) deploys by default and is the product's main entry; IM (Feishu / Slack / DingTalk) is an optional supplement — only walk §3 Register IM Apps if you want to enable it.

> 💡 **Just want to try Web Chat?** Then you can skip this whole document.
> [DEPLOYMENT_ONECLICK.en.md](DEPLOYMENT_ONECLICK.en.md) is a path that needs **nothing installed
> locally and no access keys**: download one CloudFormation template from the Release, upload it in
> the console, stack done in ~4.5 minutes. The trade-off is that it deploys **Web Chat only** (plus at
> most one optional IM bot, request/response only) — no daily inspection, no inspection backend, and no
> proactive pushes into IM; on that path "Inspection" **does not appear at all** under Web Chat's
> "More" (rather than failing to load once you open it). The full list is in §0.1 of that document.
> Want those, come back here and run `setup.sh`. ⚠️ In the same account and Region the two paths
> use the same table and bucket names and cannot exist side by side: first delete the one-click
> stack with `DeleteEverything` (its data does not carry over; see
> [§6 of that document](DEPLOYMENT_ONECLICK.en.md#6-deleting-the-stack)), or install `setup.sh` in another Region.

### 0.1 One-command deploy

```bash
./setup.sh
```

The first run is **interactive**: confirm AWS account + region → (optional) PHD event forwarding → **pick which IM platforms to deploy (`1` Feishu / `2` Slack / `3` DingTalk, multi-select such as `1,3`; on a first install the default is `0` = skip, web UI only. On a **re-run** the default is "keep whatever the live deployment already has enabled", so pressing Enter will not freeze a running bot — see §4.1)** → build the frontend (there is only one: Web Chat's `frontend/chat-app`) → deploy the Web Chat Agent (AgentCore Runtime) → CDK bootstrap → CDK synth → CDK deploy `--all`. **Web Chat + the backend agent deploy by default.** IM credentials are **not** collected here — CDK creates **empty** secrets, and you fill them in *after* deploy (see §4 / §5).

> **About DingTalk**: DingTalk is supported on **both deployment paths** since 2026-09-08, in the same Lambda-webhook shape as Feishu / Slack (`setup.sh` option `3`; one-click `InstallOption=web+dingtalk`). If you don't pick it, `enabledPlatforms` excludes `dingtalk` → `ImStack` creates no DingTalk Lambda / webhook, no cost. DingTalk does have a few **real platform-capability** differences from Feishu / Slack (card buttons can only be links, sent messages cannot be edited, robots cannot add reactions, proactive pushes need a second URL) — the full table is in [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §3.6; separately, the DingTalk console validates nothing when you save the message-receive URL — see §3.3.

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

Once `setup.sh` finishes, split features into two buckets — **don't mistake the "onboard member accounts" step for something the whole product needs:**

| | Whole product **works out of the box** (no extra config) | **Only** these features need one more step |
|---|---|---|
| **Feature** | Web Chat: AWS Q&A · investigation · cost analysis · Support cases · Skills · notifications (Health / alert push) · resource inspection (High Load / Idle & Cost) | Bringing **member accounts** (any account other than the deploy account) into inspection |
| **Default target** | **The deploy account itself**, usable right after login; inspection covers it automatically too (all regions by default, daily at 02:00 UTC) | Onboard each account under Web Chat's left nav "More → Admin" → "Accounts" → "Member account onboarding" |
| **If not configured** | — | Inspection covers the deploy account only; **Web Chat is completely unaffected** |

> In one line: **just chatting in Web Chat → log in and go, nothing to configure**; resource inspection of the deploy account also runs on schedule as soon as it is installed — see the results under "More → Inspection" (change the run time in the same place, under "Settings → Thresholds & Schedule"; to skip the wait, click "Run high-load" / "Run idle" on the dashboard for first results right away). Only to bring **other accounts** into inspection do you onboard them under "More → Admin" → "Accounts", and that works in either deploy mode (an account added there can also be investigated on the web with "Deep Dive" / "DevOps Chat"); what depends on the deploy mode is taking IM, NotiOps-model conversations in Web Chat, Support cases and the daily cost-anomaly scan across to other accounts, or receiving PHD events from member accounts — see §0.1.2. The collection role in a member account (`notiops-cross-account-role-<deploy account>`; read-only, plus Support-case open / reply / resolve by default — set the template parameter `EnableSupportCaseWrite=false` to keep it strictly read-only) is **not** created by hand — the onboarding template creates it: in a multi-account deployment (`./setup.sh --multi-account`), organization accounts get **one-click onboarding** in "Member account onboarding" (rolled out via StackSets, including DevOps/PHD event forwarding); in every other case (the account is outside this organization, you lack management-account access, or the deployment is not multi-account) use "Manual onboarding" on the same page — enter the account ID → "Generate link" → send the Launch Stack link to that account's admin, who deploys it while signed in to **that account** → paste `AgentSpaceId` / `TriggerRoleArn` / `InspectionAgentSpaceId` from the Stack Outputs back → "Test connection" → "Save & activate"; no Organizations permissions needed at any step. Which regions each account is scanned in is set on that account's row of the "Accounts" page ("Inspection scope"; `*` = all regions); exclude resources you don't want scanned under "More → Inspection" → "Settings → Scope".
>
> ⚠ Member accounts onboarded before 2026-10 have this role named `notiops-idle-detection-role-<deploy account>` (a leftover from the old idle-detector). No manual migration is needed: the two names are treated as aliases, and once the member stack is updated to the new name the next cross-account call updates the registration on its own.

### 0.1.2 Deploy mode: single-account (default) vs multi-account `--multi-account`

**Decide the mode before running `setup.sh`** — it determines how CDK bakes the cross-account gate at deploy time. **Switching after deploy requires a redeploy** (it is not a runtime toggle).

| | **Single-account (default)** | **Multi-account** `./setup.sh --multi-account` |
|---|---|---|
| **How to trigger** | Just `./setup.sh` | `./setup.sh --multi-account`, run either in the **organization management account (payer)** or in a member account registered as a **StackSets delegated administrator** — see the note below |
| **Who it's for** | Using NotiOps in **this account only** (most trials / single-account customers) | Managing many accounts under Organizations and wanting **cross-member-account** inspection / investigation / event forwarding |
| **Cross-account gate** | Locked to the deploy account (`LOCKED_ACCOUNT_ID` = this account). The gate covers IM, NotiOps-model conversations in Web Chat, Support cases under "Cases" and the daily cost-anomaly scan — those only touch the deploy account. **Resource inspection** and the web's "Deep Dive" / "DevOps Chat", which call **DevOps Agent directly**, do not go through it, so accounts added with "Manual onboarding" are still inspected in this mode and can still be investigated with those two | Gate unlocked (`LOCKED_ACCOUNT_ID` empty, using `aws:PrincipalOrgID` to allow the whole org): the paths on the left can reach onboarded member accounts too |
| **Member-account resources** | Not rolled out (to add another account, use "Manual onboarding" and have that account deploy one stack itself — see §0.1.1) | Rolled out automatically to member accounts via **StackSets** (the collection role — read-only, plus Support-case write by default, see §0.1.1 — and DevOps/PHD event forwarding) |
| **Features affected** | All Web Chat features work out of the box for **this account**; manually onboarded accounts are inspected and can be deep-investigated on the web | Additionally unlocks: **one-click onboarding** of organization accounts under Web Chat "More → Admin" → "Accounts" → "Member account onboarding" (StackSets roll out the collection role + DevOps/PHD event forwarding, and the step-2 DevOps Agent association follows by itself), cross-account **PHD event forwarding**, **cross-account troubleshooting** in IM and NotiOps-model conversations, cross-account **Support cases**, and the daily cost-anomaly scan covering member accounts |

#### Hard prerequisite: management account, or a StackSets delegated administrator

> `--multi-account` accepts **two** deploying identities — either one is enough:
> 1. the **AWS Organizations management account (payer)**; or
> 2. a member (linked) account that the management account has registered as a **CloudFormation StackSets delegated administrator**.
>
> **No flag distinguishes them** — `setup.sh` detects it (`detect_stackset_call_as`). Once it recognizes
> a delegated administrator it carries `CallAs=DELEGATED_ADMIN` through every StackSets call (creating /
> updating both StackSets, rolling out instances, and `teardown.sh`'s inventory and delete paths), and
> passes `stackSetCallAs` / `orgManagementAccountId` into CDK so the runtime one-click onboarding in
> `bff/web-chat/member_accounts.mjs` sends it too.

Check before you run `--multi-account` (a few seconds):

```bash
aws organizations describe-organization --query 'Organization.[Id,MasterAccountId]' --output text
aws sts get-caller-identity --query Account --output text
```

Second **column** of the first command (`MasterAccountId`) == output of the second ⇒ this is the
management account, go ahead. They **differ** ⇒ this is a member account; check whether it is already a
StackSets delegated administrator:

```bash
aws organizations list-delegated-administrators \
  --service-principal member.org.stacksets.cloudformation.amazonaws.com \
  --query 'DelegatedAdministrators[].Id' --output text
```

This account's id **is** in the output ⇒ go ahead. It is not ⇒ three ways forward: have the management
account register it (below), run it in the management account instead, or stay on default single-account
mode (web / IM / deep investigation / case creation all work exactly the same; you just get no one-click
onboarding and fewer cross-account features — see the table above).
⚠️ That command **must** pass `--service-principal`. Without it you get the delegated administrators of
**every** service (GuardDuty / Config / Security Hub …); those accounts also hold Organizations read-only
permissions but **cannot** operate StackSets, so judging from that list gives you a "should work" that
turns into `AccessDenied` at StackSet creation time.
First command says `AWSOrganizationsNotInUseException` ⇒ this account is not in an organization at all;
single-account is the only option.

**Registering a delegated administrator (one-time, run in the management account):**

```bash
aws organizations register-delegated-administrator \
  --service-principal member.org.stacksets.cloudformation.amazonaws.com \
  --account-id <the member account you will deploy NotiOps into>
```

The reverse is `aws organizations deregister-delegated-administrator` (same two parameters). Then just
re-run `./setup.sh --multi-account` in that member account — **no extra flags**.

**Four things to know before taking this path:**

1. ⚠️ **A delegated administrator has full deployment permissions across the whole organization.** AWS
   states plainly that the management account **cannot** scope it to specific OUs or operations — once
   registered, this member account can deploy StackSets into **any** account in the organization, not
   just NotiOps' two. That is the AWS StackSets model, not a NotiOps implementation choice.
2. **Trusted access must already be enabled by the management account.** `enable-aws-service-access` and
   `activate-organizations-access` are **management-account only**, so on this path `setup.sh` **skips**
   them (rather than "call and swallow the error", which would make people believe the script had turned
   it on). It only verifies with `describe-organizations-access --call-as DELEGATED_ADMIN` and, if it is
   off, prints both commands for you to run in the management account.
3. **An organization allows at most 5 delegated administrators** (an AWS hard limit, across all services).
4. **The StackSet entities live in the management account**, even when a delegated administrator created
   them. So `notiops-member-onboarding` / `notiops-member-devops-agent` do not show up in the **deploying**
   account's CloudFormation console (you need `--call-as DELEGATED_ADMIN` to see them); `teardown.sh`
   passes that flag too, so nothing is silently skipped at delete time.

> 🔴 **One hard limit that has nothing to do with which identity you use**: CloudFormation **never**
> deploys a service-managed StackSet into the **organization management account itself** — even if you
> target the OU it sits in, `CreateStackInstances` returns SUCCEEDED and creates nothing (a silent fake
> success). In practice only a **delegated-administrator deployment** runs into it: there the management
> account is an ordinary row in the member list, but one-click onboarding is unavailable for it. To let
> NotiOps query it, use **"Manual onboarding" alone**: "Generate link" → deploy that stack while signed in
> to the management account → paste the Stack Outputs back → "Test connection" → "Save & activate"; that
> stack creates the collection role as well. **Do not** also deploy `infra/member-account-onboarding.yaml`
> by hand: it creates a collection role with the same name, so deploying both ends in `EntityAlreadyExists`
> and a stack rollback; if it is already deployed in that account, set `CreateCollectionRole` to `no` on
> the quick-create page, and if that stack forwards events (its `DevOpsEventBusArn` parameter is set), also
> clear `DevOpsEventBusArn` on the same page — the two stacks name their forwarding rules differently, so
> nothing fails, but both would forward and every investigation event would be delivered twice. When you
> deploy from the management account itself there is nothing to do — it is then the deploy account,
> registered and inspected automatically.

When the prerequisite isn't met, `setup.sh` **stops and exits 1 before `cdk deploy`** (it does not
silently fall back to single-account), printing those three ways forward and the register command
verbatim. The one-click equivalent is
[DEPLOYMENT_ONECLICK.en.md §2.6.1](DEPLOYMENT_ONECLICK.en.md#261-hard-prerequisite-management-account-or-a-stacksets-delegated-administrator).

**Why isn't multi-account the default?** Multi-account mode requires the current identity to be the **Organizations management account or a StackSets delegated administrator**, touches StackSets, and rolls out resources to member accounts — unnecessary and higher-privilege for the vast majority who just want to try it in a single account. Single-account is the least-privilege, fastest path to a working deployment, so it is **off by default**; add `--multi-account` explicitly when you need it.

**Already deployed single-account and now want multi-account?** Re-run `./setup.sh --multi-account` from the management account (or a registered delegated administrator account) — the incremental CDK update rewrites the gate and rolls out member-account resources. On a single-account deployment the top of the "More → Admin" → "Accounts" page carries a note that starts "One-click onboarding is unavailable - it needs CloudFormation StackSets…" — that is exactly this signal: one-click onboarding needs a re-run with `--multi-account`, and **this cannot be toggled from the console**. If you would rather not redeploy, "Manual onboarding" on the same page works right away (the accounts it adds are inspected and can be deep-investigated on the web; cross-account troubleshooting in IM and NotiOps-model conversations still needs multi-account mode).

> Not sure which to pick? **Get single-account working first**, confirm Web Chat is usable, then re-run `--multi-account` once you actually have a cross-account need. The two don't conflict — multi-account is a superset.

### 0.2 Verify

**Primary verification — open Web Chat (the single main entry)**: when the script finishes it prints the Web Chat URL plus the `admin` user and a temporary password (and calls it "the single main entry"). Open that URL in a browser, log in as `admin` with the temp password (change it on first login), ask anything (e.g. "list EC2 in this account") and you should get a reply.

```
Open the Web Chat URL printed at the end of the script → log in as admin / temp password → send a question
```

**Only if you enabled an IM platform** (Feishu / Slack / DingTalk), also @bot in the channel to verify:

```bash
# In your Feishu / Slack / DingTalk channel, @bot a message (fill that platform's credentials first — see §4 / §5):
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
| **`ImStack`** | Only when IM is selected | **The production path for IM**: one **API Gateway HTTP API** per platform (the public entry point, a `$default` catch-all route) plus one Lambda pair — ingress (validates the signature and hands off asynchronously, `reservedConcurrentExecutions=10`) + worker (does the real work, 900s) — plus the shared dependency Layer and a de-duplication table. Its `FeishuWebhookUrl` / `SlackWebhookUrl` / `DingtalkWebhookUrl` outputs are the request URLs you paste into the IM platform console (see [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md)) |
| ~~**`BotStack`**~~ | ❌ **Retired (2026-09-03)** | It used to be: VPC + public subnets, ECS Cluster (512 CPU / 1024 MB per task), ECR repo, one Fargate Service per selected platform, pricing + cost MCP sidecars per task, Task Role, Security Group. After IM refactor M2, `infra/bin/app.ts` **no longer instantiates it**, so fresh installs get no VPC / ECS / ECR and need no finch / docker. The source (`infra/lib/bot-stack.ts` + three Dockerfiles) is deliberately kept in the repo as the long-connection rollback path — rolling back means `new BotStack(...)` again, which is far cheaper than rebuilding VPC/ECS and the images from scratch. Accounts installed before M2 still have the stack: `teardown.sh` deletes it by name, or delete it on its own with `aws cloudformation delete-stack --stack-name BotStack` (it publishes **no CFN exports**, so no other stack can be importing it) |

**Deployment order** (handled automatically by `./setup.sh`):
```
./setup.sh (interactive: region / optional PHD / [IM skipped by default])
   → build the frontend (only one: `frontend/chat-app`) → deploy Web Chat Agent → cdk deploy --all
(optional) to enable IM: §3 Register an IM app first, then re-run setup.sh and pick the platform
```

Credential flow: `setup.sh` **does not collect IM credentials** — it only sets the `enabledPlatforms` flag based on your selection. CDK creates **placeholder** secrets (`notiops/im-bot-feishu` / `notiops/im-bot-dingtalk` / `notiops/slack-bot-token` / `notiops/slack-signing-secret`); after deploy you fill in **all three platforms from Web Chat's left nav "More → Admin → IM Integration"**, one tab each: four Feishu credentials on one form, one form for DingTalk, and the Slack tab takes two fields — **Bot User OAuth Token** (`xoxb-`) and **Signing Secret**. You can also edit Secrets Manager directly (see §4.2 — webhook mode needs **no** service restart). CDK stacks always reference the secrets by ARN. **Nothing is persisted to disk locally.**

> ⚠️ The two Slack secrets hold a **plain string**, not JSON, and the placeholder CDK creates is a **random value**, not an empty one — so "forgot to fill it in" looks exactly like "filled in wrong" (`invalid_auth` / a 401 on URL verification). The "configured" badge on the IM Integration page is derived from the **shape of the value**, so a placeholder always reads as *not configured*; after saving, hit "Test credentials" to see the workspace / bot name and **each missing scope by name**.

---

## 2. Prerequisites

> ✅ **One command covers everything in this section: `bash scripts/preflight.sh`** (read-only,
> installs nothing). The **specific consequence** of each miss, a fix per item, and the things
> `setup.sh` does **not** check (boto3 / version floors / interactive terminal / Bedrock model
> access) are all in **[PREREQUISITES.en.md](PREREQUISITES.en.md)**. This section is the cheat
> sheet; that page is the long form.

### 2.1 Required tools

| Item | Requirement | Check |
|---|---|---|
| AWS CLI v2 | ≥ 2.13 (Bedrock support) | `aws --version` |
| ~~AWS SAM CLI~~ | ~~≥ 1.100~~ | ~~`sam --version`~~ *(retired — CDK deploy doesn't need SAM CLI)* |
| Node.js | ≥ 22 | `node --version` *(CDK runtime)* |
| ~~Container build tool~~ | ~~finch (recommended) / docker~~ | — *(**no longer required** as of 2026-09-03 — see the note below)* |
| jq | any version | `jq --version` |
| Python | **≥ 3.10** (3.12+ recommended) | `python3 --version` |
| **uv** | any version | `uv --version` |
| **boto3** | in the interpreter setup.sh will use | `python3 -c "import boto3"` — [fix](PREREQUISITES.en.md#3-boto3-the-easiest-one-to-miss) |

> ⚠️ **`setup.sh` only checks whether a command exists — it never compares versions.** Every floor
> above is a real runtime requirement, but the preflight uses `command -v`, so an old version sails
> through and fails mid-deploy (half the cloud resources already created). `scripts/preflight.sh`
> closes exactly that gap. The Python floor is **3.10**, not "present": building the Lambda
> dependency layer makes `pip` validate each wheel's `Requires-Python` against **the running
> interpreter**, and macOS still ships 3.9.x at `/usr/bin/python3`.

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
> ⚠️ If a Docker asset is ever reintroduced, this note, `setup.sh`'s preflight,
> `scripts/preflight.sh` (which today has **no** container check at all), the "Container runtime"
> row in the [prerequisites page](PREREQUISITES.en.md) (which currently says **not needed**), and
> both root READMEs (one per language) all have to change back together.

### 2.2 AWS account preparation

- **AWS account**: admin or equivalent permissions
- ~~**VPC**~~: **no longer needed** — IM runs on Webhook + Lambda (`ImStack`), so there is no ECS Fargate task and therefore no VPC / public subnet requirement (2026-09-03, IM refactor M2). Only the `infra/lib/bot-stack.ts` long-connection rollback path needs one
- **AWS DevOps Agent**: enabled (required for deep investigation). **No need to bring your own Agent Space** — CDK auto-creates one named `notiops-devops-<account>` in your account (see §5.3.5); you don't pre-create one or supply a space id
- **Bedrock**: the model behind the catalogue's **default_model** is enabled in your region (Bedrock console → Model access). Today that is **Moonshot Kimi K3** (`global.moonshotai.kimi-k3`); enable the others too (Grok 4.7, GLM 5.3, Claude Sonnet 5.5 / Opus 5.5, DeepSeek, GPT-5.6 / GPT-6 Sol) if you want users to be able to switch. Note: Claude Sonnet 5.5 / Opus 5.5 and GPT-6 Sol need an AWS Marketplace agreement accepted **once per account** -- in some accounts Sonnet 5 works while 5.5 is not enabled yet. The simplest fix is to accept the agreement in that account. Otherwise: re-enabling `claude-sonnet-5` / `claude-opus-5` on the Admin "Models" page **fixes Web only** -- the IM aliases `claude` / `opus` belong to the 5.5 entries, so also **disable** `claude-sonnet-5-5` / `claude-opus-5-5` and have IM users switch with `@bot model claude-sonnet-5` / `@bot model claude-opus-5` (once those are disabled, IM preferences already set to `claude` / `opus` fall back to the default model). `gpt_sol` works the same way and belongs to GPT-6 Sol (`gpt-6-sol`): if you do not accept its agreement, disable that entry (preferences already set to `gpt_sol` fall back to the default model)

### 2.3 Region selection

`setup.sh` deploys **every stack into one region** (the one you pick in the region menu, i.e. `DEPLOY_REGION`); there is no parameter that puts one stack into a different region. So that one region has to satisfy all of these:

| Component | Requirement on the deploy region | Notes |
|---|---|---|
| **AWS DevOps Agent service** | **Must be a region where DevOps Agent is available** | The main stack creates two Agent Spaces (troubleshooting + inspection) right in the deploy region; in a region without DevOps Agent they cannot be created and the deploy fails. The list built into the one-click template is `us-east-1` / `us-west-2` / `ca-central-1` / `sa-east-1` / `ap-south-1` / `ap-southeast-1` / `ap-southeast-2` / `ap-northeast-1` / `eu-central-1` / `eu-west-1` / `eu-west-2`; the Supported Regions page of the AWS DevOps Agent docs is authoritative |
| **IM stack (`ImStack`; Feishu / Slack / DingTalk)** | Same as the deploy region | The API Gateway HTTP API behind the webhook lives here |
| **Bedrock** | Same as the deploy region | There is no separate Bedrock region parameter: model calls are made from the deploy region (except GPT-5.6 Terra / Luna, which always go to `us-east-2`). The default model, Kimi K3, is a `global.` cross-Region inference profile; for model access see §2.2 |
| **DDB / S3** | Same as the deploy region | Created in the same region as the stack |

**Simplest deploy**: the `setup.sh` region menu defaults to `1) ap-northeast-1` (Tokyo); just press Enter to use it — it is on the DevOps Agent list above. Check that list before choosing "Custom input".

### 2.4 IAM deployment permissions

`setup.sh` needs permissions in **three** stages. The substantive difference from Method A (one-click CFN, see [DEPLOYMENT_ONECLICK.en.md §1.1](DEPLOYMENT_ONECLICK.en.md#11-an-aws-account-and-console-permissions-to-create-the-stack)) is only in the **third** stage.

#### (1) `cdk bootstrap` — once per account + region

Before deploying, `setup.sh` runs `npx cdk bootstrap` (without `--cloudformation-execution-policies`). That creates a stack named `CDKToolkit` containing: an asset bucket `cdk-hnb659fds-assets-<account>-<region>` plus a KMS key, an ECR repository `cdk-hnb659fds-container-assets-…`, five roles `cdk-hnb659fds-{deploy,cfn-exec,file-publishing,image-publishing,lookup}-role-<account>-<region>`, and an SSM parameter recording the bootstrap version.

For this stage your identity needs: `cloudformation:*` (to create `CDKToolkit`), `iam:CreateRole` / `PutRolePolicy` / `AttachRolePolicy`, `s3:CreateBucket` + `PutBucketPolicy`, `kms:CreateKey`, `ecr:CreateRepository`, `ssm:PutParameter`.

> ⚠️ **This stage bakes administrator permissions into the account.** We do not pass `--cloudformation-execution-policies`, so CDK uses its default of `arn:aws:iam::aws:policy/AdministratorAccess` and attaches it to `cdk-hnb659fds-cfn-exec-role`. Every later `cdk deploy` creates resources as that role. To narrow it you would have to bootstrap by hand with a tighter policy ARN — but we have **not validated** any narrower policy, it will most likely fail to install everything, and we don't recommend it.

#### (2) `cdk deploy --all` — creates the three stacks

This stage does **not** require your identity to have write access to the individual services. `setup.sh` passes no `--role-arn`, so `cdk deploy` assumes the bootstrap roles from (1) and the resources are actually created by `cdk-hnb659fds-cfn-exec-role` (which holds AdministratorAccess). Your identity only needs:

| Action | Resource |
|---|---|
| `sts:AssumeRole` | `arn:aws:iam::<account>:role/cdk-hnb659fds-*` |
| `cloudformation:DescribeStacks` / `GetTemplate` and other reads | `*` |
| `ssm:GetParameter` | `/cdk-bootstrap/hnb659fds/version` |

The service scope of the resources inside the stacks is essentially the same as Method A — see [DEPLOYMENT_ONECLICK.en.md §1.1 (2)](DEPLOYMENT_ONECLICK.en.md#11-an-aws-account-and-console-permissions-to-create-the-stack).

> **`ecs:*` is not needed**, and neither is docker / finch: the only container-building stack, the legacy `BotStack`, was retired on 2026-09-03, so a normal deploy pushes no image assets. `ecr:CreateRepository` is only used when bootstrap assets were deleted out-of-band and have to be repaired.

#### (3) The AWS APIs `setup.sh` calls directly — **these run as you**

This is the **biggest difference** from Method A. Method A hands the same work to the stack's `StagerOrgSetup` Lambda, which uses its own execution role (so a Method A installer does not need these permissions). `setup.sh` calls them from your terminal, so **your identity must have them**.

Always called:

| Service | Actions | What for |
|---|---|---|
| `sts` | `GetCallerIdentity` | Confirm account / identity |
| `cloudformation` | `DescribeStacks` / `ListStackResources` / `GetTemplate` / `DeleteStack` | Status checks, retiring old stacks |
| `s3` | `CreateBucket` / `HeadBucket` / `PutBucketTagging` / `PutBucketPolicy` / `PutObject` | Asset bucket; syncing member-account onboarding templates into `notiops-data-*` |
| `lambda` | `Invoke` / `GetFunctionConfiguration` | Post-deploy self-checks |
| `dynamodb` | `GetItem` / `PutItem` | Writing `notiops-config` |
| `cognito-idp` | `ListUsers` / `AdminCreateUser` / `AdminAddUserToGroup` | Creating the first administrator |
| `secretsmanager` | `DescribeSecret` / `DeleteSecret` | Checking IM credential secrets, cleaning up retired ones |
| `ssm` | `GetParameter` | Reading the bootstrap version |
| `events` | `DescribeEventBus` | Event bus check |
| `sns` | `GetTopicAttributes` | Alarm topic check |
| `iam` | `GetRole` / `ListRolePolicies` / `ListAttachedRolePolicies` / `GetRolePolicy` / `DetachRolePolicy` / `DeleteRolePolicy` / `DeleteRole` / `ListInstanceProfilesForRole` / `RemoveRoleFromInstanceProfile` | Cleaning up roles left behind by retired stacks |

Only called when the corresponding feature is on — **these are exactly the groups Method A does not need and Method B does**:

| Trigger | Service | Actions |
|---|---|---|
| `--multi-account` (cross-account within an org) | `organizations` | `DescribeOrganization` / `ListAccounts` / `EnableAWSServiceAccess` / `RegisterDelegatedAdministrator` / `ListDelegatedAdministrators` |
| Same (rolling out member stacks via StackSets) | `cloudformation` | `CreateStackSet` / `UpdateStackSet` / `DescribeStackSet` / `CreateStackInstances` / `ActivateOrganizationsAccess` / `DescribeOrganizationsAccess` |
| Same (reusing an existing OAM Sink) | `oam` | `ListSinks` |
| Security inspection's org-wide view | `securityhub` | `EnableOrganizationAdminAccount` / `CreateFindingAggregator` |
| Billing detail (CUR + Athena) | `cur` | `PutReportDefinition` / `DescribeReportDefinitions` |
| Same (the one-shot T+25h finalizer) | `scheduler` | `CreateSchedule` |

> Signing in with IAM Identity Center also runs `aws sso login` — that is local credential acquisition and needs no in-account IAM permissions.

> ⚠️ **As with Method A, the installer on this path is effectively an account administrator.** `iam:CreateRole` from (1) plus the AdministratorAccess on `cdk-hnb659fds-cfn-exec-role` together amount to privilege escalation. "Least privilege" here can only mean **narrowing the service scope**; it can never mean "let a non-administrator install this". Once installed, **day-to-day use of NotiOps needs no AWS permissions at all** — users only sign in to Cognito — so you can install with a temporary identity and then retire it.

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
   ask for credentials; after deploy, fill them in under **Web Chat's left nav "More →
   Admin → IM Integration"** — all four credentials (App ID / App Secret / Encrypt Key /
   Verification Token) sit on one form and Save writes them into the
   `notiops/im-bot-feishu` secret (you can also edit that secret directly, see §5). See
   §4 / §5 and [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md)
10. **Add the bot to your channel.** If you want the daily ops notification and AWS Health events (`setup.sh` deployments only, Feishu only, see §7.1) delivered to a group, grab that group's `chat_id` first:

```bash
# First fetch a tenant_access_token
curl -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
  -H 'Content-Type: application/json' \
  -d '{"app_id":"'$FEISHU_APP_ID'","app_secret":"'$FEISHU_APP_SECRET'"}'

# List chats and note the target chat_id (starts with oc_)
curl 'https://open.feishu.cn/open-apis/im/v1/chats' \
  -H 'Authorization: Bearer <tenant_access_token>' | jq '.data.items[]'
```
Later put this `chat_id` into the Feishu secret's `notify_chat_ids` (or enter it as "Target group chat IDs" on the Feishu tab of Web Chat "More → Admin → IM Integration") — it is **not** a `setup.sh` prompt (optional; leave it empty and neither of those two is sent). Investigation results go back to the conversation that started them and need no entry here; real-time alert pushes do not reach IM in this release (see §7).

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
   after deploy, enter them under **Web Chat's left nav "More → Admin → IM Integration" → Slack tab** (the
   "View detailed setup steps" drawer on that page walks all 8 steps, each doable entirely
   in a browser); the backend writes them into the `notiops/slack-bot-token` /
   `notiops/slack-signing-secret` secrets. You can also edit Secrets Manager yourself —
   see §4 / §5 and [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §2
8. In the target channel run `/invite @YourBot`. Of the proactive pushes, only **inspection pushes** support Slack today (the daily notification, Health / alarm pushes and the rest do not), but this release has **no way yet** to register a Slack channel as an inspection push target: there is no web setting (the Slack tab of "IM Integration" only takes the Bot Token and Signing Secret), `setup.sh` does not ask, and the release ships no tool for it. So in this release Slack is only for talking to the bot; see inspection results under Web Chat "More → Inspection". The **Channel ID** (`C...`, in the channel settings panel) only matters if you want to restrict the bot to certain channels (the chat allowlist — see [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §4)

### 3.3 DingTalk Internal App

> Same shape as Feishu / Slack: a **Lambda webhook** (supported on both deployment paths
> since 2026-09-08). The `setup.sh` IM prompt lists it as `3) DingTalk`; on the
> one-click path it is `InstallOption=web+dingtalk`. As in §3.1, **the message-receive
> URL is filled in only after the deploy finishes.**
>
> The full walkthrough (where the URL comes from, how to debug it) is
> [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §3 — and **every step there can be
> done in the browser alone**: Web Chat's left nav "More → Admin → IM Integration" → DingTalk
> tab → "View detailed setup steps" in the top right.

1. Visit [open-dev.dingtalk.com](https://open-dev.dingtalk.com/) → **应用开发 → 企业内部应用 → 创建应用** (App Development → Internal App → Create). Name and description are enough — you do **not** need to declare server egress IPs.
2. Left nav **机器人 (Robot)** → enable the robot capability, give it a name and icon → save. Unlike Feishu, DingTalk needs **no** per-scope permission ticking — send/receive rides the robot capability's own channel, which is not the same thing as Feishu's `im:` / `cardkit:` scopes.
3. Left nav **凭证与基础信息 (Credentials & Basic Info)** → copy **AppKey** / **AppSecret** (AppSecret only appears after you click it).
   ⚠️ DingTalk has **only this one secret**: AppSecret both exchanges for an access token *and* verifies the inbound `sign` header. So there is **no** Feishu-style Encrypt Key / Verification Token — the two missing form fields are **deliberate**, not an omission.
4. **消息接收模式 (message-receive mode) → pick "HTTP 模式" (HTTP mode)**. DingTalk defaults to **Stream mode**, and you **must change it**.
   ⚠️ Left on Stream mode, DingTalk never sends a request to your URL at all and the bot simply never answers — the single most expensive step on this path. For **消息接收地址 (message-receive URL)**, use the `DingtalkWebhookUrl` deploy output (**keep the trailing `/`**), filled in after the deploy completes.
5. **版本管理与发布 (Version & Release) → publish a version** — without a published version the robot cannot be added to a group.
6. Group settings → **智能群助手 → 添加机器人** (group assistant → add robot) → pick the app robot you just published.
7. **Save** AppKey + AppSecret — `setup.sh` does **not** ask for credentials; after deploy, enter them on **Web Chat's left nav "More → Admin → IM Integration" → DingTalk tab**, which writes them to the `notiops/im-bot-dingtalk` secret (the secret name is identical on both deployment paths; you can also edit that secret directly, see §5). ⚠️ **Order matters: store the credentials first, then fill in the message-receive URL** — the ingress function hard-validates both on cold start and refuses to start if either is missing (better a dead ingress than a public URL anyone can forge requests to).
8. **(Optional) custom-robot push URL**: add a second robot to the group — a **custom robot** (群设置 → 群机器人 → 添加机器人 → 自定义) — and put its webhook URL in the same secret's `webhook_url` key (in the web UI this is "Custom-robot push URL" on the DingTalk tab of "IM Integration"). In this release only two things use it: the fallback when an investigation report cannot be posted back to its conversation, and inspection push (`setup.sh` deployments only, and the group must first be registered as an inspection push target — this release has no way to do that yet); the daily notification, Health and real-time event pushes are not sent to DingTalk (see §7). ⚠️ **In this release none of the custom robot's three security settings (DingTalk requires at least one) can guarantee delivery**: 加签 (HMAC sign) needs a signing secret that neither deployment path has anywhere to store, so the messages we send carry no signature and DingTalk rejects them (Test credentials then reports that the push webhook rejected the message); a custom keyword must appear in every message, and the reports we send are not guaranteed to contain it — the Test credentials message contains `NotiOps`, so a passing test does **not** prove that real reports get through; an IP address (range) needs a fixed egress IP, which these Lambdas do not have. The URL only serves the two uses above (and the second one cannot be set up in this release yet), so **this step can be skipped**. ⚠️ It points the **opposite direction** from step 4's message-receive URL and the two are easy to confuse: this one is us **sending to** DingTalk (it is a credential), that one is DingTalk **sending to** us (it is a public ingress address). Skipping this step leaves chat and investigation dispatch unaffected.

> ⚠️ **DingTalk validates nothing when you save the message-receive URL** — there is no
> Feishu-style URL challenge, so nothing turns green and nothing errors. That means **one
> wrong character in the URL** and **credentials not yet stored** look exactly the same:
> the bot never answers. The only reliable way in is the two log groups
> (`notiops-im-ingress-dingtalk` / `notiops-im-worker-dingtalk`), see
> [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §3.5 — whether the ingress saw a
> request at all separates "DingTalk never sent it" from "we didn't recognise it".
>
> This path **does require public ingress** (API Gateway HTTP API), same as Feishu /
> Slack. The old "Stream Mode outbound long-poll, no public ingress needed" shape
> (`BotStack`'s ECS task) was retired on 2026-09-03.

---

## 4. Configuration & IM Credentials

CDK deployment doesn't need `bootstrap.env` — `./setup.sh` walks you through the deploy parameters on first run (account / region / whether to deploy PHD / whether to pick an IM platform). **Note: `setup.sh` collects no IM credentials** — CDK only creates **empty** IM secrets, and you fill them in *after* deploy (see §4.2).

### 4.1 What setup.sh asks you for

| Category | Item | Notes |
|---|---|---|
| **AWS Profile** | Deploy profile | Pick from your local `~/.aws` profile list, or keep the current one |
| **AWS** | Account ID | Auto-detected from `aws sts get-caller-identity`; just confirm |
| | Region | 6 options (`ap-northeast-1` [default] / `us-east-1` / `us-west-2` / `eu-west-1` / `ap-southeast-1` / custom input). Every stack goes into this one region, and it must support AWS DevOps Agent (see §2.3) |
| **Push (PHD)** | Deploy PHD event forwarding | Defaults to `Y`; the `--phd` flag handles linked-account-side forwarding |
| **Multi-account** | Business account allowlist | Triggered separately via `--multi-account`; single-account by default |
| **IM platforms** (optional) | Choice | `1` Feishu / `2` Slack / `3` DingTalk (multi-select, e.g. `1,3`) / `0` skip (default on a **first install only**, web UI only). On a **re-run** the default is to keep the live platforms as-is (`keep`); if the live state cannot be read and there is no TTY, it **exits with an error** rather than continuing on a default. **Only sets the `enabledPlatforms` flag — no credential prompt** |

> **Agent Space id is not a prompt** — CDK auto-creates `notiops-devops-<account>` (see §5.3.5); you don't supply one.

### 4.2 Where IM credentials live / when you fill them

At deploy time CDK creates **empty** IM secrets; you fill the credentials in **after deploy**, two ways (the script's completion banner also points here):
- **Option A (recommended)**: log in to Web Chat (admin) → left nav "More → Admin" → "IM Integration" → fill them in
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
| `notiops/im-bot-dingtalk` | DingTalk bot credentials (single secret, JSON: `app_key` / `app_secret` / `webhook_url`). `app_key` / `app_secret` are **required** — miss either and the ingress function crashes on cold start; `webhook_url` (the group's custom-robot URL) is **optional** and used only as the fallback when an investigation report cannot be posted back to its conversation, and for inspection push (which cannot be set up in this release, see §3.3 step 8); the daily digest, Health and real-time event pushes are not sent to DingTalk |
| `notiops/bedrock-api-key` | Bedrock API Key (cross-account model-invocation auth; populated manually post-deploy, leave empty to use IAM) |
| `notiops/litellm-config` | LiteLLM credentials (JSON: `base_url` / `api_key` / `default_model`; only if you use LiteLLM) |

> The DingTalk secret is the `notiops/im-bot-dingtalk` row above, on **the same mechanism as Feishu / Slack** — CDK creates it (empty) and you fill the JSON in after deploy; **no manual `create-secret`**. There is **no `bot-stack-*/` secret prefix, and no `notiops/devops-agent-config`** (Agent Space id and other metadata live in the DDB onboard record + CDK context, not a secret).

### 4.3 Optional overrides (change defaults)

These are CDK context keys, read at synth time. `setup.sh` passes the ones it manages as `-c` flags on
every run (`organizationId` / `agentRuntimeArn` / `costAgentMcpUrl` and so on, driven by its own flags and
environment variables); the ones it does **not** pass (such as `allowedOrigins`) go into the `context` block of
`infra/cdk.json`, followed by a re-run of `./setup.sh`. Don't pass them with `-c` to a hand-run `cdk deploy`:
the next `./setup.sh` run will not carry them, and deploying a single stack also drops everything `setup.sh`
normally passes (see §8.1).

| Context | Default | Notes |
|---|---|---|
| `allowedOrigins` | (empty = all origins) | Comma-separated CORS allow-list, e.g. `https://d123.cloudfront.net` |
| `organizationId` | (empty) | Non-empty = multi-account (Organizations) mode. Passed by `./setup.sh --multi-account`; don't set it by hand |
| `inspectionReportLocale` | (empty = follow `DEFAULT_LOCALE`) | Language of the inspection **findings text**; one global value (`setup.sh` derives it from `$INSPECTION_REPORT_LOCALE`) |
| `monthlyLimitSeconds` | `-1` (= unlimited) | Monthly seconds budget guard for the inspection executor |
| `opsAlertEmail` | (empty) | Ops alert email (SNS subscription) |
| `webBaseUrl` | (empty) | Site root for the "view details / view all" deep links in inspection pushes; empty = no deep links |
| `reportsCdnDomain` | (empty) | Serve report downloads from your own CDN domain; empty = fall back to presigned URLs (dead after 12h) |
| `skipPhd` | `false` | `true` = do not create the PHD forwarder. Created by default — `setup.sh` no longer asks; opt out with `ENABLE_PHD=false ./setup.sh` (see below) |
| `phdLinkedAccounts` | (empty) | Member accounts PHD should watch (comma-separated) |
| `oamSinkArn` | (empty) | Reuse an existing OAM sink instead of creating one |
| `costAgentMcpUrl` / `costAgentFunctionArn` | (empty) | "External" mode: a cost-agent MCP **you already run** (the two must come as a pair), used as the data source behind the four CUR sheets under FinOps. To have NotiOps deploy that server for you (recommended), use `COST_MCP_SELF_HOST=true ./setup.sh` instead of these two — see §14.2. With neither, those four entries do not appear at all (see `requiresEnv`) |
| `agentRuntimeArn` | (empty) | ARN of an already-deployed Web Chat AgentCore Runtime. `setup.sh` passes it once the agent is deployed |
| `operatorAppAlreadyEnabled` | `false` | ⚠️ **Never pass this by hand** — passing `true` makes the stack assume the Operator App is already enabled and skip enabling it |

For the IM side (`enabledPlatforms` / `imAllowedChatIds`) see the `ImStack` context
table in §11.1. `infra/cdk.json`'s `context` block contains **no** entries for any of
these keys by default — to use one, add it there yourself and re-run `./setup.sh`
(except `enabledPlatforms`, which comes from `setup.sh`'s IM-platform prompt; see §8.1).

**AWS Health event forwarding (PHD) is on by default; `setup.sh` does not ask.**

| | |
|---|---|
| What it does | Pushes an **extra** message to your Feishu group for each AWS Health event, summarized by Bedrock |
| With no Feishu configured | Pushes nothing, and **never calls Bedrock** (the forwarder checks `notify_chat_ids` before summarizing), so the cost is one Lambda invocation |
| Relation to the Web notification inbox | **None.** Health events land in the Web Chat notification inbox regardless; that path is unaffected by this switch |
| How to turn it off | `ENABLE_PHD=false ./setup.sh`, and pass it on every later run too (`setup.sh` creates the forwarder by default, so a run without it puts it back) |
| IM platforms supported | Feishu only (`phd_event_forwarder/notifier.py` uses `shared.feishu_sender`); DingTalk / Slack are not wired up |
| Deployment paths | Only **Path B** (`setup.sh` / CDK) has this forwarder; Path A (one-click CloudFormation) does not include PHD |

Older versions asked "push AWS Health events to your Feishu IM group?" right after
region selection — before the IM platform was even chosen, so the question could not
be answered at that point. It has been removed.

> 🔴 **Six of the seven keys this table used to list do not exist at all**
> (`bedrockModelId` / `agenticChatMode` / `awsMcpMode` / `enableMcpPricing` /
> `defaultLocale` / `defaultLlmProvider`), and the default `bedrockModelId` value it
> printed (`us.anthropic.claude-sonnet-4-6`) has not been the default model for a
> while either (it is `global.moonshotai.kimi-k3` now, and the effective value comes from
> the DDB model catalogue rather than a deploy-time parameter). They were pre-M2 keys
> feeding the `BotStack` Fargate container, and that stack is retired — criterion:
> `git grep -n <key> -- infra/` returns zero hits for every one of them. See the
> matching warning in §11.1.

> **⚠️ Tighten CORS (recommended for production)**: every endpoint on the Web Chat Function
> URL is already authenticated (Cognito / AWS_IAM SigV4), so the
> browser CORS policy is not the primary trust boundary. The default therefore **falls back
> to all origins** (`*`) so the sample repo works out of the box without pre-knowing the
> CloudFront domain that is only generated at deploy time. Production deployments should
> narrow it explicitly: add `"allowedOrigins": "https://<your-frontend-domain>"` (the
> `WebChatStack` `ChatUrl` output) to the `context` block of `infra/cdk.json`, then re-run
> `./setup.sh`. `setup.sh` does not pass this key, so if you only pass it with `-c` to one
> hand-run `cdk deploy`, the next `./setup.sh` run puts it back to `*` (see §8.1).
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
6. Asks which IM platforms to deploy (`1` Feishu / `2` Slack / `3` DingTalk, multi-select such as `1,3`; `0` skips it — the default on a **first install only**). On a **re-run** the default is to keep the live platforms as-is, so pressing Enter cannot freeze a running bot on old code. **Only sets the `enabledPlatforms` flag — does not collect credentials**
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

# After editing the cdk.json context, the right move is to re-run ./setup.sh from the repo root (see §8.1);
# the lines below are raw CDK commands that bypass setup.sh -- read the warning underneath first
npx cdk deploy --all

# Deploy a single stack
npx cdk deploy NotiOpsBackendStack
npx cdk deploy ImStack       # IM side (Feishu / Slack / DingTalk webhook + Lambda)

# Diff to see what would change
npx cdk diff --all
```

> ⚠️ These commands carry only the `-c` flags you add yourself, none of the ones `setup.sh` normally passes — read the warning at the end of §8.1 before copying them.

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
| **Cross-account onboarding** (investigate resources in other business accounts) | ✅ Yes | The business account needs NotiOps's trigger role (`notiops-agent-trigger-<business account>-m<deploy account>`) + a row registered in NotiOps's config DDB — both are done in Web Chat "More → Admin" → "Accounts": in a multi-account deployment (`./setup.sh --multi-account`), click "Onboard" on an organization account (the step-2 DevOps Agent association then runs by itself; only if the "Step 2: DevOps Agent" badge does not reach "Investigations enabled" and an "Associate" button shows up next to it, click that to retry); in every other case (outside this organization, no management-account access, or not a multi-account deployment) use "Manual onboarding" on the same page (see §0.1.1). ⚠️ In a deployment that is not multi-account, an account added this way can only be investigated through the web's "Deep Dive" / "DevOps Chat", which call DevOps Agent directly; IM and NotiOps-model conversations stay on the deploy account until you redeploy with `--multi-account` (see §0.1.2) |
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
npx cdk deploy WebChatStack --exclusively --require-approval never <every -c from the setup.sh line>
# 2. Then the full deploy -- again with the full set of -c flags; the simplest way is to re-run ./setup.sh
npx cdk deploy --all <every -c from the setup.sh line>
```

**What about `FALLTHROUGH`?** Reordering cannot save that version (consumer-first fails with `No export named … found`; main-first fails on the export deletion). The correct answer is to **split it into two releases**: ship the retirement first, then the addition. A CI gate in this repo (`cfn-export-gate` plus [infra/exports.golden.json](../infra/exports.golden.json)) blocks such a version before it reaches `main`, so as a deployer you should essentially never see it.

> 📌 **Method A (one-click deploy) is unaffected**: it is a **single stack** (`NotiOps`) with no cross-stack references and therefore no CFN Exports — the failure mode does not exist structurally, so Method A needs no equivalent preflight step. This is not a feature gap (the **web functionality** of both paths remains identical).

---

## 6. Smoke Tests

> 💡 **How to find the actual resource names from your deploy**:
> ```bash
> # Lambda functions (IM is notiops-im-*, the Web Chat BFF is notiops-web-chat-bff; there is no ECS any more, see §6.1)
> aws lambda list-functions --region $AWS_REGION \
>   --query 'Functions[?starts_with(FunctionName, `notiops-`)].FunctionName'
>
> # CloudWatch log groups (these functions log to /aws/lambda/<function name>)
> aws logs describe-log-groups --region $AWS_REGION \
>   --query 'logGroups[?contains(logGroupName, `notiops`)].logGroupName'
>
> # CloudFormation stack outputs (also written to cdk-outputs.json)
> cat infra/cdk-outputs.json
> ```
> Throughout the rest of the document, `<log-group>` is a placeholder — substitute the actual name you found above.

Run these immediately after deploying:

### 6.0 Web Chat console (main entry — verify this first)

> Web Chat is the product's main entry and deploys by default; this is the **most important step**. IM (§6.1-6.3) only matters if you enabled the corresponding platform.

1. Open the **Web Chat URL** printed in the script's completion banner (or `jq -r '.WebChatStack.ChatUrl' infra/cdk-outputs.json`)
2. Log in as `admin` / the temp password the script printed (change it on first login)
3. Confirm the left nav shows: Notifications / Investigation / Cost / Cases / **More** (which expands to Inspection / Skills / Admin), and **no** "Security" item — the security dashboards open from the "Security posture" pill above the Investigation composer
4. Send a question or investigation request (e.g. "investigate EC2 in IAD") — a reply within seconds means success

For the fuller Web Chat smoke test, see §12.6.

### 6.1 The webhook endpoint is alive (only if you enabled IM)

> §6.1-6.3 **apply only if you enabled an IM platform (Feishu / Slack / DingTalk)**. For web-only deploys you can skip all of them.

IM runs on an **API Gateway HTTP API + Lambda webhook** — there is no long-lived container to look
at, so the criterion is "the URL exists + there are logs":

```bash
# The URL (this is exactly what you paste into the Feishu / Slack / DingTalk console)
aws cloudformation describe-stacks --stack-name ImStack --region $AWS_REGION \
  --query 'Stacks[0].Outputs[?OutputKey==`FeishuWebhookUrl`||OutputKey==`SlackWebhookUrl`||OutputKey==`DingtalkWebhookUrl`]' \
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

`@bot` something in a group, then read both Lambda log groups (Feishu shown; for Slack /
DingTalk replace `feishu` with `slack` / `dingtalk`):

```bash
aws logs tail /aws/lambda/notiops-im-ingress-feishu --region $AWS_REGION --since 5m
aws logs tail /aws/lambda/notiops-im-worker-feishu  --region $AWS_REGION --since 5m
```

| Symptom | What it means |
|---|---|
| both have logs | ✅ working |
| ingress yes, worker no | signature check passed but the async handoff failed — read the ingress error |
| `401 (signature/token)` in ingress | the two keys do not match the console; back to [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §1.2 |
| neither has logs | The platform never sent it — Feishu / Slack: is the delivery mode still on long connection / Socket Mode? DingTalk: is the message-receive mode still on Stream mode (the default, which must be changed to HTTP mode)? |

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
   [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §7.2)
7. When it finishes (possibly minutes later) the card settles into the answer plus two buttons

> ℹ️ **The DingTalk criteria are different (platform primitives, not unfinished work)**: DingTalk cannot
> edit a message it has already sent and its card buttons can only be links, so there is **no** 🚀 Start
> Investigation edit card and **no** "Dispatch Investigation" button — one sentence dispatches it directly;
> progress does **not** refresh in place on one card either, it arrives as **at most 2 appended** "still
> running" messages (a hard cap). On DingTalk the criteria are: an ack immediately → 0–2 progress messages
> → the answer / report as the last one. Comparison table in
> [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §3.6.

⚠️ "It took several minutes to answer" is **not** a failure. There is exactly one criterion:
**did the thinking card show up immediately after you sent the question?** The user-facing wording is in
[IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §7 — don't file it as a regression.

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

> ⚠️ **To be clear up front: in this release, real-time pushes of AWS service events (CloudWatch alarms /
> Backup / GuardDuty / Cost Anomaly / Trusted Advisor) reach neither Feishu, Slack nor DingTalk, and
> enabling the rules does not produce any cards.** Whether the push Lambda `notiops-push-handler` delivers
> depends only on its own environment variables (`PUSH_TARGET_PLATFORM` / `PUSH_TARGET_CHAT_ID`, plus
> `DINGTALK_PUSH_WEBHOOK_URL` for DingTalk); it does **not** read the Feishu secret's `notify_chat_ids` or the
> DingTalk secret's `webhook_url`, and neither deployment path sets those variables — so even with the
> `notiops-push-*` rules enabled, it logs one `Push disabled` line per event and returns.
> Read these events in Web Chat's left-nav "Notifications" instead (both deployment paths have it, see §12.5).

### 7.1 What actually reaches an IM group today (`setup.sh` deployments only)

| Push | Where it goes | Where the target comes from |
|---|---|---|
| **Daily ops notification** (`notiops-notifier`, 02:00 UTC daily: resource inspection + cost anomalies + investigations from the last 24h) | Feishu only | `notify_chat_ids` in the Feishu secret `notiops/im-bot-feishu`, i.e. "Target group chat IDs" on the Feishu tab of Web Chat "More → Admin → IM Integration"; empty = nothing is sent |
| **AWS Health events** (the PHD forwarder `notiops-phd-forwarder`, deployed by default, see §4.3) | Feishu only | Same; empty = nothing is pushed and Bedrock is not called |
| **Inspection push** (`notiops-inspection-push`) | Feishu / DingTalk / Slack | The group must first be registered as an inspection push target — this release has **no way yet** to do that (no web setting, `setup.sh` does not ask, and the release ships no tool for it), so it cannot actually be set up in this release; see inspection results under Web Chat "More → Inspection" |

`setup.sh` **does not ask** for a push target (it only asks whether to deploy PHD event forwarding).
Investigation results go back to the conversation that started them, not to `notify_chat_ids`. The
DingTalk secret's `webhook_url` (the group's custom-robot URL, see §3.3 step 8) is used in only two places:
the fallback when an investigation report cannot be posted back to its conversation, and the inspection
push in the table above; the daily notification and Health events are not sent to DingTalk.

<!-- Corrected 2026-09-06: this section used to point at a set of push toggle keys in
     infra/cdk.json — the code never reads those keys (repo-wide grep hits docs only),
     so following it silently did nothing. The real mechanism is the EventBridge rule
     toggle below. tests/test_docs_no_phantom_config.py pins this. -->
<!-- Corrected again 2026-10-11: the rule toggle is real, but the notiops-push-handler behind the
     rules only honours the PUSH_TARGET_CHAT_ID / PUSH_TARGET_PLATFORM environment variables
     (_push_configured in shared/report_delivery/push_handler.py), and no stack sets them, so an
     enabled rule still delivers nothing. This section used to name notify_chat_ids as its target
     group and the DingTalk webhook_url as its push target; both were wrong. -->

### 7.2 The `notiops-push-*` rules (no IM delivery in this release)

The backend stack has 5 EventBridge rules (`notiops-push-<source>`), **all DISABLED by default**. The
toggle is enabling / disabling the rule in EventBridge, but an enabled rule only makes
`notiops-push-handler` get invoked, log `Push disabled` as described above, and return — it does **not**
post a card into any IM group:

| Rule name | Event source |
|---|---|
| `notiops-push-cloudwatchalarm` | CloudWatch alarm state changes (NotiOps' own ops alarms excluded) |
| `notiops-push-backupjob` | Backup job state changes |
| `notiops-push-guardduty` | GuardDuty findings |
| `notiops-push-costanomaly` | Cost Anomaly Detection (requires a monitor; global service, emits in us-east-1 only) |
| `notiops-push-trustedadvisor` | Trusted Advisor check item changes (requires Business+ Support; us-east-1 only) |

> What does deliver is the **separate** set of rules behind the web "Notifications" inbox
> (`notiops-web-notif-*`, 10 rules, 5 on by default), independent of the 5 above: Method B tunes those
> by putting `"webNotif<Id>": "on"` or `"off"` into the `context` block of `infra/cdk.json` and re-running
> `./setup.sh` (see §8.1); Method A toggles them in the EventBridge console (see §12.5).

### 7.3 Fully silent

To stop the daily ops notification and Health events reaching a Feishu group, clear `notify_chat_ids` in
the Feishu secret ("Target group chat IDs" on the Feishu tab of "IM Integration") — both Lambdas keep
running, they just send nothing. To stop only the Health one, run `ENABLE_PHD=false ./setup.sh` (see §4.3).
The `notiops-push-*` rules post nothing to groups anyway, so there is nothing to do there.

### 7.4 Test push

You don't have to wait for 02:00 UTC to see the daily ops notification — invoke `notiops-notifier` once by
hand; with no `report_date` in the event it reports on the current day, exactly as the scheduled run does:

```bash
aws lambda invoke --function-name notiops-notifier --region $AWS_REGION \
  --cli-binary-format raw-in-base64-out --payload '{}' /tmp/notiops-notifier-out.json
cat /tmp/notiops-notifier-out.json
```

- `"status": "completed"` with `"notifications_sent"` ≥ 1 → a "daily ops notification" lands in the Feishu group.
- `"notifications_sent": 0` → `notify_chat_ids` is empty, or sending failed (check the `/aws/lambda/notiops-notifier` log).
- `"status": "skipped"` (`"reason": "no_data"`) → there is genuinely nothing to report today (inspection did not
  run, no open findings, no cost anomalies, no investigations in the last 24h); not a failure.

---

## 8. Day-2 Operations

### 8.1 Configuration changes

`setup.sh` passes the context keys it manages (`enabledPlatforms` / `agentRuntimeArn` / `organizationId`
and so on) as `-c` flags on every run; keys it does **not** pass (such as the first two rows below) have to go
into the `context` block of `infra/cdk.json`, so that every later `./setup.sh` run keeps them:

| Change | How |
|---|---|
| Edit chat_id allowlist | Add `"imAllowedChatIds": "oc_xxx,C0123ABC"` (comma-separated) to the `context` block of `infra/cdk.json`, then re-run `./setup.sh` |
| Toggle a single source of the web "Notifications" inbox | Same, with `"webNotif<Id>": "on"` or `"off"` (see §12.5). The IM `notiops-push-*` rules are not context, and they deliver nothing in this release (see §7) |
| Add / remove IM platforms | Re-run `./setup.sh` and pick again at the IM-platform prompt (the `-c enabledPlatforms=…` it passes overrides the same key in `cdk.json`; `none` = deploy no IM side at all) |

> ⚠️ **Don't deploy just one stack**: `npx cdk deploy ImStack` without `--exclusively` first redeploys the
> `NotiOpsBackendStack` it depends on, and both stacks get only the `-c` flags you typed this time — none of
> the ones `setup.sh` normally passes — so they are synthesized with defaults (`enabledPlatforms` back to
> `feishu`, an empty `agentRuntimeArn`, and the cross-account gate of a multi-account deployment locked again).
> It is the same trap as in §5.4. If you really must deploy one stack by hand, add `--exclusively` and copy
> every `-c` from the `setup.sh` line.

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
`get-function-configuration` first and pass them all back, don't send a single key. Don't reach for
`cdk deploy ImStack` instead: with an unchanged template it deploys nothing and cycles no instances, and it
carries only the `-c` flags you type (see the warning at the end of §8.1). (On pre-M2 installs that still
have ECS, the equivalent was `aws ecs update-service --force-new-deployment`.)

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
| **L1 disable a single event source** | `aws events disable-rule --name notiops-web-notif-<source>` (the web "Notifications" inbox, see §12.5); the IM-side `notiops-push-<source>` rules deliver nothing in this release anyway (see §7) | Single event source, instant, no deploy |
| ~~**L2 disable a whole conversation tier**~~ | **This switch no longer exists**: `agenticChatMode` has not been read since M2 (2026-09-03) (`AGENTIC_CHAT_MODE=enabled` is hard-coded in `infra/lib/constructs/im-core.ts`), so passing it has no effect — see §11.1. To stop IM, use L4 | — |
| **L3 take IM from webhook back to long connection** | ⚠️ **No longer "minutes" after M2 (2026-09-03)** — `BotStack` is not instantiated by `infra/bin/app.ts` any more, so you first add `new BotStack(...)` back, install finch/docker, and `cdk deploy BotStack` (which creates VPC/ECS/ECR and builds images), then set the Feishu / Slack console delivery mode back to long connection / Socket Mode. Pre-M2 installs (stack still present) stay minutes-level: switch the delivery mode + `aws ecs update-service --desired-count 1 ...` | Single platform; ~20 min on fresh installs, minutes on pre-M2 installs ([IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §1.6) |
| **L4 turn the bot off entirely** | webhook mode: `aws lambda put-function-concurrency --reserved-concurrent-executions 0` (the ingress starts 429-ing everything at once); long-connection mode: `aws ecs update-service --desired-count 0 ...` | Single platform, instant |
| **L5 delete the stack** | `cd infra && npx cdk destroy <stack-name>` | Entire stack |

> ⚠️ Stack deletion removes the Lambda / API Gateway / IAM resources (plus ECR / SG / ECS on pre-M2 installs). **The four DDB tables are NOT deleted** (`notiops-config` / `notiops-conversations` / `notiops-web-chat` / `notiops-inspection`, `removalPolicy: RETAIN`) — clean them up manually if needed; **the data bucket `notiops-data-<account>-<region>` is the opposite: deleting the main stack deletes it together with its objects** (your Skills and long reports live there — export them first if you want to keep them). By design, every AWS resource created by this project carries the `auto-delete=no` tag to protect it from automated cleanup jobs.
>
> To remove the **whole environment** (as opposed to rolling back one stack), don't run
> `cdk destroy` stack by stack — use `./teardown.sh` in the repository root. It deletes
> the stacks in reverse dependency order and cleans up the non-CDK leftovers (the one-shot
> EventBridge schedule, the WebSearch gateway, the 30-day recovery window on the secrets).
> Start with `./teardown.sh --dry-run`; the default keeps the four RETAIN'd tables, and
> `--delete-everything` deletes them together with the leftover log groups; the data bucket goes
> with the main stack in both modes, so by default it first backs the bucket up locally
> (`--no-backup` skips that). Everything
> CUR-related (the `notiops-cur-report` report definition, its delivery bucket, the Athena
> integration stack, the saved queries) is **kept in both modes** -- that is your billing
> history, and AWS does not backfill it; on reinstall `setup.sh` recognises the kept
> `notiops-cur-report`, reuses it without asking or re-creating it, and picks up the existing
> Athena table within minutes (see §13.2).

---

## 10. Top 5 Deployment Errors

| Symptom | Likely cause | Diagnose / fix |
|---|---|---|
| **Access denied on Secrets Manager** — during CDK deploy (creating the empty secrets) or later when you fill in IM credentials with the CLI | The two cases are denied for different identities: during CDK deploy the secrets are created by the bootstrap role `cdk-hnb659fds-cfn-exec-role` (see §2.4 (2)), not by you; only when you fill in credentials with the CLI is it your own identity that lacks permission (the web "IM Integration" page writes through the BFF's own role and is not affected by this row) | CDK deploy case: check whether that role's execution policy was replaced by a narrower one (when `setup.sh` bootstraps the account itself it is AdministratorAccess, see §2.4 (1)), and whether an SCP or a permissions boundary blocks Secrets Manager. CLI case: give the IAM user / role / Identity Center permission set you use a statement limited to `arn:aws:secretsmanager:<region>:<account>:secret:notiops/*` with `secretsmanager:DescribeSecret` / `GetSecretValue` / `PutSecretValue` (`setup.sh` itself also calls `DescribeSecret` / `DeleteSecret`, see §2.4 (3)). Don't attach the whole `SecretsManagerReadWrite` policy for this |
| **`ImStack` fails at synth complaining the Layer is missing packages** | `scripts/build_im_layer.sh` wasn't run, or it failed | Re-run `bash scripts/build_im_layer.sh` (it cross-downloads with `pip --platform manylinux2014_x86_64 --only-binary=:all:` — **no container needed**) |
| **Bot doesn't respond to @ — worker logs show `auth failed`** | Wrong IM credentials / wrong Secret payload | `aws secretsmanager get-secret-value --secret-id <name>` and compare to the original credential; fix it and wait for the next cold start (no redeploy needed) |
| **Bot dispatch succeeds but the report doesn't return to the channel** | report-handler Lambda doesn't have IM credentials | Verify the Secret ARNs in the Lambda env match those in `ImStack`; re-run `./setup.sh` (not a lone `cdk deploy NotiOpsBackendStack` — see the warning at the end of §8.1) |
| **`Bedrock InvokeModel` AccessDeniedException** | The model is not enabled in the deploy region / (Claude Sonnet 5.5 / Opus 5.5, GPT-6 Sol) this account has not accepted its AWS Marketplace agreement / the execution role lacks the permission | Bedrock console → Model access; for the Marketplace agreement and what to do if you won't accept it, see §2.2; the IAM action is `bedrock:InvokeModel` (not `bedrock-runtime:`) |

---

## 11. Full CDK Context Reference

Below are the context keys each stack **actually reads**. `setup.sh` passes some of them on the command line itself; for the ones it doesn't, put them in the `context` block of `infra/cdk.json` and re-run `./setup.sh` (how, and the single-stack-deploy trap, are in §8.1).

### 11.1 ImStack (IM platform stack)

`ImStack` reads exactly **four** context keys (`infra/lib/im-stack.ts`):

| context key | Default | Description |
|---|---|---|
| `enabledPlatforms` | `feishu` | IM platforms to enable (comma-separated, e.g. `feishu,slack`). `none` = the whole `ImStack` is not instantiated (`infra/bin/app.ts`); platforms not listed get no Lambda / webhook at all |
| `imAllowedChatIds` | (empty) | chat_id allowlist (comma-separated; empty = no restriction). Injected as `ALLOWED_CHAT_IDS` on the worker |
| `organizationId` | (empty) | Non-empty = multi-account (Organizations) mode, same semantics as `NotiOpsBackendStack` |
| `agentRuntimeArn` | (empty) | ARN of the Web Chat AgentCore Runtime (the same `-c` that `WebChatStack` reads). IM's `/agent notiops` goes through it; empty = `/agent notiops` is refused outright (`agent.not_configured`) rather than quietly falling back to DevOps direct. `setup.sh` passes it once the agent is deployed |

> ⚠️ **These keys stopped doing anything after M2 (2026-09-03)** — don't copy them from older docs:
> `bedrockModelId` / `bedrockRegion` / `agenticChatMode` / `defaultLlmProvider` / `gptRegion` /
> `awsMcpMode` / `enableMcpPricing` / `defaultLocale` / `allowedChatIds`.
> They only ever fed the `BotStack` Fargate container environment, and that stack is retired. The IM
> equivalents are now **hard-coded in `infra/lib/constructs/im-core.ts`** (`AGENTIC_CHAT_MODE=enabled`,
> `AWS_MCP_MODE=docs_only`, `AWS_MCP_PRICING_ENABLED=false` / `AWS_MCP_COST_ENABLED=false` — there is no
> sidecar for a Lambda to talk to). **Model** is resolved at runtime: per-chat / per-DM `@bot model <alias>`
> → the DDB model catalogue's `default_model` (`core/llm_pref_resolver.py`, see
> [USER_GUIDE.en.md §15](USER_GUIDE.en.md#15-model-and-chat-object)); **locale** comes from
> `core/locale_resolver.py`'s user / DM / thread / incident records, falling back to `en` when there is
> none (`DEFAULT_LOCALE` is not injected). Passing these `-c` flags neither errors nor takes effect —
> that is **silently ineffective**, which is exactly why they're listed here.

### 11.2 NotiOpsBackendStack (shared backend + push)

The context keys `NotiOpsBackendStack` reads are exactly its rows in the §4.3 table — `organizationId` /
`inspectionReportLocale` / `monthlyLimitSeconds` / `opsAlertEmail` / `webBaseUrl` / `skipPhd` /
`phdLinkedAccounts` / `oamSinkArn` / `operatorAppAlreadyEnabled` — plus the `webNotif<Id>` keys from §12.5.

> ⚠️ The three keys this table used to list, `agentSpaceId` / `devOpsAgentRegion` /
> `reportUrlExpirationSeconds`, are **not read anywhere** in the code, so passing them has no effect: the
> stack creates both Agent Spaces itself (see §5.3.5), and DevOps Agent is used in the deploy region (see §2.3).

> IM push targets and per-source toggles are **not** CDK context, and the `notiops-push-*` path delivers
> nothing to IM in this release; what actually reaches IM, and where its targets come from, is in §7.1.

> The data bucket is auto-created: `notiops-data-<account>-<region>` (private, SSE-S3 encrypted, TLS only;
> no parameter required), with Skills, reports and so on split by prefix. It is **not** RETAIN'd — deleting the
> main stack deletes it (see §9).

---

## 12. Web Chat Deployment

> **Web Chat** is NotiOps's browser-based agentic AI assistant. It is **independent** of the IM bot above — you can deploy the IM bot only, Web Chat only, or both. Web Chat reuses the notiops Cognito user pool for auth and the shared backend (config table, `core/push_event` normalizer, DevOps Agent).

### 12.1 Web Chat architecture

| Component | Description |
|---|---|
| **Agent Runtime** | Bedrock AgentCore Runtime hosting the Strands agent (default model **Kimi K3** (`global.moonshotai.kimi-k3`), taken from the catalogue's `default_model`). Deployed as a CodeZip by `scripts/deploy_agent.sh`, which emits a **Runtime ARN** |
| **BFF Lambda** | Node.js 24 Lambda (`notiops-web-chat-bff`) with a **Function URL** (`AuthType=AWS_IAM`) that responds to the frontend via **SSE streaming**; it calls the Agent Runtime and also handles deterministic operations directly (case creation `/actions/execute`, the `/support/services` catalog, etc.) |
| **Frontend** | React / Vite single-page app, statically hosted |
| **Auth** | Cognito (reuses the notiops user pool) + Identity Pool; the frontend gets temporary credentials and **SigV4-signs** requests to the Function URL |
| **Data** | CDK `WebChatStack` creates the single DDB table `notiops-web-chat` (sessions/messages + the persistent notification inbox in the `notif#` segment, 90-day TTL, account-shared) |

The data plane is **strictly read-only on your infrastructure**: the hard boundary is IAM — the roles that reach your account are read-only on your infrastructure, and writes that change resources get no permission. Outside NotiOps' own resources, the only write permission is creating / replying to / resolving AWS Support cases (run only after you confirm a preview; a member account's role can be made strictly read-only with the template parameter `EnableSupportCaseWrite=false`). On top of it sit tool-level read-only enforcement (`READ_OPERATIONS_ONLY` + a curated read-only MCP allow list), a command-level denylist, and a read-only system prompt (see [TECHNICAL_DESIGN.en.md](TECHNICAL_DESIGN.en.md) §5.3 for the full make-up of this defense in depth). Web Chat does not relax any of it.

### 12.2 Deployment order

Web Chat is two steps, and every `./setup.sh` run does both, in order:

```
scripts/deploy_agent.sh    # 1) agentcore deploy CodeZip → prints the Agent Runtime ARN
        │
        ▼  (setup.sh hands the ARN to CDK as -c agentRuntimeArn=<ARN>)
setup.sh's cdk deploy --all    # 2) one command with the other -c flags it manages; creates / updates WebChatStack
```

1. **`scripts/deploy_agent.sh`** — uses `agentcore deploy` to package the agent as a **CodeZip** and create / update the AgentCore Runtime, printing the **Runtime ARN**.
2. **CDK `WebChatStack`** — inject that ARN via `-c agentRuntimeArn=<ARN>` to create the BFF Lambda + Function URL + DDB table + notification handler.
3. **Frontend `config.json`** — after deploy, write the BFF Function URL (and more) into the frontend (see §12.4).

> ⚠️ If you do step 2 by hand, don't pass `-c agentRuntimeArn` alone: without `--exclusively` CDK first
> redeploys the main stack with defaults, and even with it you lose the rest of the context `setup.sh`
> normally passes (`organizationId` for multi-account, the cost MCP keys and so on — see the warning at the
> end of §8.1). Either just re-run `./setup.sh`, or add `--exclusively` and copy every `-c` from the
> `setup.sh` line — when the agent fails to deploy, `setup.sh` prints that full command at the end (see the
> first row of §12.7).

### 12.3 Key environment variables (BFF Lambda / handler)

| env | Description |
|---|---|
| `WEB_CHAT_TABLE` | DDB single-table name (`notiops-web-chat`), shared by sessions / messages / notification inbox |
| `AGENT_RUNTIME_ARN` | The AgentCore Runtime ARN from `deploy_agent.sh` (injected via `-c agentRuntimeArn`) |
| `SKILLS_BUCKET` | Skills storage S3 bucket (`skills/` prefix, shared with the IM side) |
| `DEVOPS_AGENT_SPACE_ID` | DevOps Agent Space id (used for deep investigation) |
| `REPORTS_CDN_DOMAIN` | CloudFront domain for online reports (HTML reports land in S3, CloudFront 7 days; presigned URL 12h fallback) |
| `CONFIG_TABLE` | The notiops config table (`notiops-config`), reused for configuration / notification-source toggles |
| `NOTIOPS_CROSS_ACCOUNT_ROLE` | Cross-account collection role name (read-only, plus Support-case open / reply / resolve by default — set `EnableSupportCaseWrite=false` to keep it strictly read-only; see §0.1.1) |
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
- **Off by default** (5 — turn one on by adding `"webNotif<Id>": "on"` to the `context` block of `infra/cdk.json` and re-running `./setup.sh`, see §8.1): Backup / EC2 Spot / Auto Scaling / RDS / Config (their `<Id>`s are `BackupJob` / `Ec2Spot` / `AutoScalingFail` / `Rds` / `Config`)
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
> Don't need them? Add `"webNotifCostAnomaly": "off"` and `"webNotifTrustedAdvisor": "off"` to the `context`
> block of `infra/cdk.json` and re-run `./setup.sh`; the warning goes away.

> 📌 **Both deployment paths ship this whole set, from one shared definition.** The event-source definitions (10 sources, defaults, rule names, rule descriptions, Lambda env) live in
> [`infra/lib/constructs/web-notif-sources.ts`](../infra/lib/constructs/web-notif-sources.ts), and `setup.sh`'s
> `notiops-backend-stack.ts` and the one-click `notiops-webchat-standalone-stack.ts` **import the same file**
> (check ⑤ in `scripts/test_oneclick_parity.py` pins that nobody copies the list back into a stack).
> **The one intentional difference is how you turn a source off**: the `webNotif<Id>` key above is CDK context (it goes into the
> `context` block of `infra/cdk.json`, see §8.1) and only applies to `setup.sh`.
> One-click has no CDK context, so you Disable the `notiops-web-notif-*` rule in the **EventBridge console** instead — the template does not
> manage a rule's enabled state, so that manual change is not reverted by a version upgrade.
> The customer-facing write-up for one-click is [DEPLOYMENT_ONECLICK.en.md §2.9](DEPLOYMENT_ONECLICK.en.md#29-notifications-inbox).

> Near real-time delivery is via **60s frontend polling** (not WebSocket, so there is up to ~60s latency); the left-nav red dot counts **inbox unread only**. The "Notifications" topic also has an **AWS Health Dashboard live view** that the BFF queries against the Health API in real time (not persisted); it requires a **Business+ / Enterprise Support** plan. Without one it degrades gracefully to console links, and the Health unhandled count is **not** rolled into the red dot.

### 12.6 Smoke tests

> **Where the login credentials come from**: on first deploy `setup.sh` creates a Cognito `admin` user and prints a **temp password** (in the completion banner: `👤 Login: admin / <temp password>`) — this is the entry account for the web console. Change it on first login. If the banner shows no password, the `admin` user already exists (password unchanged).

```
1. Open the Web Chat frontend URL in a browser → sign in via Cognito
2. Confirm the left nav shows: Notifications / Investigation / Cost /
   Cases / **More**
   ("More" expands to Inspection / Skills / Admin, and opens by itself when the current page is one of them)
   (there is also **no "Security" item** — Security folded into Investigation,
    and its dashboards open only from a pill)
   (Investigation / Cost / Cases each carry a pill row **above** the composer,
    **left-aligned with the chat box** and with **no** leading "Dashboards"
    label: Investigation = ⟨Operations overview⟩ ⟨Security posture⟩,
    Cost = ⟨Spend & savings⟩, Cases = ⟨Case progress⟩. Each opens the same
    dashboard tree as before, with a Back button at the top left)
3. Send an investigation request (e.g. "investigate EC2 in IAD"):
   → a "View thinking · N steps" entry appears above the reply body (one per reply); the
     right-side "Thinking" docked panel opens by itself when the first step arrives and grows
     in real time (once you have closed the panel by hand it stops auto-opening — use the entry)
   → on completion the main chat shows the root-cause conclusion + an HTML online report link
4. Create a case: go to the "Cases" topic, use the editable card to pick service /
   category / case type → preview → confirm
   (execution goes through the deterministic /actions/execute, not the LLM)
```

> **The DevOps Agent toggles under the composer**: the Investigation topic has two, "DevOps Chat" and "Deep Dive"; the Cost topic has only "Deep Dive" (General / Cases / What's New have none). **All are off by default** and only take effect once you switch them on. There is **no** "FinOps Agent" toggle (the greyed-out "coming soon" placeholder was removed on 2026-09-13), so don't look for it during the smoke test. A toggle greyed out with an "N/A" badge means the deployment account has no Agent Space, or the selected account isn't onboarded to DevOps Agent (the tooltip says which). Details in [USER_GUIDE.en.md §4.3](USER_GUIDE.en.md#43-who-answers-and-how-deep).

### 12.7 Common pitfalls

| Symptom | Cause / fix |
|---|---|
| **Every question comes back as `Got it — you said: … (Echo — AGENT_RUNTIME_ARN not set …)`** | **The agent was never deployed** and the BFF is on its echo fallback. Chain: `deploy_agent.sh` failed → no Runtime ARN → `WebChatStack` got an empty `AGENT_RUNTIME_ARN` → [bff/web-chat/index.mjs](../bff/web-chat/index.mjs) echoes. **One command fixes it: `bash scripts/fix_web_chat_echo.sh --region <region>`** (read-only diagnosis → prints the verdict → after you confirm: installs uv / pins the CLI / restores the CDK harness / redeploys the agent / injects the ARN into the BFF, carrying over the live `organizationId` and CORS allowlist). ⚠️ On a deployment whose cost MCP server NotiOps hosts (§14.2) it **refuses to run** -- it would redeploy that server as "your own server" and so delete it; it also refuses when it cannot tell whether NotiOps hosts it. On such a deployment use `COST_MCP_SELF_HOST=true ./setup.sh` instead. By hand: **first suspect is a missing `uv`** (see §2.1) → install uv → re-run `./setup.sh` (it redeploys the agent and injects the ARN together with all the other `-c` flags; on a deployment whose cost MCP server NotiOps hosts, use `COST_MCP_SELF_HOST=true ./setup.sh`). If you would rather not re-run the whole thing: `DEPLOY_REGION=<region> bash scripts/deploy_agent.sh`, then paste the ARN it prints into the full `cdk deploy WebChatStack --exclusively …` command printed at the end of your last `setup.sh` run (it carries that deployment's whole `-c` set, including the multi-account and cost MCP ones). Don't build your own command with only `-c agentRuntimeArn`: every context key it leaves out is synthesized with its default — a multi-account deployment turns into `org_mode_disabled`, the 4 CUR sheets disappear from FinOps, and a self-hosted cost MCP server gets deleted. Verify: `aws lambda get-function-configuration --function-name <web-chat-bff> --query 'Environment.Variables.AGENT_RUNTIME_ARN'` must be non-empty |
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
  │        (two cases skip the question, see §13.2)
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
2. If none: two cases are settled **without asking** first; only if neither applies does it detect and ask:
   - The account still has NotiOps's own `notiops-cur-report` (deleting NotiOps deliberately keeps it -- e.g. a reinstall after `./teardown.sh --delete-everything`) → **reuse it**, via step 3 below; usually `READY` within minutes
   - This run is `COST_MCP_SELF_HOST=true` without `CUR_TABLE` / `CUR_BUCKET_NAME` (§14.2) → the self-hosted cost MCP is already set up for the CUR NotiOps creates, so **create it**
   - Neither → use `cur:describe-report-definitions` to detect whether the account already has a qualifying CUR (Hourly + Resource IDs)
     - Found → prompt the user: **0) Create a dedicated new one** (default, AWS-recommended) / **1) Reuse the existing one**
     - Not found → go straight to creating a new one
3. Reuse path (pick 1, or the `notiops-cur-report` case above): **synchronously invoke `lambda6_cur_finalizer`** (data already available → dynamically discover / build the Athena table → write `READY`, no 24h wait)
4. New path: create the S3 bucket (with the bucket policy CUR's service needs to write) → `cur put-report-definition` → write DDB `PENDING` → `scheduler create-schedule` (one-time, `action-after-completion=DELETE`)

### 13.3 New AWS resources involved

| Resource | Purpose |
|---|---|
| S3 bucket `notiops-cur-<account_id>-<region>` | Dedicated CUR report delivery bucket (Parquet format) |
| CUR ReportDefinition `notiops-cur-report` | Hourly + Resource IDs + Athena integration |
| Lambda `lambda6_cur_finalizer` (function name generated by CDK; its log group is fixed at `/aws/lambda/notiops-cur-finalizer`) | Detects the first delivery and deploys the Athena-integration CFN stack; triggered by the one-time schedule below, with a standing EventBridge rule `notiops-cur-finalizer-selfheal` as a 4-hourly backstop (it returns at once when there is no record or the record is already `READY`) |
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

The IAM identity running `setup.sh` additionally needs: `cur:PutReportDefinition` / `cur:DescribeReportDefinitions`, `s3:CreateBucket`, `scheduler:CreateSchedule`, `iam:PassRole` (to pass `notiops-cur-finalizer-scheduler-role`); plus the permissions to set up the Athena FinOps saved queries: `athena:GetWorkGroup` / `athena:UpdateWorkGroup` (to set the result output location on the primary workgroup) + `athena:ListNamedQueries` / `athena:BatchGetNamedQuery` / `athena:CreateNamedQuery`. The CDK-deployed `notiops-cur-finalizer-role` (see §13.3) and the Web Chat BFF role (which holds the `athena:*Query*` + `athena:ListNamedQueries`/`BatchGetNamedQuery`/`GetNamedQuery` needed to query CUR (Cost Deep Dive fetches saved queries), `glue:Get*`, CUR-bucket read-only, and on the results bucket `s3:GetBucketLocation` + `s3:GetObject`/`s3:PutObject` (`GetObject` for re-signing Deep Dive CSV downloads); Cost Deep Dive's AI insight needs `bedrock:InvokeModel` (DeepSeek V3.2 first, falling back to the default model Kimi K3 when that Region lacks it or it returns nothing), and same-day result caching needs `dynamodb:PutItem` on the `notiops-config` table — without `GetBucketLocation`, Athena errors with "Unable to verify/create the output bucket") need no additional manual grants.

Once the CUR is ready (within minutes when reusing an existing CUR), `setup.sh` automatically: ① sets the result output location on the primary workgroup (`s3://notiops-data-<account>-<region>/athena-results/`, not overwritten if already set) ② idempotently creates **6** Athena saved queries using the [dynamically-discovered db/table names] — `NotiOps - DevOps Agent Usage & Credit` (same measure as the dashboard's credit card), `NotiOps - EDP Commitment Attainment` (edit the annual commitment + contract start/end in `params` and run it directly), plus 4 **Cost Deep Dive** detail queries: `CloudWatch cost by usage type` / `Data Transfer by service` / `EC2 cost by instance type` / `S3 cost by storage class` (run on demand from the dashboard's "Cost Deep Dive" card). The dashboard's Commitments & Programs card "View SQL in Athena" link points here; each Cost Deep Dive scenario's SQL is also read from these saved queries (single source of truth, editable directly in the Athena console) — after the BFF runs it, it hands the real result rows to Bedrock for charts + insights and caches the day's result in the `notiops-config` table (clicking again the same day only re-signs the CSV download, without re-running SQL / re-calling AI).

---

## 14. Customer CUR Dashboard + cost-agent MCP (optional)

> How this differs from §13: §13 queries **this deployment account's own** CUR (which NotiOps creates for you). This section connects **one CUR table** at line-item granularity. The server NotiOps deploys for you only queries a table **in the deployment account and Region** (a CUR in another account is not supported in this release); for a CUR in another account (cross-account, or several payers), use "External" and point NotiOps at a server you run yourself (see §14.2). Leave it unconfigured and the FinOps page simply doesn't show the 4 CUR sheets and chat doesn't mount the CUR tools; nothing else changes (fail-closed).
>
> **This cost MCP server is NotiOps's own code, and it is in this repo** (`cost_mcp/`: six Python files, 45 read-only tools). You do **not** need to find code elsewhere or write a Lambda yourself -- give it one CUR table and NotiOps deploys the server for you (see §14.2). If you **already** run a cost-agent MCP of your own, NotiOps can point at it instead of creating one (the "External" row in §14.2).

### 14.1 What it adds

| Capability | Where | Notes |
|---|---|---|
| 4 CUR dashboard sheets | FinOps page: Cost trend (cross-filtering) / Credit / Extended Support / Savings Plans | BFF caches per day; instant after the daily warmup |
| Ask about customer spend in chat | Just ask in the conversation ("customer's total spend in July") | The agent reaches the MCP's 45 CUR tools through 2 meta-tools (`list_cost_tools` / `call_cost_tool`) |
| Inline charts | Any answer with >=3 data points gets a chart | The tool return carries `chartable`; the frontend renders a ```chart fence |

**The 45 tools, by theme** (ask "list the available cost tools" at runtime for the authoritative catalogue):

| Group | Typical questions it answers |
|---|---|
| Basic spend / trend / attribution (7) | "What did we spend this month", "year to date", "top 10 services", "split by account / region / OS / usage type", "**why did X go up**" (month-over-month, then drill into usage type / instance type / account) |
| EC2 and compute (8) | "How much is On Demand vs SP vs Spot vs RI vs Capacity Block", "average daily instances / vCPUs", "how much Graviton", "c5 vs c6i vs c7g" |
| Commitments: SP / RI / ODCR (10) | "SP coverage / utilisation / **how much is wasted**", "which contracts are wasting money", "**which SPs expire in the next 90 days**", "ODCR utilisation with the worst offenders" |
| Per-service drill-down (9) | "S3 split by API operation", "how many PiB stored and in which storage classes", "how many EBS volumes, how much gp2 is left", "**how many GB transferred**, how much cross-AZ", "Direct Connect port inventory" |
| Billing / reconciliation (5) | "Credit / Refund / Tax detail", "**how much EDP discount did we get**", "reconciliation table by payer x charge type x currency (sums to roughly the invoice)", "which accounts are new this month" |
| AI spend (2) | "Spend per model", "**how many million tokens**" |
| Tag allocation (1) | Split cost / instances / vCPU by your own user tags |
| Dashboard-only (3) | Feed the four sheets above; **not for chat** |

> **Why use this instead of Cost Explorer alone**: these 45 queries encode measures CE cannot
> give you -- amortisation via a **row-level** `CASE` (`net_unblended` gets cancelled out by
> SavingsPlanNegation), a `final_service` that **splits EBS / NAT Gateway / VPC Peering out of
> EC2**, instance counts as `SUM(usage_amount)/24` over three usage types and four charge types
> (`COUNT DISTINCT` is off by an order of magnitude), and `COALESCE` on every ARN emptiness test
> (a CTAS table gives NULL, a native one gives an empty string). Every aggregate comes **straight
> from SQL**, and the return carries a `caliber_note` the model must repeat verbatim rather than
> re-adding numbers itself.

### 14.2 Let NotiOps deploy one for you (recommended), or point at one you already run

**Three states; pick one or neither:**

| State | How | Result |
|---|---|---|
| **Off** (default) | Fill nothing in | No extra resources. Cost questions go to Cost Explorer -- nothing is broken, you just do not get line-item detail |
| **Self-hosted** (recommended) | Give it **one CUR table**, or let NotiOps **create the CUR too** | NotiOps creates the Lambda (`cost_mcp/`, code in this repo) plus a dedicated Athena workgroup and its own results bucket, **all inside your account** |
| **External** (escape hatch) | Give a Function URL + function ARN | Points at a cost-agent MCP you already run; NotiOps creates nothing |

> The two are **mutually exclusive**. Filling in both is rejected during parameter validation
> (path A's `CostMcpExclusiveWithExternal`) or by `setup.sh`'s preflight -- because "which one
> wins when both are set" would become something you have to read code to answer.

#### What self-hosting needs

| Value | Path A (one-click parameter) | Path B (`setup.sh` env var) | Required? |
|---|---|---|---|
| **Let NotiOps create the CUR** | `ProvisionCur=yes` | nothing extra: `COST_MCP_SELF_HOST=true` without a table creates one (see below) | Either/or: pick this if you have no CUR |
| CUR Glue table `db.table` | `CurTable` | `CUR_TABLE` (**usually filled in for you**, see below) | Either/or: fill this if you already have a CUR |
| S3 bucket holding the CUR | `CurBucketName` | `CUR_BUCKET_NAME` | Required with a table (on path B it comes along when the table is read from the record) |
| Cross-account read-only role | `CurRoleArn` | `CUR_ROLE_ARN` | **Not supported yet -- leave empty** (a value is refused, see below) |
| Partition layout | `CurPartitionStyle` | `CUR_PARTITION_STYLE` | Defaults to `flat` -- **check this against your table** |
| CUR schema version | `CurVersion` | `CUR_VERSION` | Defaults to `1` (`2` is experimental) |
| User tags to split by | `CurTagKeys` | `CUR_TAG_KEYS` | Optional, comma separated, no spaces; these are **column-name suffixes**, see below |
| Scan cap per query | `CostMcpScanCapGiB` | `COST_MCP_BYTES_CUTOFF` | Defaults to 100 GiB (`COST_MCP_BYTES_CUTOFF` is in bytes) |

> ⚠️ **The table, its Glue database and the CUR bucket must be in the account and Region you deploy
> NotiOps to.** The server runs Athena there, and Athena only sees the Glue Data Catalog of its own
> Region: a table in another Region deploys fine, then every query fails (the 4 sheets say
> "temporarily unavailable" and chat falls back to Cost Explorer). If your CUR's Athena integration
> is in another Region, deploy NotiOps in that Region, or let NotiOps create a new CUR in the
> deployment Region (the first row above).

> ⚠️ **A CUR in another account (`CurRoleArn` / `CUR_ROLE_ARN`) is not supported in this release**,
> and three places refuse it: the one-click template's `CostMcpCrossAccountNotSupported` rule,
> `setup.sh`'s preflight, and CDK synth. The reason: the queries would run in the CUR account
> against a workgroup that only exists in the NotiOps account, so every one of them would fail. Two
> ways forward: (1) deploy NotiOps in the account that holds the CUR; (2) use "External" and point
> at a server of your own (`CostAgentMcpUrl` + `CostAgentFunctionArn` / `COST_AGENT_MCP_URL` +
> `COST_AGENT_FN_ARN`, see §14.3). The `CurRoleArn` parameter is still in the template; leave it empty.

> **`CurTagKeys` / `CUR_TAG_KEYS` are not the tag keys as you typed them in AWS, but the part after
> `resource_tags_user_` in your CUR table's column names.** Check the column list in Glue / Athena
> first: a tag `cost-center`, for example, usually appears as the column
> `resource_tags_user_cost_center`, so enter `cost_center` (several: `team,cost_center`). Letters,
> digits and underscores only, and no spaces around the commas. Path A's parameter page rejects
> anything else. Path B does not check up front: any other character (e.g. `cost-center`) still
> deploys, but the server fails as soon as it starts and none of the 45 tools work; a space makes
> `setup.sh` stop at the CDK synth step with an error that does not mention tag keys (CDK reports
> `No stacks match the name(s) ...`). Leave it empty and no tag dimension is offered.

#### No CUR yet? Both paths can create one for you

**Both deployment paths can create the CUR for you**, including the official Athena integration.
You do not have to go and configure one in the AWS console first:

- **Path A**: set `ProvisionCur` to `yes` on the parameter page and leave `CurTable` empty.
- **Path B**: run `COST_MCP_SELF_HOST=true ./setup.sh` -- **one run is enough**, and no `CUR_TABLE` is
  needed. The self-hosted server is set up for the CUR NotiOps creates (bucket
  `notiops-cur-<account>-<region>`), and the "CUR + Athena" step later in the same run (section 13)
  **creates it without asking**. If the account still has the `notiops-cur-report` from an earlier
  install (deleting NotiOps deliberately keeps it), that report and its bucket are used instead and
  nothing new is created.

What gets created is an **Hourly + Include Resource IDs + Athena/Parquet** report -- that exact
combination is what the 45 tools query. The spec, and the reason behind every single field, is in
`cur_provisioner/spec.py`.

> ⏱ **AWS takes up to 24 hours to deliver the first report. That delay is on the AWS side and we
> cannot work around it.** Until then cost questions use Cost Explorer. Once it is ready NotiOps
> **switches over by itself -- you do not need to deploy again** (it checks every 4 hours and picks
> the table up the moment it becomes queryable).

> 🔒 **Deleting NotiOps does not delete your billing data.** The CUR report and its S3 bucket are
> **left exactly as they are** when the stack is deleted -- that is your billing history, and AWS
> **does not backfill** past months. Delete them by hand if you want them gone. The NotiOps role
> does not even have permission to delete them.
> A reinstall reuses them: on path B `setup.sh` recognises the kept `notiops-cur-report` and reuses
> it without asking or re-creating it, picking up the existing Athena table within minutes; on path A
> the 4-hourly check picks it up (within about 4 hours).

**If you already have a CUR**: on path A leave `ProvisionCur` at `no` and put the table in `CurTable`
and its bucket in `CurBucketName`. On path B pass `CUR_TABLE=<db>.<table> CUR_BUCKET_NAME=<bucket>`
together with the `CUR_PARTITION_STYLE` that matches the table, and pass them **on every later
`setup.sh` run as well**. Without them `setup.sh` uses the `cur-athena-status#<account>` record in
`notiops-config`, which describes the CUR that section 13 created or connected for you (the
partition layout is inferred from it too, and is `flat` when it cannot be inferred) -- only when that
is the CUR you want can you leave all of them out. **Without** them and without such a record, path B
creates a new CUR for you as described above instead of using the one you have. On both paths the
table must meet the same-account, same-Region rule above.

> ⚠️ The two are **mutually exclusive**: `ProvisionCur=yes` together with `CurTable` is rejected
> during parameter validation (`ProvisionCurExcludesCurTable`). Otherwise you would get a second
> CUR created for nothing (a second CUR charge on your bill) while believing the table you filled
> in is the one being used.
> Path B has **no** such check: with `CUR_TABLE` set, the section 13 step still runs. While there is
> no such record it sets up NotiOps's own CUR for the FinOps dashboard (it reuses a
> `notiops-cur-report` kept from an earlier install; otherwise it creates one -- without asking when
> the account has no qualifying existing CUR, and with "create new" as the default answer when it has
> one, see section 13.2). From then on that record describes that CUR.

**Re-running path B**: on a deployment that already self-hosts the server, a plain `./setup.sh`
**keeps self-hosting** -- it recognises the server it deployed (the WebChatStack `CostMcpUrl` output
matches the live BFF), so you do not need to pass `COST_MCP_SELF_HOST=true` every time. The
`CUR_VERSION`, `CUR_TAG_KEYS` and per-query scan cap you set before are carried over from the live
deployment too. To remove the self-hosted server, run `COST_MCP_SELF_HOST=false ./setup.sh` (it
prints a warning first); after that the 4 CUR sheets disappear from FinOps (dropped by
`requiresEnv`) and cost questions are answered from Cost Explorer. If it cannot read the stack
outputs, and so cannot tell whether the live server is the one NotiOps deployed, `setup.sh` stops
and asks you to say which, rather than guessing.

> ⚠️ Two cases where it does **not** stop:
> - **The table, bucket and partition layout are not carried over from the live deployment**; they
>   come from that record, as described under "If you already have a CUR" above. A deployment on your
>   own table that is re-run without them moves to a different CUR.
> - If what it cannot read is **the live BFF's configuration** (the warning "⚠️ Could not read the
>   live configuration ... your own CUR data source (cost-agent MCP)"), `setup.sh` only warns and
>   carries on, and it cannot tell that the server is self-hosted -- a run that finishes without the
>   switch removes the self-hosted server. On a self-hosted deployment, use
>   `COST_MCP_SELF_HOST=true ./setup.sh` instead, and add any `CUR_VERSION` / `CUR_TAG_KEYS` /
>   `COST_MCP_BYTES_CUTOFF` you set before (they cannot be read back in this case); do not run the
>   External command that warning suggests.

#### 🔴 Spend guardrail (please read this one)

Athena bills **per byte scanned**, has **no per-call cap**, and **charges for cancelled queries
too**. So NotiOps gives this server a **dedicated workgroup** with
`BytesScannedCutoffPerQuery` set from `CostMcpScanCapGiB` (default **100 GiB**) and enforced --
one question cannot turn into a surprise bill. Raise it if your CUR is large and queries keep
getting cancelled; lower it to cap what a single question can ever cost you.

#### Permissions (self-hosted; NotiOps sets these up)

The execution role has **no write action at all** on your CUR data: five read-only Athena actions **scoped to that
one workgroup**, read-only Glue catalog, read-only on the CUR bucket, and write access limited to
its own results prefix. A CUR in another account is not supported in this release (see above), and
**NotiOps will not, and does not support, storing long-lived access keys for it.**

#### ⚠️ On a different CUR some answers will be "missing a piece" -- that is normal, not a failure

**A CUR's column set varies per account**: AWS only emits attribute columns for the service
dimensions you actually use. So:

- **No discount agreement (EDP/PPA)** means no `*_net_*` (post-discount) columns. The server
  detects this at cold start, falls back to the pre-discount (`unblended`) columns, and **says so
  in every answer**. With no discount the two are identical anyway; with one, that sentence
  matters -- do not read pre-discount numbers as post-discount.
- **No Savings Plans** means no `savings_plan_*` attribute columns, so the SP-detail tools answer
  "your bill has no Savings Plans" -- **not an error, and not a zero**.
- Likewise: no GPU usage means no `product_gpu`; no Direct Connect means no `product_port_speed`.

> The rule behind this is **no silent degradation**: if the measure changed, say it; if the data is
> not there, say it is not there. A plausible-looking wrong number is far worse than "your bill
> does not contain that."

### 14.3 Wiring up the External mode (pointing at a server you already run)

> For self-hosting, section 14.2 is all you need; this section is about **External** only.

You supply exactly **two values**, and they must come as a pair: a Function URL does not contain the function ARN, and `lambda:InvokeFunctionUrl` can only be granted per resource — so filling in only one half deploys a data source that *looks* installed and 403s on every call, where the 403 is visible only in CloudTrail. Both paths therefore block that half-configuration **before anything is created**.

| | How you supply it | Where "only one half" is caught |
|---|---|---|
| Path A (one-click CFN) | Parameters page → *Optional: your own CUR data source* → `CostAgentMcpUrl` + `CostAgentFunctionArn` (you can also add them later via a stack update) | `CostAgentArnRequiredWithUrl` (a CfnRule — parameter-validation time, the stack is never created) |
| Path B (setup.sh) | `COST_AGENT_MCP_URL=... COST_AGENT_FN_ARN=... ./setup.sh` | setup.sh's preflight check, **before** the ~20-minute agent deploy |

Once supplied, both paths wire up all four pieces automatically (no manual steps remain):

1. **Agent (chat)**: runtime env var `COST_AGENT_MCP_URL` + two statements on the execution role, `InvokeCostAgentMcp` (`lambda:InvokeFunctionUrl`) and `InvokeCostAgentMcpFn` (`lambda:InvokeFunction`).
2. **BFF (dashboard data)**: the same env var + the same two statements + S3 read/write on the cache prefix (`CurDashCache`).
3. **Cache lifecycle**: 3-day expiry on the data bucket's `cur-dash-cache/` prefix.
4. **Daily warmup**: EventBridge rule `CurDashWarmup`.

> ⚠️ **Upgrade note**: these used to be manual (the old §14.3/§14.4 in v1.0.x). CDK now **owns** the BFF env var and that rule — the next deploy **overwrites** any `COST_AGENT_MCP_URL` you set by hand with the parameter value. So when you upgrade, pass the URL *and* the function ARN to setup.sh (or fill in the one-click parameters); otherwise your manual configuration is reset to empty and the 4 sheets silently disappear (their capability nodes are dropped by `requiresEnv`). Delete any EventBridge rule you created by hand, or the warmup runs twice a day.

**IAM is two-sided**: the identity side (those two roles) is now IaC -- when the server is **in the same account** as NotiOps, that is all it takes. When the server is **in another account**, the **resource policy** on its side (that's your own deployment, not in this repo) must also allow those two roles to invoke it, again with **both actions**.

> 🔴 **When you point at your own server, both actions are required**: `lambda:InvokeFunctionUrl` **and** `lambda:InvokeFunction`. AWS changed Function URL authorization in **October 2025**: newly created URLs require both (the Note at the top of the [official docs](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html)). Granting only the first is very easy to misdiagnose: the signature is valid, the identity is recognised, and the IAM policy simulator even says `allowed` -- yet the request is rejected **at the authorization step** with a 403 and **never reaches your function** (the function's logs stay empty; only CloudWatch's `Url4xxCount` goes up).
> ⚠️ The two statements need **different** Conditions: `InvokeFunctionUrl` uses `lambda:FunctionUrlAuthType = AWS_IAM`; the authorization context of `InvokeFunction` has **no** such key, so it uses `lambda:InvokedViaFunctionUrl = true` (copying the first statement's condition gets you another 403, because the condition does not match).

### 14.4 What happens when the data source is down (the degradation chain never blocks the whole tool)

This is an **external** dependency, so it is fail-soft at four layers, and every degradation is **stated out loud** (a silent degradation is worse than an error — CE's aggregated numbers passing themselves off as CUR line-item numbers would have the customer reconciling against the wrong figures):

| Layer | Situation | What the customer sees |
|---|---|---|
| Deploy time | Parameters not supplied | The capability **does not exist, by design**: the 4 `nav:finops:cur-*` nodes are dropped by `requiresEnv` (no menu entry that does nothing when clicked); the agent mounts zero tools |
| BFF | MCP unreachable / timing out | Only those 4 sheets say "temporarily unavailable" (HTTP 200 + `available:false`); the rest of the page is unaffected |
| Agent | MCP unreachable / timing out | The answer still comes: **customer CUR (line-item) → CE MCP (aggregated, deploy account) → `call_aws` / `aws_readonly`**, and it says which source and which measure it fell back to |
| Agent | 2 consecutive transport failures | A 10-minute circuit breaker fast-fails instead of waiting out 300s every turn — *that* wait is what actually blocks the whole tool |

A single tool's **logical error** (bad arguments) does not trip the breaker: the data source is alive, so the model is left to fix its arguments and retry. Covered by `tests/test_cost_agent_mcp_failsoft.py` and `bff/web-chat/tests/cur_dashboard_failsoft.test.mjs`.

What the warmup does: on `{"source":"notiops.curdash.warmup"}` the BFF queries all 4 panels concurrently for the default window (T-33 to T-3 — the last 3 days of CUR aren't complete, so the window is closed early) and writes the day's cache, so the first person to open it during the day gets it instantly. The cron is `cron(0 22 * * ? *)` (22:00 UTC = 06:00 Beijing) — **the cache key's date basis is UTC+8**, so if you change the timezone you must change both. To verify, send the same payload manually with `aws lambda invoke --invocation-type Event`; the log should show `curdash warmup: cube:fulfilled credit:fulfilled es:fulfilled sp:fulfilled` **with no** `cur-dash <panel>: source unavailable (...)` warning before it -- that line alone is not enough: a panel that failed to fetch has already been turned into "temporarily unavailable" and is counted as `fulfilled` there too.

### 14.5 Troubleshooting

| Symptom | Cause |
|---|---|
| The 4 sheets say "data source not configured" | The BFF is missing `COST_AGENT_MCP_URL`, or IAM isn't through |
| MCP calls keep returning 403 | **Most common: only `lambda:InvokeFunctionUrl` was granted, `lambda:InvokeFunction` is missing** (both are required since AWS's 2025-10 change); or the server is in another account and its resource policy doesn't list the calling role. Tell-tale: the request is **not** in the function's logs while `Url4xxCount` rises -- it was rejected at the authorization step, not by your code |
| First open of the day still takes 1-5 minutes | The warmup didn't run, or the timezone is misaligned — the cache key's date basis is UTC+8 and the EventBridge cron must match it; check the BFF log's warmup line |
| The 4 sheets say "temporarily unavailable", yet the warmup line reads `fulfilled` for all 4 | Usually the MCP side cannot query: a CUR NotiOps just created is still waiting for its first delivery (up to 24 hours), the table is outside the deployment Region, a bad `CUR_TAG_KEYS` value stops the server from starting, or an External server's own credentials have expired, etc. A panel that failed to fetch has already been turned into "temporarily unavailable", so the warmup line still counts it as `fulfilled`; the cause is in the BFF log's per-panel `cur-dash <panel>: source unavailable (...)` lines |
