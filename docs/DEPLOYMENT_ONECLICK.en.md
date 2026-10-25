# NotiOps — One-Click Deployment (CloudFormation, no local setup)

> ⚠️ **Disclaimer**: This is sample code, for non-production usage. You should work with your security and legal teams to meet your organizational security, regulatory and compliance requirements before deployment.

> 🌐 **Language**: [中文](DEPLOYMENT_ONECLICK.md) · [English](DEPLOYMENT_ONECLICK.en.md)
>
> **Audience**: anyone who wants to get the Web Chat console running and try it. You need **nothing installed locally** and **no IAM user / access keys**.
>
> **Time**: **~10 minutes** (the stack itself measured ~4.5 minutes).
>
> **See also**:
> - [DEPLOYMENT.en.md](DEPLOYMENT.en.md) — the full deployment guide (`setup.sh`: IM bots, scheduled inspection and its dashboard, CUR/Athena)
> - [USER_GUIDE.en.md](USER_GUIDE.en.md) — how to use it once deployed

---

## 0. Two deployment paths — this doc covers the second one

The repository ships **two** ways to deploy, with different scope. This document covers only the second.

| | **`setup.sh`** (full, see [DEPLOYMENT.en.md](DEPLOYMENT.en.md)) | **This doc: one-click** |
|---|---|---|
| What you need | git, Node, Python, uv, AWS CDK, plus deployment credentials (**no Docker/finch** — since 2026-09-03 / M2 the IM side ships as a Lambda Layer and builds no images) | **just a browser logged into the AWS console** |
| How you start | clone the repo → `./setup.sh` | download one template from the Release → upload it in the CloudFormation console |
| What gets deployed | Web Chat + IM bots (Feishu/Slack/DingTalk, several at once if you want) + daily inspection (including its dashboard in the web UI) + CUR/Athena FinOps source | **Web Chat** (chat UI + BFF + agent + a DevOps Agent space; multi-account optional) **plus one optional IM bot** (Feishu/Lark, Slack or DingTalk — see [§2.11](#211-add-an-im-bot-feishulark-slack-or-dingtalk)) **plus an optional CUR/Athena FinOps source** (built for you, or an existing one connected — see [§2.12](#212-optional-connect-your-own-cur-data-source)) |
| Good for | long-term use, IM notifications, scheduled inspection | trying it out / demos / just the read-only ops assistant in a browser (with the option of @-mentioning it in a group chat) |

**You can do both, in order**: deploy one-click to try it (tick the IM bot right there on the parameters page if you want one — see [§2.11](#211-add-an-im-bot-feishulark-slack-or-dingtalk)), then run `setup.sh` later when you want scheduled inspection (with its dashboard) and proactive push. ⚠️ In the same account and Region, though, the two paths use the same table and bucket names and cannot exist side by side: first delete this stack with `DeleteEverything` (its data does not carry over; see [§6](#6-deleting-the-stack)), or install `setup.sh` in another Region.

### 0.1 What one-click does **not** include

Better said up front than discovered later. These require `setup.sh`:

- **Proactive push into IM**: the daily ops notification and AWS Health events posted into a Feishu group — both come from the report pipeline that only `setup.sh` deploys, and they go to Feishu only (real-time alert pushes do not reach IM on either path in this release, see [DEPLOYMENT.en.md §7](DEPLOYMENT.en.md#7-enable--tune-push-mode)). The IM bot itself **can** be installed (see [§2.11](#211-add-an-im-bot-feishulark-slack-or-dingtalk) — you @-mention it, it answers), but that is **request/response only**. (The 10 signal sources **do** land in the in-browser Notifications inbox — see [§2.9](#29-notifications-inbox); only the IM leg is missing.)
- **More than one IM platform at a time**: one one-click stack installs exactly **one** platform (Feishu/Lark, Slack or DingTalk — pick one, see [§2.11](#211-add-an-im-bot-feishulark-slack-or-dingtalk)); running several side by side needs `setup.sh` (pick several at its IM-platform prompt, e.g. `1,2,3`, which becomes `-c enabledPlatforms=feishu,slack,dingtalk`).
- **Scheduled daily inspection** (idle-resource detection, cost-anomaly scanning) and its four Lambdas (`notiops-inspection-scheduler` / `-executor` / `-reconciler` / `-push`) plus the cost-anomaly scanner `notiops-cost-analyzer`.
- **The inspection dashboard** (sidebar **More → Inspection**: Findings → High Load / Idle & Cost;
  Settings → Scope / Thresholds & Schedule). The page code is part of chat-app and shared by both
  paths, but one-click creates neither the `notiops-inspection` table nor the four inspection Lambdas
  above, so on one-click the entry **does not appear at all** (rather than failing once you open it):
  `nav:inspection` declares `requiresEnv: INSPECTION_TABLE`, one-click leaves that variable empty, and
  the Inspection tab and all its sub-pages drop out of `/capabilities`; calling the `/inspection/*`
  API directly returns a plain `inspection_not_deployed`. So on one-click, **More** holds only the **Skills** /
  **Admin** items you are allowed to see, and an account allowed neither (by default, every preset
  role except admin and `role:developer`) sees no **More** at all — that is expected, not a broken
  deployment. The inspection dashboard needs `setup.sh`.
  (**The Skills management UI is not in this list** — one-click still creates the Skills bucket,
  so that page works.)
- **Cross-account scheduled inspection and event forwarding**: one-click *can* do **cross-account read-only troubleshooting / investigation / case creation** (`DeployMode=MultiAccount`, see [§2.6](#26-optional-multi-account-across-an-organization)), but the member-account **CloudWatch OAM Sink** and **cross-account event forwarding** (Health / DevOps Agent investigation events flowing back) are not part of this path — those need `setup.sh`.

(**DevOps Agent deep investigation**, **web search** and the **Notifications inbox** are *not* in this list — the stack creates all three for you, see [§2.7](#27-deep-investigation-aws-devops-agent), [§2.8](#28-web-search-agentcore-web-search) and [§2.9](#29-notifications-inbox). The **IM bot** is not in this list either — it's an option on the parameters page, see [§2.11](#211-add-an-im-bot-feishulark-slack-or-dingtalk). Nor is **CUR + Athena cost detail** (since v1.0.30): set `ProvisionCur` to `yes` on the parameters page and the stack creates the CUR and the official Athena integration for you (AWS takes up to 24 hours to deliver the first report; until then cost questions use Cost Explorer, and they switch over on their own once it is ready); if you already have a CUR, connect its Glue table instead (`CurTable`; the table must be in this stack's account and Region). Both are covered in [§2.12](#212-optional-connect-your-own-cur-data-source).)

---

## 1. Prerequisites (all three)

### 1.1 An AWS account and console permissions to create the stack

There are **two** separate permission stages. What actually blocks customers is almost always the first one (uploading the template), not the second (creating the stack).

#### (1) Uploading the template — the console's Create stack step

The console stores the template you upload in a bucket named `cf-templates-<random>-<region>` **inside your own account**. That is not an AWS-managed bucket — it is a resource in your account, so this step needs bucket-create and object-write permissions:

| Action | Resource | What it's for |
|---|---|---|
| `cloudformation:CreateUploadBucket` | `*` | Console-only API; creates the `cf-templates-*` bucket on first upload |
| `s3:CreateBucket` | `*` | Same — the bucket lands in your account |
| `s3:PutObject` | `*` | Writes the template JSON |
| `s3:GetObject` | `*` | CloudFormation reads it back |
| `s3:ListBucket` | `*` | Checks what's already in the bucket |

> **These five can only be `Resource: "*"`.** Don't narrow them to `arn:aws:s3:::cf-templates-*` — the random suffix is generated per account and region, so you cannot write it ahead of time, and `CreateUploadBucket` is console-only and supports `*` alone.
>
> **Missing `s3:PutObject` looks like this** (a real customer report):
> `User: arn:aws:iam::111122223333:user/alice is not authorized to perform: s3:PutObject on resource: "arn:aws:s3:::cf-templates-xxxxxxxx-us-east-1/2026-01-01T000000.000Zabc-notiops-webchat.template.json"`
>
> **You can avoid these five entirely**: upload the template to a bucket you already have, then on Create stack choose **Amazon S3 URL** instead of **Upload a template file** and paste the object URL. That path needs no new S3 permissions. The template is about 430 KB (it grows with the resource count each release), well under the 1 MB ceiling for the S3-URL route.

#### (2) Creating the stack — the resources are created **as you**

This template ships **no** CloudFormation service role (stack service role). CloudFormation does not switch identity: the template declares 156 resources (counting the ones that only get created for certain parameter values; the default parameters create 76 — see [§3](#3-what-the-stack-creates)), and every one that does get created is created using **your current IAM identity**, so your permissions are the ceiling on what this stack can build. The service scope (the counts are what the template declares):

| Service prefix | What the stack creates | Count |
|---|---|---|
| `cloudformation` | The stack itself (create / describe / rollback / delete) | 1 stack |
| `iam` | Roles + inline policies + one managed policy; **also `iam:PassRole`** — handing an execution role to Lambda / EventBridge / AgentCore is also done as you | 15 Role + 16 Policy + 1 ManagedPolicy |
| `lambda` | Functions, layers, invoke permissions, Function URLs | 15 Function + 2 Layer + 11 Permission + 2 Url |
| `logs` | Log groups; **plus `logs:PutResourcePolicy` (resource `*`)** because RUM writes to CloudWatch Logs | 15 LogGroup |
| `events` | Event rules: the 10 Notifications-inbox sources + the daily CUR dashboard warm-up; with IM also the investigation callback, progress polling and ingress keep-alive (one keep-alive rule per platform, only the chosen one is created); with `ProvisionCur=yes` also the CUR stage-2 schedule | 17 Rule |
| `dynamodb` | Config table, the web chat table (sessions, messages and the Notifications inbox); with IM also the group-conversation and usage tables | 4 Table |
| `s3` | Site bucket, artifact (staging) bucket, data bucket (Skills, reports) + bucket policies; with `CurTable` set or `ProvisionCur=yes` also the cost MCP's Athena query-results bucket (same service as (1), different objects) | 4 Bucket + 4 BucketPolicy |
| `cloudfront` | Site distributions + a function + OAI / OAC | 2 Distribution + 1 Function + 2 access identities |
| `cognito-idp` | User pool, app client, 8 permission groups | 1 UserPool + 1 Client + 8 Group |
| `cognito-identity` | Identity pools + role attachments (how the frontend gets temporary credentials to sign SigV4) | 2 IdentityPool + 2 RoleAttachment |
| `apigateway` | The IM bot's public entry point: one HTTP API per platform, only the chosen one is created (HTTP API also uses the `apigateway:` prefix) | 3 Api + 3 Integration + 3 Route + 3 Stage |
| `sqs` | Dead-letter queue + queue policy for the deep-investigation callback (which delivers group-chat investigation reports back to the group); created only with IM | 1 Queue + 1 QueuePolicy |
| `rum` | Frontend real-user monitoring | 1 AppMonitor |
| `bedrock-agentcore` | Agent runtime + session memory | 1 Runtime + 1 Memory |
| `aidevops` | The DevOps Agent space and its association (**the IAM prefix is `aidevops:`**, not `devops-agent:`) | 1 AgentSpace + 1 Association |
| `athena` | The cost MCP's dedicated workgroup (the per-query scan cap lives on it); created only when `CurTable` is set or `ProvisionCur=yes` | 1 WorkGroup |

Services your identity does **not** need: `organizations` / `securityhub` / `cur` / `oam` / `glue`. Those are only used by the multi-account, security-posture-dashboard and billing-detail features, and they are all called by functions inside the stack under **their own execution roles** (`StagerOrgSetup` and the StackSets it rolls out to member accounts for multi-account, the CUR stage-1 / stage-2 functions for creating the CUR, and otherwise the BFF, the agent and the cost MCP) — not as you. (This differs from `setup.sh`; see [DEPLOYMENT.en.md §2.4](DEPLOYMENT.en.md#24-iam-deployment-permissions).)

> ⚠️ **Be clear about one thing: on this path the installer is effectively an account administrator.**
> `iam:CreateRole` + `iam:PutRolePolicy` + `iam:AttachRolePolicy` in the table above can only be scoped to `*` (role names carry CloudFormation-generated suffixes), and that combination is equivalent to privilege escalation — with it you can mint yourself an admin role. So "least privilege" here can only mean **narrowing the service scope** (the 16 services above instead of `*`); it can **never** mean "let a non-administrator install this".
> If your policy forbids holding that permission long-term: install with a temporary identity and then retire it — **using NotiOps day to day requires no AWS permissions at all**; users only sign in to Cognito.

> You must tick **"I acknowledge that AWS CloudFormation might create IAM resources"** —
> the stack creates roles for the agent and the BFF.

### 1.2 Pick a region, and enable Bedrock model access there

The agent runs on **Amazon Bedrock**. **Before creating the stack**, go to the Bedrock console → Model access and confirm the model you want shows **Access granted** in that region.

- **The default model is Moonshot Kimi K3** (`global.moonshotai.kimi-k3`) — grant access to that one or the deployment is unusable.
- Want a different model (Grok 4.7, GLM 5.3, Claude Sonnet 5.5 / Opus 5.5, DeepSeek, GPT-5.6 / GPT-6 Sol)? Grant those too; users can switch per conversation from the model picker at the right end of the composer toolbar. Note: Claude Sonnet 5.5 / Opus 5.5 and GPT-6 Sol need an AWS Marketplace agreement accepted **once per account** -- in some accounts Sonnet 5 works while 5.5 is not enabled yet. The simplest fix is to accept the 5.5 agreement once in that account. Otherwise, re-enable `claude-sonnet-5` / `claude-opus-5` on the **More → Admin → Models** page -- **that fixes Web only**. In IM the aliases `claude` / `opus` belong to the 5.5 entries, so with IM installed also disable `claude-sonnet-5-5` / `claude-opus-5-5` and tell people in your groups to switch with `@bot model claude-sonnet-5` / `@bot model claude-opus-5` (conversations already set to `claude` / `opus` then fall back to the default model). If GPT-6 Sol (the IM alias `gpt_sol` belongs to it) is not enabled in that account, either accept its agreement once there, or disable `gpt-6-sol` on the same page (conversations already set to `gpt_sol` then fall back to the default model).
- **us-east-1** or **us-west-2** recommended (best Bedrock AgentCore and model coverage).
- Without model access the stack still **succeeds**, the site loads and login works — but every question fails with `AccessDeniedException`. This is the most common "it deployed but doesn't work".

### 1.3 The account must be able to reach GitHub (or bring your own mirror)

During deployment, a Lambda inside the stack downloads the artifacts (frontend, BFF, notification producer, agent code — these four always; the IM bot's two, the cost MCP's two and the CUR-creation one only if you opted into that feature, see [§2.1](#21-download-the-template)) from the **GitHub Release** and stages them into your own S3 bucket. Lambda is not in a VPC here and uses AWS-managed egress, so **most accounts satisfy this out of the box**.

If your enterprise egress allowlist does **not** include github.com, you don't have to abandon this path — see [§7 No internet egress: use a private S3 mirror](#7-no-internet-egress-use-a-private-s3-mirror).

---

## 2. Deploy (5 steps)

### 2.1 Download the template

From the [Releases](https://github.com/aws-samples/sample-notiops/releases) page, download from the latest release:

```
notiops-webchat.template.json
```

The same release also has nine artifacts (`bff.zip` / `chat-dist.zip` / `web-notif.zip` / `agent-code.zip` / `im-code.zip` / `im-layer.zip` / `cost-mcp-code.zip` / `cost-mcp-layer.zip` / `cur-provisioner.zip`) — **you don't need to download those**; the template makes your account fetch them. Their SHA256 digests are baked into the template and verified on arrival; a mismatch fails the stack.

> The last five are **downloaded on demand**: the two `im-*.zip` files only if you pick an install option that includes IM ([§2.11](#211-add-an-im-bot-feishulark-slack-or-dingtalk)); the two `cost-mcp-*.zip` files only if the stack deploys its own cost MCP for you (`CurTable` set, or `ProvisionCur=yes` — pointing `CostAgentMcpUrl` at an MCP you already run, [§2.12](#212-optional-connect-your-own-cur-data-source), does not count); `cur-provisioner.zip` only if `ProvisionCur=yes`. With every default left alone (web only, `CurTable` empty, `ProvisionCur=no`) all five are skipped, so you don't pay transfer or storage for them.

> **Why isn't there a one-click "Launch Stack" link?** CloudFormation's `TemplateURL` only accepts
> objects in S3, not GitHub URLs. So this costs you two extra clicks (download + upload) and buys
> you the fact that **we host nothing**: the artifacts live only on the GitHub Release, and every
> step that puts code into your account is driven by your own credentials.

### 2.2 Upload it in the CloudFormation console

1. Check the **region** selector top-right matches what you picked in §1.2.
2. **CloudFormation** → **Create stack** → **With new resources (standard)**.
3. **Choose an existing template** → **Upload a template file** → pick `notiops-webchat.template.json` → **Next**.
   (The console stores the template in a `cf-templates-<random>-<region>` bucket **in your own account** — it creates that bucket for you, but **using your permissions**, so you need the five actions in §1.1 (1). If you don't have them, use **Amazon S3 URL** instead; see [§1.1](#11-an-aws-account-and-console-permissions-to-create-the-stack).)

### 2.3 Fill in the parameters

**Stack name**: use `notiops` (the rest of this doc assumes it). Another name works too — the DynamoDB tables are always named `notiops-config` / `notiops-web-chat`, independent of the stack name.

Exactly **one parameter is required**:

| Parameter | What it does |
|---|---|
| **Administrator email** | Your email. After the stack completes, Cognito emails you the **sign-in URL (ChatUrl) + username + temporary password**. It must be a real mailbox — **this is the only way in**. |

Everything else has a safe default. For a first deployment, **leave them all alone**:

| Parameter | Default | When you'd change it |
|---|---|---|
| **What to install** | `web` | A four-way dropdown: `web` (just the in-browser chat UI) / `web+feishu` (plus a Feishu/Lark bot) / `web+slack` (plus a Slack bot) / `web+dingtalk` (plus a DingTalk bot). **All four install web** — IM is an add-on, not a replacement. Picking an IM option leaves a few steps to do on the IM platform side, see [§2.11](#211-add-an-im-bot-feishulark-slack-or-dingtalk). **You can change it after deploying** (update the stack with a different value — see §2.11). |
| **Give the agent account-wide read-only access?** | `Yes` | `Yes` attaches the AWS-managed `ReadOnlyAccess` policy so the agent can answer questions about any resource in the account. `No` restricts it to the explicit read-only grants (cost, logs, metrics, RDS/EC2 describe); some questions then fail with a message naming the missing action. **Neither option grants any write permission.** |
| **CORS allowed origins** | `*` | The endpoint is already `AWS_IAM` (SigV4) authenticated, so `*` is not a privilege hole. For defense in depth, update the stack after the first deploy and set this to the `ChatUrl` output. |
| **IM chat/channel allow list (optional)** | empty | Only meaningful once you installed IM ([§2.11](#211-add-an-im-bot-feishulark-slack-or-dingtalk)); with web only you can ignore it entirely. A comma-separated list of Feishu chat ids (`oc_...`), Slack channel ids (`C...`) or DingTalk `conversationId`s (@-mention the bot once, then take it out of the worker log), **no spaces**; empty means no restriction — the bot answers in every group it is invited to. All three platforms share this one parameter. It is one of the defense-in-depth boundaries on the IM entry point (boundary (c) in [§8](#8-security-notes-worth-knowing)): a message from a chat outside the list is dropped **before any model call** — Feishu/Slack are stopped in the ingress function (which holds even if signature verification were bypassed), while DingTalk's `conversationId` only becomes readable **after** signature verification, so its check lands one layer later, in the worker. **The normal rhythm is: deploy with it empty → create the group and take its chat id → then update the stack with that id**, which is why it sits in the `Security` group and not among the required parameters. Equivalent to `imAllowedChatIds` on the `setup.sh` path (there it goes into the `context` block of `infra/cdk.json`, see [IM_WEBHOOK_SETUP.en.md §4](IM_WEBHOOK_SETUP.en.md#4-chat-allowlist-optional-all-three-platforms)). |
| **On stack delete** | `KeepData` | Decides what happens to your data when the stack is deleted. See [§6](#6-deleting-the-stack) — **there is a gotcha; read it before you delete**. |
| **Deployment mode** | `SingleAccount` | Pick `MultiAccount` (and fill in the org id below) to let it also see **other** accounts in your organization. `MultiAccount` requires this account to be the **AWS Organizations management account** or a registered **StackSets delegated administrator** member account (auto-detected, no parameter to set) — run the commands in [§2.6.1](#261-hard-prerequisite-management-account-or-a-stacksets-delegated-administrator) first to confirm. If the account doesn't qualify, the stack fails within the first minute and tells you what to do. |
| **AWS Organizations id (MultiAccount only)** | empty | Only needed with `MultiAccount` (starts with `o-`). **Half a choice does nothing**: `MultiAccount` with an empty org id stays single-account, and the `DeployModeStatus` output says so. Getting the id **wrong** — a valid org id that isn't this account's — is caught by the in-stack preflight (otherwise it gets baked into the member trust policy and every account onboarding afterwards fails with AccessDenied, with nothing on screen pointing at the id). |
| **Enable AWS DevOps Agent features (deep investigation, DevOps Chat)?** | `Yes` | One switch, **four** capabilities — see [§2.7](#27-deep-investigation-aws-devops-agent). An idle agent space costs nothing, which is why it defaults to on; pick `No` if you don't want it (all four are then greyed out). |
| The **Optional: your own CUR data source** group | empty / `no` | Only when you want line-item cost analysis: `ProvisionCur=yes` (shown as **Let NotiOps create the CUR for you?**) has the stack create the CUR for you; if you already have a CUR, fill in `CurTable` + `CurBucketName` (table and bucket must be in this stack's account and Region); if you already run your own cost-agent MCP, fill in `CostAgentMcpUrl` + `CostAgentFunctionArn`. Pick only one of the three — see [§2.12](#212-optional-connect-your-own-cur-data-source). `CurRoleArn` (a CUR in another account) is not supported yet; leave it empty. |
| **Artifact base URL override** / **Artifact mirror bucket name (s3:// only)** | empty | Only when you can't reach GitHub — see [§7](#7-no-internet-egress-use-a-private-s3-mirror). |

### 2.4 Acknowledge IAM, create

**Next** → on the final page tick **"I acknowledge that AWS CloudFormation might create IAM resources"** → **Submit**.

**Measured: about 4.5 minutes** (two independent runs: 4m16s / 4m25s, us-east-1, with the default web-only option). You'll see the stack waiting on two `Custom::NotiOpsStager…` resources — that's it staging ~165 MB of artifacts from GitHub into your S3 bucket, unpacking the frontend, writing runtime config, and creating the admin user. An install option that includes IM also stages the two IM artifacts and creates 4 more Lambdas (ingress / worker / progress refresh / investigation callback; tens of seconds).

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
| **FeishuWebhookUrl** | Present only with `web+feishu`: the request URL to paste into the Feishu open platform ([§2.11](#211-add-an-im-bot-feishulark-slack-or-dingtalk)). |
| **SlackWebhookUrl** | Present only with `web+slack`: the request URL to paste into all three places in your Slack app ([§2.11](#211-add-an-im-bot-feishulark-slack-or-dingtalk)). |
| **DingtalkWebhookUrl** | Present only with `web+dingtalk`: the message-receive address to paste into the DingTalk open platform, under **Bot → message receive mode → HTTP mode** ([§2.11](#211-add-an-im-bot-feishulark-slack-or-dingtalk)). |
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

#### 2.6.1 Hard prerequisite: management account, or a StackSets delegated administrator

> `MultiAccount` accepts **two** deploying identities — either one is enough:
> 1. the **AWS Organizations management account (payer)**; or
> 2. a member (linked) account that the management account has registered as a **CloudFormation StackSets delegated administrator** — how to register it is in [2.6.2](#262-deploying-from-a-member-account-register-a-stacksets-delegated-administrator).
>
> **No parameter distinguishes the two** — the stack detects it. If neither holds, the stack fails **within the first minute** and the failure reason hands you the register command and the management account id — it does not build a hundred resources first and then roll all of them back.

**Run these before you create the stack.** A few seconds tells you whether this account qualifies:

```bash
aws organizations describe-organization \
  --query 'Organization.[Id,MasterAccountId]' --output text
aws sts get-caller-identity --query Account --output text
```

- Second **column** of the first command (`MasterAccountId`) == output of the second ⇒ this is the management account; `MultiAccount` is fine.
- They **differ** ⇒ this is a member account. Run one more command to see whether it is already a StackSets delegated administrator:

  ```bash
  aws organizations list-delegated-administrators \
    --service-principal member.org.stacksets.cloudformation.amazonaws.com \
    --query 'DelegatedAdministrators[].Id' --output text
  ```

  This account's id **is** in the output ⇒ `MultiAccount` is fine. It is not ⇒ three ways forward: register it per [2.6.2](#262-deploying-from-a-member-account-register-a-stacksets-delegated-administrator), run this template **in the management account** instead, or pick `SingleAccount` for now (web / IM / deep investigation / case creation all work exactly the same; you just get no one-click onboarding — accounts added through "Manual onboarding" can still be investigated on the web with "Deep Dive" / "DevOps Chat", see [DEPLOYMENT.en.md §0.1.2](DEPLOYMENT.en.md#012-deploy-mode-single-account-default-vs-multi-account---multi-account); "Generate link" first needs the template upload described in the 🔴 note below).
  ⚠️ That command **must** pass `--service-principal`. Without it you get the delegated administrators of **every** service (GuardDuty / Config / Security Hub …). Those accounts also hold Organizations read-only permissions but **cannot** operate StackSets — judging from that list gives you a "should work" that turns into `AccessDenied` at StackSet creation time.
- First command says `AWSOrganizationsNotInUseException` ⇒ this account is not in an organization at all; `SingleAccount` is the only option.
- First command says `AccessDeniedException` ⇒ almost always a service control policy blocking `organizations:DescribeOrganization`. Until that is lifted, the stack's own check cannot read it either, so it will not get through.

> 🔴 **One hard limit that has nothing to do with which identity you use**: CloudFormation **never** deploys a service-managed StackSet into the **organization management account itself** — even if you target the OU it sits in, `CreateStackInstances` returns SUCCEEDED and creates nothing (a silent fake success). In practice only a **delegated-administrator deployment** runs into it (when you deploy from the management account itself, it is the deploy account and there is nothing to do): the management account is an ordinary row on **More → Admin → Accounts** in the web UI, but has no one-click onboarding button. To let NotiOps query it, use **"Manual onboarding" alone** on the same page: "Generate link" → deploy that stack while signed in to the management account → paste the Stack Outputs back → "Test connection" → "Save & activate"; that stack creates the cross-account collection role as well (read-only, plus Support-case open / reply / resolve by default, controlled by the member template parameter `EnableSupportCaseWrite`).
>
> - **Do not** also deploy [`infra/member-account-onboarding.yaml`](../infra/member-account-onboarding.yaml) by hand: it creates a collection role with the same name (`notiops-idle-detection-role-<deploy-account-id>`), so deploying both ends in `EntityAlreadyExists` and a stack rollback. If it is already deployed in the management account, set `CreateCollectionRole` to `no` on the quick-create page, and if that stack forwards events (its `DevOpsEventBusArn` parameter is set), also clear `DevOpsEventBusArn` on the same page — the two stacks name their forwarding rules differently, so nothing fails, but both would forward the same investigation events.
> - ⚠️ A one-click deployment does **not** put the template that "Generate link" needs into the data bucket; until you upload it, "Generate link" only returns `template not found` (for every account, not just this one). In the deploy account, upload [`infra/member-devops-agent.yaml`](../infra/member-devops-agent.yaml) from the same release as your stack (see the `InstalledRelease` output):
>
>   ```bash
>   aws s3 cp member-devops-agent.yaml \
>     s3://notiops-data-<account-id>-<region>/onboarding-templates/member-devops-agent.yaml
>   ```

**The org id is the first column** of the first command (starts with `o-`). Getting it wrong fails in a particularly unhelpful way: it gets baked into the member-account trust policy as `aws:PrincipalOrgID`, so every subsequent member-account onboarding returns `AccessDenied` with nothing on screen pointing at a mistyped id. That's why the stack's preflight **also cross-checks** the id you typed against the organization this account really belongs to, and refuses with the correct value if they differ.

**Both fields are required.** Picking `MultiAccount` while leaving the org id empty still **deploys successfully but stays single-account** — deliberately: the org id is the `aws:PrincipalOrgID` condition that closes off the cross-account trust policy. Without it, the member-account role would merely trust the system account's root with no organization boundary, which is worse than not enabling it. The `DeployModeStatus` output spells this out.

#### 2.6.2 Deploying from a member account: register a StackSets delegated administrator

In many organizations the management account is kept clean — no workloads, changes go through a separate approval path. There, running NotiOps in a member account and delegating only the *rolling out member-account roles* part to it is far more realistic than pushing the whole web/IM base stack into the management account.

**One-time action, run in the management account** (replace `<member-account-id>` with the account you intend to deploy NotiOps into; official steps: [Register a delegated administrator member account](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/stacksets-orgs-delegated-admin.html)):

```bash
aws organizations register-delegated-administrator \
  --service-principal member.org.stacksets.cloudformation.amazonaws.com \
  --account-id <member-account-id>
```

Verify (from the management account, or from that member account):

```bash
aws organizations list-delegated-administrators \
  --service-principal member.org.stacksets.cloudformation.amazonaws.com \
  --query 'DelegatedAdministrators[].[Id,Status]' --output text
```

The reverse is `aws organizations deregister-delegated-administrator` (same two parameters).

Once registered, create this template in that member account and pick `MultiAccount` — **no extra parameters**. The stack's preflight runs `DescribeOrganization` → `ListDelegatedAdministrators` (filtered by the service principal above), recognizes this identity, and then carries `CallAs=DELEGATED_ADMIN` through every StackSets call (creating/updating both StackSets, rolling out instances, and the nine runtime StackSets calls the BFF behind the web Admin page makes).

**Four things to know before taking this path:**

1. ⚠️ **A delegated administrator has full deployment permissions across the whole organization.** AWS states plainly that the management account **cannot** scope a delegated administrator down to specific OUs or operations. Once registered, this member account can deploy StackSets into **any** account in the organization — not just NotiOps' two. That is the AWS StackSets model, not a NotiOps implementation choice.
2. **Trusted access must already be on, enabled by the management account.** Registering a delegated administrator requires it, and the two APIs that turn it on — `enable-aws-service-access` and `activate-organizations-access` — are **management-account only**. So on this path the stack does **not** try to enable it (it cannot); it only **verifies** with `describe-organizations-access --call-as DELEGATED_ADMIN`, and if it is off, it fails and hands you both commands to run in the management account. See [§2.6.3](#263-trusted-access-both-halves-are-required).
3. **An organization can register at most five StackSets delegated administrators at a time** (an AWS limit, see the official page above; the limit is per service — other services have their own).
4. **The StackSet entities live in the management account**, even when a delegated administrator created them. So `notiops-member-onboarding` / `notiops-member-devops-agent` show up in the management account's CloudFormation console and **not** in the deploying account's (to see them there you must pass `--call-as DELEGATED_ADMIN`). `teardown.sh` / `TeardownMode` pass that flag too, so nothing gets silently skipped at delete time.

#### 2.6.3 Trusted access: both halves are required

A service-managed StackSet requires **trusted access** between CloudFormation and Organizations, and that comes in **two halves** — neither is optional:

| Half | Command | Symptom when missing |
|---|---|---|
| Organizations side | `aws organizations enable-aws-service-access --service-principal member.org.stacksets.cloudformation.amazonaws.com` | — |
| CloudFormation side | `aws cloudformation activate-organizations-access --region <your region>` | `CreateStackSet` fails with `ValidationError: You must enable organizations access to operate a service managed stack set` |

**When you deploy in the management account, the stack turns on both halves for you** (during the preflight phase, and only when `MultiAccount` is selected), then **verifies** with `describe-organizations-access` that the status really is `ENABLED` before continuing. So normally you do nothing.

**When you deploy from a delegated administrator (member account), the stack only verifies — it does not try to enable.** Both commands above are management-account only; retrying them in a member account will never work. Skipping is deliberate rather than "call it and swallow the error": the latter leaves an `AccessDenied` in the deployment log and makes people believe the script already turned it on, when the only correct action is to go **back to the management account** and run those two commands. The verification passes `--call-as DELEGATED_ADMIN` (without it CloudFormation interprets the call as `SELF` and reads **this account's** namespace, where that switch does not exist on this path ⇒ always `DISABLED` ⇒ a perfectly qualified environment gets rejected).

If something like an SCP does block the stack from doing it, the failure reason hands you both commands verbatim (with your region filled in) — run them in the management account and update the stack. The most misleading part here: **the Organizations half often already lists that service principal**, so it looks enabled, while the CloudFormation half is still `DISABLED` — and the `ValidationError` AWS returns says nothing about `activate-organizations-access`.

**What you additionally get**: the stack creates two StackSets (`notiops-member-onboarding`, `notiops-member-devops-agent`) and — when deployed in the management account — enables Organizations trusted access for StackSets. ⚠️ Service-managed StackSets **always live in the organization management account**, even when a delegated administrator created them, so when you deploy from a member account these two will not appear in the deploying account's CloudFormation console. You then onboard member accounts one at a time from **More → Admin → Accounts** in the web UI (each member account gets a cross-account collection role — read-only, plus Support-case open / reply / resolve by default, controlled by the member template parameter `EnableSupportCaseWrite` — plus a deep-investigation trigger role). After that you can switch accounts in the chat UI for read-only troubleshooting, deep investigation, and case creation.

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

**No parameters, the stack sets it up.** The inbox behind the first left-nav item is fed by **10 EventBridge rules** → one Lambda (`notiops-web-notif-handler`, normalizes + dedups: the same event is recorded once per 5 minutes, Trusted Advisor once per 24 hours) → the `notiops-web-chat` table. The frontend polls every **60s**, so latency is up to about a minute; the red dot counts **unread only**.

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

### 2.11 Add an IM bot (Feishu/Lark, Slack or DingTalk)

That **What to install** dropdown in the first parameter group:

| Option | What you get |
|---|---|
| `web` (default) | Just the chat UI in the browser. |
| `web+feishu` | Web Chat **plus** a Feishu/Lark bot: @-mention it in a group, or DM it. |
| `web+slack` | Web Chat **plus** a Slack bot: the `/notiops` slash command, @-mentions, DMs. |
| `web+dingtalk` | Web Chat **plus** a DingTalk bot: @-mention it in a group (nothing to register for slash commands — DingTalk has no command registry the way Slack does). |

**All four options install web** — IM is an add-on, not a replacement. One stack installs **one** IM platform; if you want several at once, use `setup.sh` from [DEPLOYMENT.en.md](DEPLOYMENT.en.md) (pick several at its IM-platform prompt, e.g. `1,2,3`, which becomes `-c enabledPlatforms=feishu,slack,dingtalk`).

**IM and the web UI are the same backend**: the same read-only AWS DevOps Agent, the same Skills, the same config table. So whatever you ask in the browser (cost, investigations, Support cases) gives the same answer in a group chat.

**Where DingTalk differs from the other two, stated plainly**: the capabilities (read-only inspection, deep investigation, case creation, Skills) and the command entry points (`/devops`, `/investigate`, `/case`, `/model`, …) are identical on all three platforms, but DingTalk offers fewer platform primitives, so the same thing looks different there. This is DingTalk's limitation, not a cut-down version of this deployment path:

- **Actions that need confirming are completed by replying, not by clicking a button**: DingTalk card buttons can only open a link — there is no "click posts back to the server" channel — so a confirmation-bearing action like case creation is **a reply with a keyword** (and `/case` cannot pop a form either; it hands you a copyable plain-text template instead).
- **Progress is appended, not updated in place**: DingTalk has no API to edit an already-sent message, so there is no self-updating progress card like on Feishu/Slack; long tasks post **at most two** appended progress messages.
- **The bot won't react to your message**: the instant acknowledgement when it picks up a command is a **text receipt**, not a 👀 reaction.
- **There is only one place to paste the message-receive address** (Feishu has two, Slack three), but DingTalk **validates nothing when you save it**: one wrong character in the address and credentials-not-written-yet look exactly the same — the bot just says nothing. So on DingTalk the way in to troubleshooting is the logs, see [§4.5](#45-im-is-installed-but-the-bot-stays-silent-in-the-group).

**By default it doesn't burn tokens**: every incoming message first goes through deterministic routing (regex + keywords, in both English and Chinese); anything that matches "look at resources / start an investigation / check progress / switch model / switch language" calls the API directly, and chat defaults to `/agent devops`, which the DevOps Agent answers directly. In that mode the NotiOps side spends **zero tokens**; only the **case flow** (turning your description into case text) actually calls the model. **That changes once someone sends `/agent notiops`**: from then on every question is answered by the NotiOps agent (the same AgentCore Runtime the web chat uses, with the narrow `im-chat` tool set), and that **does** consume Bedrock tokens. The switch applies per conversation — anyone in a group can flip it and the whole group follows; see the `/agent` row in [IM_WEBHOOK_SETUP.en.md §2.4](IM_WEBHOOK_SETUP.en.md#24-slash-commands).

**A deep investigation started from a group chat delivers its report back to that group**: when the investigation finishes (usually a few minutes), a callback function in the stack writes the HTML report under the `investigations/` prefix of the data bucket and posts a card to the group carrying a **time-limited public download link** — whoever reads the report does not need access to this AWS account. The link is an **S3 presigned URL** that the callback function signs with its own **temporary credentials** (not CloudFront: the stack's report CloudFront distribution only serves `reports/`, and investigation reports live under `investigations/`). Such a link cannot outlive the credentials that signed it: it stops working when they expire, at most about 12 hours later, not 7 days. Download the report if you need to keep it.

> ⚠️ This path is **asynchronous** (EventBridge → Lambda), so when it breaks it does so **without any error**: the progress card still reaches 100% (a different function draws that by polling task state) and then the report simply never arrives. On DingTalk there is no such card (progress is appended messages), so the symptom reads "the last progress message arrived, the report card never did" — the checks are the same. If that happens, check in this order: does `aws lambda get-function --function-name <stack-name>-devops-callback` exist → does its log group (a CFN-generated random name; resolve it by the logical-ID prefix `DevOpsCallbackLogs`, same command shape as the table in [§4](#4-troubleshooting)) contain `account_not_configured` → does `aws s3 ls s3://<data-bucket>/investigations/` hold an object for this investigation. If all three are fine and it still doesn't arrive, look at that function's dead-letter queue.

**Two steps are left to you after deploying**, and the bot stays silent until both are done (the `ImNextSteps` output reminds you too):

1. **Put credentials in Secrets Manager** — the bot needs keys to verify signatures and to reply.
   - **Feishu/Lark**: `notiops/im-bot-feishu`, four keys: `app_id` / `app_secret` / `encrypt_key` / `verification_token`.
     **Easiest path is the web UI**: sign in and go to **More → Admin → IM Integration** in the left nav — all four credentials sit on one form and Save writes them into this secret, so you need no CLI and no extra credentials. That page also carries the four-step summary of the Feishu-side work and a "View the detailed setup steps" side panel.
   - **Slack**: two secrets, `notiops/slack-bot-token` (starts with `xoxb-`) and `notiops/slack-signing-secret`, each holding a **plain string** (not JSON — the data plane uses the whole SecretString as the value). **The web UI works here too**: **More → Admin → IM Integration → the Slack tab**, two fields and Save; the backend creates the secret for you if it doesn't exist, and that page has the same "View the detailed setup steps" drawer. ⚠️ **Both** Slack values are credentials (there is no plainly-visible field to cross-check against, like Feishu's `app_id` or DingTalk's `app_key`), so the only way to confirm *which* app you configured is that page's Test credentials button — it reports your workspace and bot name back, and **names every missing bot token scope**.
   - **DingTalk**: `notiops/im-bot-dingtalk`, two keys: `app_key` / `app_secret` (the AppKey / AppSecret from "Credentials and basic info" on the DingTalk open platform). **The web UI works here too**: **More → Admin → IM Integration → the DingTalk tab**, two fields and Save; the backend creates the secret for you if it doesn't exist, and that page has the same "View the detailed setup steps" drawer in its top-right corner. ⚠️ DingTalk has **only this one** secret: the AppSecret both fetches access tokens and verifies the `sign` on inbound requests, so there is no equivalent of Feishu's `encrypt_key` / `verification_token` — the two missing fields on the form are **deliberate**.
2. **Paste the request URL back into the IM platform** — that's the `FeishuWebhookUrl` / `SlackWebhookUrl` / `DingtalkWebhookUrl` output.

> ⚠️ **Don't reverse the order**: credentials first, request URL second. Feishu and Slack fire a verification request the **moment** you save the request URL; with no credentials yet the ingress function fails outright, and what you see on the IM platform is "verification failed" — which looks like a wrong URL.
> DingTalk needs the order kept even more: it does **not** validate at all when you save the address — nothing turns green, nothing errors — and the only symptom of missing credentials is a bot that says nothing (also remember to go back to "Version management and release" and **publish a version again** after changing the message-receive mode).

**Where to click and what to type is in [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md)** (Feishu §1, Slack §2, DingTalk §3; that doc covers both deployment paths — the secret names and the use of the request URL are identical).

**Changing your mind later**: update the stack with a different **What to install** value.

- `web` → any option with IM: creates the IM resources (~30 s), then do the two steps above.
- Any option with IM → `web`: removes them. ⚠️ **Both IM DynamoDB tables (conversations and usage) go with them** — that's the group-conversation context and investigation job state, and it's gone for good.
- Switching platform (`web+feishu` → `web+slack` / `web+dingtalk`, or back): removes the old platform's set, creates the new one's. The old HTTP API's address is **not** preserved — switching back gives you a new address, so you have to re-enter it in that platform's console.
- **Credentials don't follow the stack**: those secrets (1 for Feishu, 2 for Slack, 1 for DingTalk) are outside the stack, so they survive option changes and a `KeepData` delete. Only a delete with `TeardownMode=DeleteEverything` removes them too (see [§6](#6-deleting-the-stack)).

---

### 2.12 (Optional) Connect your own CUR data source

**Off by default**: cost questions still get answered (from Cost Explorer), just without line-item drill-down. If you want it there are three ways in, and **you pick only one** (filling in more than one is rejected by the parameter-validation rules `CostMcpExclusiveWithExternal` / `ProvisionCurExcludesCurTable` **before the stack is created**, so you never end up with half a thing). The parameters below all sit in the **Optional: your own CUR data source** group on the parameters page (`ProvisionCur` shows up there as **Let NotiOps create the CUR for you?**):

| Way in | What to fill in | What you get |
|---|---|---|
| **Let the stack create the CUR** (pick this if you have none) | `ProvisionCur=yes`, `CurTable` left empty | An hourly, resource-level CUR in Parquet plus the official Athena integration, and a cost MCP (45 read-only CUR tools) on top. ⏱ AWS takes **up to 24 hours** to deliver the first report; until then cost questions use Cost Explorer, and they switch over on their own once it is ready (checked every 4 hours) — **no second deployment needed** |
| **Connect an existing CUR table** | `CurTable` (`database.table`) + `CurBucketName` (the bucket holding the CUR data) | The same cost MCP, usable right away. The table, its database and the bucket must all be in this stack's **account and Region** (see the three points below the table). ⚠️ The partition style `CurPartitionStyle` defaults to `flat` — **check it against your table** (a table built by the official Glue crawler is `year-month`) |
| **Point at a cost-agent MCP you already run** | `CostAgentMcpUrl` + `CostAgentFunctionArn` | The stack creates nothing for it — see "External" below |

NotiOps builds the first two itself, entirely in your account: a Lambda (`cost_mcp/` in this repository) + a dedicated Athena workgroup (`<stack-name>-cost-mcp`) + a separate query-results bucket. The workgroup enforces a per-query scan cap, `CostMcpScanCapGiB` (default 100 GiB) — Athena bills per byte scanned and has no per-call cap, so this is the real spend guard. 🔒 **Deleting the stack does not delete your billing data**: the CUR report and its S3 bucket created by `ProvisionCur=yes` stay in place under either `TeardownMode` (see the end of [§6.5](#65-delete-stopped-in-delete_failed-stagersite)). A later reinstall in the same account and Region (again with `ProvisionCur=yes`) reuses that CUR, with no new 24-hour wait for a first delivery; on one-click, though, it is only picked up by the next 4-hourly check, so allow **up to about 4 hours** — until then cost questions use Cost Explorer.

When you **connect an existing CUR table**, check these three things first:

- **Same account, same Region, and give the bucket name**: the `CurTable` Glue table, its database and the `CurBucketName` bucket must all be in **this stack's account and Region** — that is where the cost MCP runs Athena (with the table in another Region the stack still deploys fine, but every query fails afterwards). `CurBucketName` is not optional (rule `CostMcpNeedsCurAccess` rejects `CurTable` without it): the cost MCP is granted read on exactly that bucket, rather than read on every bucket in the account.
- **A CUR in another account (`CurRoleArn`) is not supported yet**: the parameter is still there but must stay empty — a value is rejected before the stack is created by the rule `CostMcpCrossAccountNotSupported`. In that setup the queries would run in the CUR's account, against a workgroup that only exists in this one, so every query would fail. If your CUR lives in another account or Region: deploy NotiOps in that account / Region, or use the third way in (`CostAgentMcpUrl`) to point at a server you run yourself.
- **`CurTagKeys` (which user tags to split cost by) takes the column suffix**: the part after `resource_tags_user_` in your CUR table's column names (letters, digits and underscores only; comma separated, no spaces) — **not** the tag key as you typed it in AWS. For example, the tag `cost-center` usually shows up as the column `resource_tags_user_cost_center`, so you enter `cost_center`. Look at the table's columns in Glue / Athena before filling it in.

All three add the same things: 4 CUR sheets on the FinOps page (cost trend / credit / extended support / Savings Plans) plus the ability to ask about that spend directly in chat.

**External** usually means **someone else's CUR table** — a customer's, or several payers' (the TAM scenario) — at line-item granularity. ⚠️ **Both of its parameters or neither.** A Function URL does **not** contain the function ARN, and the invoke permissions (the two actions `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`) can only be granted per function — so filling in just the URL deploys a data source that *looks* installed and 403s on every call. The template therefore carries a parameter-validation rule (`CostAgentArnRequiredWithUrl`): half-filled is rejected **before the stack is created**.

- **Leave them empty**: the capability doesn't exist, by design — the 4 sheets' navigation entries simply don't appear (no menu item that does nothing when clicked), and chat mounts no corresponding tools. Nothing else is affected.
- **Add it later**: update the stack with the corresponding parameters filled in; no rebuild needed.
- **An External server in another account leaves one step on your side**: that Lambda's **resource policy** must grant this stack's two roles (the BFF and the agent runtime) **both** actions — `lambda:InvokeFunctionUrl` (condition `lambda:FunctionUrlAuthType=AWS_IAM`) and `lambda:InvokeFunction` (condition `lambda:InvokedViaFunctionUrl=true`). Since 2025-10 AWS requires both for a Function URL; this stack already creates the two matching grants on its own side, but that Lambda is your own deployment, which the template can't touch. The typical symptom of granting only the first: the request never shows up in that function's logs while its `Url4xxCount` keeps rising.
- **If the MCP goes down it doesn't take the tool with it**: only those 4 dashboard sheets say "temporarily unavailable"; chat falls back to Cost Explorer and then to the AWS read-only API, and **tells you it switched sources** (different measure — don't reconcile against it blindly).

**The full parameter table (including `CurVersion`), caveats about the 45 tools' measures, and the full degradation chain are in [DEPLOYMENT.en.md §14](DEPLOYMENT.en.md#14-customer-cur-dashboard--cost-agent-mcp-optional)** (that section covers both deployment paths).

---

## 3. What the stack creates

**76 resources** with the default parameters, all in your own account (3 more in us-east-1 — the web-search set; 6 fewer with deep investigation off; 8 more if you pick multi-account; **26 more if you pick an install option with IM**; 10 more — the cost MCP set — with `CurTable` set or `ProvisionCur=yes`, and another 11 on top of that if you chose `ProvisionCur=yes`):

| Category | Resources |
|---|---|
| Frontend | S3 website bucket + CloudFront distribution + CloudWatch RUM; report downloads go through a second CloudFront distribution (with a CloudFront Function that only lets report paths through) |
| API | 1 Lambda (BFF) + Function URL (`AWS_IAM` auth, streaming) + 1 EventBridge rule (warms the CUR dashboard cache once a day; with no CUR connected the BFF returns immediately) + its invoke permission |
| Agent | 1 Bedrock AgentCore Runtime + 1 AgentCore Memory (session memory, see [§2.10](#210-session-memory-agentcore-memory)) |
| Sign-in | Cognito User Pool + Client + Identity Pool + 8 groups (roles) |
| Data | DynamoDB `notiops-config`, `notiops-web-chat`; 1 data bucket (reports etc.) |
| Deployment helper | 1 staging bucket (for the staged artifacts) + 1 inline Lambda + 4 custom resources (stage the artifacts / write the frontend config / **on delete, drain the staging bucket until it really is empty** / on delete, delete the data bucket once the reports CloudFront distribution is gone, only under `DeleteEverything`) |
| Permissions | 6 IAM roles + 6 inline policies (the AgentCore Memory execution role has **no policy at all** — it is just a shell for the service to trust) + 1 managed policy (the BFF role's grants exceed the inline-policy size limit, and the overflow lands here) |
| Notifications inbox (see [§2.9](#29-notifications-inbox)) | **10 EventBridge rules** (5 ENABLED / 5 DISABLED) + 1 Lambda + its log group + 1 role (plus its policy) + 1 Lambda invoke permission = 15 |
| Deep investigation (on by default) | 1 DevOps Agent agent space (**with its operator app enabled automatically**) + 1 read-only association + 1 role assumed by DevOps Agent (plus its policy) + 1 operator app role + 1 custom resource (registers the deployment account for deep investigation) = 6 |
| Web search (us-east-1 only) | 1 custom resource (creates the AgentCore gateway) + 1 gateway service role + 1 inline policy |
| Multi-account (optional) | 2 custom resources (① the eligibility preflight ② creates the two member StackSets) + the preflight's own Lambda / role / policy / log group + 2 inline policies = 8 |
| IM bot (optional, see [§2.11](#211-add-an-im-bot-feishulark-slack-or-dingtalk)) | 4 Lambdas (ingress / worker / progress refresh / investigation callback — the last one delivers deep-investigation reports started from a group chat back to that group) + 4 log groups + 1 **API Gateway HTTP API** (a public entry point, see below; 4 resources counting its route / integration / stage) + 4 invoke permissions (HTTP API -> ingress, keep-alive rule -> ingress, progress rule -> progress, callback rule -> investigation callback) + 1 dependency layer + 2 DynamoDB tables (group conversations, usage) + 3 EventBridge rules (refreshes investigation progress every minute, pings the ingress every 4 minutes, fires the callback when an investigation ends) + 1 SQS dead-letter queue (plus its queue policy: if the callback can't be delivered, or the callback function itself fails, the event lands here instead of being lost) + 1 role (plus its policy) = 26. All three platforms have the **same shape**; only the ingress/worker pair is swapped for that platform's pair (with `web+dingtalk` the progress-refresh function is still created, but DingTalk progress is appended messages with no card to refresh, so its every-minute scan finds nothing to do) |
| Cost MCP (optional: `CurTable` set or `ProvisionCur=yes`, see [§2.12](#212-optional-connect-your-own-cur-data-source)) | 1 Lambda + Function URL + 1 dependency layer + log group + 1 role (plus its policy) + 1 Athena workgroup + 1 query-results bucket (plus its bucket policy) + 1 inline policy that lets the agent call it = 10 |
| CUR creation (optional: `ProvisionCur=yes`, on top of the cost MCP) | Stage 1: 1 Lambda + log group + 1 role (plus its policy) + 1 custom resource (creates the delivery bucket, its bucket policy and the report definition); stage 2: 1 Lambda + log group + 1 role (plus its policy) + 1 EventBridge rule every 4 hours + its invoke permission = 11. The CUR report, the delivery bucket and the `notiops-cur-athena-<account>` stack that stage 2 deploys are **not** resources of this stack — they stay when you delete it, see the end of [§6.5](#65-delete-stopped-in-delete_failed-stagersite) |

**Cost, idle**: CloudFront, S3 and DynamoDB are pay-per-use, Lambda costs nothing when not invoked, and an idle AgentCore Runtime costs nothing — idle, this is cents of storage. The real cost is **Bedrock tokens when you ask questions**. Each installed release keeps ~**165 MB** in the staging bucket (plus the IM and cost MCP code and dependency layers if you installed those; ≈ $0.004/month in S3 Standard), and an upgrade keeps the previous release's copy too (the bucket is emptied when you delete the stack), see [§5](#5-upgrading). The IM set is likewise **free when idle** (four Lambdas that cost nothing uninvoked, two on-demand tables, and that per-minute progress rule only does real work while an investigation is running). The cost MCP likewise costs nothing uninvoked; what it really adds once built is the **Athena scan volume** of each query (capped, see [§2.12](#212-optional-connect-your-own-cur-data-source)) and, with `ProvisionCur=yes`, the S3 storage of the delivered CUR.

**Read-only by design**: every grant the agent gets is read-only, and there is no tool in the product that modifies your resources. The furthest it can go is **opening an AWS Support case**, and only after you confirm in the conversation.

---

## 4. Troubleshooting

### 4.1 The stack rolled back — find which resource failed

On the Events tab, find the **first** `CREATE_FAILED` / `UPDATE_FAILED` (not the last). The two common ones:

| Symptom | Cause and fix |
|---|---|
| `StagerArtifacts` failed, logs show a timeout / connection error | The account has no internet egress and can't reach GitHub. Go to [§7](#7-no-internet-egress-use-a-private-s3-mirror). |
| `StagerArtifacts` failed with `failed to stage <your mirror>/<file name> after 3 attempts`, followed by `AccessDenied` or HTTP 404 | You are using the [§7](#7-no-internet-egress-use-a-private-s3-mirror) mirror and **that file is missing from it**. On an `s3://` mirror a missing file shows up as `AccessDenied`, not "not found": the deployment Lambda has `s3:GetObject` on that bucket but no `s3:ListBucket`, so S3 answers a key that doesn't exist with a 403 — don't let it send you off checking permissions. Add the file to the mirror first. If the stack failed to **create**, then clean up the retained resources per §4.2 below and create it again. If an **update** failed (for example when you turn on IM or the cost options later), the stack rolls back to where it was on its own (`UPDATE_ROLLBACK_COMPLETE`) and the tables and the bucket are still in use — do **not** follow §4.2; just run the update again once the file is there. |
| `AgentRuntime` failed | The region may not support Bedrock AgentCore. Use us-east-1 / us-west-2. |
| `StagerPreflight` failed, mentioning `needs this account to be either the AWS Organizations management account or a registered ... delegated administrator` | You picked `MultiAccount`, but this account is neither the management account nor a registered StackSets delegated administrator (yet). The failure reason already lists all three ways forward, the register command verbatim, and the management account id. To deploy from this member account, register it per [§2.6.2](#262-deploying-from-a-member-account-register-a-stacksets-delegated-administrator) and update the stack. |
| `StagerPreflight` failed, mentioning an `OrganizationId` mismatch | You mistyped the org id. The failure reason carries the **correct** one; fix it and create the stack again. |
| `StagerPreflight` failed, mentioning `activate-organizations-access` | Only one half of trusted access is on, and something (usually an SCP) stopped the stack from turning on the other. Run the two commands from the failure reason in the management account, then update the stack. See [§2.6.3](#263-trusted-access-both-halves-are-required). |
| `StagerOrgSetup` failed, mentioning `management account` or `activate-organizations-access` | Same three causes. This is the second gate for `MultiAccount` (it runs after the preflight and is the step that actually writes to the organization), so reaching it means the preflight passed but creating the StackSet was still refused. |

Detailed logs are in the CloudWatch log groups `/aws/lambda/notiops-stager` and `/aws/lambda/notiops-preflight` (substitute your stack name).

> 🩹 **Stack stuck in `ROLLBACK_FAILED` with `StagingBucket` in `DELETE_FAILED` (v1.0.25 and earlier)**: during rollback the **already-cancelled** download Lambda kept running and wrote the 144 MiB agent zip into the bucket *after* the bucket had been emptied — so the bucket can't be deleted and neither can the stack. Finish it by hand: console → S3 → the `<stack-name>-staging-…` bucket → **Empty** (also clear anything under "Incomplete multipart uploads"), then delete the stack again. Later releases clean up after themselves (emptying now requires two consecutive clean passes, and there is an extra gate that must finish before the bucket is deleted).

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

Step 2 is quicker from the CLI (substitute your region and account id):

```bash
REGION=us-east-1
ACCT=$(aws sts get-caller-identity --query Account --output text)

aws dynamodb delete-table --table-name notiops-config   --region "$REGION"
aws dynamodb delete-table --table-name notiops-web-chat --region "$REGION"
aws s3 rm "s3://notiops-data-$ACCT-$REGION" --recursive   # empty it first
aws s3 rb "s3://notiops-data-$ACCT-$REGION"
```

(**Leave those names exactly as written — they do not follow the stack name**: the two tables are always called `notiops-config` / `notiops-web-chat` (hardcoded constants, whatever you named the stack — see §2.3), and the data bucket is named after your **account id + region** (`notiops-data-<account-id>-<region>`) — neither contains the stack name. Renaming them after your stack goes wrong in three linked steps: `delete-table` returns `ResourceNotFoundException` (no table by that name exists) → you conclude the tables are already gone → your next create fails **as a whole stack** in the `NAME_CONFLICT_VALIDATION` preflight, because the two tables that really were retained are still sitting there (see the second warning in §6.1). What *does* follow the stack name is Lambda function names and log groups, which is §4.5's business.)

⚠️ This is **deliberately not auto-detected**: on a genuinely fresh install "the table doesn't exist yet" is the normal case, so treating "already exists" as an error would block every first-time deploy.

(If a previous deployment already put data you want to keep in them, **don't** delete them — a new stack reuses them.)

> 💡 A failed **multi-account** deploy also leaves behind the member StackSets (`notiops-member-onboarding` / `notiops-member-devops-agent`) and the Organizations trusted access. Both are **left on purpose** (rationale in [§6.4](#64-whats-left-behind-orphans-and-whether-to-care)) and they do **not** block a retry — a new stack reuses the same-named StackSets.

### 4.3 The page is blank / 404

A new CloudFront distribution takes a few minutes to propagate. Wait 2–3 minutes and hard-refresh. Still broken: confirm the `ChatUrl` output is a full `https://xxx.cloudfront.net`, and check the website bucket contains `index.html`, `config.json` and `assets/`.

### 4.4 Sign-in works but questions fail

- `AccessDeniedException` mentioning `bedrock` → model access from §1.2 isn't enabled.
- An error naming a specific action (e.g. `rds:DescribeDBInstances`) → you set **Give the agent account-wide read-only access** to `No`. Either add that permission or update the stack back to `Yes`.

### 4.5 IM is installed, but the bot stays silent in the group

This is a **silent failure**, and it's almost always one of the two steps in [§2.11](#211-add-an-im-bot-feishulark-slack-or-dingtalk) left undone:

| Check this first | How to tell |
|---|---|
| Are the credentials complete | Does the secret exist in Secrets Manager, and does it have every key (Feishu needs all four; DingTalk needs both `app_key` and `app_secret`)? The ingress function fails **on purpose** at cold start when a key is missing — better not to start at all than to expose a public entry point anyone can forge requests to. |
| Did you fill in the request URL | Feishu needs it in **two** places (event config + callback config), Slack in **three** (Events / Interactivity / Slash Commands) — the same URL each time. DingTalk needs it in exactly **one** (Bot → message receive mode → HTTP mode → message-receive address), but you must **publish a version again** afterwards, and DingTalk validates nothing on save, so a wrong address gives you no hint at all. |
| The logs | ⚠️ Under one-click deployment the **log group names are CloudFormation-generated** (`<stack-name>-FeishuIngressLogs<hash>-<random>`); they do **not** start with `/aws/lambda/` and cannot be derived from the stack name (rationale and resolver in [IM_WEBHOOK_SETUP.en.md §1.5](IM_WEBHOOK_SETUP.en.md#15-verify)). To look one up: `aws cloudformation describe-stack-resources --stack-name <stack-name> --region <region> --query "StackResources[?starts_with(LogicalResourceId,'FeishuIngressLogs')].PhysicalResourceId" --output text` (use `FeishuWorkerLogs`, `SlackIngressLogs` / `SlackWorkerLogs`, `DingtalkIngressLogs` / `DingtalkWorkerLogs`, or `ImProgressLogs` for the others). The **function** names, in contrast, are derivable: `<stack-name>-im-ingress-feishu` / `<stack-name>-im-worker-feishu` (DingTalk is `-im-ingress-dingtalk` / `-im-worker-dingtalk`) / `<stack-name>-im-progress`. The ingress function shows signature-verification failures — or no logs at all, which means the IM platform never called it, i.e. the URL isn't set correctly. |

The step-by-step checks and what each error means are in [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) (Feishu §1.5, Slack §2.5, DingTalk §3.5).

### 4.6 Using the CLI instead of the console

You can, with two catches:

```bash
# The template is about 430 KB (it grows with the resource count each release), well past the
# 51,200-byte --template-body limit, so it must go via S3 + --template-url
aws s3 cp notiops-webchat.template.json s3://<your-bucket>/notiops-webchat.template.json
aws cloudformation create-stack --stack-name notiops \
  --template-url https://<your-bucket>.s3.<region>.amazonaws.com/notiops-webchat.template.json \
  --capabilities CAPABILITY_IAM \
  --parameters ParameterKey=AdminEmail,ParameterValue=you@example.com
# Multi-account: add both of these (either one alone does nothing, see §2.6)
#   ParameterKey=DeployMode,ParameterValue=MultiAccount \
#   ParameterKey=OrganizationId,ParameterValue=o-xxxxxxxxxx
# Add an IM bot (see §2.11): web / web+feishu / web+slack / web+dingtalk
#   ParameterKey=InstallOption,ParameterValue=web+feishu
```

Omitting `--capabilities CAPABILITY_IAM` is rejected outright (the stack contains IAM roles).

---

## 5. Upgrading

When a new release lands: **download the new template and update the existing stack** (don't create a second stack).

1. Download `notiops-webchat.template.json` from the new release.
2. CloudFormation → select your stack → **Update** → **Replace existing template** → **Upload a template file**.
3. Keep parameters on **Use existing value** (except what you actually want to change) → tick IAM → Submit. (If your stack is on v1.0.20–v1.0.29 and has an IM bot, read the 🔴 note below before you submit.)

**Measured: ~1 minute.** During the upgrade: the new release's artifacts are staged from GitHub or your mirror (their S3 keys carry the release tag) → the frontend is republished and last version's stale files are pruned → CloudFront is invalidated (`/*`) → the AgentCore Runtime gets a new version **in place** (same ARN, no frontend config change).

An upgrade does **not**: re-send the invitation email, change the admin's email or password, touch existing settings in `config.json`, or clear your chat history.

**Multi-account mode**: since v1.0.30 the member DevOps Agent StackSet (`notiops-member-devops-agent`) is rolled out with `CreateCollectionRole=no` (same as `setup.sh`), so it no longer creates a second copy of the inspection collection role that the onboarding StackSet already put into the member account under the same name. Any account where **Step 2: DevOps Agent** → **Associate** on **More → Admin → Accounts** failed earlier, with the member stack rolling back on `EntityAlreadyExists`, can simply be associated again once this update is done — every release's update re-applies both StackSets, so there is nothing else to do.

> 🔴 **Stacks upgrading from v1.0.20–v1.0.29 that have an IM bot (What to install is not `web`) and use the default GitHub artifact source (Artifact base URL override left empty)** (the `InstalledRelease` output and those two parameters tell you):
> `im-code.zip` has been withdrawn from the GitHub Releases of those versions. If this upgrade fails **for any reason**, CloudFormation's automatic rollback re-runs the deployment Lambda from the **old** template, which re-downloads the old `im-code.zip` → HTTP 404 → the stack stops in `UPDATE_ROLLBACK_FAILED` (on `StagerArtifacts`). Nothing in v1.0.30 can prevent this: the rollback runs the old template's inline code with the old SHA256 list.
>
> - **Before upgrading**: under **Stack failure options** in the update wizard, pick **Preserve successfully provisioned resources** (on the CLI, `aws cloudformation update-stack … --disable-rollback`). If the upgrade then fails, the stack stops in `UPDATE_FAILED` without rolling back; fix the cause and run the update to v1.0.30 again — and **don't** press Roll back in between.
> - **Already stuck in `UPDATE_ROLLBACK_FAILED`**:
>
>   ```bash
>   aws cloudformation continue-update-rollback --stack-name <stack> --region <region> \
>     --resources-to-skip StagerArtifacts
>   ```
>
>   If it stops again on other resources with `NoSuchKey`, run it once more with the logical IDs CloudFormation reports as `UPDATE_FAILED` as `--resources-to-skip`. Once the rollback completes, fix whatever made the upgrade fail, then run the update to v1.0.30 again.
>
> These recovery steps are worked out from the mechanism; they have not yet been tried on a real stack running one of those old versions with IM.

**Rollback**: update again with the **older template**. ⚠️ That does not switch back to old files already in the bucket: an update to a different template version makes the stack **download that version's artifacts again** from GitHub (or your mirror) — the stack doesn't reuse what's already in the bucket — so it only works while that older release still has all its artifacts. That is why a stack with IM **cannot** roll back to v1.0.20–v1.0.29: `im-code.zip` has been withdrawn from those releases, so the update fails on `StagerArtifacts` with HTTP 404 (and CloudFormation then returns the stack to the current version).

> **Staged artifacts are kept** (from v1.0.30; stacks on v1.0.29 and earlier have a lifecycle rule, `expire-staged-artifacts-7d`, that deletes them after 7 days, and upgrading to v1.0.30 removes it). The reason: every update of the AgentCore Runtime — even one that only changes a parameter — re-reads the agent package from this bucket. Once the artifacts have expired, an update that only changes a parameter such as `EnableDeepInvestigation`, `DeployMode` or `CostAgentMcpUrl` fails on `AgentRuntime` (`S3 object not found in bucket`), the rollback needs the same package and fails too, and the stack stops in `UPDATE_ROLLBACK_FAILED` (measured 2026-10-11). Each release is about 165 MB, so the storage cost is negligible; the bucket is emptied when you delete the stack.
>
> 🔴 **Stacks still on v1.0.29 or earlier whose last install or upgrade was more than 7 days ago**: don't make a parameter-only update — **upgrade to v1.0.30 first** (a version change downloads the artifacts again). If a stack is already stuck in `UPDATE_ROLLBACK_FAILED`, let the rollback finish first (if the failure events name a resource other than `AgentRuntime`, skip that one instead):
>
> ```bash
> aws cloudformation continue-update-rollback --stack-name <stack-name> --resources-to-skip AgentRuntime
> ```
>
> Once it reaches `UPDATE_ROLLBACK_COMPLETE` (about half a minute in our test), upgrade to v1.0.30, then change the parameter.

---

## 6. Deleting the stack

### 6.1 Decide what happens to your data

The `TeardownMode` parameter decides the fate of three things:

| | `KeepData` (default) | `DeleteEverything` |
|---|---|---|
| `notiops-config` table (settings) | **kept** | deleted |
| `notiops-web-chat` table (chat history, notifications) | **kept** | deleted |
| Data bucket `notiops-data-…` (exported reports etc.) | **kept** | deleted |
| Everything else (frontend, CloudFront, Lambda, agent, **Cognito user pool**, and with IM installed those 26 resources including both IM tables) | deleted | deleted |
| IM credentials (the `notiops/im-bot-feishu` / `notiops/im-bot-dingtalk` / the two Slack Secrets Manager secrets — outside the stack) | **kept** | deleted (unrecoverable) |
| The CUR report, delivery bucket and `notiops-cur-athena-<account>` stack created by `ProvisionCur=yes` (outside the stack) | **kept** | **kept** (on purpose: that is your billing history, and AWS does not re-deliver it; a reinstall in the same account and Region reuses it, picked up within about 4 hours — see [§2.12](#212-optional-connect-your-own-cur-data-source)) |

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

During deletion the stack's deployment Lambda first **empties** the website bucket, the staging bucket and (when the cost MCP is installed) the Athena query-results bucket (a non-empty bucket can't be deleted and would stall the whole delete), then honours `TeardownMode` for the two tables and the data bucket. The data bucket is deleted by a separate step, `DataCleanup`, only **after** the reports CloudFront distribution is gone -- that bucket is the distribution's origin (v1.0.32 and earlier deleted the bucket first, so for several minutes the distribution pointed at a bucket name that no longer existed, and bucket names are global: anyone could have claimed it). Measured in 2026-08: **zero `DELETE_FAILED`** in both modes. Note: this did **not** hold on a v1.0.30 pre-release -- with the cost MCP installed, the deployment Lambda lacked permissions on the query-results bucket and the delete stopped in `DELETE_FAILED` (measured 2026-10-10, fixed; re-measured the same day after the fix: `DeleteEverything` finished in 4m12s with zero `DELETE_FAILED`, with an object left in the query-results bucket on purpose). If yours is stuck, see [§6.5](#65-delete-stopped-in-delete_failed-stagersite).

### 6.4 What's left behind (orphans), and whether to care

| Left behind | Why | Recommendation |
|---|---|---|
| Log group `/aws/vendedlogs/RUMService_notiops-web-chat<hash>` | Created by CloudWatch RUM itself; not owned by the stack. The `notiops-web-chat` part of that name is the **RUM app monitor's fixed name — it does not follow the stack name**, so it reads the same even when your stack is called something else | **Fine to ignore**: measured at 0 bytes, expires after 30 days. To clean up, delete it in CloudWatch by its **full name** (don't bulk-delete by prefix) |
| The two tables + data bucket under `KeepData` | That is what `KeepData` **means** | Delete manually when you're done with them (empty the bucket first). **You must delete them before you can redeploy into this account** — see the second warning in §6.1 |
| CloudFront access logs, if you enabled them yourself | Not managed by this stack | As you like |
| **If you ever installed IM**: the `notiops/im-bot-feishu` / `notiops/im-bot-dingtalk` / `notiops/slack-bot-token` / `notiops/slack-signing-secret` Secrets Manager secrets | They are not stack resources (all three platforms' secrets are created on demand by the web UI's "More → Admin → IM Integration" page), so `KeepData` leaves them alone | `DeleteEverything` **deletes them too** (unrecoverable). Under `KeepData`, delete them yourself if you want them gone; leave them and a reinstall reuses the same-named secrets |
| **If you saved a Bedrock API key or a gateway under "More → Admin → Models"**: `notiops/bedrock-api-key` / `notiops/litellm-config` | Same reason: they are not stack resources but are created on demand by that page on the first save, so `KeepData` leaves them alone | `DeleteEverything` **deletes them too** (unrecoverable). Under `KeepData`, delete them yourself if you want them gone; to retire a gateway key for good, revoke it on the gateway side |
| **In multi-account mode**: the `notiops-member-onboarding` / `notiops-member-devops-agent` StackSets, and Organizations trusted access for StackSets | **Deliberate.** (1) A StackSet can only be deleted once every stack instance is gone, and removing those wipes the cross-account roles in your member accounts — a cross-account destructive action shouldn't be triggered implicitly by deleting one stack. (2) Trusted access is an **organization-wide** switch; turning it off with our stack would break other people's StackSet deployments. | If you really want them gone: CloudFormation → StackSets → **Delete stacks from StackSet** (removes the instances), then delete the StackSet itself. Leave trusted access alone unless you're sure nobody else relies on it. |

**No other orphans**: the agent's log group, the BFF's log group, the notification handler's log group, the deployment Lambda's log group, IAM roles, the Cognito user pool, the RUM app monitor, the AgentCore Runtime, the website bucket and the staging bucket were all verified to go away with the stack. Note: this did **not** hold on a v1.0.30 pre-release -- the three functions added in that release (cost MCP, CUR stage 1 / stage 2) had no stack-owned log group, so the `/aws/lambda/<stack>-CostMcpFunction…` / `…CurProvisionerFn…` / `…CurFinalizerFn…` groups Lambda creates on first invocation were not owned by the stack, survived the delete and **never expire** (after a clean delete on 2026-10-10 `…CurProvisionerFn…` was left behind; fixed -- every function now writes to a stack-owned log group, and a test checks each one). The execution roles of those three functions also **no longer carry** `logs:CreateLogGroup`: Lambda delivers logs asynchronously, so after the stack deleted a log group, late log lines used to re-create it through that permission (seen in the RC round trip the same day: the group reappeared one second after it was deleted) — now they can't. Some of the older functions still have that permission, which leaves a narrow gap: if one of them happens to be invoked in the last few seconds of the delete, its log group can be re-created this way and stay behind in the account (a known issue). If you find one, delete it in CloudWatch by its full name. With `ProvisionCur=yes` the account also keeps the log groups of the two Lambdas in the `notiops-cur-athena-<account>` stack (AWS's own template: `…AWSCURInitializer…` / `…AWSS3CURNotification…`) -- they are kept **on purpose** together with that stack (see the end of §6.5), not orphans of this one. The agent space and association created for deep investigation also go away with it (they are ordinary stack resources). Same for the session-memory AgentCore Memory ([§2.10](#210-session-memory-agentcore-memory)) — an ordinary stack resource with **no** retention policy, deleted with the stack, taking the stored session messages with it (this one is what the template declares; unlike the list above, it has not yet been verified by an actual stack deletion). The web-search AgentCore gateway splits two ways: one **this stack created** is deleted with the stack; one it **reused** (a pre-existing `notiops-websearch-gw` in the account, e.g. from `setup.sh`) is left alone — deleting one stack shouldn't take down something another deployment path still uses.

### 6.5 Delete stopped in `DELETE_FAILED` (StagerSite)

`StagerSite` is the "empty first, then honour `TeardownMode`" step above. When it fails, **its failure reason lists every step that did not complete** (which bucket / table / secret, which API, which error code) -- read that line first. A stack in `DELETE_FAILED` **cannot be updated**, so the way out is to finish the remaining work by hand and let CloudFormation skip this step. The same goes for the step that deletes the data bucket (`DataCleanup`, which only acts under `DeleteEverything`): its failure reason names that bucket too; use `--retain-resources DataCleanup` in step 2 (both names if both failed), then delete that bucket as in step 3:

```bash
# 1. Empty the buckets named in the failure reason (only those)
aws s3 rm s3://<bucket named in the failure reason> --recursive

# 2. Retry the delete, skipping StagerSite (a custom resource with no physical resource behind it)
aws cloudformation delete-stack --stack-name <stack> --retain-resources StagerSite
```

Skipping StagerSite **also skips its clean-up**. If you chose `DeleteEverything`, nothing will delete the following for you any more -- remove them yourself after the stack is gone: the two tables (`notiops-config` / `notiops-web-chat`), any of the `notiops/*` secrets from the §6.4 table that exist, and this stack's agent log group under `/aws/bedrock-agentcore/runtimes/`. The data bucket `notiops-data-<account>-<region>` is not on that list (it belongs to `DataCleanup`) -- delete it yourself only if you also skipped `DataCleanup`, or if the stack still runs v1.0.32 or earlier (where StagerSite deleted the data bucket too); empty it first, and **it holds your Skills and exported reports -- export them first if you want to keep them**. With `KeepData` the two tables and the data bucket are kept on purpose anyway. Everything CUR-related (the report, its delivery bucket, the `notiops-cur-athena-<account>` stack) is **kept** in every mode, by design.

```bash
# 3. Only if you chose DeleteEverything: finish the clean-up that was skipped. Otherwise a re-install in the
#    same account and Region fails its pre-check on the same-named tables / bucket (~9 s, see §6.1)
aws dynamodb delete-table --table-name notiops-config
aws dynamodb delete-table --table-name notiops-web-chat
# the data bucket: only if you skipped DataCleanup, or the stack runs v1.0.32 or earlier
aws s3 rb s3://notiops-data-<account>-<region> --force   # --force empties it first; export Skills / reports before if you want them
aws logs delete-log-group --log-group-name /aws/bedrock-agentcore/runtimes/<runtime id>-DEFAULT
# any of the notiops/* secrets from the §6.4 table that exist:
aws secretsmanager delete-secret --secret-id notiops/<name> --force-delete-without-recovery
```

---

## 7. No internet egress: use a private S3 mirror

If your account has no internet egress (or policy forbids pulling executable code from github.com), mirror the artifacts into an S3 bucket and point the stack at it. The bucket can be **fully private** (Block Public Access all on) — the deployment Lambda reads it with its own role over the S3 API, no internet required.

**One-time setup** (done once by someone with credentials; every account/team can then reuse the mirror):

```bash
# 1. Download the nine zips and SHA256SUMS from the release into one directory. SHA256SUMS is the
#    list to go by: one zip per line, the same list as scripts/artifacts.py in the repository
#    (the nine that `python3 scripts/artifacts.py all` prints)
# 2. From that directory, copy all of them into a bucket in the SAME region you deploy to
for f in $(awk '{print $2}' SHA256SUMS); do
  aws s3 cp "$f" s3://my-mirror/notiops/v1.2.3/
done
```

**Mirroring all nine** is simplest — the stack only fetches the ones it uses, and you won't have to come back when you turn on IM or the cost options later. Mirroring only what you need also works: `bff.zip` / `chat-dist.zip` / `web-notif.zip` / `agent-code.zip` are always needed; the two `im-*.zip` files only for an IM bot (§2.11); the two `cost-mcp-*.zip` files only if the stack deploys its own cost MCP (§2.12: `CurTable` set or `ProvisionCur=yes`; pointing `CostAgentMcpUrl` at your own server does not count); `cur-provisioner.zip` only with `ProvisionCur=yes`. Leave out one that is needed and the stack fails on `StagerArtifacts` (symptom and fix in §4.1).

**When you upgrade**, upload the new release into a **new** directory (one per version, like `v1.2.3/` above) and change **Artifact base URL override** to it in the update; clear the old directory only after the update has succeeded. If the update fails, the automatic rollback fetches the old release's files from the old directory again and checks them against the old SHA256 values — if they are gone or overwritten, the stack stops in `UPDATE_ROLLBACK_FAILED`.

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
6. **Installing IM adds one public entry point** ([§2.11](#211-add-an-im-bot-feishulark-slack-or-dingtalk)) — that **API Gateway HTTP API** has to be **unauthenticated**, because Feishu, Slack and DingTalk won't sign SigV4 for you (before 2026-09-01 this was a Lambda Function URL; why it changed, and the two alternatives that were ruled out, are in [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §5.1). Five boundaries: (a) **signature verification** (Feishu with the Encrypt Key + Verification Token, Slack with the signing secret, DingTalk with the AppSecret checking the `sign` header inside a one-hour time window; a missing key fails the cold start, so "misconfigured but still reachable" doesn't exist); (b) **two throttling layers** — the HTTP API stage caps at 50 req/s with a burst of 100 (anything above that gets a 429 straight from API Gateway and **never reaches Lambda**), and the ingress function additionally carries a **concurrency cap of 10**: together, the spend ceiling on a public unauthenticated entry point; (c) an optional **chat allowlist** (only messages from named groups take effect — see [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §4; on DingTalk this check lands in the worker, after signature verification, because `conversationId` is only readable once the signature has been verified); (d) **idempotent de-duplication** (a redelivered event is processed once); (e) behind it is still the **same read-only agent** with no write permission at all — even a forged message gets, at worst, read-only information back. Credentials always live in Secrets Manager: never in environment variables, never printed to logs. The risks that remain are listed plainly in [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) §5.3.

---

## 9. Next

- [USER_GUIDE.en.md](USER_GUIDE.en.md) — using the UI and its topics (cost, investigation, Support cases, Skills…)
- [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md) — what to click on the Feishu/Slack/DingTalk side once you installed an IM bot ([§2.11](#211-add-an-im-bot-feishulark-slack-or-dingtalk))
- [DEPLOYMENT.en.md](DEPLOYMENT.en.md) — the full deployment, when you want scheduled inspection (with its dashboard) and proactive push into IM
- [TECHNICAL_DESIGN.en.md](TECHNICAL_DESIGN.en.md) — architecture and design trade-offs
