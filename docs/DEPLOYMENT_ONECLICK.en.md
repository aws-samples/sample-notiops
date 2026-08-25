# NotiOps — One-Click Deployment (CloudFormation, no local setup)

> ⚠️ **Disclaimer**: This is sample code, for non-production usage. You should work with your security and legal teams to meet your organizational security, regulatory and compliance requirements before deployment.

> 🌐 **Language**: [中文](DEPLOYMENT_ONECLICK.md) · [English](DEPLOYMENT_ONECLICK.en.md)
>
> **Audience**: anyone who wants to get the Web Chat console running and try it. You need **nothing installed locally** and **no IAM user / access keys**.
>
> **Time**: **~10 minutes** (the stack itself measured ~4.5 minutes).
>
> **See also**:
> - [DEPLOYMENT.en.md](DEPLOYMENT.en.md) — the full deployment guide (`setup.sh`: IM bots, scheduled inspection, admin dashboard, CUR/Athena)
> - [USER_GUIDE.en.md](USER_GUIDE.en.md) — how to use it once deployed

---

## 0. Two deployment paths — this doc covers the second one

The repository ships **two** ways to deploy, with different scope. This document covers only the second.

| | **`setup.sh`** (full, see [DEPLOYMENT.en.md](DEPLOYMENT.en.md)) | **This doc: one-click** |
|---|---|---|
| What you need | git, Node, Python, AWS CDK, Docker/finch, plus deployment credentials | **just a browser logged into the AWS console** |
| How you start | clone the repo → `./setup.sh` | download one template from the Release → upload it in the CloudFormation console |
| What gets deployed | Web Chat + IM bots (Feishu/Slack) + daily inspection + admin dashboard + CUR/Athena FinOps source | **Web Chat only** (chat UI + BFF + agent) |
| Good for | long-term use, IM notifications, scheduled inspection | trying it out / demos / just the read-only ops assistant in a browser |

