# NotiOps — User Guide

> 🌐 **Language**: [中文](USER_GUIDE.md) · [English](USER_GUIDE.en.md)
>
> **Audience**: SREs, DevOps engineers, and application developers who use NotiOps. **The primary surface is the browser-based Web Chat console**; IM (Feishu / Slack) is a necessary but **secondary supplement**.
>
> **What you'll be able to do**: efficiently use the Web Chat console to view alarm notifications, investigate AWS resources, ask cost questions, manage AWS Support cases, ask AWS concept questions, and invoke your own Skills — and use the bot in Feishu / Slack for the same investigations and alarm follow-up.
>
> **Entry points**: **the Web Chat web console is the primary surface** (see §12). On the IM side, v1 supports Feishu / Slack as a supplement; DingTalk adapter code lives in the repo, but the two-robot credential flow stabilizes in v2 — `setup.sh` does not surface DingTalk to v1 customers.

**Version**: v1.3 · 2026-06-10 (case_analyze smart analysis + Pricing/Cost MCP bundled by default; primary surface is the Web Chat console, with IM supplement on Feishu / Slack)

> 💡 **Start here**: NotiOps's **primary surface is the browser-based Web Chat console** — sign in and use natural language to view notifications, run failure investigations, ask cost questions, file Support cases, and invoke your own Skills. Sections §1–§11 of this guide walk through each capability primarily through the IM (Feishu / Slack) experience; those same capabilities are all available in Web Chat, where the experience is more focused. The full Web Chat walkthrough is in **§12**.

---

## Table of Contents

