# IM Webhook Setup (Feishu / Slack)

Both Feishu and Slack run on an **API Gateway HTTP API + Lambda webhook** — no long-lived
containers, no persistent socket. This document only covers **what you click in the
IM platform console**, and it is the step you do **after the deployment finishes**.

> **Three kinds of reader, all covered**:
> - **One-click (path A)**: you set **What to install** to `web+feishu` / `web+slack` on the
>   parameters page (see
>   [DEPLOYMENT_ONECLICK.en.md §2.11](DEPLOYMENT_ONECLICK.en.md#211-add-an-im-bot-feishulark-or-slack)),
>   the stack is up, and this document is all that's left — read the 🅰️ note in §0 (four
>   differences, that's all), then follow §1 / §2.
> - **New deployment (path B, `setup.sh`)**: first follow [DEPLOYMENT.en.md](DEPLOYMENT.en.md)
>   §3 to create the app, set the scopes and collect the keys; run `setup.sh`; then come back
>   here to fill in the request URL.
> - **Existing long-connection deployment**: this is an **in-place switch**. You do not
>   create a new app and (for Feishu) you do not change any scope — you change only
>   "delivery mode + request URL", plus add the two keys (§1.2).
>
> ⚠️ **The order is not optional**: fill in the request URL only after the stack is
> deployed **and** the keys are written into the secret. Getting it backwards shows up as
> "verification failed" in the Feishu / Slack console, which looks like a wrong URL.

---

## 0. Get the webhook URL first

**The easy way: admin console → "IM integration" → "View the detailed setup steps" → step 3.**
This deployment's real Feishu URL is shown right there with a Copy button — no CloudFormation
console, no CLI, and it works the same on both deployment paths (A and B). The backend resolves
it by looking up the IM entry point's HTTP API by name, so your stack name does not matter.

> If that box says the URL could not be retrieved, this deployment has no IM installed
> (web-only), or the lookup lacks permission — fall back to the CLI / Outputs below;
> both places show the same value. **The Slack URL is only in the Outputs** — the admin
> console's "IM integration" page covers Feishu only.

The CLI way (script deployments, automation, and Slack). `ImStack` emits two CfnOutputs:

```bash
aws cloudformation describe-stacks --stack-name ImStack --region <REGION> \
  --query 'Stacks[0].Outputs[?OutputKey==`FeishuWebhookUrl`||OutputKey==`SlackWebhookUrl`]' \
  --output table
```

It looks like `https://<random>.execute-api.<region>.amazonaws.com/`. **Keep the trailing `/`.**

The same URL serves everything: Feishu's *Events* and *Callbacks*; Slack's *Events*,
*Interactivity* and *Slash Commands*. The HTTP API uses a `$default` catch-all route (any
method, any path reaches the ingress function), which routes on the request body, not on
the path — so appending a sub-path still works, but paste it exactly as the output gives it.

> 📌 **This URL changed shape on 2026-09-01.** It used to be a Lambda Function URL
> (`https://<random>.lambda-url.<region>.on.aws/`); there is now an API Gateway HTTP API in
> front of the ingress function. The reasoning and the trade-offs are in §4. **If you are
> upgrading an older deployment, the URL changes** — read the outputs again and re-paste the
> new URL in §1.3 / §1.4 (or §2.3). The old address is not preserved.

> 🅰️ **If you deployed one-click (path A)**: you have no `ImStack` — IM is an **add-on of the
> main stack** (the **What to install** parameter set to `web+feishu` or `web+slack`, see
> [DEPLOYMENT_ONECLICK.en.md §2.11](DEPLOYMENT_ONECLICK.en.md#211-add-an-im-bot-feishulark-or-slack)).
> Only these four things differ; every step in §1 / §2 applies as written:
> - **Read the URL from the main stack's Outputs**: in the command above, replace
>   `--stack-name` with your stack name (`notiops` by default). The output keys are
>   identical, plus there's an `ImNextSteps` output telling you which step is still pending.
> - **The secret names are identical** (`notiops/im-bot-feishu` / `notiops/slack-bot-token` /
>   `notiops/slack-signing-secret`), so every command in this document works as-is.
> - **You create the two Slack secrets yourself** (`aws secretsmanager create-secret`, see
>   §2.2) — the template creates no secrets; the Feishu one is created for you by the backend
>   when you save the credentials on the admin console's "IM integration" page.
> - **Your install option must include the platform you're configuring**: a web-only stack has
>   no such HTTP API, and no `FeishuWebhookUrl` / `SlackWebhookUrl` output.

---

## 1. Feishu

### 1.1 Scopes: the switch needs none, but **add one reaction scope**

Long connection and webhook use the same set of scopes — the switch itself changes
nothing. Keep exactly what your app already has (for a new deployment, see the importable
JSON in step 4 of [DEPLOYMENT.en.md](DEPLOYMENT.en.md) §3.1):

```
cardkit:card:read / cardkit:card:write / cardkit:template:read
im:chat / im:chat.access_event.bot_p2p_chat:read
im:message / im:message.group_at_msg:readonly / im:message.p2p_msg:readonly
im:message:readonly / im:message:send_as_bot / im:resource
```

⚠️ **As of 2026-09-03 there is one more: `im:message.reaction:write`** (it puts a 👀
reaction on the user's message *before* the "thinking" card, so the "got it"
acknowledgement drops from seconds to milliseconds). It is **optional**:

- With it: you see the reaction immediately, then the card.
- Without it: the call returns a non-zero code and the ingress log gets one
  `quick_ack.feishu: reactions.create code=…` WARNING. **The answer is completely
  unaffected** — you just lose the instant acknowledgement.

After adding it you must **publish a new version** under Version Management & Release for
it to take effect (Feishu ships scopes with the version; saving on the scopes page alone
does nothing).

**Asking about an older message needs no extra scope.** When you reply (or reply in
thread) to any earlier message — someone else's, NotiOps's own, or yours — and then ask
NotiOps about it, it reads that message's body with the `im:message` /
`im:message:readonly` scopes already listed above. When it can't (the bot isn't in that
conversation, the message was recalled, or it only contains images/files with no text) it
**tells you so explicitly** and answers from your sentence alone — it never silently
pretends there was no quote.

### 1.2 Get the two keys (**order matters**)

In long-connection mode `Encrypt Key` and `Verification Token` are **unused** — so if
you are switching over from long connection, those two keys in the secret are probably
**empty strings** (`app_id` / `app_secret` have values, these two do not). In webhook
mode they are the **only** authentication mechanism: the ingress function validates them
at cold start and crashes outright if either is empty (see "hard constraint A" in the
header of [lambda_ingress.py](../platforms/feishu/lambda_ingress.py)). That is
deliberate — better a Lambda that will not boot than a public endpoint anyone can forge
requests against. **So this step is not "double-check it", it is mandatory.**

Self-check (prints key names and empty/non-empty only, never values):

```bash
aws secretsmanager get-secret-value --secret-id notiops/im-bot-feishu \
  --region <REGION> --query SecretString --output text \
| python3 -c 'import json,sys
d = json.load(sys.stdin)
for k in sorted(d):
    print("  %s: %s" % (k, "NON-EMPTY" if str(d[k]).strip() else "EMPTY"))'
```

1. Feishu Open Platform → your app → **Events & Callbacks → Encryption Strategy**
   - **Encrypt Key**: supply your own random string (≥32 chars recommended). Generate one:
     ```bash
     openssl rand -hex 24
     ```
   - **Verification Token**: shown on that same page — **copy it**.

2. Store both values (**do this before filling in the request URL**). Two ways — pick one:

   **Recommended · admin console** (no CLI, no credentials): in the web UI, go to
   **Admin → IM Integration** and fill in `Encrypt Key` / `Verification Token` (same form as
   `App ID` / `App Secret`), then Save. That page also carries the four-step summary of the
   Feishu-side work plus a "View the detailed setup steps" right-hand drawer whose content
   mirrors this document — this is the path for customers who only have a browser.

   After saving, the page only echoes the last 4 chars (`****xxxx`); **sending a masked value
   back means "keep unchanged"**, so you can edit the target chats later without re-entering the
   keys. An **unset key renders as a blank field** (not `****`) — blank means not configured yet.

   **Alternative · CLI** (for automation / fleet deployments):
   ```bash
   # Read the existing JSON first and edit it — do not overwrite wholesale;
   # app_id / app_secret and the other keys must survive untouched.
   aws secretsmanager get-secret-value --secret-id notiops/im-bot-feishu \
     --region <REGION> --query SecretString --output text > /tmp/fs.json

   # Edit /tmp/fs.json and add these two keys:
   #   "encrypt_key": "<generated in step 1>",
   #   "verification_token": "<copied in step 1>"

   aws secretsmanager put-secret-value --secret-id notiops/im-bot-feishu \
     --region <REGION> --secret-string file:///tmp/fs.json
   rm -f /tmp/fs.json
   ```

> **Why the order cannot be reversed**: when you save the request URL in step 3, Feishu
> immediately sends a URL challenge. If `encrypt_key` is not in the secret yet, the
> ingress function crashes on cold start and Feishu reports "verification failed" —
> which looks like a misconfigured URL.

### 1.3 Event config: long connection → developer server

**Events & Callbacks → Event Configuration**:

| Field | Set to |
|---|---|
| Delivery mode | from "Receive events via long connection" → **"Send events to developer server"** |
| Request URL | the `FeishuWebhookUrl` from step 0 |
| Subscribed events | confirm `im.message.receive_v1` is in the list (it already is — leave it) |

Feishu runs the URL challenge on save; green means it passed.

### 1.4 Callback config: the same URL

**Events & Callbacks → Callback Configuration**:

| Field | Set to |
|---|---|
| Delivery mode | → **"Send callbacks to developer server"** |
| Request URL | the **same** `FeishuWebhookUrl` |
| Subscribed callbacks | confirm `card.action.trigger` (every card button depends on it; miss it and buttons do nothing) |

> Feishu enforces a **~3s hard timeout** on the card-button path. The ingress function
> hands the work off to the worker asynchronously and returns an empty response
> immediately; the real work happens in the worker, which then PATCHes the card. So
> after clicking a button you get "the card updates itself a moment later", not a
> spinner.

### 1.5 Verify

In a group chat, `@bot hello` → it should reply. Then:

```bash
aws logs tail /aws/lambda/notiops-im-ingress-feishu --region <REGION> --since 5m
aws logs tail /aws/lambda/notiops-im-worker-feishu  --region <REGION> --since 5m
```

- ingress logs but no worker logs → signature check passed but the async handoff failed
  (read the ingress error)
- `401 (signature/token)` in ingress → the two keys do not match the console; back to §1.2
- neither logs anything → Feishu never sent it; check that the delivery mode really
  moved off long connection

**If Feishu says "verification failed", or a manual `curl` returns
`HTTP 500 {"message":"Internal Server Error"}`, first tell the two causes apart** — they look
identical from the outside but need opposite fixes:

```bash
aws logs tail /aws/lambda/notiops-im-ingress-feishu --region <REGION> --since 5m \
  | grep -E "INIT_REPORT|RuntimeError|Task timed out"
```

| In the log | Means | What to do |
|---|---|---|
| `RuntimeError: feishu secret missing encrypt_key/verification_token` | **The keys are not set** and the ingress crashes on cold start — this fail-fast is deliberate (§1.2 / §4.2 item 1) | Go back to §1.2, write both keys into the secret, then re-enter the request URL |
| `INIT_REPORT ... Status: timeout`, but the `REPORT` line in the same log says `Memory Size: 2048 MB` and there is **no** `Task timed out` | **Normal, nothing to do** (as of 2026-09-02). Init doesn't fit Lambda's hard 10s INIT limit, so Lambda re-runs it inside the first invoke and that invoke succeeds (`Duration` ~10.4s < `Timeout=20`). A cold request does exceed Feishu's 3s, but that is what the keep-alive in §5 is for | Just confirm `MemorySize=2048` / `Timeout=20` were not lowered (next row), then check that the keep-alive rule exists (§5.2) |
| Same, but `Memory Size` is **below 2048 MB**, or you see `Task timed out after 10.00 seconds` | The ingress **memory/timeout was lowered** — the init re-run also hits the function timeout, so the entry point returns 500 for every request | *This* is the regression — the ingress must be `MemorySize=2048` / `Timeout=20` (1024 MB is not enough either — the comments on those two lines in `im-core.ts` record all three measurements) |
| Nothing at all (not even `INIT_START`) | The request never reached Lambda | Wrong URL, or the §0 output was read off a different stack |

### 1.6 Rollback

⚠️ **As of 2026-09-03 (IM refactor M2), rollback is no longer "flip one switch"**:
`BotStack` (the ECS Fargate long connection) has been retired — `infra/bin/app.ts` no
longer instantiates it, so a fresh install has none of those containers. The webhook is
the **only** IM runtime path.

If you really need the long connection back, the order is:

1. Add `new BotStack(...)` back to `infra/bin/app.ts` (the source and the three
   Dockerfiles are **deliberately kept** in the repo for exactly this);
2. Install `finch` or `docker` (the 5 `ContainerImage.fromAsset("../")` calls in
   `BotStack` need it);
3. `cd infra && npx cdk deploy BotStack` (creates VPC / ECS / ECR and builds the images,
   ~20 min);
4. Only then set the **delivery mode in §1.3 / §1.4 back to "long connection"**.

**Accounts installed before M2** may still have `BotStack` (at `desiredCount=1` — running
and billing as Fargate, but receiving no events; the Slack one additionally crash-loops
because Socket Mode is off, which is expected). There, rollback is still a matter of
minutes: just change the delivery mode. Once you are sure you will not roll back, delete
the whole stack to stop paying for it (it publishes **no CFN Exports**, so no other stack
can reference it):

```bash
aws cloudformation delete-stack --stack-name BotStack --region <REGION>
# Or scale to 0 first, keeping the rollback option:
aws ecs update-service --cluster <BotStack cluster> \
  --service <FeishuBotService> --desired-count 0 --region <REGION>
```

---

## 2. Slack (new app)

### 2.1 Create the app + scopes

[api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch.

**OAuth & Permissions → Bot Token Scopes**:

| Scope | What it does | Symptom if missing |
|---|---|---|
| `app_mentions:read` | receive `@bot` | no reaction to @ in channels |
| `chat:write` | send messages / update cards | cannot send anything at all |
| `im:history` | read DM text | bot receives empty messages in DMs |
| `im:write` | send in DMs | no reply in DMs |
| `channels:history` | read public-channel conversations (thread follow-ups) | follow-ups in a thread do nothing |
| `groups:history` | read private-channel conversations | same, private channels |
| `commands` | slash commands | `/devops` reports dispatch_failed |
| `reactions:write` | 👀 reaction right after the question (instant ack) | **only the reaction is lost, the answer is unaffected**; the log shows `quick_ack.slack: reactions.add error=missing_scope` |
| `mpim:history` | read **group DMs** (multi-person DMs) | follow-ups in a group DM do nothing; asking about an older message can't read it there |

Install to the workspace and collect the `xoxb-...` token.

**Asking about an older message uses those same `*:history` scopes — nothing extra to
add.** Slack has no "quoted message" event field: replying inside that message's thread
is the only form it takes, so NotiOps reads the **thread's parent message**
(`conversations.replies`, first message only). NotiOps's own messages are Block Kit
cards whose text lives in `blocks` rather than `text`; both are read. When it can't read
it, it **says so** and then answers from your sentence alone — never silently.

> ⚠️ **Do not enable Socket Mode.** Socket Mode and webhooks are mutually exclusive —
> with it on, Slack stops sending requests to your Request URL. You also do not need an
> App-Level Token (`xapp-...`); that belonged to the long-connection design.

### 2.2 Two secrets

```bash
# Bot Token (OAuth & Permissions page, starts with xoxb-)
aws secretsmanager put-secret-value --secret-id notiops/slack-bot-token \
  --region <REGION> --secret-string 'xoxb-...'

# Signing Secret (Basic Information → App Credentials)
aws secretsmanager put-secret-value --secret-id notiops/slack-signing-secret \
  --region <REGION> --secret-string '<signing secret>'
```

Two things you must know first:

1. **`notiops/slack-signing-secret` is created by `NotiOpsBackendStack` (the main
   stack)**, not by `ImStack`. If you are upgrading an older Socket Mode deployment the
   secret did not exist before (Socket Mode authenticated with the App Token and had no
   use for it) — deploying `ImStack` alone is not enough. Deploy the main stack once
   first, or `put-secret-value` fails with `ResourceNotFoundException`.

2. ⚠️ **These two secrets are not empty — they hold a CDK-generated random string.**
   When `new secretsmanager.Secret(...)` is created without a `secretStringValue`,
   Secrets Manager **generates a random value** (not an empty string). The consequence:
   forgetting to fill them in does not surface as "secret is empty", it surfaces as
   "wrong credential" —
   - bot token not filled in → Slack returns `invalid_auth` and the bot cannot say a word;
   - signing secret not filled in → every request fails signature validation with 401 and
     Slack reports that URL verification failed.

   To tell whether they were ever filled in (without printing values): `LastChangedDate`
   must be clearly later than `CreatedDate`.
   ```bash
   aws secretsmanager describe-secret --secret-id notiops/slack-signing-secret \
     --region <REGION> --query '{Created:CreatedDate,LastChanged:LastChangedDate}'
   ```

### 2.3 Three Request URL fields — all the same value

`SlackWebhookUrl`, character-for-character identical in all three places:

1. **Event Subscriptions** → Enable Events → Request URL.
   Slack sends `url_verification` the moment you save and the ingress function answers
   the challenge (**fill in the signing secret from §2.2 first**, otherwise validation
   fails). Then under **Subscribe to bot events** add:
   `app_mention` · `message.im` · `message.channels` · `message.groups`
2. **Interactivity & Shortcuts** → turn on → Request URL (buttons and modal submissions
   both go here)
3. **Slash Commands** → Create New Command for each one; the Request URL is the same

### 2.4 Slash commands

| Command | What it does |
|---|---|
| `/devops` | talk to the DevOps Agent directly (0 tokens) |
| `/investigate` | start a deep investigation |
| `/case` · `/cases` | cases: open / list / view / reply |
| `/model` | switch model (`/model list` shows the catalog) |
| `/language` | switch language (`/language zh` \| `/language en`) |
| `/skills` | list the available skills |
| `/help` | command menu |

> ⚠️ Slack command names accept only lowercase letters, digits, hyphens and
> underscores, so **Chinese slash commands cannot be registered** (on Feishu `/调查`
> and `/开案例` work fine). The Chinese entry points on Slack are the other two, both
> fully supported: **Chinese natural language** ("帮我调查一下 xxx", "我要开案例") and
> **`@bot 调查 xxx`**. Switching language also understands Chinese phrasing
> ("切换成中文").

### 2.5 Verify

In a channel, `/invite @your-bot`, then `@bot hi`; then try `/help`.

```bash
aws logs tail /aws/lambda/notiops-im-ingress-slack --region <REGION> --since 5m
aws logs tail /aws/lambda/notiops-im-worker-slack  --region <REGION> --since 5m
```

Two Slack-specific gotchas:

- **`dispatch_failed` / 3s timeout**: the ingress cold start was too slow. The second
  attempt works. If it never stops, the secrets are wrong — check the ingress logs for
  401s.
- **A button says "failed to open the dialog, please try again"**: Slack's `trigger_id`
  is valid for only ~3 seconds and the worker starts asynchronously, so a cold start can
  miss the window. The worker automatically posts a message with a "try again" button;
  one click opens it immediately. This is **by design**, not a failure (see item 2 in the
  header of [lambda_worker.py](../platforms/slack/lambda_worker.py)).

---

## 3. Chat allowlist (optional, both platforms)

Restrict the bot to specific groups / channels:

```bash
cd infra && npx cdk deploy ImStack --output ../.cdk-out --region <REGION> \
  -c imAllowedChatIds="oc_xxx,C0123ABC"
```

Feishu takes chat ids starting with `oc_`, Slack takes channel ids starting with `C` or
`D`, comma-separated. Leave it empty for no restriction (same behaviour as the
long-connection design).

---

## 4. Security boundary of the public endpoint

### 4.1 Shape of the entry point: API Gateway HTTP API → ingress Lambda

```
Feishu / Slack ──HTTPS POST──▶ API Gateway HTTP API ($default catch-all, no auth)
                                       │  principal = apigateway.amazonaws.com
                                       ▼
                               ingress Lambda (verify + decrypt → async invoke worker)
```

**The entry point is unauthenticated, and it has to be** — Feishu and Slack only ever send
ordinary HTTPS requests; they will not SigV4-sign anything for you. The real gate is at the
**body** level: Feishu with Encrypt Key (signature + AES decryption) and Verification Token,
Slack with the signing secret (HMAC). That has never changed.

**Why there is now an API Gateway in front** (changed 2026-09-01): the previous design hit
the ingress Lambda through a Function URL, and receiving a plain HTTP POST there requires
`AuthType=NONE` — which is equivalent to writing `Principal: "*"` +
`lambda:InvokeFunctionUrl` into the function's resource policy. That **policy shape** is what
cloud security baselines and automated detectors flag as "this function is open to the
world", and some of them **strip that permission automatically**. The result is a 403 for
everybody (Feishu included), the whole IM path silently dead, and every redeploy putting the
permission back so it can be stripped again. The detector sees the policy shape; it cannot
see that we validate a signature over the request body, so there is no exemption to ask for.

With an HTTP API, the Lambda resource policy's principal is `apigateway.amazonaws.com`
scoped to that API's ARN (no `*` anywhere), and no Function URL is created at all — the shape
is gone. **This changes how "publicly reachable" is expressed, not how strongly the endpoint
is authenticated**: it was unauthenticated before and it is unauthenticated now.

Two alternatives that were ruled out, recorded so nobody re-walks them:

- **CloudFront + OAC + Function URL**: OAC requires the Function URL to be
  `AuthType=AWS_IAM`, and AWS documentation is explicit that with `POST`/`PUT` to a Function
  URL the **caller** must compute the SHA256 of the body and send `x-amz-content-sha256`
  ("Lambda doesn't support unsigned payloads"). Feishu and Slack are generic webhook senders
  and will never add that header — this route cannot work for inbound webhooks.
- **REST API instead of HTTP API**: REST API can take a WAF, but it costs 3.5× more and takes
  minutes to create (which one-click deployment cares about). We chose HTTP API, and the price
  is that **it cannot take a WAF** (only REST API can); the compensation is the two throttling
  layers in item 2 below. Customers who need a WAF can put CloudFront + WAF in front
  themselves — for an HTTP API that is an ordinary custom origin, without the Function URL
  payload-signing restriction.

### 4.2 Five measures

1. **Fail-fast signature validation** — Feishu refuses to cold-start if either key is
   missing; Slack validation uses stdlib HMAC with `compare_digest` and rejects requests
   whose timestamp is off by more than 300s (replay protection).
2. **Two throttling layers** — the HTTP API stage is capped at 50 req/s with a burst of 100
   (excess requests are rejected with 429 by API Gateway and **never reach Lambda**, so they
   cost no Lambda time), and the ingress function additionally carries
   `reservedConcurrentExecutions=10`. Real IM event volume is orders of magnitude below both.
3. **Chat allowlist** (§3).
4. **Idempotent de-duplication** — the worker records `event_id` in DynamoDB, so a
   repeated delivery is processed once (Slack's Events API retries reuse the same
   `event_id`).
5. **The backend is still read-only** — even a forged message that somehow passes signature
   validation (which would mean the keys leaked) only gets read-only agent output back; there
   is no write permission anywhere behind it.

On the logging side: `encrypt_key` / `verification_token` / `app_secret` and the signing
secret are **never logged, not even their length** — only the exception type name (see
[LOGGING_STANDARD.md](LOGGING_STANDARD.md)).

### 4.3 Residual risks, stated plainly

1. **Anyone can trigger one invocation.** The endpoint is unauthenticated, and a request that
   fails signature validation has already spent one Lambda execution. The two throttling
   layers in 4.2 put a computable ceiling on that cost, but it is **not zero**.
2. **The pre-authentication attack surface is the IM platform SDK.** On the Feishu path,
   signature validation and AES decryption happen inside `lark-oapi`; the only code of ours
   that runs before it is one event-shape parser. An SDK vulnerability is exposed there.
   Mitigation: the SDK version is pinned and upgraded with releases.
3. **No source-IP restriction.** Feishu and Slack both publish their egress IP ranges, so in
   principle only those could be allowed. We do not: those ranges change, and hard-coding
   them turns into "one morning the bot stops answering" with no log that points at the
   cause. Customers who want this layer can add CloudFront + WAF in front of the HTTP API and
   use an IP-set rule (it does not affect any configuration step in this document).

## 5. Cold starts and the keep-alive ping (every 4 minutes)

### 5.1 The problem: a 3-second hard timeout against a cold start of well over ten seconds

Two numbers decide the whole thing:

| | Measured |
|---|---|
| ingress cold start (**after the 2026-09-02 deploy**) | **~20s**: INIT hits the ceiling and is reported as `Init Duration: 9999.98 ms / Status: timeout`, Lambda re-runs init inside the first invoke, and that invoke takes `Duration: 10419.69 ms` (**it succeeds**, because `Timeout=20`) |
| the same function when **warm** | **~3.6ms** (`Duration: 3.62 ms`, same execution environment, no INIT line) |
| Feishu / Slack webhook timeout | **~3s hard limit** (platform side, not adjustable) |

In other words: **once the container has been frozen, the user's next action is guaranteed to
time out.** The cold start can't be pushed down — it's `import lark_oapi` / `slack_sdk` plus
boto3 plus one `GetSecretValue`. The long comment above `FeishuIngress` in `im-core.ts` records
the measurements at three memory sizes; it is also why ingress must stay at `MemorySize=2048`
/ `Timeout=20` (the row in §1.5's table).

> ⚠️ **This number changed on 2026-09-02, and not in a good direction.** The previous measurement
> had init *completing* in 8.65s (`Phase: init Status: error`, leaving ~1.35s of headroom at
> 2048 MB). That headroom is now gone: init runs straight into Lambda's **hard 10s INIT limit**.
> Nothing regressed functionally (a cold webhook request was already over the 3s budget, and the
> re-run still finishes inside `Timeout=20` and returns normally), but two things follow:
> ① **`Timeout=20` is now a hard requirement, not headroom** — lowering it below 10s makes the
> cold invocation *fail* rather than merely be slow; ② **`INIT_REPORT ... Status: timeout` is no
> longer a signal that the memory was lowered** (see §1.5's table for how to tell them apart).
> The only way to push it back down is to do less work during init; adding memory won't help
> (2048 MB is already past the 1769 MB single-vCPU point, and Python imports are serial).

Three actions sit right on that 3-second line:

- the URL challenge Feishu runs when you **save the request URL** under Events & Callbacks;
- Feishu `card.action.trigger` — the user **clicking a card button**;
- Slack Events API / Interactivity.

What it looks like in production: the first click on "Save" makes Feishu report **"request
timed out after 3 seconds"**; clicking again immediately succeeds. During setup there is at
least that natural retry — **card buttons have none**, so the user just sees "action failed",
and the next click (container now warm) works. That makes it look like a random glitch, which
is the hardest kind to chase.

### 5.2 What we do: EventBridge pings each ingress every 4 minutes

Each ingress function gets its own `rate(4 minutes)` EventBridge rule whose constant input is
the sentinel `{"notiops_warmup": true}`; the handler recognises it on the first line and
returns early (`platforms/common/warmup.py`). Four minutes is empirical — "more often than
Lambda reclaims an idle execution environment". Reclamation has no SLA; in practice it is
> 5 minutes.

**Cost**: 10,800 invocations/month × ~2ms @2048MB ≈ **$0.003/month**, EventBridge and Lambda
request charges included.

**Both deployment paths have the rule.** The only difference is its physical name:

| | Rule name | Why |
|---|---|---|
| Path B (`setup.sh`) | `notiops-im-keepalive-ingress-feishu` / `-ingress-slack` | Fixed name, easy to find in the console |
| Path A (one-click CFN) | generated by CloudFormation | Both paths may be installed in the **same account**; a hard-coded name would collide (already-exists) |

To confirm it is running:

```bash
# rule exists and is ENABLED (for path A, use --name-prefix <StackName>)
aws events list-rules --name-prefix notiops-im-keepalive --region <REGION> \
  --query 'Rules[].{Name:Name,State:State,Schedule:ScheduleExpression}'

# one warmup every 4 minutes in the ingress log (healthy shape: only REPORT lines, no business logs)
aws logs tail /aws/lambda/notiops-im-ingress-feishu --region <REGION> --since 10m
```

### 5.3 Where this stops working, stated plainly

The keep-alive holds **one** execution environment warm. Real concurrency — several chats
sending events at once, or a batch of investigation-progress cards refreshing — still scales
out to cold containers, and those requests can still time out. The rule fixes the **vast
majority** of cases (one person acting, low event rate); it is **not a mathematical
elimination**.

The only complete fix is **provisioned concurrency**: 2048MB resident ≈ **$21/month**. We did
not make that the default because this is an open-source project — charging everyone who
installs it $21/month for an edge case most of them will never notice is the wrong trade.
**Customers who care about that case can turn it on themselves** (it changes none of the
configuration steps in this document):

```bash
aws lambda put-provisioned-concurrency-config \
  --function-name notiops-im-ingress-feishu --qualifier <version or alias> \
  --provisioned-concurrent-executions 1 --region <REGION>
```

> ⚠️ Provisioned concurrency can only be attached to a **version or alias**, never to
> `$LATEST`, so every deployment means publishing a new version and moving the config. That is
> the other half of why it isn't the default.

---

## 6. What the bot's replies look like

Configuration is done; this section is for the people who will use the bot: **how long a
question takes, and what is on screen while it takes that long**. It is spelled out because
the most common "outage" turns out not to be one — it is a wait with no feedback.

### 6.1 Ask a question → a "thinking" card, immediately

The moment you send a question you get a card back:

```
🤔 Thinking · 3s elapsed
Got it — the DevOps Agent is working on this. Complex questions can take a
few minutes; progress and the answer will both update in this card, so no
need to ask again.
```

Then **that card changes by itself**: the seconds in the title tick up, a **Progress**
section appears in the middle (what the bot is looking at, which API it just called), and
when the run finishes the whole card turns into the final answer with two buttons at the
bottom (**escalate to a deep investigation** / **open a support case**).

**There is only ever this one card** — you will not get a stream of new messages. So:

- **Don't re-send the question.** A second send starts a second run; both then race to answer.
- Seconds ticking up = still alive. Genuinely stuck means the seconds stopped.

> **Why this deserves its own section**: run times vary enormously. "How many S3 buckets do
> I have" comes back in seconds; "list all S3 buckets **and their sizes**" took **347
> seconds** in a real deployment — with many buckets it has to ask for metrics one bucket at
> a time. Previously those 347 seconds were completely silent, which looks exactly like a
> dead backend.

### 6.2 The refresh rate slows down **on purpose**

| Elapsed | Card refresh interval |
|---|---|
| 0–30s | 2s |
| 30–120s | 5s |
| beyond 120s | 10s |

In the first 30 seconds you are probably watching the screen, so it refreshes often. For a
question that runs for minutes you have long since moved on, and refreshing every 2 seconds
would only hit Feishu / Slack rate limits (Slack suggests ~1 request per second per channel)
and make the card look frozen.

If the card is **deleted** (or fails to update three times in a row for any other reason) the
bot stops refreshing it — but **the answer is never dropped**: it posts a new message
instead, and falls back to plain text only if that fails too.

### 6.3 Deep investigation: a progress card plus a report card at the end

`@bot investigate <question>` (or `/investigate`) takes a different route: the DevOps Agent
runs it in the background, **without occupying your chat**. You get two cards:

1. a **progress card**, refreshed once a minute (accepted → investigating → completed);
2. a **final report card**, posted back to the **same conversation** when the run finishes,
   with a summary plus a **report link** and a trace link.

> ⚠️ The report link is an **S3 presigned URL valid for 7 days** — not a permanent link, and
> not a CloudFront URL. Download the file if you need to keep it.
>
> ⚠️ Only the case where the progress card reaches "completed" and the report card **never
> arrives** is a real failure. That means the chat-routing row (`task#<task_id>`) was not
> written when the investigation started; see the "investigation results" section of
> [im-bot-interaction.md](im-bot-interaction.md).

### 6.4 The case-created card has exactly two buttons

Once a case is open, the success card carries "**View case**" (jumps to the AWS console) and
"**View all cases**".

**There is no "start an agent investigation" button**, and that is deliberate: opening a case
and starting an investigation are two independent decisions. Making the second one a button
on the first one's success card makes that card read as if the case alone were not enough.
If you want an investigation, just ask (`/investigate`, or "investigate this for me").

> **Older cards already posted** in a conversation may still carry that button — clicking it
> still works; it will not dead-click.
