# NotiOps — One-Click Deployment (CloudFormation, no local setup)

> ⚠️ **Disclaimer**: This is sample code, for non-production usage. You should work with your security and legal teams to meet your organizational security, regulatory and compliance requirements before deployment.

> 🌐 **Language**: [中文](DEPLOYMENT_ONECLICK.md) · [English](DEPLOYMENT_ONECLICK.en.md)
>
> **Audience**: anyone who wants to get the Web Chat console running and try it. You need **nothing installed locally** and **no IAM user / access keys**.
>
> **Time**: **~10 minutes** (the stack itself measured ~4.5 minutes).
>
> **See also**:
> - [DEPLOYMENT.en.md](DEPLOYMENT.en.md) — the full deployment guide (`setup.sh`: IM bots, scheduled inspection and its dashboard's write path, CUR/Athena)
> - [USER_GUIDE.en.md](USER_GUIDE.en.md) — how to use it once deployed

---

## 0. Two deployment paths — this doc covers the second one

The repository ships **two** ways to deploy, with different scope. This document covers only the second.

| | **`setup.sh`** (full, see [DEPLOYMENT.en.md](DEPLOYMENT.en.md)) | **This doc: one-click** |
|---|---|---|
| What you need | git, Node, Python, uv, AWS CDK, plus deployment credentials (**no Docker/finch** — since 2026-09-03 / M2 the IM side ships as a Lambda Layer and builds no images) | **just a browser logged into the AWS console** |
| How you start | clone the repo → `./setup.sh` | download one template from the Release → upload it in the CloudFormation console |
| What gets deployed | Web Chat + IM bots (Feishu/Slack) + daily inspection (including the inspection dashboard's write path) + CUR/Athena FinOps source | **Web Chat** (chat UI + BFF + agent + a DevOps Agent space; multi-account optional) **plus one optional IM bot** (Feishu/Lark or Slack — see [§2.11](#211-add-an-im-bot-feishulark-or-slack)) |
| Good for | long-term use, IM notifications, scheduled inspection | trying it out / demos / just the read-only ops assistant in a browser (with the option of @-mentioning it in a group chat) |

**You can do both, in order**: deploy one-click to try it (tick the IM bot right there on the parameters page if you want one — see [§2.11](#211-add-an-im-bot-feishulark-or-slack)), then run `setup.sh` later when you want scheduled inspection, proactive push, and the inspection dashboard to actually have data. (Both paths create the same admin username, `admin`, so they don't collide.)

### 0.1 What one-click does **not** include

Better said up front than discovered later. These require `setup.sh`:

- **Proactive push into IM**: daily inspection reports and alerts posted into a Feishu/Slack group. The IM bot itself **can** be installed (see [§2.11](#211-add-an-im-bot-feishulark-or-slack) — you @-mention it, it answers), but that is **request/response only**; proactive push needs the report pipeline that only `setup.sh` deploys. (The same 10 signal sources **do** land in the in-browser Notifications inbox — see [§2.9](#29-notifications-inbox); only the IM leg is missing.)
- **DingTalk** bots (Feishu/Lark and Slack are both supported).
- **Scheduled daily inspection** (idle-resource detection, cost-anomaly scanning) and its four Lambdas (`notiops-inspection-scheduler` / `-executor` / `-reconciler` / `-push`) plus the cost-anomaly scanner `notiops-cost-analyzer`.
- **The inspection write path** — and therefore the data behind the *inspection dashboard /
  thresholds / scan scope / target-account* pages. Those pages are part of chat-app and ship on
  **both** paths, but one-click never creates the `notiops-inspection` table, so opening them
  fails to load (the BFF returns `ddb_error`). Making them show anything needs `setup.sh`.
  (**The Skills management UI is not in this list** — one-click still creates the Skills bucket,
  so that page works.)
- **CUR + Athena cost detail**: FinOps questions still work at Cost Explorer granularity, but there is no bill-line-level drill-down.
- **Cross-account scheduled inspection and event forwarding**: one-click *can* do **cross-account read-only inspection / investigation / case creation** (`DeployMode=MultiAccount`, see [§2.6](#26-optional-multi-account-across-an-organization)), but the member-account **CloudWatch OAM Sink** and **cross-account event forwarding** (Health / DevOps Agent investigation events flowing back) are not part of this path — those need `setup.sh`.

(**DevOps Agent deep investigation**, **web search** and the **Notifications inbox** are *not* in this list — the stack creates all three for you, see [§2.7](#27-deep-investigation-aws-devops-agent), [§2.8](#28-web-search-agentcore-web-search) and [§2.9](#29-notifications-inbox). The **IM bot** is not in this list either — it's an option on the parameters page, see [§2.11](#211-add-an-im-bot-feishulark-or-slack).)

---

## 1. Prerequisites (all three)

### 1.1 An AWS account and console permissions to create the stack

Your identity needs to be able to create a CloudFormation stack and the resources in it (IAM roles, Lambda, DynamoDB, S3, CloudFront, Cognito, Bedrock AgentCore). You **don't need `AdministratorAccess`**, but overly narrow permissions will fail partway through. If unsure, use a test account.

> You must tick **"I acknowledge that AWS CloudFormation might create IAM resources"** —
> the stack creates roles for the agent and the BFF.

### 1.2 Pick a region, and enable Bedrock model access there

The agent runs on **Amazon Bedrock**. **Before creating the stack**, go to the Bedrock console → Model access and confirm the model you want shows **Access granted** in that region.

- **The default model is xAI Grok 4.6** (`global.xai.grok-4.6`) — grant access to that one or the deployment is unusable.
- Want a different model (Claude Sonnet 5 / Opus 5 / Haiku 4.5, Amazon Nova Pro, DeepSeek, GLM 5, the GPT-5.6 family)? Grant those too; users can switch per session from the top-right of the chat page.
- **us-east-1** or **us-west-2** recommended (best Bedrock AgentCore and model coverage).
- Without model access the stack still **succeeds**, the site loads and login works — but every question fails with `AccessDeniedException`. This is the most common "it deployed but doesn't work".

### 1.3 The account must be able to reach GitHub (or bring your own mirror)

During deployment, a Lambda inside the stack downloads the artifacts (frontend, BFF, notification producer, agent code — four; two more if you opted into an IM bot) from the **GitHub Release** and stages them into your own S3 bucket. Lambda is not in a VPC here and uses AWS-managed egress, so **most accounts satisfy this out of the box**.

If your enterprise egress allowlist does **not** include github.com, you don't have to abandon this path — see [§7 No internet egress: use a private S3 mirror](#7-no-internet-egress-use-a-private-s3-mirror).

---

## 2. Deploy (5 steps)

### 2.1 Download the template

From the [Releases](https://github.com/aws-samples/sample-notiops/releases) page, download from the latest release:

```
notiops-webchat.template.json
```

The same release also has six artifacts (`bff.zip` / `chat-dist.zip` / `web-notif.zip` / `im-code.zip` / `im-layer.zip` / `agent-code.zip`) — **you don't need to download those**; the template makes your account fetch them. Their SHA256 digests are baked into the template and verified on arrival; a mismatch fails the stack.

> The two `im-*.zip` files are downloaded only if you pick an install option that includes IM ([§2.11](#211-add-an-im-bot-feishulark-or-slack)). The default (web only) skips them, so you don't pay transfer or storage for those ~28 MB.

> **Why isn't there a one-click "Launch Stack" link?** CloudFormation's `TemplateURL` only accepts
> objects in S3, not GitHub URLs. So this costs you two extra clicks (download + upload) and buys
> you the fact that **we host nothing**: the artifacts live only on the GitHub Release, and every
> step that puts code into your account is driven by your own credentials.

### 2.2 Upload it in the CloudFormation console

1. Check the **region** selector top-right matches what you picked in §1.2.
2. **CloudFormation** → **Create stack** → **With new resources (standard)**.
3. **Choose an existing template** → **Upload a template file** → pick `notiops-webchat.template.json` → **Next**.
   (The console stores the template in CFN-managed S3 for you; you don't need a bucket.)

### 2.3 Fill in the parameters

**Stack name**: use `notiops` (the rest of this doc assumes it). Another name works too — the DynamoDB tables are always named `notiops-config` / `notiops-web-chat`, independent of the stack name.

Exactly **one parameter is required**:

| Parameter | What it does |
|---|---|
| **Administrator email** | Your email. After the stack completes, Cognito emails you the **sign-in URL (ChatUrl) + username + temporary password**. It must be a real mailbox — **this is the only way in**. |

Everything else has a safe default. For a first deployment, **leave them all alone**:

| Parameter | Default | When you'd change it |
|---|---|---|
| **What to install** | `web` | A three-way dropdown: `web` (just the in-browser chat UI) / `web+feishu` (plus a Feishu/Lark bot) / `web+slack` (plus a Slack bot). **All three install web** — IM is an add-on, not a replacement. Picking an IM option leaves a few steps to do on the IM platform side, see [§2.11](#211-add-an-im-bot-feishulark-or-slack). **You can change it after deploying** (update the stack with a different value — see §2.11). |
| **Give the agent account-wide read-only access?** | `Yes` | `Yes` attaches the AWS-managed `ReadOnlyAccess` policy so the agent can answer questions about any resource in the account. `No` restricts it to the explicit read-only grants (cost, logs, metrics, RDS/EC2 describe); some questions then fail with a message naming the missing action. **Neither option grants any write permission.** |
| **CORS allowed origins** | `*` | The endpoint is already `AWS_IAM` (SigV4) authenticated, so `*` is not a privilege hole. For defense in depth, update the stack after the first deploy and set this to the `ChatUrl` output. |
| **IM chat/channel allow list (optional)** | empty | Only meaningful once you installed IM ([§2.11](#211-add-an-im-bot-feishulark-or-slack)); with web only you can ignore it entirely. A comma-separated list of Feishu chat ids (`oc_...`) or Slack channel ids (`C...`), **no spaces**; empty means no restriction — the bot answers in every group it is invited to. It is one of the defense-in-depth boundaries on the IM entry point (boundary (c) in [§8](#8-security-notes-worth-knowing)): even if signature verification were bypassed, a message from a chat outside the list is dropped **before any model call**. **The normal rhythm is: deploy with it empty → create the group and take its chat id → then update the stack with that id**, which is why it sits in the `Security` group and not among the required parameters. Equivalent to `-c imAllowedChatIds=…` on the `setup.sh` path. |
| **On stack delete** | `KeepData` | Decides what happens to your data when the stack is deleted. See [§6](#6-deleting-the-stack) — **there is a gotcha; read it before you delete**. |
| **Deployment mode** | `SingleAccount` | Pick `MultiAccount` (and fill in the org id below) to let it also see **other** accounts in your organization. There are prerequisites — see [§2.6](#26-optional-multi-account-across-an-organization). |
| **AWS Organizations id (MultiAccount only)** | empty | Only needed with `MultiAccount` (starts with `o-`). **Half a choice does nothing**: `MultiAccount` with an empty org id stays single-account, and the `DeployModeStatus` output says so. |
| **Enable AWS DevOps Agent features (deep investigation, DevOps Chat)?** | `Yes` | One switch, **four** capabilities — see [§2.7](#27-deep-investigation-aws-devops-agent). An idle agent space costs nothing, which is why it defaults to on; pick `No` if you don't want it (all four are then greyed out). |
| **Artifact base URL override** / **Artifact mirror bucket name (s3:// only)** | empty | Only when you can't reach GitHub — see [§7](#7-no-internet-egress-use-a-private-s3-mirror). |

### 2.4 Acknowledge IAM, create

**Next** → on the final page tick **"I acknowledge that AWS CloudFormation might create IAM resources"** → **Submit**.

**Measured: about 4.5 minutes** (two independent runs: 4m16s / 4m25s, us-east-1, with the default web-only option). You'll see the stack waiting on two `Custom::NotiOpsStager…` resources — that's it staging ~165 MB of artifacts from GitHub into your S3 bucket, unpacking the frontend, writing runtime config, and creating the admin user. An install option that includes IM stages another ~28 MB and creates 3 more Lambdas (tens of seconds).

### 2.5 Sign in

Once the stack is **CREATE_COMPLETE**, open the **Outputs** tab:

| Output | What it is |
|---|---|
| **ChatUrl** | The chat UI (CloudFront). **Open this one.** |
| **LoginUsername** | The username to sign in with — always `admin` |
| **LoginPassword** | **Where** to find the initial password (not the password itself — see the note below) |
| **NextSteps** | One-line sign-in instructions |
| **InstalledRelease** | Which release this stack currently runs |
| **DataRetentionOnDelete** | What deleting the stack does to your data under the current `TeardownMode` |
| **WebChatTableName** | The DynamoDB table holding chat history and notifications (for querying it yourself, or cleaning up manually after a delete) |
| **DeployModeStatus** | Which mode is **actually in effect**. If you picked `MultiAccount` but forgot the org id, this says so plainly. |
| **DeepInvestigationStatus** | Whether deep investigation is on, off because you said so, or **skipped because this Region has no AWS DevOps Agent**. |
| **DevOpsAgentSpaceId** | Present only when deep investigation is on: the agent space the stack created. |
| **WebSearchStatus** | Whether this Region **supports** web search at all (anything other than us-east-1 skips the whole block — see [§2.8](#28-web-search-agentcore-web-search)). |
| **WebSearchProvisioning** | Present only where the Region supports it: whether the gateway **actually got built**. `enabled` = the toggle works; `unavailable (<code>)` = it failed, so the toggle returns nothing (the stack itself still succeeds — see [§2.8](#28-web-search-agentcore-web-search)). |
| **FeishuWebhookUrl** | Present only with `web+feishu`: the request URL to paste into the Feishu open platform ([§2.11](#211-add-an-im-bot-feishulark-or-slack)). |
| **SlackWebhookUrl** | Present only with `web+slack`: the request URL to paste into all three places in your Slack app ([§2.11](#211-add-an-im-bot-feishulark-or-slack)). |
| **ImNextSteps** | Present only when IM is installed: one line telling you which steps are still on you (credentials + request URL). **The bot stays silent until both are done.** |

The link in that email **is** `ChatUrl` (the same address as in the table above — no need to cross-check them). Sign in with:

- **Username: `admin`** (not the email address — though the email works too, it's configured as an alias) — this is the `LoginUsername` output
- **Password**: the temporary one from the email; you'll be asked to set a new one on first login

> 🔒 **Why isn't the initial password in the Outputs?** Two reasons, neither of them an oversight:
> 1. **The stack never has that password.** It does not pass `TemporaryPassword` when creating the
>    admin user; Cognito generates the password itself and emails it directly
>    (`_create_admin` in `infra/lambda/stager/index.py`). There is nowhere in the stack to read it from.
> 2. **Even if it could, it must not.** CFN Outputs are **plaintext**: anyone with
>    `cloudformation:DescribeStacks` (which `ReadOnlyAccess` grants) can read them, and they persist
>    in the CloudFormation API and console history — changing the password later does not remove
>    that record.
>
> So the `LoginPassword` output tells you **where to get it**, not what it is.
> (`setup.sh` printing the initial password in your terminal is a different matter: that is a
> one-off local output that never lands in an AWS API anyone else can query.)

> 📧 **No email?** The sender is `no-reply@verificationemail.com` (Cognito's default email delivery),
> subject `Your NotiOps sign-in details`. **Corporate mail systems often tag it `[EXTERNAL]` or drop it
> into junk** — check there first. Measured delivery: about a minute after stack completion in us-east-1.
>
> Truly lost: Cognito console → that user pool → Users → `admin` → reset the password.

After signing in, ask something like `list the EC2 instances in this account` to confirm the agent actually answers (this also verifies §1.2).

### 2.6 (Optional) Multi-account: across an organization

The default `SingleAccount` only ever looks at the account it runs in. To let it also see other accounts in your organization, set **Deployment mode** to `MultiAccount` and fill in the **AWS Organizations id**.

**Prerequisites (don't pick it otherwise)**:

1. The account you're deploying into is the **organization management account**, or a **CloudFormation StackSets delegated administrator**. This is hard-required — creating the member StackSets needs that standing.
2. You know your org id (starts with `o-`). It's on the **AWS Organizations** console home, or `aws organizations describe-organization --query Organization.Id`.

**Both fields are required.** Picking `MultiAccount` while leaving the org id empty still **deploys successfully but stays single-account** — deliberately: the org id is the `aws:PrincipalOrgID` condition that closes off the cross-account trust policy. Without it, the member-account role would merely trust the system account's root with no organization boundary, which is worse than not enabling it. The `DeployModeStatus` output spells this out.

**What you additionally get**: the stack creates two StackSets in this account (`notiops-member-onboarding`, `notiops-member-devops-agent`) and enables Organizations trusted access for StackSets. You then onboard member accounts one at a time from **Admin → Accounts** in the web UI (each member account gets a cross-account **read-only** role plus a deep-investigation trigger role). After that you can switch accounts in the chat UI for read-only inspection, deep investigation, and case creation.

This path still does **not** include: member-account CloudWatch OAM Sinks, cross-account Health / investigation event forwarding, or cross-account scheduled inspection. Those three need `setup.sh`.

> ⚠️ **Deleting the stack does not delete those two StackSets**, nor does it disable trusted access. Reasoning in [§6.4](#64-whats-left-behind-orphans-and-whether-to-care).

### 2.7 Deep investigation (AWS DevOps Agent)

**Enable AWS DevOps Agent features** (the template parameter is still named `EnableDeepInvestigation`) defaults to `Yes`: the stack also creates an **AWS DevOps Agent agent space** (named `notiops-oneclick-<account id>`) and associates this account with it as a **monitor (read-only)** target. That's what powers **every DevOps Agent capability** in the chat UI — handing a problem to the AWS-managed DevOps Agent for multi-round autonomous triage, which digs deeper than a single question-and-answer round.

Four capabilities depend on this one agent space (without it, the matching toggle is **greyed out with the reason shown**):

| Capability | Who answers that turn | Notes |
|---|---|---|
| **Deep investigation** | DevOps Agent (NotiOps first turns your question into an investigation request) | Multi-signal root cause with an HTML report, usually minutes |
| **Deep investigation (Direct)** | DevOps Agent, calling the API **without an LLM** | The same investigation, **token-free**; the trade-off is that your wording is passed through as-is |
| **DevOps Chat** | DevOps Agent **answers directly** (pick "conversation object = DevOps Agent" in a general chat) | Streaming Q&A, the same experience as the DevOps Agent's own console; **0 tokens on the NotiOps side** and **no model setup** (nothing to enable in Bedrock); usage is billed to your own DevOps Agent |
| **Publish a Skill to DevOps Agent** | — | Pushes your own Skill into the agent space so the "deep investigation" path can use it |

> 💡 The middle two are especially useful for a fresh deployment with **no Bedrock models enabled yet**: pick DevOps Agent as the answerer and you can start immediately.

- **Nothing to click in the console**: the stack enables the agent space's **operator app (web app)** at the same time it creates the space — the console step called “Agent Space → Access → Operator access → **Configure web app**”. That click used to be mandatory and manual; without it all four capabilities above fail with `Invalid or unregistered domain`, an error that points nowhere near “you missed a button”. The stack now does it for you: one extra role assumed by the DevOps Agent service (`AIDevOpsOperatorAppAccessPolicy`), disabled and deleted with the stack.
  > ⚠️ **Only relevant when upgrading from an older version** ([§5](#5-upgrading)): if your stack was created by an older version and you **clicked Configure web app yourself**, this update makes CloudFormation call Enable again while the service already considers it enabled. **That case has not been tested yet.** If the update fails because of it, run `aws devops-agent disable-operator-app --agent-space-id <space id> --region <region>` (the space id is in the `DevOpsAgentSpaceId` output) and update again — the web app domain is derived from the space id, so this **doesn't change the URL**. Fresh deployments are unaffected.
- **Billing**: charged per **agent-second while a task runs**; an **idle agent space costs nothing**. That's why it defaults to on — it won't hand you a monthly bill for doing nothing.
- **Regions**: AWS DevOps Agent is only available in some Regions. **If yours isn't one of them the stack does not fail** — this piece is silently skipped, everything else works, and `DeepInvestigationStatus` says it was skipped for that reason.
- Changed your mind later: update the stack and flip the parameter.

### 2.8 Web search (AgentCore Web Search)

**No parameter — the stack just creates it.** You get a **Bedrock AgentCore Gateway** (named `notiops-websearch-gw`) fronting the AWS built-in `web-search` connector. That's what the **web search** toggle above the chat input uses. **No third-party API key**, and the search requests **never leave AWS**.

- **Billing**: charged **per search** (only when you turn the toggle on *and* the agent decides to search); nothing when you don't search. That's why there is no parameter to turn it off — turning it off would save nothing.
- **Regions**: AgentCore Web Search is currently **us-east-1 only**. **If you deploy elsewhere the stack does not fail** — this piece is skipped whole, everything else works, and `WebSearchStatus` says why. The toggle still shows up in the UI (the frontend does no Region check); clicking it doesn't error, you just get no results.
- **An identically named gateway already exists** in the account (you ran `setup.sh` first, or deployed a second stack there): it is **reused, not duplicated**, and deleting the stack **will not** delete it — only a gateway this stack created gets deleted. The one exception is a same-named gateway stuck in `FAILED`: it cannot recover and is useless to anyone, so the stack replaces it.
- **Provisioning failure does not fail the stack**: web search is optional, and it breaking should not roll the whole stack back (you'd lose every other feature over one toggle). So the output to read is **`WebSearchProvisioning`**: only `enabled` means it works; `unavailable (<code>)` means this deployment has no web search and the toggle returns nothing. For details, look at the `StagerWebSearch` resource in the stack events and the StagerFn logs.

---

### 2.9 Notifications inbox

**No parameters, the stack sets it up.** The inbox behind the first left-nav item is fed by **10 EventBridge rules** → one Lambda (`notiops-web-notif-handler`, normalizes + dedups within 5 minutes) → the `notiops-web-chat` table. The frontend polls every **60s**, so latency is up to about a minute; the red dot counts **unread only**.

- **On by default (5)** — highest operational value, manageable noise: AWS Health / CloudWatch Alarm / Cost Anomaly / Trusted Advisor / GuardDuty
- **Off by default (5)** — high volume, or need a paid service turned on first: Backup jobs / EC2 Spot interruptions / Auto Scaling failures / RDS / Config
- **How to toggle**: **EventBridge console → Rules**, rules prefixed `notiops-web-notif-`, then **Enable / Disable** the one you want. That manual change **survives version upgrades** (the template does not manage the enabled state).

> ⚠️ **3 of the 5 on-by-default sources also need something on your side** — the rule is enabled, but without the prerequisite no events arrive (the empty state in the UI says which one, so it doesn't look like NotiOps is broken):
>
> | Source | Prerequisite |
> |---|---|
> | GuardDuty | GuardDuty must be **enabled** in the account (paid). Until then there are no findings; the enabled rule costs nothing and starts working the moment you enable it, no redeploy |
> | Cost Anomaly | Create a **cost anomaly monitor** in Cost Explorer first (free); events are emitted only in `us-east-1` |
> | Trusted Advisor | Needs a **Business+ / Enterprise / Unified Operations** support plan; events are emitted only in `us-east-1` |
>
> Cost Anomaly and Trusted Advisor are **global services that only emit EventBridge events in `us-east-1`**. Deploy the stack elsewhere and those two rules exist but **never fire** (their rule description says so) — to receive them, deploy NotiOps in `us-east-1`, or add your own cross-region forwarding rule in `us-east-1`.

The Notifications topic also has an **AWS Health Dashboard live view** that the BFF queries against the Health API in real time (not persisted); it needs a **Business+ / Enterprise** support plan. Without one it degrades to console links, and its unhandled count is **not** rolled into the red dot.

**Cross-account**: these 10 rules only see events from the **deployment account itself**. Getting member-account events here needs cross-account event forwarding, which is not part of this path (see [§0.1](#01-what-one-click-does-not-include)).

### 2.10 Session memory (AgentCore Memory)

**No parameter — the stack creates it for you.** The stack contains one **Bedrock AgentCore Memory**, and it does exactly one thing: store **this conversation's** messages under its `sessionId` and read them back on the next turn. **Nothing crosses conversations** — a new conversation starts from a clean page.

- **This is not "chat history"**: history lives in DynamoDB and is always visible in the UI; memory decides what the **model** still remembers. Without it, switching models / switching topics / coming back an hour later within the same conversation leaves the history on screen — but the model is a stranger. So this layer is not optional; the stack creates it **unconditionally**.
- **No cross-session memory** (product decision, 2026-09-01). This used to carry four extraction strategies that wrote "preferences you stated" and "facts about your environment" to namespaces without a session id (`/users/<actor>/…`), retrievable from the next conversation. The strategy count is now **0**, and the whole path is off: nothing is extracted, nothing is retrieved.
  - Less data retained across conversations, and more predictable behaviour ("why did it answer that?" never traces back to something you said days ago and forgot). Anything it should always know belongs in **explicit** configuration such as a Skill or the system prompt.
  - ⚠️ **Upgrading from v1.0.18 / v1.0.19**: the stack update removes those four strategies, and **already-extracted records are deleted with them** (that `<actor>` was also a single identity shared by the whole deployment — a preference A stated shaped the answers B got, which is part of why it's gone).
- **Events expire after 30 days** (pick a conversation back up the next day and it still has context; the chat history itself is stored separately in the `notiops-web-chat` table).
- **Deleted with the stack**, session messages with it.
- Billed by usage (events written / read), orders of magnitude smaller than the Bedrock tokens of the questions themselves — and smaller still now that extraction is gone.

### 2.11 Add an IM bot (Feishu/Lark or Slack)

That **What to install** dropdown in the first parameter group:

| Option | What you get |
|---|---|
| `web` (default) | Just the chat UI in the browser. |
| `web+feishu` | Web Chat **plus** a Feishu/Lark bot: @-mention it in a group, or DM it. |
| `web+slack` | Web Chat **plus** a Slack bot: the `/notiops` slash command, @-mentions, DMs. |

**All three options install web** — IM is an add-on, not a replacement. One stack installs **one** IM platform; if you want both, use `setup.sh` from [DEPLOYMENT.en.md](DEPLOYMENT.en.md) (`-c enabledPlatforms=feishu,slack`).

**IM and the web UI are the same backend**: the same read-only AWS DevOps Agent, the same Skills, the same config table. So whatever you ask in the browser (cost, investigations, Support cases) gives the same answer in a group chat.

**It doesn't burn tokens**: every incoming message first goes through deterministic routing (regex + keywords, in both English and Chinese); anything that matches "look at resources / start an investigation / check progress / switch model / switch language" calls the API directly and costs **zero tokens**. Only the **case flow** (turning your description into case text) actually calls the model.

**A deep investigation started from a group chat delivers its report back to that group**: when the investigation finishes (usually a few minutes), a callback function in the stack writes the HTML report under the `investigations/` prefix of the data bucket and posts a card to the group carrying a **time-limited public download link** — whoever reads the report does not need access to this AWS account. The link is served by this stack's own CloudFront distribution, the one whose function only allows report paths.

> ⚠️ This path is **asynchronous** (EventBridge → Lambda), so when it breaks it does so **without any error**: the progress card still reaches 100% (a different function draws that by polling task state) and then the report simply never arrives. If that happens, check in this order: does `aws lambda get-function --function-name <stack-name>-devops-callback` exist → does its log group (a CFN-generated random name; resolve it by the logical-ID prefix `DevOpsCallbackLogs`, same command shape as the table in [§4](#4-troubleshooting)) contain `account_not_configured` → does `aws s3 ls s3://<data-bucket>/investigations/` hold an object for this investigation. If all three are fine and it still doesn't arrive, look at that function's dead-letter queue.

**Two steps are left to you after deploying**, and the bot stays silent until both are done (the `ImNextSteps` output reminds you too):

1. **Put credentials in Secrets Manager** — the bot needs keys to verify signatures and to reply.
   - **Feishu/Lark**: `notiops/im-bot-feishu`, four keys: `app_id` / `app_secret` / `encrypt_key` / `verification_token`.
     **Easiest path is the web UI**: sign in and go to **Admin → IM Integration** — all four credentials sit on one form and Save writes them into this secret, so you need no CLI and no extra credentials. That page also carries the four-step summary of the Feishu-side work and a "View the detailed setup steps" side panel.
   - **Slack**: two secrets, `notiops/slack-bot-token` (starts with `xoxb-`) and `notiops/slack-signing-secret`, each holding a plain string. ⚠️ These two can currently **only** be created in the Secrets Manager console (the admin page covers Feishu only for now).
2. **Paste the request URL back into the IM platform** — that's the `FeishuWebhookUrl` / `SlackWebhookUrl` output.

> ⚠️ **Don't reverse the order**: credentials first, request URL second. Feishu and Slack fire a verification request the **moment** you save the request URL; with no credentials yet the ingress function fails outright, and what you see on the IM platform is "verification failed" — which looks like a wrong URL.

**Where to click and what to type is in [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md)** (Feishu §1, Slack §2; that doc covers both deployment paths — the secret names and the use of the request URL are identical).

**Changing your mind later**: update the stack with a different **What to install** value.

- `web` → `web+feishu`: creates the IM resources (~30 s), then do the two steps above.
- `web+feishu` → `web`: removes them. ⚠️ **Both IM DynamoDB tables (conversations and usage) go with them** — that's the group-conversation context and investigation job state, and it's gone for good.
- `web+feishu` → `web+slack`: removes the Feishu set, creates the Slack set. The Feishu HTTP API's address is **not** preserved — switching back gives you a new address, so you have to re-enter it in the Feishu console.
- **Credentials don't follow the stack**: those secrets are outside the stack, so they survive option changes and a `KeepData` delete. Only a delete with `TeardownMode=DeleteEverything` removes them too (see [§6](#6-deleting-the-stack)).

---

### 2.12 (Optional) Connect your own CUR data source

The **Optional: your own CUR data source** group on the parameters page — two parameters, **both empty by default = not enabled**:

| Parameter | What to put in it |
|---|---|
| `CostAgentMcpUrl` | The **Function URL** of your own cost-agent MCP Lambda (`https://<id>.lambda-url.<region>.on.aws`) |
| `CostAgentFunctionArn` | **The same Lambda's function ARN** |

This connects **someone else's CUR table** — a customer's, or several payers' (the TAM scenario) — at line-item granularity. It is not this account's own cost data: that's already on the FinOps page and needs neither parameter. Enabling it adds 4 CUR sheets to the FinOps page (cost trend / credit / extended support / Savings Plans) plus the ability to ask about that spend directly in chat.

⚠️ **Both or neither.** A Function URL does **not** contain the function ARN, and the invoke permission (`lambda:InvokeFunctionUrl`) can only be granted per resource — so filling in just the URL deploys a data source that *looks* installed and 403s on every call. The template therefore carries a parameter-validation rule (`CostAgentArnRequiredWithUrl`): half-filled is rejected **before the stack is created**, so you never end up with half a thing.

- **Leave them empty**: the capability doesn't exist, by design — the 4 sheets' navigation entries simply don't appear (no menu item that does nothing when clicked), and chat mounts no corresponding tools. Nothing else is affected.
- **Add it later**: update the stack with the two parameters filled in; no rebuild needed.
- **One step remains on your side**: that Lambda's **resource policy** must allow this stack's two roles (the BFF and the agent runtime) to invoke its Function URL — that's your own deployment, which the template can't touch.
- **If the MCP goes down it doesn't take the tool with it**: only those 4 dashboard sheets say "temporarily unavailable"; chat falls back to Cost Explorer and then to the AWS read-only API, and **tells you it switched sources** (different measure — don't reconcile against it blindly).

**How to deploy that Lambda, caveats about the 45 tools' measures, and the full degradation chain are in [DEPLOYMENT.en.md §14](DEPLOYMENT.en.md#14-customer-cur-dashboard--cost-agent-mcp-optional)** (that section covers both deployment paths).

---

## 3. What the stack creates

**68 resources** with the default parameters, all in your own account (3 more in us-east-1 — the web-search set; 5 fewer with deep investigation off; 3 more if you pick multi-account; **16 more if you pick an install option with IM**):

| Category | Resources |
|---|---|
| Frontend | S3 website bucket + CloudFront distribution + CloudWatch RUM; report downloads go through a second CloudFront distribution (with a CloudFront Function that only lets report paths through) |
| API | 1 Lambda (BFF) + Function URL (`AWS_IAM` auth, streaming) |
| Agent | 1 Bedrock AgentCore Runtime + 1 AgentCore Memory (session memory, see [§2.10](#210-session-memory-agentcore-memory)) |
| Sign-in | Cognito User Pool + Client + Identity Pool + 8 groups (roles) |
| Data | DynamoDB `notiops-config`, `notiops-web-chat`; 1 data bucket (reports etc.) |
| Deployment helper | 1 staging bucket (for the staged artifacts) + 1 inline Lambda + 2 custom resources |
| Permissions | 6 IAM roles + 5 inline policies (the AgentCore Memory execution role has **no policy at all** — it is just a shell for the service to trust) |
| Notifications inbox (see [§2.9](#29-notifications-inbox)) | **10 EventBridge rules** (5 ENABLED / 5 DISABLED) + 1 Lambda + its log group + 1 role (plus its policy) + 1 Lambda invoke permission = 15 |
| Deep investigation (on by default) | 1 DevOps Agent agent space (**with its operator app enabled automatically**) + 1 read-only association + 1 role assumed by DevOps Agent (plus its policy) + 1 operator app role = 5 |
| Web search (us-east-1 only) | 1 custom resource (creates the AgentCore gateway) + 1 gateway service role + 1 inline policy |
| Multi-account (optional) | 1 custom resource (creates the two member StackSets) + 2 inline policies |
| IM bot (optional, see [§2.11](#211-add-an-im-bot-feishulark-or-slack)) | 3 Lambdas (ingress / worker / progress refresh) + 3 log groups + 1 **API Gateway HTTP API** (a public entry point, see below; 4 resources counting its route / integration / stage) + 3 invoke permissions (HTTP API -> ingress, keep-alive rule -> ingress, progress rule -> progress) + 1 dependency layer + 2 DynamoDB tables (group conversations, usage) + 2 EventBridge rules (refreshes investigation progress every minute, pings the ingress every 4 minutes) + 1 role (plus its policy) = 20 |

**Cost, idle**: CloudFront, S3 and DynamoDB are pay-per-use, Lambda costs nothing when not invoked, and an idle AgentCore Runtime costs nothing — idle, this is cents of storage. The real cost is **Bedrock tokens when you ask questions**. Each installed release keeps ~**165 MB** in the staging bucket (~28 MB more with IM installed; ≈ $0.004/month in S3 Standard); upgrades don't purge old versions, see [§5](#5-upgrading). The IM set is likewise **free when idle** (three Lambdas that cost nothing uninvoked, two on-demand tables, and that per-minute progress rule only does real work while an investigation is running).

**Read-only by design**: every grant the agent gets is read-only, and there is no tool in the product that modifies your resources. The furthest it can go is **opening an AWS Support case**, and only after you confirm in the conversation.

---

## 4. Troubleshooting

### 4.1 The stack rolled back — find which resource failed

On the Events tab, find the **first** `CREATE_FAILED` (not the last). The two common ones:

| Symptom | Cause and fix |
|---|---|
| `StagerArtifacts` failed, logs show a timeout / connection error | The account has no internet egress and can't reach GitHub. Go to [§7](#7-no-internet-egress-use-a-private-s3-mirror). |
| `AgentRuntime` failed | The region may not support Bedrock AgentCore. Use us-east-1 / us-west-2. |
| `StagerOrgSetup` failed, mentioning `management account or a delegated administrator` | You picked `MultiAccount`, but this account is neither the organization management account nor a StackSets delegated administrator. Redeploy with `SingleAccount`, or use an account that qualifies. See [§2.6](#26-optional-multi-account-across-an-organization). |

Detailed logs are in the CloudWatch log group `/aws/lambda/notiops-stager` (substitute your stack name).

### 4.2 ⚠️ Before retrying a failed deploy, delete three retained resources

This is the easiest place to get stuck. To protect data, three resources carry `Retain`:

- DynamoDB table `notiops-config`
- DynamoDB table `notiops-web-chat`
- S3 bucket `notiops-data-<account-id>-<region>`

**They survive even a failed create that rolled back** (Events shows `DELETE_SKIPPED`). Retrying directly then hits `BucketAlreadyOwnedByYou` / table-already-exists. Correct order:

```
1. Delete the failed stack (wait for DELETE_COMPLETE)
2. Delete those two tables and that S3 bucket (empty the bucket first)
3. Create the stack again
```

(If a previous deployment already put data you want to keep in them, **don't** delete them — a new stack reuses them.)

### 4.3 The page is blank / 404

A new CloudFront distribution takes a few minutes to propagate. Wait 2–3 minutes and hard-refresh. Still broken: confirm the `ChatUrl` output is a full `https://xxx.cloudfront.net`, and check the website bucket contains `index.html`, `config.json` and `assets/`.

### 4.4 Sign-in works but questions fail

- `AccessDeniedException` mentioning `bedrock` → model access from §1.2 isn't enabled.
- An error naming a specific action (e.g. `rds:DescribeDBInstances`) → you set **Give the agent account-wide read-only access** to `No`. Either add that permission or update the stack back to `Yes`.

### 4.5 IM is installed, but the bot stays silent in the group

This is a **silent failure**, and it's almost always one of the two steps in [§2.11](#211-add-an-im-bot-feishulark-or-slack) left undone:

| Check this first | How to tell |
|---|---|
| Are the credentials complete | Does the secret exist in Secrets Manager, and does it have every key (Feishu needs all four)? The ingress function fails **on purpose** at cold start when a key is missing — better not to start at all than to expose a public entry point anyone can forge requests to. |
| Did you fill in the request URL | Feishu needs it in **two** places (event config + callback config), Slack in **three** (Events / Interactivity / Slash Commands) — the same URL each time. |
| The logs | ⚠️ Under one-click deployment the **log group names are CloudFormation-generated** (`<stack-name>-FeishuIngressLogs<hash>-<random>`); they do **not** start with `/aws/lambda/` and cannot be derived from the stack name (rationale and resolver in [IM_WEBHOOK_SETUP.en.md §1.5](IM_WEBHOOK_SETUP.en.md#15-verify)). To look one up: `aws cloudformation describe-stack-resources --stack-name <stack-name> --region <region> --query "StackResources[?starts_with(LogicalResourceId,'FeishuIngressLogs')].PhysicalResourceId" --output text` (use `FeishuWorkerLogs`, `SlackIngressLogs` / `SlackWorkerLogs`, or `ImProgressLogs` for the others). The **function** names, in contrast, are derivable: `<stack-name>-im-ingress-feishu` / `<stack-name>-im-worker-feishu` / `<stack-name>-im-progress`. The ingress function shows signature-verification failures — or no logs at all, which means the IM platform never called it, i.e. the URL isn't set correctly. |

The step-by-step checks and what each error means are in [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md).

### 4.6 Using the CLI instead of the console

You can, with two catches:

```bash
# The template is over 200 KB (it grows with the resource count each release), well past the
# 51,200-byte --template-body limit, so it must go via S3 + --template-url
aws s3 cp notiops-webchat.template.json s3://<your-bucket>/notiops-webchat.template.json
aws cloudformation create-stack --stack-name notiops \
  --template-url https://<your-bucket>.s3.<region>.amazonaws.com/notiops-webchat.template.json \
  --capabilities CAPABILITY_IAM \
  --parameters ParameterKey=AdminEmail,ParameterValue=you@example.com
# Multi-account: add both of these (either one alone does nothing, see §2.6)
#   ParameterKey=DeployMode,ParameterValue=MultiAccount \
#   ParameterKey=OrganizationId,ParameterValue=o-xxxxxxxxxx
# Add an IM bot (see §2.11): web / web+feishu / web+slack
#   ParameterKey=InstallOption,ParameterValue=web+feishu
```

Omitting `--capabilities CAPABILITY_IAM` is rejected outright (the stack contains IAM roles).

---

## 5. Upgrading

When a new release lands: **download the new template and update the existing stack** (don't create a second stack).

1. Download `notiops-webchat.template.json` from the new release.
2. CloudFormation → select your stack → **Update** → **Replace existing template** → **Upload a template file**.
3. Keep parameters on **Use existing value** (except what you actually want to change) → tick IAM → Submit.

**Measured: ~1 minute.** During the upgrade: new artifacts are staged (their S3 keys carry the release tag, so the old objects remain) → the frontend is republished and last version's stale files are pruned → CloudFront is invalidated (`/*`) → the AgentCore Runtime gets a new version **in place** (same ARN, no frontend config change).

An upgrade does **not**: re-send the invitation email, change the admin's email or password, touch existing settings in `config.json`, or clear your chat history.

**Rollback**: update again with the **older template** (artifacts are stored per tag, so the old objects are still there).

> **The staging bucket accumulates**: ~165 MB per installed release (~28 MB more with IM
> installed). To clean up, manually delete objects under `agent/<old-tag>/`,
> `frontend/<old-tag>/` and `im/<old-tag>/` in the staging bucket — **not the current
> release's**, or the next stack update won't find its code.

---

## 6. Deleting the stack

### 6.1 Decide what happens to your data

The `TeardownMode` parameter decides the fate of three things:

| | `KeepData` (default) | `DeleteEverything` |
|---|---|---|
| `notiops-config` table (settings) | **kept** | deleted |
| `notiops-web-chat` table (chat history, notifications) | **kept** | deleted |
| Data bucket `notiops-data-…` (exported reports etc.) | **kept** | deleted |
| Everything else (frontend, CloudFront, Lambda, agent, **Cognito user pool**, and with IM installed those 16 resources including both IM tables) | deleted | deleted |
| IM credentials (the `notiops/im-bot-feishu` etc. Secrets Manager secrets — outside the stack) | **kept** | deleted (unrecoverable) |

> ⚠️ **The Cognito user pool is deleted in both modes** — users and passwords are gone.
> `KeepData` preserves **data**, not accounts.

> ⚠️ **`KeepData` is not "keep it for next time"** — what it keeps will **block your next
> deployment**. Those names are fixed (`notiops-config` / `notiops-web-chat` /
> `notiops-data-…`), and CloudFormation runs a `NAME_CONFLICT_VALIDATION` pre-flight check
> before it creates anything: if a resource with that name already exists, **the whole stack
> fails** in about 9 seconds without creating a single resource (measured 2026-08-28; the error
> is `Resource of type 'AWS::DynamoDB::Table' with identifier 'notiops-config' already
> exists.`, and the console's Events tab only shows "Validation failed with 1 error(s)" — the
> detail is only visible via `aws cloudformation describe-events`).
> So `KeepData` is for **leaving the data in place so you can export it / keep it for
> forensics**, not for carrying it into a redeployment:
> - to **redeploy**: delete those three first (empty the bucket first), or just use
>   `DeleteEverything` as described in §6.2 from the start;
> - to **keep the data**: export it yourself before deleting (DynamoDB Export to S3 for the
>   tables, `aws s3 sync` for the bucket) and import it back once the new stack is up. The
>   stack has no way to adopt a pre-existing table.

### 6.2 ⚠️ To use `DeleteEverything`: update first, then delete

On delete, CloudFormation hands custom resources **the parameter values from the last successful deploy**, not what you'd like at deletion time. So "change TeardownMode in the delete dialog" isn't a thing. Do this instead:

```
1. Update the stack, changing only On stack delete → DeleteEverything (measured ~45 seconds)
2. Then delete the stack
```

Getting the order wrong fails silently: the stack goes away, the tables and bucket stay, and you think you cleaned up.

### 6.3 Delete

CloudFormation → select the stack → **Delete**. **Measured**: `KeepData` ~**3m10s**; `DeleteEverything` ~**6m47s** (the extra time is emptying and deleting the two buckets and two tables). Don't expect `DeleteEverything` to finish in three minutes.

During deletion the stack's deployment Lambda first **empties** the website and staging buckets (a non-empty bucket can't be deleted and would stall the whole delete), then honours `TeardownMode` for the two tables and the data bucket. Measured: **zero `DELETE_FAILED`** in both modes.

### 6.4 What's left behind (orphans), and whether to care

| Left behind | Why | Recommendation |
|---|---|---|
| Log group `/aws/vendedlogs/RUMService_<stack>-web-chat<hash>` | Created by CloudWatch RUM itself; not owned by the stack | **Fine to ignore**: measured at 0 bytes, expires after 30 days. To clean up, delete it in CloudWatch by its **full name** (don't bulk-delete by prefix) |
| The two tables + data bucket under `KeepData` | That is what `KeepData` **means** | Delete manually when you're done with them (empty the bucket first). **You must delete them before you can redeploy into this account** — see the second warning in §6.1 |
| CloudFront access logs, if you enabled them yourself | Not managed by this stack | As you like |
| **If you ever installed IM**: the `notiops/im-bot-feishu` / `notiops/slack-bot-token` / `notiops/slack-signing-secret` Secrets Manager secrets | They are not stack resources (the Feishu one is created on demand by the admin console, the two Slack ones by you), so `KeepData` leaves them alone | `DeleteEverything` **deletes them too** (unrecoverable). Under `KeepData`, delete them yourself if you want them gone; leave them and a reinstall reuses the same-named secrets |
| **In multi-account mode**: the `notiops-member-onboarding` / `notiops-member-devops-agent` StackSets, and Organizations trusted access for StackSets | **Deliberate.** (1) A StackSet can only be deleted once every stack instance is gone, and removing those wipes the cross-account roles in your member accounts — a cross-account destructive action shouldn't be triggered implicitly by deleting one stack. (2) Trusted access is an **organization-wide** switch; turning it off with our stack would break other people's StackSet deployments. | If you really want them gone: CloudFormation → StackSets → **Delete stacks from StackSet** (removes the instances), then delete the StackSet itself. Leave trusted access alone unless you're sure nobody else relies on it. |

**No other orphans**: the agent's log group, the BFF's log group, the notification handler's log group, the deployment Lambda's log group, IAM roles, the Cognito user pool, the RUM app monitor, the AgentCore Runtime, the website bucket and the staging bucket were all verified to go away with the stack. The agent space and association created for deep investigation also go away with it (they are ordinary stack resources). Same for the session-memory AgentCore Memory ([§2.10](#210-session-memory-agentcore-memory)) — an ordinary stack resource with **no** retention policy, deleted with the stack, taking the stored session messages with it (this one is what the template declares; unlike the list above, it has not yet been verified by an actual stack deletion). The web-search AgentCore gateway splits two ways: one **this stack created** is deleted with the stack; one it **reused** (a pre-existing `notiops-websearch-gw` in the account, e.g. from `setup.sh`) is left alone — deleting one stack shouldn't take down something another deployment path still uses.

---

## 7. No internet egress: use a private S3 mirror

If your account has no internet egress (or policy forbids pulling executable code from github.com), mirror the artifacts into an S3 bucket and point the stack at it. The bucket can be **fully private** (Block Public Access all on) — the deployment Lambda reads it with its own role over the S3 API, no internet required.

**One-time setup** (done once by someone with credentials; every account/team can then reuse the mirror):

```bash
# Download the artifacts from the release into a bucket in the SAME region you deploy to
aws s3 cp bff.zip        s3://my-mirror/notiops/v1.2.3/
aws s3 cp chat-dist.zip  s3://my-mirror/notiops/v1.2.3/
aws s3 cp web-notif.zip  s3://my-mirror/notiops/v1.2.3/
aws s3 cp agent-code.zip s3://my-mirror/notiops/v1.2.3/
# These two only if you're installing an IM bot (§2.11); a web-only stack never fetches them
aws s3 cp im-code.zip    s3://my-mirror/notiops/v1.2.3/
aws s3 cp im-layer.zip   s3://my-mirror/notiops/v1.2.3/
```

**Then set two parameters when creating the stack**:

| Parameter | Value |
|---|---|
| **Artifact base URL override** | `s3://my-mirror/notiops/v1.2.3` (**no** trailing slash; the template appends the filenames) |
| **Artifact mirror bucket name (s3:// only)** | `my-mirror` — the deployment Lambda is granted `s3:GetObject` on **that bucket only**, and nothing else |

Cross-account works too: a bucket policy allowing the deploying account to read is enough (`Code.S3Bucket` may be cross-account, but **must be in the same region**).

Integrity still holds: every artifact's SHA256 in the template was computed over the original release file, so tampered mirror content fails verification and the stack fails to create.

`https://` is also accepted (`https://host/path`), but that is a **plain unauthenticated GET** — the objects must be anonymously readable. For private setups use `s3://`.

---

## 8. Security notes worth knowing

1. **Read-only**: every grant the agent has is read-only, and no tool in the product modifies resources. The only outward action is opening a Support case, gated on your confirmation in the conversation.
2. **The endpoint is authenticated**: the BFF Function URL is `AWS_IAM` (SigV4) — even if the URL leaks, an unsigned request can't call it. Cognito identity checks sit on top of that.
3. **Code enters your account from the public internet.** That is what this path is. Two controls: (a) artifacts come only from a fixed tag of the `aws-samples/sample-notiops` release; (b) each artifact's SHA256 is baked into the template and verified on arrival — a mismatch deletes the uploaded object and fails the stack. If that premise doesn't work for you, use the private mirror in [§7](#7-no-internet-egress-use-a-private-s3-mirror), or use `setup.sh`.
4. **We never touch the admin password**: Cognito generates it and emails it to you. The deployment never passes, reads, prints or outputs it.
5. **Everything is done by your own credentials**: no account of ours, no bucket of ours, no role of ours is anywhere in this path.
6. **Installing IM adds one public entry point** ([§2.11](#211-add-an-im-bot-feishulark-or-slack)) — that **API Gateway HTTP API** has to be **unauthenticated**, because Feishu and Slack won't sign SigV4 for you (before 2026-09-01 this was a Lambda Function URL; why it changed, and the two alternatives that were ruled out, are in [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §4.1). Five boundaries: (a) **signature verification** (Feishu with the Encrypt Key + Verification Token, Slack with the signing secret; a missing key fails the cold start, so "misconfigured but still reachable" doesn't exist); (b) **two throttling layers** — the HTTP API stage caps at 50 req/s with a burst of 100 (anything above that gets a 429 straight from API Gateway and **never reaches Lambda**), and the ingress function additionally carries a **concurrency cap of 10**: together, the spend ceiling on a public unauthenticated entry point; (c) an optional **chat allowlist** (only messages from named groups take effect — see [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §3); (d) **idempotent de-duplication** (a redelivered event is processed once); (e) behind it is still the **same read-only agent** with no write permission at all — even a forged message gets, at worst, read-only information back. Credentials always live in Secrets Manager: never in environment variables, never printed to logs. The risks that remain are listed plainly in [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §4.3.

---

## 9. Next

- [USER_GUIDE.en.md](USER_GUIDE.en.md) — using the UI and its topics (cost, investigation, Support cases, Skills…)
- [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) — what to click on the Feishu/Slack side once you installed an IM bot ([§2.11](#211-add-an-im-bot-feishulark-or-slack))
- [DEPLOYMENT.en.md](DEPLOYMENT.en.md) — the full deployment, when you want scheduled inspection, proactive push into IM, and the inspection dashboard to have data
- [TECHNICAL_DESIGN.en.md](TECHNICAL_DESIGN.en.md) — architecture and design trade-offs