1. [What the bot is / is not](#1-what-the-bot-is--is-not)
2. [Getting started: your first @ bot](#2-getting-started-your-first--bot)
3. [Core scenario 1: Investigate AWS resources](#3-core-scenario-1-investigate-aws-resources)
4. [Core scenario 2: AWS Support case management](#4-core-scenario-2-aws-support-case-management)
5. [Core scenario 3: Ask AWS concept / docs questions](#5-core-scenario-3-ask-aws-concept--docs-questions)
6. [Passive scenario: receiving proactive alarm cards](#6-passive-scenario-receiving-proactive-alarm-cards)
7. [Model selection (`@bot model`)](#7-model-selection-bot-model)
8. [Language preferences (Chinese / English switching)](#8-language-preferences-chinese--english-switching)
9. [FAQ](#9-faq)
10. [Sample Phrasings](#10-sample-phrasings)
11. [Feedback & support](#11-feedback--support)
12. [NotiOps Web Chat (web AI assistant)](#12-notiops-web-chat-web-ai-assistant)

---

## 1. What the bot is / is not

### What the bot CAN do ✅

| Category | Capability | How to use |
|---|---|---|
| **Investigate AWS resources** | Analyze CloudWatch metrics / logs / resource configs to find root causes | `@bot what's going on with RDS my-db CPU at 100%` |
| **Manage Support cases** | Create / list / view / reply to / **smart-analyze** / close AWS Support cases | `@bot open a case for the RDS outage` / `@bot analyze case 12345` |
| **Answer AWS concept questions** | Cite AWS official docs to explain concepts, best practices, API usage | `@bot what's the difference between ALB and NLB` |
| **Proactive alarm watching** | Six event sources — CloudWatch / Health / Backup / GuardDuty / Cost / TA — auto-dispatch investigations | (No action needed; alarms trigger automatically) |
| **Multi-LLM switching** | Switch freely between whichever models your admin enabled (default **Grok 4.6**, plus Claude Sonnet 5 / Opus 5 / Haiku 4.5, Amazon Nova Pro, DeepSeek V3.2, and the GPT-5.6 family — all accessed via Amazon Bedrock); per-chat / per-DM preference is remembered | `@bot model nova` / `@bot model claude` / `@bot model list` |
| **Language switching** | Switch between Chinese and English; remembers your preference | `language zh` / `language en` / `please switch to English` |

### What the bot WILL NOT do ❌

> This is a product-level hard rule, **not a tunable setting**.

- ❌ **Modify your AWS environment**: it will not restart EC2, will not delete S3 objects, will not change IAM policies — any mutation request is rejected
- ❌ **Run CLI commands for you**: ask "restart i-0123" and the bot refuses; ask "how do I restart i-0123" and the bot will teach you (tutorials count as read-only)
- ❌ **Bypass IAM**: the resources you can investigate = the resources the AWS DevOps Agent role can read. The bot will not escalate on your behalf
- ❌ **Store sensitive data beyond 7 days**: chat history is auto-cleared by DDB TTL after 7 days; locale preferences after 90 days

> Curious why the bot is so "conservative"? See [TECHNICAL_DESIGN.en.md §4.2 three-layer defense](TECHNICAL_DESIGN.en.md#42-general-conversation--three-layer-defense-bedrock_chat).

---

## 2. Getting started: your first @ bot

### 2.1 In a channel, @ the bot

Make sure the bot has been added to the channel (admin's job), then:

```
@NotiOps hello
```

The bot usually replies within 1–2 seconds with a quick greeting and a hint at what it can help with. This is the simplest way to verify connectivity.

### 2.2 In a DM, just talk to it

If you only need it for yourself, **no @ required** — just send a message:

```
hello
```

In a DM, the bot accepts every message by default (no @ trigger needed).

### 2.3 Automatic language locking on your first message

The bot auto-detects the language of your first message and **locks to that language**:

- Feishu: DM lock for 30 days / channel thread lock for 7 days
- Slack: same as above

Later short messages (`why?` / `继续`) won't suddenly flip the whole investigation to English just because they're English — **the first message decides the language for the whole round**.

> Want to switch manually? See §8.

---

## 3. Core scenario 1: Investigate AWS resources

### 3.1 Standard investigation flow

Just @ the bot and describe the problem:

```
@NotiOps help me look at why i-0abc123def456 in IAD has such high CPU
```

The bot will:

1. **Parse intent** (within 1 second in the background, see `intent_classify` log)
2. **Show the "Start investigation" card directly** (with an editable form)
3. You can keep the defaults and click **🚀 Dispatch investigation**, or edit first
4. After dispatch, a **🔭 Investigation started** card appears with deep-link buttons
5. Every 20 seconds a progress card updates (showing which tool DevOps Agent is calling and what it's currently thinking)
6. Within 1–3 minutes the full investigation report (👉 markdown summary + HTML report + trace) is pushed back to the channel

### 3.2 Start-investigation card explained

```
📝 Start Investigation
─────────────────────
Investigation request *
[ Your original question (LLM-rephrased version) ]

Starting point (optional)
[ e.g. an alarm name / log group / metric / any starting point ]

💡 DevOps Agent usually needs these dimensions to pinpoint the problem:
  - AWS account ID
  - Region
  - Resource ARN or name

📋 Logs / error snippets (optional)
[ Paste relevant logs / error messages / JSON ]

[ 🚀 Dispatch investigation ]   [ ❌ Cancel ]
```

**How to fill it in**:
- **Quick check**: leave everything blank, click **🚀 Dispatch investigation**
- **More precise**: put info the LLM didn't ask about but you already have into **Starting point** — DevOps Agent will localize faster
- **Complex problems**: paste logs into **Logs / error snippets**, the bot wraps them in code blocks automatically so the Agent parses them more cleanly

### 3.3 Progress card explained

```
🔭 Investigating · elapsed 45s
─────────────────────
💭 Current thinking
Analyzing CloudWatch metrics for i-0abc123def456 over the past hour,
checking CPUUtilization for anomaly spikes...

🔧 Recent calls
- describe_instances(i-0abc123def456)
- get_metric_statistics(CPUUtilization, 60s)
- describe_log_streams(/aws/ec2/...)

[ 🔬 View this investigation ]  [ 🌐 Operator home ]
```

The progress card refreshes every 20 seconds until the Agent finishes.

### 3.4 Report card explained

```
✅ NotiOps Report · COMPLETED
─────────────────────
📝 Report Summary

# i-0abc123def456 CPU anomaly analysis

## Symptoms
- CPU sustained >95% over the past hour
- Window: 14:30–15:30 UTC
- Top processes: nginx + php-fpm

## Root cause
Application-layer CPU bound. nginx is configured with worker_connections=1024,
which is too few — many requests are queueing up.

## Recommendations
1. Set worker_processes to auto
2. Raise nginx worker_connections to 4096
3. Consider horizontal scaling (ASG min=2)

[ 📄 View full report ]   [ 🔬 Trace ]   [ 📋 Next steps ]
```

**The report card has next-step suggestion buttons at the bottom**, e.g. "Investigate the related ALB" / "Check RDS slow queries" — one click dispatches a new investigation. It reuses this channel's context, and the new report comes back to this same channel.

### 3.5 Investigation samples

| What you want to ask | Recommended phrasing |
|---|---|
| EC2 high CPU | `i-0abc123def456 in ap-east-1, CPU at 100% for the past hour` |
| RDS slow queries | `RDS my-db has lots of slow queries, find out why` |
| Lambda errors | `lambda function-foo lots of errors, check cloudwatch logs` |
| ALB 5xx spike | `ALB my-alb has been throwing 503 for 30 minutes` |
| S3 bucket size spike | `s3://my-bucket grew from 100GB to 1TB last week, find the anomaly` |
| EKS pod CrashLoop | `eks cluster prod-cluster pod xyz keeps CrashLoopBackOff` |
| Cross-service | `ALB → EKS → RDS full-stack timeout, help me trace it` |

> 💡 **Tip**: **questions with concrete resource ID / region** = bot won't ask clarifying questions, it goes straight to investigation. **Vague questions** = bot may suggest dimensions to add in the edit form's hint text.

---

## 4. Core scenario 2: AWS Support case management

The bot doesn't just investigate — it can also **manage AWS Support cases for you** (create / view / reply / close), so you don't have to flip to the console every time.

### 4.1 Create a case

```
@NotiOps create a case for RDS my-db restarting frequently
```

The bot opens a **create-case card** (Feishu modal / Slack modal), where you can fill in:

| Field | Description |
|---|---|
| **Subject** | Auto-summarized title from LLM (editable) |
| **Body** | Detailed description (paste raw logs if needed) |
| **Severity** | Low / Normal / High / Urgent / Critical |
| **Language** | English / Japanese / Chinese, etc. (the conversation language inside AWS Support) |
| **Contact** | Optional, contact info |

Click **Create**, the bot calls the AWS Support API to create the case, and replies with the case ID (`12345...`).

> 🔥 **Create + dispatch investigation in one go**: the card has a **Create + dispatch investigation** button at the bottom that creates the case first, then auto-dispatches a DevOps Agent investigation framed as "investigate the root cause of this case". One action = "file the ticket + start self-diagnosis".

### 4.2 List my cases

```
@bot my cases
@bot list my cases
@bot cases needing my action   # auto-filters status=pending_customer
@bot unresolved cases          # auto-filters status≠resolved
@bot cases AWS is working on   # auto-filters status=work_in_progress
@bot resolved cases            # auto-filters status=resolved
```

The bot lists the most recent N cases with status, severity, and last-reply time. Click a case ID to expand.

### 4.3 View a specific case

```
@bot case 177968247000414
@bot view case 177968247000414
@bot how's 12345 doing
```

The bot returns case details + the latest reply history.

### 4.4 Reply to a case

```
@bot reply to case 177968247000414 — already upgraded RDS to r5.large, no more restarts
@bot reply 12345 fixed by upgrading instance class
```

> Case ID is required, otherwise the bot will ask you to pick one.

### 4.5 Smart case analysis (LLM rollup + next steps)

When you want the LLM to read the entire case thread and tell you "what now":

```
@bot analyze case 177968247000414
@bot summarize case 12345
@bot help me understand case 12345
@bot what's wrong with case 12345
@bot what should I reply to case 12345
@bot 分析 case 12345
@bot 总结 case 12345
@bot 复盘 case 12345
```

The bot first sends an "Analyzing case xxx…" placeholder, then 5-15s later returns a **purple smart-analysis card** with up to 6 sections:

| Section | Content |
|---|---|
| 📝 **Summary** | One-paragraph symptom statement |
| 🔍 **Likely root cause** | Best guess from evidence; explicitly says "evidence insufficient" if too thin |
| 🛠 **AWS engineer progress** | What AWS has done, what they're waiting on |
| ✅ **Recommended next steps** | Concrete user actions, ordered by priority |
| 📋 **Info to provide to AWS** | Data points / logs / configs the user should share next |
| ✉️ **Suggested reply** (optional) | A ≤300-char draft the user can copy-paste |

Two action buttons: **💬 Reply to case** / **📋 View full case**.

> ⚠️ **Zero-Change Promise still applies**: the LLM never recommends a mutating command (delete / stop / modify). If a change is the only way forward, the bot tells you to **do it yourself** — it won't do it for you.

### 4.6 Close a case

```
@bot close case 177968247000414
@bot resolve 12345
@bot 12345 is resolved
```

---

## 5. Core scenario 3: Ask AWS concept / docs questions

> ⚠️ **Prerequisite**: this feature requires `AgenticChatMode=qa_only` or `enabled` at deploy time (gradual-rollout setting, see [TECHNICAL_DESIGN.en.md §4.2.7](TECHNICAL_DESIGN.en.md)).

### 5.1 How to ask

Just @ the bot — it auto-detects this is a "concept question" rather than an "investigation request":

```
@bot what's the difference between ALB and NLB
@bot what does Lambda cold start mean
@bot how is CloudWatch alarm evaluation period calculated
@bot how do I add a cross-account trust to an IAM role
```

### 5.2 Answer style

The bot calls **AWS Knowledge MCP** to retrieve official docs, then answers with the chat's current conversational model (**Grok 4.6** by default, see §7), **with verifiable sources attached**:

```
ALB (Application Load Balancer) operates at OSI Layer 7 and understands
HTTP/HTTPS, so it can route based on host / path / header. NLB (Network
Load Balancer) operates at Layer 4, only sees TCP/UDP, and does not
parse the application layer.

Key differences:
1. **Protocol**: ALB parses HTTP, NLB does not
2. **Health checks**: ALB can check a path, NLB is TCP-only
3. **Latency**: NLB is lower (no parsing)
4. **Static IP**: NLB supports it, ALB does not
5. **WebSocket**: ALB has native support

📚 Sources
- [Application Load Balancer overview](https://docs.aws.amazon.com/...)
- [Network Load Balancer overview](https://docs.aws.amazon.com/...)
- [Choose between ALB and NLB](https://docs.aws.amazon.com/...)

🔧 MCP tools called
- aws_docs_search("ALB vs NLB difference")
- aws_docs_read(...)

By Grok 4.6
```

**Key points**:
- **The "📚 Sources" block** = URLs the LLM actually read, not made-up references
- **"🔧 MCP tools called"** = transparent display of which tools the LLM used
- **"By Grok 4.6"** (the signature follows the chat's current model) = explicit signal that this is model-generated, not a hard-coded "official answer"

### 5.3 Concept question samples

| Category | Examples |
|---|---|
| **Service comparison** | `how to choose between ECS and EKS`, `SQS standard vs FIFO difference` |
| **API usage** | `S3 multipart upload max size`, `how to configure Lambda concurrency limits` |
| **Best practices** | `how to avoid IAM role chaining`, `VPC peering vs transit gateway choice` |
| **Error interpretation** | `what is a Throttling exception`, `common causes of UnauthorizedOperation` |
| **Configuration options** | `what is a KMS multi-region key`, `RDS multi-AZ vs read replica` |

### 5.4 When the bot routes to investigation vs Q&A

The bot decides **automatically**:

| What you said | Bot's decision | Path taken |
|---|---|---|
| `what is ALB` | Concept question | general_qa (MCP retrieval) |
| `check 5xx for ALB my-alb` | Investigation request | investigate (dispatch DevOps Agent) |
| `how do I solve Lambda cold start` | Concept + best practice | general_qa |
| `lambda foo has bad cold starts, take a look` | Investigation | investigate |

Decision rule: **contains a concrete resource ID / region / time window** → investigation; **pure concept / how-to** → Q&A.

---

## 6. Passive scenario: receiving proactive alarm cards

### 6.1 How auto-investigation on alarms works

If your AWS account has push mode enabled (admin config), the bot listens to 6 event sources:

| Event source | Trigger condition |
|---|---|
| CloudWatch Alarm | Alarm state changes to ALARM |
| AWS Health | Issue / scheduled change / account notification raised |
| AWS Backup | Backup job FAILED / EXPIRED / ABORTED |
| GuardDuty | New finding (default severity ≥ 7) |
| Cost Anomaly | Anomalous cost change |
| Trusted Advisor | Check status flips to ERROR |

**On event trigger**:

1. Push handler Lambda receives the EventBridge event
2. 5-minute deduplication (same resource only investigated once per 5 minutes)
3. **Auto-dispatch** to DevOps Agent — the investigation request text is normalized by the bot from the event
4. The channel receives a **⚠️ Proactive watch: <event summary>** header card
5. Same progress-card → report-card flow as a manual investigation

### 6.2 Alarm card sample

```
⚠️ Proactive watch · CloudWatch Alarm
─────────────────────
Alarm name: high-cpu-prod-rds
State: ALARM
Reason: Threshold Crossed: 1 datapoint [98.5] > 85.0

DevOps Agent has automatically started an investigation...
```

Everything afterwards is the same as the report card flow in §3.

### 6.3 Silencing

A specific event source too noisy for a channel? Admins can disable it individually:

```bash
# Disable a push source (admin-side): tune the enabled event sources,
# then re-deploy — see DEPLOYMENT.en.md §7 for the exact toggles.
./setup.sh
```

Detailed config options in [DEPLOYMENT.en.md §7](DEPLOYMENT.en.md#7-enable--tune-push-mode).

---

## 7. Model selection (`@bot model`)

The aliases the bot accepts are whatever your admin enabled for the IM surface in the model catalogue (the common ones are below); **anyone in a chat can switch between them** (no admin gate). Ask `@bot model list` for the live set:

| alias | model | notes |
|---|---|---|
| `grok` | **Grok 4.6** | **Default** (the catalogue's `default_model`). Bedrock Converse; ⚠️ no explicit prompt caching, so long conversations cost more on input than Claude |
| `claude` | **Claude Sonnet 5** | Reliable tool-use and good in Chinese & English in internal testing; supports prompt caching |
| `nova` | **Amazon Nova Pro** | Bedrock Converse API; ~1/4 the unit cost of Claude Sonnet (per public Bedrock pricing, as of 2026-07); works for compliance-restricted lists |
| `gpt` / `gpt_sol` / `gpt_luna` | **GPT-5.6** Terra / Sol / Luna (experimental) | Bedrock Mantle Responses API; tool-use is less reliable than the two above. Suggested for experimentation only. |

> ⚠️ **GPT-5.6 is currently an experimental tier.** Under tool-use the model occasionally leaks OpenAI internal protocol fragments or low-quality tokens into the reply. The bot ships three layers of hard defenses (output-token cap / JSON-error feedback / output sanitizer) but the residual leak rate is still higher than Claude / Nova. Treat it as a "try out an OpenAI model" tier, and prefer `claude` / `nova` as the default.
>
> Note: all models are accessed through Amazon Bedrock (managed security, compliance monitoring, and cost controls). This is sample code for educational/reference purposes, not production-ready; test and harden it against your organization's security and compliance requirements before any real use.

### 7.1 Commands

```
@bot model              # show current model in this chat / DM
@bot model list         # list all aliases
@bot model nova         # switch to Nova for the whole chat
@bot model claude       # switch back to Claude
@bot model default      # clear preference, fall back to deploy default
```

### 7.2 Scope

- Sent in a **group chat** → switches the model for **everyone in the channel**.
- Sent in a **DM** → only affects that DM, doesn't touch any group.

This is how a single bot deployment serves multiple markets: keep
overseas channels on `claude`, set compliance-restricted teams to
`nova`, all under one stack.

### 7.3 Notes on switching to `gpt` (experimental)

GPT-5.6 uses the **Bedrock Mantle Responses API** (OpenAI-compatible
protocol), which differs from Bedrock InvokeModel / Converse:

- **Reliability**: Under tool-use (investigation dispatch / concept Q&A) GPT-5.6 occasionally writes OpenAI internal protocol fragments (`to=functions.<tool>`) or low-quality tokens into the reply. The bot has three hard defenses to intercept that output — when triggered, the user gets the canned chitchat fallback instead of garbage — but the visible "half-broken" rate is still higher than Claude / Nova. **Prefer `claude` or `nova` for serious use**; treat `gpt` as a "try it / compare" tier.
- **Cross-region call**: GPT-5.6 lives in `us-east-2` (also supported in `us-west-2` and GovCloud-us-west). The bot ECS deployment runs in `us-east-1`, so selecting `gpt` triggers a cross-region HTTPS POST. Latency is ~50ms higher than Claude / Nova but otherwise transparent.
- **Operator can pin a different region**: the CFN parameter `GptRegion` defaults to `us-east-2`; can be changed to `us-west-2` or `us-gov-west-1`.
- **Reasoning effort**: GPT-5.x has an explicit reasoning-depth knob, default `medium`. Operators can change `GPT_REASONING_EFFORT` env to `low` / `high`.
- **Latency**: at `effort=high`, a single reply may take 10-30 seconds. For the chat path, keep `medium`.
- **Tool use**: Identical surface to Claude / Nova — MCP tools (AWS Knowledge / Pricing / Cost) work via automatic protocol translation.

### 7.4 Resolution priority

```
1. Per-chat preference (set via `@bot model X` in a channel) — 30d TTL
2. Per-DM preference (set in a DM) — 30d TTL
3. Deploy default (`DEFAULT_LLM_PROVIDER` env, `DefaultLlmProvider` CFN parameter)
4. Final fallback: claude
```

To permanently switch the deploy-wide default for new chats, an
operator can update the CFN parameter `DefaultLlmProvider` and redeploy.

---

## 8. Language preferences (Chinese / English switching)

### 8.1 Three ways to trigger

```
language        # Show current language + brief help
language zh     # Switch to Chinese (effective immediately, 90-day preference)
language en     # Switch to English (effective immediately)

please switch to English   # Natural-language switch, equivalent to language en
切换到英文                  # Same
请用英文回复                # Same
switch to chinese          # Equivalent to language zh
```

### 8.2 Language priority chain

When the bot decides what language to respond in, it **looks for an answer in this order**:

```
1. Your explicit preference (language zh|en or natural-language switch you set)
2. Current investigation lock (after dispatch, the whole round is locked to one language)
3. Current thread lock (set when an @bot opens a topic in a channel)
4. Current DM lock (set after the first message in a DM)
5. Auto-detection of the current message's language
6. Group / workspace default language (admin config)
7. Fallback: English
```

Why so complicated? Because:
- You don't want a single `why?` to suddenly flip everyone to English when discussing tech with teammates
- You don't want to switch to English and then have your next "你好" detected as Chinese
- Your preference should be stable across channels and devices

### 8.3 Common confusion

**Question**: I just said `language zh`, but the bot's next reply is still in English?

**Cause**: that message likely happened to be inside a thread, and thread lock outranks everything except user preference.

**Fix**: **user preference is the top layer** and overrides every lock. If `language zh` failed to write (check ECS logs), ask the admin to clear your `locale#user#<uid>` row.

---

## 9. FAQ

### Q1: Can I have the bot restart an EC2 for me?

**No**. The bot is read-only — a product-level hard rule that cannot be bypassed. See [TECHNICAL_DESIGN.en.md §5 Security design](TECHNICAL_DESIGN.en.md#5-security-design).

Workaround: **ask the bot how to restart it** (tutorial-style), and it will teach you the CLI commands. You review them, then run them yourself.

### Q2: How does the bot know about my AWS resources?

The bot **does not call AWS APIs directly**. Every investigation is dispatched to **AWS DevOps Agent**. The Agent reads your resources using the role you authorized for it. The bot's task role only has minimal permissions (send messages, call Bedrock, write DDB).

### Q3: How long is my chat data retained?

| Type | TTL |
|---|---|
| Chat events / investigation context | 7 days |
| Investigation report HTML (S3) | 7 days (presigned URL also 7 days) |
| Language preference | 90 days |
| DM lock | 30 days |
| Channel thread lock | 7 days |
| Investigation lock | 24 hours |
| Push event dedup | 5 minutes |

DDB TTL handles cleanup automatically — no manual intervention needed.

### Q4: The bot suddenly stopped responding, what do I do?

Follow the §11 process and ask an admin to investigate. Common causes:
- ECS task is restarting (transient, wait 30 seconds)
- IM credentials expired (admin re-enters them in Secrets Manager)
- Bedrock throttling (occasional during peak hours)

### Q5: Can I add the bot to non-production channels?

Yes. **We strongly recommend trying it in a test channel for 1–2 weeks first**. The bot accepts every chat by default; admins can use `AllowedChatIds` to restrict it to an allowlist.

### Q6: Are the bot's replies model-generated? Will it hallucinate?

- **Investigation reports**: generated by DevOps Agent actually reading your resources, with a trace.html for verification — no fabrication
- **Concept Q&A**: the conversation's Bedrock model (Grok 4.6 by default) + AWS official docs retrieval (Knowledge MCP); answers come with 📚 source URLs you can click to verify
- **Intent classification / progress narration**: LLM-generated and may have minor inaccuracies, but doesn't affect the truthfulness of the investigation result itself

If a concept answer disagrees with what you know, **click the 📚 source URL and read the AWS official docs yourself** — that's ground truth.

### Q7: Will creating an AWS Support case via the bot incur extra Support fees?

No. The bot just calls the AWS Support API on your existing account. Cases themselves are not metered separately (case counts are included with your Support plan).

### Q8: When investigating, will DevOps Agent do "unexpected" things?

DevOps Agent is read-only by design (uses your authorized role, which should only have a ReadOnly policy attached). The bot only passes investigation request text on dispatch — **no mutating instructions**.

But **the precondition is**: the role you give DevOps Agent has not accidentally been granted write permissions. We recommend ops audits this role periodically.

---

## 9.5 DingTalk platform notes

What works on Feishu / Slack is being delivered to DingTalk **in stages**. This section spells out what's available now and what's still being built so you don't have to guess.

### 9.5.1 Available now (Phase 1)

| Feature | Available on DingTalk |
|---|---|
| @ bot in groups / DM the bot | ✅ |
| Investigation dispatch (`check i-xxx CPU` / `RDS my-db slow`, …) | ✅ |
| Concept Q&A (`what is EKS` / `ALB vs NLB`) | ✅ |
| Model switching (`@bot model claude/nova/gpt`) | ✅ |
| Language switching (`language zh/en` / natural language) | ✅ |
| Investigation report markdown writeback | ✅ (operator must add a custom robot to the target group; see [DEPLOYMENT.en.md §3.3](DEPLOYMENT.en.md) step 6) |
| Zero-change promise (any mutation request is refused) | ✅ |

### 9.5.2 Not yet available (Phase 2 roadmap)

| Feature | DingTalk | Feishu / Slack |
|---|---|---|
| AWS Support case create / list / reply / close | ⏳ | ✅ |
| Live progress card (20s investigation updates) | ⏳ | ✅ |
| Skill selection / switch / self-upload | ⏳ | ✅ |
| Push observation (CW Alarm / Health, etc., 6 sources) | ⏳ | ✅ |
| Next-step one-click dispatch buttons | ⏳ | ✅ |

When you hit a Phase 2 intent on DingTalk, the bot replies: `👷 This intent (...) is on the DingTalk Phase-2 roadmap. Use Feishu or Slack for now.` — **never silently dropped**.

### 9.5.3 Permanent structural differences (not a Phase issue)

DingTalk's IM protocol differs from Feishu / Slack in ways we can't paper over:

- **No native modal forms**: Feishu / Slack's "open a case form, fill fields" has no DingTalk equivalent. Phase 2's case create / skill upload will use **conversational completion**: bot asks you to send messages in order ("First send the Subject on one line, then a multi-line Body…"). Slightly more typing, same functional outcome.
- **No thread subtopic semantics**: DingTalk has no Slack `thread_ts` analogue. The whole group locks as one — a short follow-up (`why?`) stays in the locked language same as a 1-on-1 DM. Simpler, but means we lose Feishu / Slack's "follow-up in thread without re-@" trick.
- **Every inbound is for the bot**: DingTalk bots don't see general group chatter, only @-mentions and DMs. So the bot doesn't have to decide "is this for me?" — it always is. Net: cleaner inbound flow, but no thread-implicit-follow-up.

### 9.5.4 Preferences are platform-isolated

`@bot model` and `language` preferences are keyed by `(platform, chat_id)` / `(platform, user_id)`, so **a Feishu preference doesn't carry to DingTalk and vice versa**. The same user can run Claude in a Feishu DM and Nova in a DingTalk group, independently.

---

## 10. Sample Phrasings

The bot supports both Chinese and English — pick whichever you prefer.

### 10.1 Chinese samples

| 意图 | 推荐说法 |
|---|---|
| 你好 | `你好` / `早上好` / `在吗` |
| 看 EC2 状态 | `查 i-0abc123 的 CPU` |
| 看 RDS 性能 | `RDS my-db 慢查询多, 看下原因` |
| 看 Lambda 错误 | `lambda function-foo 大量 error` |
| 看 S3 异常 | `s3://my-bucket 上周空间暴涨, 查异常` |
| 看跨服务问题 | `从 ALB 到 EKS 到 RDS 全链路超时, 帮我串一下` |
| 创建 case | `创建一个 case 处理 RDS 故障` / `提一个工单` |
| 列出 case | `我的 case` / `未解决的 case` |
| 查 case | `case 177968247000414` |
| 回复 case | `回复 case 12345 已经修好` |
| 关闭 case | `关闭 case 12345` |
| 概念问题 | `ALB 和 NLB 有什么区别` / `什么是 KMS multi-region key` |
| 切语言 | `language en` / `请切换到英文` |

### 10.2 English samples

| Intent | Recommended phrasing |
|---|---|
| Greeting | `hi` / `hello` / `good morning` |
| EC2 check | `check i-0abc123 CPU usage` |
| RDS performance | `RDS my-db has slow queries, please look` |
| Lambda errors | `lambda function-foo many errors` |
| S3 anomaly | `s3 my-bucket size spiked last week` |
| Cross-service | `ALB → EKS → RDS timeout, help me trace` |
| Create case | `open a case for RDS issue` / `file a ticket` |
| List cases | `my cases` / `unresolved cases` |
| View case | `case 177968247000414` |
| Reply to case | `reply to case 12345 — issue resolved` |
| Close case | `close case 12345` |
| Concept | `what's the difference between ALB and NLB` / `what is KMS multi-region key` |
| Switch language | `language zh` / `switch to chinese` |

---

## 11. Feedback & support

### 11.1 Feedback channels

Just @ the bot in the channel: `@bot I wish you could...`. The bot won't "understand" the feedback itself (it'll classify it as chitchat), but **the message lands in ECS logs and admins review them periodically to improve prompts**.

### 11.2 Where to get help

| Problem | Who to contact |
|---|---|
| Bot didn't reply | Internal channel admin / IT ops |
| Bot replied but the content is clearly wrong | Screenshot it in the bot channel, admin checks ECS logs |
| Investigation report won't open | Check whether the S3 presigned URL has expired (7 days) |
| I don't have permission to investigate this resource | This is a DevOps Agent role permission issue, not the bot's problem |
| AWS Support case creation failed | Read the error the bot returned — likely Support plan limit or severity not allowed |

### 11.3 Want to learn more?

- [TECHNICAL_DESIGN.en.md](TECHNICAL_DESIGN.en.md) — technical design, module boundaries, security rules
- [DEPLOYMENT.en.md](DEPLOYMENT.en.md) — deployment manual (for ops engineers)

---

## 12. NotiOps Web Chat (web AI assistant)

In addition to the bot in Feishu / Slack, NotiOps also ships a **browser-based agentic AI assistant — Web Chat**. You open it in a browser, sign in, and use natural language to view alarm notifications, run failure investigations, ask cost questions, create Support cases, and invoke your own Skills. This section covers **how to operate it and what you'll see**.

> Web Chat and the IM bot are two parallel entry points that share the same read-only backend safeguards (strictly read-only; the backend's three-layer defense carries over). It doesn't replace the IM bot — it's a web workbench better suited to "sitting down to focus on an investigation or filing a case."

### 12.1 Sign-in and overall layout

- **Sign-in**: Web Chat uses Cognito sign-in (reusing the notiops user pool). Open the URL your admin gives you and sign in with your account.
- **Left-side navigation (topics)**, in order: **Notifications / Investigate / FinOps / Cases / Skills / More**. Click a topic to enter that conversation scenario.
- **Default model**: a new conversation defaults to **Grok 4.6** (the exact default is set by your admin on the Admin → Models page).
- **Right-side Sources / Investigation panel**: shows tool calls and source pass-through, plus the live "Investigation" panel under the Investigate topic (see §12.3).

Toggles available in the top/toolbar area: **multi-account selector**, **model switching**, **web search toggle** (see §12.7).

### 12.2 Notifications topic: Health Dashboard + inbox red dot

The Notifications topic has **two parts**, answering "is there any AWS event affecting me right now" and "what events have happened":

**(A) AWS Health Dashboard live view**
- Entering the Notifications topic queries the AWS Health API in real time (**not persisted**, fetched fresh each time), broken into:
  - **Service health** (PUBLIC issues — region/service-level public events)
  - **Your account health** (issues related to your account + scheduled changes)
  - Plus other notifications / event log / status history, with console links to jump in for details
- **Prerequisite**: the live Health view requires a **Business+ / Enterprise Support** plan. If your account doesn't qualify, it **gracefully degrades** to console links (rather than erroring out).

**(B) Persistent inbox (source of the red dot)**
- The inbox aggregates notifications from multiple event sources (collected via EventBridge, deduplicated over 5 minutes, then written to the inbox):
  - **On by default**: CloudWatch Alarm, AWS Health, AWS Backup
  - **Off by default** (admin must enable): GuardDuty, Cost Anomaly, Trusted Advisor, RDS, Config
- Notifications are retained in the inbox for **about 90 days** (TTL), shared at the account level.
- **The left-side red dot** = the inbox **unread count**, refreshed by the frontend **polling every 60 seconds** (note: polling, not real-time WebSocket push). Health Dashboard's unhandled counts **do not** contribute to the red dot.
- **Actions on each notification card**: **Investigate** (use this notification as the starting point and go to the Investigate topic to launch a DevOps Agent deep investigation) / **Ask about this** (keep the conversation going around this notification) / **Console link** (jump to the AWS console for the raw event).

### 12.3 Investigate topic: live process panel + mitigation hand-off + escalate to human

The Investigate topic connects to **DevOps Agent deep investigation**, which runs **synchronously with live streaming** once dispatched, so you can watch as you wait.

**How to operate it, and what you'll see:**
1. Describe your problem (or click "Investigate" on a notification card to bring in a starting point) and launch the investigation.
2. The analysis steps (Observation / Finding, etc.) appear in real time in the **right-side "Investigation" docked panel** (this panel reuses the Sources column). It **does not auto-pop**; the main chat gives a **"View investigation" entry button** — click it to watch the panel **grow live** with the analysis steps.
3. The **main chat area** keeps only the **root-cause conclusion** + a link to the **HTML online report** (the report is stored in S3, served via CloudFront for about 7 days, with a presigned URL of about 12 hours as a fallback). This keeps the main conversation clean, with the process details in the side panel.
4. At the **end of the conclusion there are two buttons**:
   - **"Generate a mitigation plan in the DevOps Agent backend"** — opens the operator app deep link (new tab). Note: the backend switches tabs purely on the frontend and **cannot deep-link directly to the Root cause tab**, so after opening, please **switch to the Root cause tab manually** to continue generating the mitigation plan.
   - **"Escalate to human support"** — one click routes you to the human/case-filing path. When escalating to a human case, the subject is organized around the investigation question and the body follows best practices, including background + summary + report link.

> Web Chat **faithfully passes through DevOps Agent content**; NotiOps does not apply a second round of LLM processing to the investigation conclusion.

### 12.4 FinOps topic

- The FinOps topic is for cost / usage questions.
- The **DevOps Agent toggle** now appears under **both** the Investigate and FinOps topics (in FinOps you can use it for deep cost/usage analysis). **On entering FinOps, that toggle is off by default** (only the Investigate topic defaults to on).
- ⚠️ **FinOps Agent deep analysis is currently greyed out / disabled**: this feature is not yet complete, and the UI shows a **"coming soon"** note. Do not treat it as available for now.

### 12.5 Cases topic: two ways to file a case

Web Chat offers **two case-filing paths; you pick one**. Both run **deterministic execution** (via the BFF's `/actions/execute`, **not through an LLM**) and give you a preview to confirm before actually filing.

**(1) Editable "Create support case" card**
- Fill in a structured card with fields including:
  - **Service** dropdown: options come from the real AWS service catalog (BFF `describe-services`, about **328** services), and the **category updates in tandem with the service**.
  - **Case type**: technical / customer-service (billing & account) / service-limit-increase.
  - **Severity** and **Language** (the conversation language of the case inside AWS Support).
- Flow: **fill in → preview → confirm**.
- **Preventing invalid combinations**: if the model suggests a `service_code` that isn't in the real catalog, the frontend **corrects it by token matching or clears it**, avoiding illegal service/category combinations.

**(2) Markdown template**
- You get a markdown template, **fill it in, and send it back**.
- The agent uses `create_case_from_template` to **deterministically parse** service + category **against the real service catalog** (rather than letting the model make it up), produces a **read-only preview card**, and after your **confirmation files the case directly**.

> Both paths follow a rigorous "propose → confirm → execute" flow and never skip confirmation to file a case directly.

### 12.6 Skills (your own skills)

- **Skills are customer-authored skills**, with a **top-level navigation entry** on the left, and can also be invoked in conversation via the **"/" command menu**.
- Skills are stored under the **`skills/` prefix in S3** (**shared** with the same storage as the IM side).
- They support **version history / rollback / zip import** for easy management and reuse.

### 12.7 Multi-account / multi-model / web search / What's New / "/" commands

- **Model switching**: defaults to **Grok 4.6**, with **Claude Sonnet 5**, **Claude Opus 5**, **Claude Haiku 4.5**, **Amazon Nova Pro**, **DeepSeek V3.2**, and the **GPT-5.6** family (Terra / Sol / Luna) also available (all accessed via Amazon Bedrock; third-party models run via Bedrock, not direct vendor APIs). It **remembers your model preference per session**, and **each reply is signed with the model used**.
- **Multi-account selector**: defaults to the **deployment account**, shared by the team. ⚠️ **In v1, cross-account is locked to the deployment account by default** (switching to arbitrary other accounts isn't open yet).
- **Web search toggle**: **off by default**; turn it on manually when you want the assistant to reference public web information. It uses the AWS built-in AgentCore Web Search (requests never leave AWS). ⚠️ That capability exists **only in `us-east-1`**: in other Regions the toggle still clicks but returns nothing — that's not a fault, check the deployment Region with whoever operates it.
- **What's New**: view the latest AWS announcements.
- **"/" commands**: type `/` in the input box to pop up a command menu for quickly invoking Skills and more.
- **Sources panel**: passes through tool calls and sources so you can verify what the assistant based its answer on.
- **Read-only safety**: Web Chat carries over the backend's strict read-only constraints (three-layer defense) and will not modify your AWS environment.

### 12.8 Things to know (please read)

- **FinOps Agent deep analysis is temporarily disabled**; the UI shows "coming soon," and it is not available yet.
- **In v1, cross-account is locked to the deployment account by default**; switching to other accounts is not yet possible.
- **Notification freshness relies on 60-second polling** (not WebSocket), so the red dot may lag by up to about 1 minute.
- **The live Health Dashboard view requires a Business+ / Enterprise Support plan**; otherwise it degrades to console links.