**You can do both, in order**: deploy one-click to try it, then run `setup.sh` later when you want IM and inspection. (Both paths create the same admin username, `admin`, so they don't collide.)

### 0.1 What one-click does **not** include

Better said up front than discovered later. These require `setup.sh`:

- **IM bots** (Feishu / Slack / DingTalk), including alert push to IM.
- **Scheduled daily inspection** (idle-resource detection, cost-anomaly scanning) and its 5 Lambdas.
- **The admin dashboard** (thresholds, target-account management, Skills management UI). One-click ships the chat UI only.
- **Content for the Notifications inbox**: the UI is there, but the backend that produces notifications (Health event forwarding, alert push) is not.
- **CUR + Athena cost detail**: FinOps questions still work at Cost Explorer granularity, but there is no bill-line-level drill-down.
- **Cross-account inspection / multi-payer onboarding**: the agent only sees **the account it is deployed into**.
- **Web search** (Exa) and **DevOps Agent deep investigation**: both need extra keys/service enablement and are off by default.

---

## 1. Prerequisites (all three)

### 1.1 An AWS account and console permissions to create the stack

Your identity needs to be able to create a CloudFormation stack and the resources in it (IAM roles, Lambda, DynamoDB, S3, CloudFront, Cognito, Bedrock AgentCore). You **don't need `AdministratorAccess`**, but overly narrow permissions will fail partway through. If unsure, use a test account.

> You must tick **"I acknowledge that AWS CloudFormation might create IAM resources"** —
> the stack creates roles for the agent and the BFF.

### 1.2 Pick a region, and enable Bedrock model access there

The agent runs on **Amazon Bedrock**. **Before creating the stack**, go to the Bedrock console → Model access and confirm the Claude model you want shows **Access granted** in that region.

- **us-east-1** or **us-west-2** recommended (best Bedrock AgentCore and model coverage).
- Without model access the stack still **succeeds**, the site loads and login works — but every question fails with `AccessDeniedException`. This is the most common "it deployed but doesn't work".

### 1.3 The account must be able to reach GitHub (or bring your own mirror)

During deployment, a Lambda inside the stack downloads three artifacts (frontend, BFF, agent code) from the **GitHub Release** and stages them into your own S3 bucket. Lambda is not in a VPC here and uses AWS-managed egress, so **most accounts satisfy this out of the box**.

If your enterprise egress allowlist does **not** include github.com, you don't have to abandon this path — see [§7 No internet egress: use a private S3 mirror](#7-no-internet-egress-use-a-private-s3-mirror).

---

## 2. Deploy (5 steps)

### 2.1 Download the template

From the [Releases](https://github.com/aws-samples/sample-notiops/releases) page, download from the latest release:

```
notiops-webchat.template.json
```

The same release also has three artifacts (`bff.zip` / `chat-dist.zip` / `agent-code.zip`) — **you don't need to download those**; the template makes your account fetch them. Their SHA256 digests are baked into the template and verified on arrival; a mismatch fails the stack.

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
| **Administrator email** | Your email. After the stack completes, Cognito emails a **temporary password** here. It must be a real mailbox — **this is the only way in**. |

Everything else has a safe default. For a first deployment, **leave them all alone**:

| Parameter | Default | When you'd change it |
|---|---|---|
| **Give the agent account-wide read-only access?** | `Yes` | `Yes` attaches the AWS-managed `ReadOnlyAccess` policy so the agent can answer questions about any resource in the account. `No` restricts it to the explicit read-only grants (cost, logs, metrics, RDS/EC2 describe); some questions then fail with a message naming the missing action. **Neither option grants any write permission.** |
| **CORS allowed origins** | `*` | The endpoint is already `AWS_IAM` (SigV4) authenticated, so `*` is not a privilege hole. For defence in depth, update the stack after the first deploy and set this to the `ChatUrl` output. |
| **On stack delete** | `KeepData` | Decides what happens to your data when the stack is deleted. See [§6](#6-deleting-the-stack) — **there is a gotcha; read it before you delete**. |
| **Artifact base URL override** / **Artifact mirror bucket name (s3:// only)** | empty | Only when you can't reach GitHub — see [§7](#7-no-internet-egress-use-a-private-s3-mirror). |

### 2.4 Acknowledge IAM, create

**Next** → on the final page tick **"I acknowledge that AWS CloudFormation might create IAM resources"** → **Submit**.

**Measured: about 4.5 minutes** (two independent runs: 4m16s / 4m25s, us-east-1). You'll see the stack waiting on two `Custom::NotiOpsStager…` resources — that's it staging ~165 MB of artifacts from GitHub into your S3 bucket, unpacking the frontend, writing runtime config, and creating the admin user.

### 2.5 Sign in

Once the stack is **CREATE_COMPLETE**, open the **Outputs** tab:

| Output | What it is |
|---|---|
| **ChatUrl** | The chat UI (CloudFront). **Open this one.** |
| **ChatBffUrl** | The backend endpoint (the frontend uses it; you don't need to) |
| **NextSteps** | One-line sign-in instructions |
| **InstalledRelease** | Which release this stack currently runs |
| **DataRetentionOnDelete** | What deleting the stack does to your data under the current `TeardownMode` |
| **WebChatTableName** | The DynamoDB table holding chat history and notifications (for querying it yourself, or cleaning up manually after a delete) |

Open `ChatUrl` and sign in with:

- **Username: `admin`** (not the email address — though the email works too, it's configured as an alias)
- **Password**: the temporary one from the email; you'll be asked to set a new one on first login

> 📧 **No email?** The sender is `no-reply@verificationemail.com` (Cognito's default email delivery),
> subject `Your temporary password`. **Corporate mail systems often tag it `[EXTERNAL]` or drop it
> into junk** — check there first. Measured delivery: about a minute after stack completion in us-east-1.
>
> Truly lost: Cognito console → that user pool → Users → `admin` → reset the password.

After signing in, ask something like `list the EC2 instances in this account` to confirm the agent actually answers (this also verifies §1.2).

---

## 3. What the stack creates

44 resources, all in your own account:

| Category | Resources |
|---|---|
| Frontend | S3 website bucket + CloudFront distribution + CloudWatch RUM |
| API | 1 Lambda (BFF) + Function URL (`AWS_IAM` auth, streaming) |
| Agent | 1 Bedrock AgentCore Runtime |
| Sign-in | Cognito User Pool + Client + Identity Pool + 8 groups (roles) |
| Data | DynamoDB `notiops-config`, `notiops-web-chat`; 1 data bucket (reports etc.) |
| Deployment helper | 1 staging bucket (for the staged artifacts) + 1 inline Lambda + 2 custom resources |
| Permissions | 5 IAM roles + 5 inline policies |

**Cost, idle**: CloudFront, S3 and DynamoDB are pay-per-use, Lambda costs nothing when not invoked, and an idle AgentCore Runtime costs nothing — idle, this is cents of storage. The real cost is **Bedrock tokens when you ask questions**. Each installed release keeps ~**165 MB** in the staging bucket (≈ $0.004/month in S3 Standard); upgrades don't purge old versions, see [§5](#5-upgrading).

**Read-only by design**: every grant the agent gets is read-only, and there is no tool in the product that modifies your resources. The furthest it can go is **opening an AWS Support case**, and only after you confirm in the conversation.

---

## 4. Troubleshooting

### 4.1 The stack rolled back — find which resource failed

On the Events tab, find the **first** `CREATE_FAILED` (not the last). The two common ones:

| Symptom | Cause and fix |
|---|---|
| `StagerArtifacts` failed, logs show a timeout / connection error | The account has no internet egress and can't reach GitHub. Go to [§7](#7-no-internet-egress-use-a-private-s3-mirror). |
| `AgentRuntime` failed | The region may not support Bedrock AgentCore. Use us-east-1 / us-west-2. |

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

### 4.5 Using the CLI instead of the console

You can, with two catches:

```bash
# The template is ~95 KB > the 51,200-byte --template-body limit, so it must go via S3 + --template-url
aws s3 cp notiops-webchat.template.json s3://<your-bucket>/notiops-webchat.template.json
aws cloudformation create-stack --stack-name notiops \
  --template-url https://<your-bucket>.s3.<region>.amazonaws.com/notiops-webchat.template.json \
  --capabilities CAPABILITY_IAM \
  --parameters ParameterKey=AdminEmail,ParameterValue=you@example.com
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

> **The staging bucket accumulates**: ~165 MB per installed release. To clean up, manually delete
> objects under `agent/<old-tag>/` and `frontend/<old-tag>/` in the staging bucket — **not the
> current release's**, or the next stack update won't find its code.

---

## 6. Deleting the stack

### 6.1 Decide what happens to your data

The `TeardownMode` parameter decides the fate of three things:

| | `KeepData` (default) | `DeleteEverything` |
|---|---|---|
| `notiops-config` table (settings) | **kept** | deleted |
| `notiops-web-chat` table (chat history, notifications) | **kept** | deleted |
| Data bucket `notiops-data-…` (exported reports etc.) | **kept** | deleted |
| Everything else (frontend, CloudFront, Lambda, agent, **Cognito user pool**) | deleted | deleted |

> ⚠️ **The Cognito user pool is deleted in both modes** — users and passwords are gone.
> `KeepData` preserves **data**, not accounts. After redeploying you sign in again with a fresh
> temporary password (your data is still there).

### 6.2 ⚠️ To use `DeleteEverything`: update first, then delete

On delete, CloudFormation hands custom resources **the parameter values from the last successful deploy**, not what you'd like at deletion time. So "change TeardownMode in the delete dialog" isn't a thing. Do this instead:

```
1. Update the stack, changing only On stack delete → DeleteEverything (measured ~45 seconds)
2. Then delete the stack
```

Getting the order wrong fails silently: the stack goes away, the tables and bucket stay, and you think you cleaned up.

### 6.3 Delete

CloudFormation → select the stack → **Delete**. **Measured ~3m10s** (identical in both modes).

During deletion the stack's deployment Lambda first **empties** the website and staging buckets (a non-empty bucket can't be deleted and would stall the whole delete), then honours `TeardownMode` for the two tables and the data bucket. Measured: **zero `DELETE_FAILED`** in both modes.

### 6.4 What's left behind (orphans), and whether to care

| Left behind | Why | Recommendation |
|---|---|---|
| Log group `/aws/vendedlogs/RUMService_<stack>-web-chat<hash>` | Created by CloudWatch RUM itself; not owned by the stack | **Fine to ignore**: measured at 0 bytes, expires after 30 days. To clean up, delete it in CloudWatch by its **full name** (don't bulk-delete by prefix) |
| The two tables + data bucket under `KeepData` | That is what `KeepData` **means** | Delete manually when you're done with them (empty the bucket first) |
| CloudFront access logs, if you enabled them yourself | Not managed by this stack | As you like |

**No other orphans**: the agent's log group, the BFF's log group, the deployment Lambda's log group, IAM roles, the Cognito user pool, the RUM app monitor, the AgentCore Runtime, the website bucket and the staging bucket were all verified to go away with the stack.

---

## 7. No internet egress: use a private S3 mirror

If your account has no internet egress (or policy forbids pulling executable code from github.com), mirror the three artifacts into an S3 bucket and point the stack at it. The bucket can be **fully private** (Block Public Access all on) — the deployment Lambda reads it with its own role over the S3 API, no internet required.

**One-time setup** (done once by someone with credentials; every account/team can then reuse the mirror):

```bash
# Download the three artifacts from the release into a bucket in the SAME region you deploy to
aws s3 cp bff.zip        s3://my-mirror/notiops/v1.2.3/
aws s3 cp chat-dist.zip  s3://my-mirror/notiops/v1.2.3/
aws s3 cp agent-code.zip s3://my-mirror/notiops/v1.2.3/
```

**Then set two parameters when creating the stack**:

| Parameter | Value |
|---|---|
| **Artifact base URL override** | `s3://my-mirror/notiops/v1.2.3` (**no** trailing slash; the template appends the filenames) |
| **Artifact mirror bucket name (s3:// only)** | `my-mirror` — the deployment Lambda is granted `s3:GetObject` on **that bucket only**, and nothing else |

Cross-account works too: a bucket policy allowing the deploying account to read is enough (`Code.S3Bucket` may be cross-account, but **must be in the same region**).

Integrity still holds: the three SHA256 digests in the template were computed over the original release artifacts, so tampered mirror content fails verification and the stack fails to create.

`https://` is also accepted (`https://host/path`), but that is a **plain unauthenticated GET** — the objects must be anonymously readable. For private setups use `s3://`.

---

## 8. Security notes worth knowing

1. **Read-only**: every grant the agent has is read-only, and no tool in the product modifies resources. The only outward action is opening a Support case, gated on your confirmation in the conversation.
2. **The endpoint is authenticated**: the BFF Function URL is `AWS_IAM` (SigV4) — even if the URL leaks, an unsigned request can't call it. Cognito identity checks sit on top of that.
3. **Code enters your account from the public internet.** That is what this path is. Two controls: (a) artifacts come only from a fixed tag of the `aws-samples/sample-notiops` release; (b) each artifact's SHA256 is baked into the template and verified on arrival — a mismatch deletes the uploaded object and fails the stack. If that premise doesn't work for you, use the private mirror in [§7](#7-no-internet-egress-use-a-private-s3-mirror), or use `setup.sh`.
4. **We never touch the admin password**: Cognito generates it and emails it to you. The deployment never passes, reads, prints or outputs it.
5. **Everything is done by your own credentials**: no account of ours, no bucket of ours, no role of ours is anywhere in this path.

---

## 9. Next

- [USER_GUIDE.en.md](USER_GUIDE.en.md) — using the UI and its topics (cost, investigation, Support cases, Skills…)
- [DEPLOYMENT.en.md](DEPLOYMENT.en.md) — the full deployment, when you want IM bots, scheduled inspection and the admin dashboard
- [TECHNICAL_DESIGN.en.md](TECHNICAL_DESIGN.en.md) — architecture and design trade-offs
