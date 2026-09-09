# IM Webhook Setup (Feishu / Slack / DingTalk)

Feishu, Slack and DingTalk all run on an **API Gateway HTTP API + Lambda webhook** — no
long-lived containers, no persistent socket. This document only covers **what you click in
the IM platform console**, and it is the step you do **after the deployment finishes**.

> **Three kinds of reader, all covered**:
> - **One-click (path A)**: you set **What to install** to `web+feishu` / `web+slack` /
>   `web+dingtalk` on the parameters page (see
>   [DEPLOYMENT_ONECLICK.en.md §2.11](DEPLOYMENT_ONECLICK.en.md#211-add-an-im-bot-feishulark-or-slack)),
>   the stack is up, and this document is all that's left — read the 🅰️ note in §0 (four
>   differences, that's all), then follow §1 / §2 / §3.
> - **New deployment (path B, `setup.sh`)**: first follow [DEPLOYMENT.en.md](DEPLOYMENT.en.md)
>   §3 to create the app, set the scopes and collect the keys; run `setup.sh`; then come back
>   here to fill in the request URL.
> - **Existing long-connection deployment**: for Feishu this is an **in-place switch** —
>   you do not create a new app and you do not change any scope; you change only
>   "delivery mode + request URL", plus add the two keys (§1.2).
>   **DingTalk has no such path**: its long-connection runtime (Fargate) is retired, so
>   follow §3 and create a new internal app.
>
> ⚠️ **The order is not optional**: fill in the request URL only after the stack is
> deployed **and** the keys are written into the secret. Getting it backwards shows up as
> "verification failed" in the Feishu / Slack console, which looks like a wrong URL.
> **DingTalk doesn't even show that** — it validates nothing when you save the address; the
> robot simply never replies (see §3.4).

### 🔴 IM platforms supported in this release: Feishu / Lark, Slack, DingTalk

| Platform | This release | Notes |
|---|:--:|---|
| Feishu / Lark | ✅ | Lambda webhook, §1 below |
| Slack | ✅ | Lambda webhook, §2 below |
| DingTalk | ✅ | Lambda webhook, §3 below (since 2026-09-08) |
| Microsoft Teams | ❌ **not available** | `platforms/teams/` is an empty directory — design intent, no implementation |

> Microsoft Teams is a **known to-do**, not part of this release. To use NotiOps from
> Teams today, the only option is the Web Chat in a browser — its capability set matches
> the IM side.

---

## 0. Get the webhook URL first

**The easy way: admin console → "IM integration" → switch to your platform's tab →
"View the detailed setup steps" → step 3.** This deployment's real URL is shown right there
with a Copy button — no CloudFormation console, no CLI, and it works the same on both
deployment paths (A and B). The backend resolves it by looking up the IM entry point's
HTTP API by name, so your stack name does not matter.

> **That page covers Feishu and DingTalk** (separate tabs and separate drawers, each
> resolving its own entry point). **The Slack URL is only in the Outputs.**
>
> If the box says the URL could not be retrieved, this deployment has no such platform
> installed (web-only, or Feishu-only while you're looking at the DingTalk tab), or the
> lookup lacks permission — fall back to the CLI / Outputs below; both places show the
> same value.

The CLI way (script deployments, automation, and Slack). `ImStack` emits one CfnOutput per
installed platform:

```bash
aws cloudformation describe-stacks --stack-name ImStack --region <REGION> \
  --query 'Stacks[0].Outputs[?OutputKey==`FeishuWebhookUrl`||OutputKey==`SlackWebhookUrl`||OutputKey==`DingtalkWebhookUrl`]' \
  --output table
```

It looks like `https://<random>.execute-api.<region>.amazonaws.com/`. **Keep the trailing `/`.**

Each platform gets **its own** HTTP API and ingress (`FeishuWebhookUrl` /
`SlackWebhookUrl` / `DingtalkWebhookUrl` are three different addresses — don't cross them).
Within one platform, though, there is only one URL: Feishu's *Events* and *Callbacks* take
the same value; so do Slack's *Events*, *Interactivity* and *Slash Commands*; DingTalk has
only the one "message receiving address".
The HTTP API uses a `$default` catch-all route (any
method, any path reaches the ingress function), which routes on the request body, not on
the path — so appending a sub-path still works, but paste it exactly as the output gives it.

> 📌 **This URL changed shape on 2026-09-01.** It used to be a Lambda Function URL
> (`https://<random>.lambda-url.<region>.on.aws/`); there is now an API Gateway HTTP API in
> front of the ingress function. The reasoning and the trade-offs are in §5. **If you are
> upgrading an older deployment, the URL changes** — read the outputs again and re-paste the
> new URL in §1.3 / §1.4 (or §2.3 / §3.4). The old address is not preserved.

> 🅰️ **If you deployed one-click (path A)**: you have no `ImStack` — IM is an **add-on of the
> main stack** (the **What to install** parameter set to `web+feishu`, `web+slack` or
> `web+dingtalk`, see
> [DEPLOYMENT_ONECLICK.en.md §2.11](DEPLOYMENT_ONECLICK.en.md#211-add-an-im-bot-feishulark-or-slack)).
> Only these four things differ; every step in §1 / §2 / §3 applies as written:
> - **Read the URL from the main stack's Outputs**: in the command above, replace
>   `--stack-name` with your stack name (`notiops` by default). The output keys are
>   identical, plus there's an `ImNextSteps` output telling you which step is still pending.
> - **The secret names are identical** (`notiops/im-bot-feishu` / `notiops/im-bot-dingtalk` /
>   `notiops/slack-bot-token` / `notiops/slack-signing-secret`), so every command in this
>   document works as-is.
> - **You create the two Slack secrets yourself** (`aws secretsmanager create-secret`, see
>   §2.2) — the template creates no secrets; the **Feishu and DingTalk** ones are created for
>   you by the backend when you save the credentials on the admin console's "IM integration"
>   page.
> - **Your install option must include the platform you're configuring**: a web-only stack has
>   no such HTTP API, and no `FeishuWebhookUrl` / `SlackWebhookUrl` / `DingtalkWebhookUrl`
>   output. ⚠️ **Path A installs one IM platform at a time** — `web+feishu` / `web+slack` /
>   `web+dingtalk` are mutually exclusive. To run two IM platforms at once, use path B
>   (`setup.sh` accepts multiple picks).

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

> ⚠️ **Those two names only hold for Option B (`./setup.sh`). Option A (one-click) must
> resolve them first.** The same applies to every `/aws/lambda/notiops-im-*` later in this file.
>
> Why: under Option A the function names carry the stack-name prefix
> (`<stack-name>-im-ingress-feishu`, so they cannot collide with a `setup.sh` deployment),
> and the **log group names are CloudFormation-generated**
> (`<stack-name>-FeishuIngressLogs<hash>-<random>`) — they do not even start with
> `/aws/lambda/`, so no amount of stack-name substitution produces them. Option A leaves
> them unnamed on purpose: hard-coding `/aws/lambda/<function>` collides with the group
> the Lambda service creates itself, and `NAME_CONFLICT_VALIDATION` fails the whole stack
> within 9 seconds (see `explicitLogGroupNames` in `infra/lib/constructs/im-core.ts`).
>
> Read them off the stack (the logical-ID prefixes are stable — do not guess the hash):
>
> ```bash
> STACK=<the stack name you entered>   # e.g. notiops
> REGION=<REGION>
> lg() { aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
>   --query "StackResources[?starts_with(LogicalResourceId,'$1')].PhysicalResourceId" --output text; }
>
> aws logs tail "$(lg FeishuIngressLogs)" --region "$REGION" --since 5m
> aws logs tail "$(lg FeishuWorkerLogs)"  --region "$REGION" --since 5m
> # For Slack use SlackIngressLogs / SlackWorkerLogs; the progress poller is ImProgressLogs
> ```
>
> The one exception is the deployment Lambda: its log group **is** hard-coded as
> `/aws/lambda/<stack-name>-stager`.

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
| `RuntimeError: feishu secret missing encrypt_key/verification_token` | **The keys are not set** and the ingress crashes on cold start — this fail-fast is deliberate (§1.2 / §5.2 item 1) | Go back to §1.2, write both keys into the secret, then re-enter the request URL |
| `INIT_REPORT ... Status: timeout`, but the `REPORT` line in the same log says `Memory Size: 2048 MB` and there is **no** `Task timed out` | **Normal, nothing to do** (as of 2026-09-02). Init doesn't fit Lambda's hard 10s INIT limit, so Lambda re-runs it inside the first invoke and that invoke succeeds (`Duration` ~10.4s < `Timeout=20`). A cold request does exceed Feishu's 3s, but that is what the keep-alive in §6 is for | Just confirm `MemorySize=2048` / `Timeout=20` were not lowered (next row), then check that the keep-alive rule exists (§6.2) |
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
   (**this step is optional** — see the end of §2.4: every command also works without the
   slash, and registering only buys you Slack's native `/` autocomplete)

### 2.4 Slash commands

| Command | What it does |
|---|---|
| `/devops` | talk to the DevOps Agent directly (0 tokens) |
| `/agent` | pick which agent answers: `/agent devops` (default, 0 tokens) \| `/agent notiops` (goes through the model, **consumes tokens**); no argument shows the current value |
| `/web` | web search for the NotiOps Agent: `/web on` \| `/web off` (off by default; no effect on the DevOps direct path) |
| `/account` | pick which account you are asking about: `/account <12-digit account id>` \| `/account list` shows what you can pick \| `/account default` goes back to the deployment account; no argument shows the current value |
| `/investigate` | start a deep investigation |
| `/case` · `/cases` | cases: open / list / view / reply |
| `/model` | switch model (`/model list` shows the catalog) |
| `/language` | switch language (`/language zh` \| `/language en`) |
| `/help` | command menu |

> 📌 **Upgrade note: `/skills` was retired from the IM side on 2026-09-06** (the skill
> feature lives on in full in the web console). If you registered it from an older
> version of this guide, **delete it by hand** under **Slash Commands** in your Slack
> App config — that registry lives in your own app, we cannot change it. Leaving it is
> harmless: typing `/skills` returns the command menu at 0 tokens, it just keeps
> showing up in autocomplete.

> ⚠️ Slack command names accept only lowercase letters, digits, hyphens and
> underscores, so **Chinese slash commands cannot be registered** (on Feishu `/调查`,
> `/开案例`, `/智能体` and `/联网` work fine). The Chinese entry points on Slack are the other two, both
> fully supported: **Chinese natural language** ("帮我调查一下 xxx", "我要开案例") and
> **`@bot 调查 xxx`**. Switching language also understands Chinese phrasing
> ("切换成中文").

> 💡 **Registering the slash commands is optional — every command above also works
> without the slash.** The leading slash is optional in the parser itself
> ([`core/nl_router.py`](../core/nl_router.py), `_cmd()`: `^\s*/?\s*(?:...)`), so
> `@bot agent notiops`, `@bot web on`, `@bot 智能体 notiops` and `@bot 联网 on` are
> **exactly equivalent** to `/agent notiops` and `/web on` (in a DM you can drop the
> `@bot` too). Registering only buys Slack's native `/` autocomplete and argument hints.
>
> Why we cannot register them for you: the slash-command registry lives in **your own
> Slack app configuration**, and changing it needs a workspace configuration token (write
> access, expires in 12 hours, only a human can mint it in the Slack admin UI) — NotiOps
> does not hold, and does not want to hold, write credentials for your IM. Feishu has no
> such registry (`/智能体` is just message text), which is why nothing is needed there.
>
> **What it looks like when you skip it**: the Slack client intercepts it on the spot
> (Slackbot answers "that is not a valid command") and the request never reaches API
> Gateway — so there is nothing in the ingress / worker logs; don't go looking. That is a
> different failure from `dispatch_failed`, which means the command **is** registered but
> nothing answered within 3 seconds (see §2.5).

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

## 3. DingTalk (create a new internal app)

> Unlike the Feishu section, DingTalk is a **new app** — there is no in-place cutover.
> DingTalk's only previous runtime was the retired Fargate long-connection stack; this
> path is a Lambda webhook.
>
> **Every step below can be done in a browser alone**: admin console → "IM integration" →
> switch to the **DingTalk** tab → "View the detailed setup steps" in the top right. The
> drawer has the same steps and gives you this deployment's callback URL with a Copy
> button. It maps one-to-one onto this section (source:
> [`content/dingtalkGuide.ts`](../frontend/chat-app/src/content/dingtalkGuide.ts)).
> The CLI equivalents below are for script deployments and automation.

### 3.1 Create the app and enable the robot (**no per-scope grants**)

[open-dev.dingtalk.com](https://open-dev.dingtalk.com) → App development → Internal app →
Create. A name and description are enough; **no egress IP list is needed**.

Inside the app: left nav → Robot → enable the bot capability, set its name and icon →
Save. Finally **publish a version** under Version management & release — an unpublished
robot cannot be added to a group.

Unlike Feishu, DingTalk needs **no** per-scope grants: robot messaging rides on the bot
capability itself, which is not the same mechanism as Feishu's `im:` / `cardkit:` scopes,
and there is no equivalent of Slack's Bot Token Scopes table.

### 3.2 Get the two credentials (**order matters**)

Left nav → Credentials & Basic Info → copy the **AppKey** and the **AppSecret** (the
secret only appears after you click to reveal it).

⚠️ **DingTalk has exactly ONE secret.** The AppSecret does two jobs: it fetches access
tokens and it verifies the inbound `sign` header. That is why there are **no** `Encrypt
Key` / `Verification Token` fields like Feishu's — the two missing inputs are
**deliberate**, not an omission.

Same rule as Feishu: **the ingress validates both values at cold start and refuses to
start if either is empty** (better a dead entry point than a public URL anyone can forge
requests to). So the order is: **store the credentials first, then paste the URL in §3.4.**

### 3.3 Store the credentials in the secret

**Option 1 (recommended, browser only)**: admin console → "IM integration" → DingTalk tab
→ fill in AppKey / AppSecret → Save. The backend creates the secret if it does not exist.
After saving, the page echoes only the **last 4 chars** of the AppSecret (`****xxxx`);
**sending a masked value back means "keep unchanged"**, so later edits to the push URL do
not require re-entering the AppSecret. Neither the value **nor even its length** is logged.

**Option 2 (CLI)**:

```bash
aws secretsmanager put-secret-value --secret-id notiops/im-bot-dingtalk \
  --region <REGION> \
  --secret-string '{"app_key":"ding...","app_secret":"...","webhook_url":""}'
```

- The secret name is **identical on both deployment paths**: `notiops/im-bot-dingtalk`.
- The `webhook_url` key holds the **custom-robot push URL** from §3.7 (optional, leave it
  empty). ⚠️ It points in the **opposite direction** from the "message receiving address"
  and the similar naming makes them easy to confuse: the former is what **we post to**
  (a credential); the latter is what **DingTalk posts to us** (a public endpoint).
- To change one field, `get-secret-value` first and write the whole document back —
  `put-secret-value` **replaces**, it does not merge. The admin console's Save button
  merges for you.

### 3.4 Switch to HTTP mode and paste the callback URL

The URL is the one from §0 (output key `DingtalkWebhookUrl`); **keep the trailing `/`**.
Back on the app's Robot page:

| Field | Value |
|---|---|
| Message receiving mode | Pick **HTTP mode** (the default is Stream mode — you **must** change it) |
| Message receiving address | The `DingtalkWebhookUrl` from §0 |
| Release | Save, then **publish a version again** under Version management & release |

DingTalk needs only this **one** URL: robots have no separate button-callback channel, so
message events and card postbacks arrive on the same address (Feishu wants it in two
places, Slack in three).

> ⚠️ **DingTalk validates NOTHING when you save this address.** There is no URL challenge
> like Feishu's — no green check, no error. So **one wrong character, or credentials not
> yet saved, look exactly the same: the robot never says a word.** This is the most
> expensive trap on the DingTalk path, because the symptom does not point at the cause —
> people go back and re-check credentials instead. The only reliable entry point for
> troubleshooting is the two log commands in §3.5: whether the entry point received a
> request at all separates "DingTalk never sent it" from "we rejected it".

### 3.5 Add it to a group and verify

Group settings → Group assistant → Add robot → pick the app robot you just published.
Then send `@robot hello` in that group; you should get a reply.

```bash
aws logs tail /aws/lambda/notiops-im-ingress-dingtalk --region <REGION> --since 5m
aws logs tail /aws/lambda/notiops-im-worker-dingtalk  --region <REGION> --since 5m
```

| What you see | What it means | What to do |
|---|---|---|
| Neither has any logs | DingTalk never sent anything | Back to §3.4: is the mode really HTTP, does the URL match exactly, is the version published? |
| `401` in ingress | `sign` verification failed | The AppSecret does not match the DingTalk console — back to §3.2 / §3.3 |
| A `timestamp skew` error in ingress | The time window does not match (DingTalk's signature carries a 1-hour window) | This host's clock is more than an hour off from DingTalk's; in practice this only shows up with a broken self-hosted NTP |
| ingress has logs, worker has none | The signature passed but dispatch failed | Read the ingress ERROR itself |
| `RuntimeError: dingtalk app_secret unavailable (...)` | **The credentials are not set** and the ingress crashes on cold start — the same **deliberate** fail-fast as Feishu (§5.2 item 1) | Store the credentials per §3.3, then re-enter the URL |

The cold-start shape (`INIT_REPORT ... Status: timeout` while the `REPORT` line shows
normal memory) is **word-for-word identical** to Feishu's — use the table in §1.5 to tell
them apart. All three ingress functions share the same numbers (`MemorySize=2048` /
`Timeout=20`) and the same keep-alive rule (§6).

### 3.6 Differences from Feishu / Slack (**platform primitives, not unfinished work**)

DingTalk robots expose fewer platform primitives than Feishu, so the same feature looks
different here. We **write these out** rather than implying them by omission:

| Difference | How it looks on DingTalk |
|---|---|
| **Card buttons can only be links** | Every DingTalk ActionCard button is a URL jump — there is no "click posts back to the server" interaction. Actions that need confirmation (opening a case, starting an investigation) are therefore **confirmed by replying with a keyword**. |
| **Sent messages cannot be edited** | DingTalk has no message-update API, so instead of Feishu's self-updating progress card there are **one or two appended** progress messages for long tasks. |
| **Robots cannot add reactions** | There is no 👀 / 👍 instant acknowledgement when a command arrives; a short **text receipt** takes its place. |
| **Proactive pushes need a second URL** | The robot's own reply channel is the **one-time session webhook** DingTalk hands us in the callback (`sessionWebhook`, valid for roughly **90 minutes** after a message), so it cannot carry scheduled pushes. For those, see §3.7. |

The command surface is **the same** as the other two platforms: `/devops`, `/agent`,
`/web`, `/account`, `/investigate`, `/case`, `/model`, `/language` and `/help` all work, as
do the Chinese forms and the slash-less forms (`@robot agent notiops`) — DingTalk has no
slash-command registry like Slack's, so **there is nothing to register**.

#### So how do I open a case on DingTalk? (**no modal, but there is a copy-paste template**)

On Feishu / Slack, `/case` pops a modal where you fill in subject, severity and language.
DingTalk cannot pop one: per the "buttons can only be links" row above, there is no
"button posts back to our server" path, and therefore no modal. So on DingTalk that modal
becomes a **plain-text template**: send `open case` and the bot replies with this —

```
📋 Case template
🏷️ Account: 111122223333 (deployment account)
Copy the whole block, edit it, send it back. Only "Description" is required — adjust the rest as needed.

Description:
Severity: 2  (1 Low / 2 Normal / 3 High / 4 Urgent / 5 Critical)
Language: 2  (1 中文 / 2 English / 3 日本語 / 4 한국어)
Case type: 1  (1 Technical / 2 Account & billing / 3 Service limit increase)
Service: 0  (0 auto-detect / 1 ec2 / 2 rds / …; not listed? just type the name, e.g. bedrock / msk / glue)
Subject: auto  (leave "auto" = generated from your description)

The description can span several lines — all of it goes into the case body.
Once you send it back I'll show a confirmation card; nothing is filed until you reply "confirm".
```

**Only "Description" is required**; the other five rows already carry a default:

| Row | If you leave it alone | If you want to change it |
| --- | --- | --- |
| Description | **Required** — leave it empty and you just get the template back | One line or several paragraphs; keep typing on new lines (all of it goes into the case body) |
| Severity | Normal | The **number** (`4`), the **API code** (`urgent`) or the **label** (`Urgent`) all work. The options follow your Support plan — Basic / Developer never see a tier they can't use |
| Language | Follows the current conversation language | Same three forms |
| Case type | Technical | Same three forms |
| Service | `0` = **auto-detect** (service and category derived from your description) | A number, or just type the service name (`bedrock`, `msk`) — names outside the list are accepted too |
| Subject | "auto" = derived from the description | Type your own (parentheses are kept verbatim) |

- A value we can't recognize is **called out explicitly** ("used the default for this one")
  rather than silently defaulted;
- To target another account, send `/account <12-digit account>` first (see §4.2); both the
  template and the confirmation card echo which account it will be opened in;
- Send it back and the bot replies with a **confirmation card** (subject / severity /
  language / problem); it only opens the case after you reply **confirm**, and **cancel**
  drops it. Valid for 30 minutes;
- The whole template flow spends **zero model tokens** (rendering is string concatenation,
  parsing is keyword matching). Filling in both "Service" and "Case type" also skips the
  one service-classification call.

> 💡 **Already know what you're reporting? Skip the template** — one line still works:
>
> ```
> open case RDS connections spiking, app-wide timeouts severity=high language=en
> ```
>
> The description goes in the same message (it is both the case subject and the case body),
> and optional parameters follow it: `severity=low|normal|high|urgent|critical`,
> `language=zh|en`, `type=technical|account`, `service=...`, `category=...`. You still get a
> confirmation card. The template is what you get when you send `open case` on its own —
> the bot will **never** use the words "open case" as the case subject.

> 💡 **`/case <description>` opens a case too** — `/case RDS connections spiking` is
> equivalent to `open case RDS connections spiking`, confirmation card included. The rule:
> `case` followed by a **case id** shows details, followed by a **description** opens a
> case, and followed by nothing (or only a filter word like `list` / `my` / `recent` /
> `all`) lists your recent ones. The least ambiguous form is still `open case` (or
> `/create-case`, `/new-case`, `开案例`).

The other case actions are one-liners too, and each is a **single verb-noun word**:
`/case` lists recent ones, `/case <case-id>` or `/view-case <case-id>` shows details,
`/analyze-case <case-id>`, `/reply-case <case-id> <text>`, `/close-case <case-id>`
(closing also needs a **confirm** reply). The Chinese synonyms all work as well:
`/案例`, `/查看案例`, `/分析案例`, `/回复案例`, `/关闭案例`.

### 3.7 Proactive push (optional: a custom robot)

For pushes nobody asked for first — inspection broadcasts, alerts, scheduled reports —
DingTalk requires a "custom robot": Group settings → Group assistant → Add robot →
**Custom** → copy its webhook URL → paste it into the "Custom-robot push URL" field on the
admin console's DingTalk tab (or the `webhook_url` key of the JSON in §3.3).

> ⚠️ **That URL IS a credential** — anyone holding it can post into that group, and report
> delivery POSTs the **full text** of long reports through it. So: the admin console echoes
> only its last 4 chars, accepts only the `https://oapi.dingtalk.com/robot/send` shape,
> never logs it, and never echoes the URL you typed back in an error message.
> **Do not paste it into tickets or screenshots.**

**In-group Q&A does not need this field** — that path uses the one-time session webhook
from DingTalk's own callback, with zero extra configuration. Leaving it empty is fine.

Once filled, click **Test credentials** on the admin console: it first fetches one access
token with the AppKey / AppSecret (the **authoritative** credential check), then, if a push
URL is set, posts a real message to that group.

> DingTalk has **no** API to post a test message into an arbitrary group. So with no push
> URL configured, that button **only validates credentials and sends nothing** — and the
> UI **says so plainly** (it does not pretend "sent to your group"). To verify end to end
> in that case, go back to §3.5 and @-mention the robot in a group.

---

## 4. Chat allowlist (optional, all three platforms)

Restrict the bot to specific groups / channels:

```bash
cd infra && npx cdk deploy ImStack --output ../.cdk-out --region <REGION> \
  -c imAllowedChatIds="oc_xxx,C0123ABC"
```

Feishu takes chat ids starting with `oc_`, Slack takes channel ids starting with `C` or
`D`, DingTalk takes the `conversationId` (read it out of the worker log after one
@-mention), comma-separated. Leave it empty for no restriction (same behaviour as the
long-connection design).

> 📌 **On DingTalk this check lives in the worker, not the ingress** (Feishu and Slack
> enforce it in both). The reason: DingTalk's `conversationId` is only decodable **after**
> signature verification — the ingress cannot filter on a field it hasn't seen yet. The
> customer-visible behaviour is the same: in a group that isn't on the list, the bot never
> replies. The cost is one extra worker cold start for a request that gets dropped, which
> is negligible at IM volumes. The env var name differs for the same reason (DingTalk
> `ALLOWED_CONVERSATION_IDS`, Feishu `ALLOWED_CHAT_IDS`, Slack `ALLOWED_CHANNEL_IDS`) —
> but the **deploy parameter `-c imAllowedChatIds` is shared by all three**, so there is
> nothing extra to fill in.

### 4.1 Two bots in one group (a test env and a production env)

**Supported**, and they won't both answer: whichever one you @-mention replies, the other
stays completely silent — it doesn't even add the "thinking" reaction.

The criterion is the bot's own `open_id`. Feishu has **no** equivalent of Slack's
`app_mention` event: once a bot is a member of a group, *every* message in that group
arrives as `im.message.receive_v1`, carrying a single `mentions` array with **everyone**
the message @-mentioned. So "who was mentioned" is something the bot has to decide for
itself: on first use it calls `GET /bot/v3/info` once to learn its own `open_id`, and it
only responds when that id appears in `mentions`.

Consequences:

- **Ordinary group chatter with no @ reaches neither bot** — group messages need an
  @-mention to trigger anything (direct messages don't).
- **Mixed mentions like `@alice @NotiOps take a look` do trigger it** — it only needs to
  be one of the mentioned parties.
- **If the bot cannot determine its own `open_id`** (expired credentials, a network
  blip), it **stays silent in groups** rather than answering every @ it sees. We would
  rather you notice "it stopped replying" immediately than have two bots answer and leave
  you unable to tell which one did. **Direct messages keep working** in that state; look
  for the `bot identity: GET /bot/v3/info` ERROR line in the ingress log (a transient
  blip self-heals within a minute).

> Slack doesn't need this layer: it has a dedicated `app_mention` event, so the platform
> has already done the disambiguation for us.

### 4.2 Multi-account: `/account` picks which account you are asking about

Once multi-account is on (`DeployMode=MultiAccount` on Option A, or
`./setup.sh --multi-account` on Option B), `/account` decides which account this
conversation is about:

| You type | What happens |
|---|---|
| `/account` | shows which account you are currently asking about |
| `/account list` | lists what you can pick (the deployment account + every member account enabled in the web console) |
| `/account 444455556666` | switches; **in a group it applies to the whole group**, in a DM only to you |
| `/account default` | back to the deployment account |

Three things worth stating plainly, because they are easy to misread:

1. **Onboarding (adding / enabling / disabling an account) happens only in the web
   console; IM only reads that list.** There is no onboarding entry point in IM and there
   will not be one — `/account` can only pick among accounts already enabled in the web
   console. Enable a new account there and IM can pick it on its **very next message** (no
   redeploy, no restart); disable it there and an IM selection pointing at it **falls back
   to the deployment account** on the next message, with an explicit note saying why.
2. **Each side picks independently.** Switching accounts in the web console does not move
   your IM group, and vice versa. The only shared thing is *which accounts are available*.
3. **Support cases follow `/account` too (since 2026-09-07).** Viewing, opening, replying to,
   resolving and analysing a case all happen in the account you currently have selected.
   Three preconditions — you are told **explicitly** when one is missing, rather than the case
   silently landing in the wrong account:
   - That member account allowed NotiOps to open cases on its behalf during onboarding
     (template parameter `EnableSupportCaseWrite`, **on by default**). With it off, NotiOps
     names the exact missing action (`support:CreateCase` / `AddCommunicationToCase` /
     `ResolveCase`) so you can decide whether to grant it or open the case in the console.
   - That account has a Business, Enterprise On-Ramp or Enterprise support plan (the AWS
     Support API is not available on Basic or Developer). **This is per account** — a plan on
     the deployment account says nothing about a member account.
   - That account is still *enabled* in the web console. Once disabled, cross-account
     credentials stop being issued.

   The card **names the account the case was opened under**. Case display ids can collide
   across accounts, and the AWS console link carries no account parameter — without the
   account spelled out, clicking through lands you in whichever account you happen to be
   signed into.

   One exception worth remembering: **escalating to a case from a report card's 🆘 button, and
   「📎 sync to case」, follow the account the *investigation* ran against — not the account
   selected in the chat at the moment the button is clicked.** A report card may be clicked
   hours later, long after `/account` moved on; following the chat would be the wrong answer.

> ⚠️ **Residual risk, stated honestly**: **anyone** in the group who can @-mention the bot
> can point that group at **any enabled** account — there is no per-person authorization on
> the IM side (an IM identity is not an AWS identity, and we won't treat it as one). Your two
> controls are: **only enable the accounts that should actually be asked about**, and **use
> the group allowlist in §4 above** to keep the bot in groups that should see those accounts.
> The last line against over-reach is on the agent side (only "deployment account + enabled
> accounts" is allowed, and when that list can't be read the answer is **refuse**, not
> open up) plus the trust policy on the read-only role in the target account itself.

---

## 5. Security boundary of the public endpoint

### 5.1 Shape of the entry point: API Gateway HTTP API → ingress Lambda

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

### 5.2 Five measures

1. **Fail-fast signature validation** — Feishu refuses to cold-start if either key is
   missing; Slack validation uses stdlib HMAC with `compare_digest` and rejects requests
   whose timestamp is off by more than 300s (replay protection).
2. **Two throttling layers** — the HTTP API stage is capped at 50 req/s with a burst of 100
   (excess requests are rejected with 429 by API Gateway and **never reach Lambda**, so they
   cost no Lambda time), and the ingress function additionally carries
   `reservedConcurrentExecutions=10`. Real IM event volume is orders of magnitude below both.
3. **Chat allowlist** (§4).
4. **Idempotent de-duplication** — the worker records `event_id` in DynamoDB, so a
   repeated delivery is processed once (Slack's Events API retries reuse the same
   `event_id`).
5. **The backend is still read-only** — even a forged message that somehow passes signature
   validation (which would mean the keys leaked) only gets read-only agent output back; there
   is no write permission anywhere behind it.

On the logging side: `encrypt_key` / `verification_token` / `app_secret` and the signing
secret are **never logged, not even their length** — only the exception type name (see
[LOGGING_STANDARD.md](LOGGING_STANDARD.md)).

### 5.3 Residual risks, stated plainly

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

## 6. Cold starts and the keep-alive ping (every 4 minutes)

### 6.1 The problem: a 3-second hard timeout against a cold start of well over ten seconds

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

### 6.2 What we do: EventBridge pings each ingress every 4 minutes

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

### 6.3 Where this stops working, stated plainly

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

## 7. What the bot's replies look like

Configuration is done; this section is for the people who will use the bot: **how long a
question takes, and what is on screen while it takes that long**. It is spelled out because
the most common "outage" turns out not to be one — it is a wait with no feedback.

### 7.1 Ask a question → a "thinking" card, immediately

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

### 7.2 The refresh rate slows down **on purpose**

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

### 7.3 Deep investigation: a progress card plus a report card at the end

`@bot investigate <question>` (or `/investigate`) takes a different route: the DevOps Agent
runs it in the background, **without occupying your chat**. You get two cards:

1. a **progress card**, refreshed once a minute (accepted → investigating → completed);
2. a **final report card**, posted back to the **same conversation** when the run finishes:
   the question you asked at the top, the opening slice of the report as the body, and three
   buttons underneath (📊 View full report / 🔍 Investigation trace /
   🆘 Escalate to AWS Support). The "🔬 Open this investigation" console deep link lives on
   the **progress card** only — every other link on the report card is presigned and needs no
   login, so adding one that requires a console session would force the footnote beneath them
   to claim "no login required" and "login required" at once.

> 🔴 **As of v1.0.22 there is only one report card.** It used to be two ("📝 Report Summary"
> + "✅ NotiOps Report"), and the first one's body came from an LLM summary — once the default
> model became a reasoning model, its thinking tokens ate the whole 1024-token output budget,
> so the body frequently held nothing but "report truncated due to token limits", and
> occasionally nothing at all. It is now one card whose body is the DevOps Agent's own text,
> which makes the whole deep-investigation path **0 token**.
>
> ⚠️ The report link is an **S3 presigned URL valid for 7 days** — not a permanent link, and
> not a CloudFront URL. Download the file if you need to keep it.
>
> ⚠️ When the report does not fit on the card, the body ends with "⚠️ This card shows only the
> beginning of the report — full content via *📊 View full report*". The content behind that
> button is **not** truncated; conversely, no such line means the card holds the whole thing.
> **"No body was retrieved" is a different message** ("No report body was retrieved…") — do
> not read the two as the same thing.
>
> ⚠️ The **📊 View full report** page carries **Summary + Root cause**; the
> **🔍 Investigation trace** page carries the **investigation timeline** (what the Agent
> checked at each step). If the trace page says `No records found.` while the investigation
> clearly ran, cross-account permissions blocked the journal read — the page now lists the
> read failures instead of leaving only that empty notice.
>
> ⚠️ Only the case where the progress card reaches "completed" and the report card **never
> arrives** is a real failure. That means the chat-routing row (`task#<task_id>`) was not
> written when the investigation started; see the "investigation results" section of
> [im-bot-interaction.md](im-bot-interaction.md).

### 7.4 The case-created card has exactly two buttons

Once a case is open, the success card carries "**View case**" (jumps to the AWS console) and
"**View all cases**".

**There is no "start an agent investigation" button**, and that is deliberate: opening a case
and starting an investigation are two independent decisions. Making the second one a button
on the first one's success card makes that card read as if the case alone were not enough.
If you want an investigation, just ask (`/investigate`, or "investigate this for me").

> **Older cards already posted** in a conversation may still carry that button — clicking it
> still works; it will not dead-click.

### 7.5 DingTalk is different: progress is **appended**, not refreshed

The "one card that changes by itself" described in 7.1 / 7.2 is what **Feishu and Slack** look
like. DingTalk cannot do that, so both the behaviour and the wording differ there — this is a
platform difference, not a bug:

| | Feishu / Slack | DingTalk |
|---|---|---|
| Progress | the **same card** refreshes in place | **a new message** (at most 2 before the answer: roughly one at 2 min and one at 6 min) |
| Seconds in the title | keep ticking | the first message shows **no** seconds; the appended ones show the real elapsed time at the moment they were sent |
| What the opener says | "progress and the answer both **update in this card**" | "progress and the answer arrive as **new messages**" |
| Final answer | the card turns into the answer | a new message |

The reason is concrete: a DingTalk bot replies through `sessionWebhook`, whose response carries
**only `errcode` — no message id**. With no message id there is no handle for "which message do
I edit", so a message already sent cannot be changed. A genuinely refreshable card requires a
card template (`cardTemplateId`) **registered by hand** in the DingTalk Open Platform console —
a one-off manual step that CFN cannot automate, so that path is stubbed out for now.

> ⚠️ **You do not need to register that card template.** The DingTalk setup steps in
> sections 1–3 above are **complete** — nothing is missing. `card_template_id` is merely an
> **optional** field in the credentials secret; **no code in this release reads it**, so filling
> it in changes nothing (which is why the admin console form does not expose it). Whether to go
> down that road is a product decision, not a deployment step — and since DingTalk buttons can
> only open a URL (there is no "button calls our server back" path), even with a card template
> the only thing gained is in-place refresh: the 🆘 escalate panel and the case-creation form
> still would not exist on DingTalk.

So, on DingTalk:

- **The answer is in a new message, not in the first one.** The first message never changes;
  don't sit and watch it.
- **The missing timer on the first message is deliberate.** It freezes the moment it is sent, so
  printing "0s elapsed" would hang a clock that is stuck at zero forever — that is not less
  information, it is wrong information.
- **"No need to ask again" still applies on DingTalk** (it applies on all three). Re-sending the
  question hits the one-run-per-conversation queue and puts you behind yourself — the more
  impatient you are, the slower it gets.
- The group therefore sees 1–2 extra messages. That cap is **hard** (2, in code); it will not
  flood the channel.
