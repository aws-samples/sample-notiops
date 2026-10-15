# NotiOps — User Guide

> 🌐 **Language**: [中文](USER_GUIDE.md) · [English](USER_GUIDE.en.md)
>
> **Audience**: SREs / DevOps engineers / application developers using NotiOps.
>
> **How this guide is organised**: **Part 1 covers the Web Chat console in your browser — the primary NotiOps surface**, where most day-to-day work happens. **Part 2** covers the bot in Feishu / Slack / DingTalk, a necessary but **secondary, supplementary** surface. **Part 3** holds the FAQ and support paths that apply to both.

**Version**: v2.5 - 2026-09-15 (**the multi-cloud sections are withdrawn in full** -- that path is **not offered externally for now**: the chat objects on "New chat" are back to the **two** NotiOps / AWS DevOps Agent, the admin console's "Cloud environment" group no longer has a third page, the IM `agent` command lists those two only, and the `/help` row narrows to match. The related material in the old §6.8 and §15.5 is removed with them. ⚠️ **If you had previously registered read-only credentials for another cloud**: they still exist in this deployment account's AWS Secrets Manager -- no entry point in the UI does not mean the credential was deleted. To revoke them for good, delete or disable that AccessKey in that cloud's own console. Previous version, v2.1 - 2026-09-11: the security topic was folded into investigation)

---

**Pick a surface first** — most things work on both, but each is good at different situations:

| What you want to do | Use | Why |
|---|---|---|
| Sit down and work through one failure, watching the analysis as it happens | **Web Chat** | A live "Thinking" panel on the right; full reports are readable online and downloadable |
| Cost reviews / security posture / the whole Support case lifecycle | **Web Chat** | These topics come with dashboards and structured cards that exist only on the web |
| Write / manage / publish your own Skills | **Web Chat only** | Skill intents were retired from the IM side on 2026-09-06 (see §5) |
| You're on call and want to ask right in the group chat, with colleagues looking on | **IM bot** | @ the bot to ask or to dispatch a deep investigation; answers and reports are visible to the whole group (note: in this release alarms are **not** pushed into IM groups — they show up under Notifications in the web; see §14) |
| Ask one quick question from your phone and move on | **IM bot** | No laptop needed |

> Both surfaces are **read-only by default**; the one write is an **AWS Support case** (create / reply / close), and it runs only after you confirm it (§1.5, §12). Each surface guarantees read-only **its own way** — Web Chat relies on "IAM permissions (the hard boundary, read-only on your infrastructure) + read-only tool layer + command-level denylist + read-only system prompt"; on IM, the default DevOps Agent direct path relies on "the read-only agent and read-only role on the DevOps Agent side", while after `/agent notiops` the same AgentCore Runtime as Web Chat answers with its read-only role and read-only tools (as in §8.1); on both IM paths NotiOps adds one change-wording regex. See §8 and "Who guarantees this 'read-only'" in §9. Anything that would change your AWS environment produces a preview for you to confirm on either surface, or sends you to the relevant console instead.

---

## Table of Contents

**Part 1 · The Web Chat console (primary surface)**

1. [Five minutes in: opening Web Chat for the first time](#1-five-minutes-in-opening-web-chat-for-the-first-time)
2. [The left nav: what each entry is for](#2-the-left-nav-what-each-entry-is-for)
3. [Three end-to-end walkthroughs](#3-three-end-to-end-walkthroughs)
4. [Cross-topic mechanics](#4-cross-topic-mechanics)
5. [Skills (your own capability packs)](#5-skills-your-own-capability-packs)
6. [Administration and customisation (admin view)](#6-administration-and-customisation-admin-view)
7. [Web Chat sample phrasings](#7-web-chat-sample-phrasings)
8. [Web Chat: things to know](#8-web-chat-things-to-know)

**Part 2 · IM (Feishu / Slack / DingTalk), the supplementary surface**

9. [What the bot is / is not](#9-what-the-bot-is--is-not)
10. [Getting started: your first @ bot](#10-getting-started-your-first--bot)
11. [Investigate AWS resources](#11-investigate-aws-resources)
12. [AWS Support case management](#12-aws-support-case-management)
13. [Ask AWS concept / docs questions](#13-ask-aws-concept--docs-questions)
14. [Passive scenario: receiving proactive alarm cards](#14-passive-scenario-receiving-proactive-alarm-cards)
15. [Model and chat object](#15-model-and-chat-object)
16. [Language preferences (Chinese / English switching)](#16-language-preferences-chinese--english-switching)
17. [DingTalk platform notes](#17-dingtalk-platform-notes)
18. [IM Sample Phrasings](#18-im-sample-phrasings)

**Part 3 · Common to both surfaces**

19. [FAQ](#19-faq)
20. [Feedback & support](#20-feedback--support)

---

# Part 1 · The Web Chat console (primary surface)

> This part is the main line of NotiOps. Sign in once in your browser and you can use natural language to run failure investigations, do cost reviews, check your security posture, file AWS Support cases, follow AWS launches, invoke your own Skills, and read all your alarm notifications in one place.

## 1. Five minutes in: opening Web Chat for the first time

Web Chat is the NotiOps web console: one browser page with navigation on the left, the conversation in the middle, and "Sources" / "Thinking" panels that slide out on the right when needed. You ask questions in plain language, it uses **read-only** permissions to look at your AWS environment, and it hands back conclusions, evidence and links together.

### 1.1 Signing in

Your administrator gives you a URL and an initial account.

1. Open the URL. You get a single card titled **Sign in to NotiOps**, with Username / Password fields and a **Sign in** button. Nothing else renders until you are signed in.
2. **Your first sign-in always forces a password change**: the same card then asks you to **Set a new password**, and you go straight in.
3. The sign-in page is deliberately **English-only** — there is no language switch here. You switch to Chinese after signing in. Note that a failed sign-in shows a hardcoded Chinese string (`登录失败`), and an unsupported extra verification step shows `需要额外验证步骤: <step>`.

**The initial username is `admin` on both deployment paths**; where the temporary password comes from differs:

- **One-click deployment (method A)**: follow the instructions in the CloudFormation Outputs — it is emailed to the address you supplied.
- **Full deployment (method B, `setup.sh`)**: the temporary password is printed in the deployment terminal.

> Sign-in uses the NotiOps Cognito user pool (the same deployment that sends your proactive notifications). **There is no self-registration and no self-service password recovery** — a forgotten password or a new account both go through whoever operates this NotiOps deployment.

### 1.2 Set language and appearance first

**Click your own name at the bottom-left** to open the user menu. It has exactly three items, and the first two are worth setting on day one:

| Menu item | What it does |
|---|---|
| **Appearance** | Only **Dark** (the default) and **Light** — there is no "follow system" option |
| **Language** | Exactly two options: `English (United States)` and `中文（简体）`. **A fresh browser defaults to English**; your choice is remembered per browser |
| **Sign out** | Returns you to the sign-in card |

The GitHub icon to the right of your name (its hover text reads "Star NotiOps on GitHub") opens the public repository home in a new tab — the changelog (Releases) and issue reporting (Issues) are reached from there. The menu's three former external links (View changelog / Learn more / Report an issue) were removed on 2026-09-12.

> ⚠️ **As of 2026-09-11 there is no "Settings" item in this menu.** It was never implemented — clicking it only popped a "Settings · Coming soon" alert — so the whole item was removed rather than left as a placeholder. The real configuration entries are the sidebar's **More → Admin** (roles / permissions / models / IM credentials) and **More → Inspection → Settings** (scope / thresholds & schedule); neither is the same thing.

> The UI language only affects **UI text**. The language of the *answers* follows **the language you ask in** — ask in English, get English.

### 1.3 The three regions of the screen

- **Left nav**: **New chat** at the top, then 4 top-level entries (Notifications / Investigation / Cost / Cases) and an expandable **More** (Inspection / Skills / Admin — whether each one shows still depends on your role, the deployment and the Modules switches; it expands by itself when the current page is one of them, and remembers whether you left it open; if none of the three is shown, "More" is not shown at all — see §2.10 for why), then your **conversation list** grouped by topic, and at the bottom a **What's New** card plus your user menu. The whole sidebar collapses ("Collapse sidebar" / "Expand sidebar").
- **Middle**: the conversation. The topbar shows the title, a topic tag and the **account picker**; messages in the middle; the composer and its toolbar at the bottom.
- **Right-hand dock**: takes no space until needed, then slides out as either **Sources** (what this answer was based on) or **Thinking** (what it did, step by step). Both share one rail, so only one shows at a time.

### 1.4 Asking your first question

Click **New chat** and you get: a pulsing logo, the headline "What should we do in NotiOps?", a **chat-object picker**, and **4 starter cards**.

Those starter cards are **4 drawn at random from a pool of 12**, re-drawn every time you start a new chat. Clicking one **types that sentence into the composer** — it does not send it and does not switch topic — so you can edit before sending.

Enter sends, `Shift + Enter` inserts a newline. A caption under the composer always reads "NotiOps can make mistakes. Verify important findings."

**Chat object: who answers this whole conversation** (the picker exists **only on a general conversation** — it isn't rendered once you enter a specific topic):

| Option | The exact UI wording | What it means |
|---|---|---|
| **NotiOps** | Global view · inspection, investigation, cases and knowledge | Our orchestrated model plus the read-only toolset — it can file cases, read inspection findings, and use the knowledge base |
| **AWS DevOps Agent** | Go on-site · live triage, no model setup | Straight to your own AWS DevOps Agent, **0 tokens** (usage is charged to your DevOps Agent) |

- Pick one of the two. The default is **NotiOps**, and you can skip the choice altogether by just typing.
- The **AWS** in that segment name is deliberate: this row decides who answers the sentence, and the two paths differ in who answers, which tools are available and whose usage it lands on -- so the name has to say it itself.
- It is a **two-stage control**: switch freely before you send the first message, but it **locks once the first message goes out**. To change it, start a new conversation. Reload the page or open the same conversation on another device and the object is still the one you picked.
- "**No model setup**" is more than a token saving: on a brand-new deployment with no Bedrock model enabled yet, picking this side (or turning on "Deep Dive" inside a topic) lets you **send anyway** -- the Send button bypasses the model-catalog gate.
- **Only the segment that isn't configured is greyed out, and the reason is spelled out in the hint line under the control** (not just in a hover title): when the account has no DevOps Agent onboarded, the right-hand segment is the grey one, and the hint says whether it is "this account isn't onboarded" or "this deployment isn't wired up". If the segment that got greyed out is the one you had selected, it **falls back automatically** to NotiOps -- once it is grey you cannot click your way back to it.
- After you pick DevOps Agent, the composer drops the web-search toggle and the model selector, but the **"/" command button stays and genuinely works** (§5.6).
- The **NotiOps / AWS DevOps Agent** label on the conversation titlebar is the current object (**worded identically** to the segment names above, and to the signature in the answer footer). It is deliberately not rendered while history is still hydrating -- don't read "no label yet" as NotiOps.

### 1.5 Three things to know immediately

1. **It is read-only on your infrastructure.** It can read your CloudWatch, CloudTrail, EC2, RDS, cost, security findings and Support cases, and it **changes nothing**. The single exception is AWS Support cases (create / reply / close), and even those only execute after you click a confirm button — see §8.
2. **Every question targets one specific AWS account.** The account picker in the topbar decides which account this turn is about, and every answer's footer prints the 12-digit account it actually answered for, so you can't mistake an old answer for the current account.
3. **Conversations are kept for 30 days by default.** The server expires them (touching a conversation refreshes the clock). Anything you need long-term, export via **long-report download** (§4.8).

---

## 2. The left nav: what each entry is for

Start with the whole picture — the key distinction is which entries are **chat topics** and which are **dashboards**:

| Entry | Shape | Reach for it when |
|---|---|---|
| **Notifications** | Dashboard (inbox) | You want to know "is anything wrong": AWS Health, alarms, cost anomalies, Trusted Advisor and GuardDuty all land here |
| **Investigation** | Chat topic **+** 7 operational dashboards **+** 4 security dashboards | You have one concrete failure to chase; **security questions belong here too**, and so do the security dashboards (see §2.4); or you want to scan alarms / changes / backups / EOL first and then decide |
| **Cost** | Chat topic **+** dashboards | Monthly cost reviews, finding what drove an increase, SP/RI coverage, splitting spend by tag |
| **Cases** | Chat topic **+** 4 dashboards | The whole AWS Support case lifecycle: read, analyse, create, reply, close |
| **Inspection** | **Dashboards only — not a chat topic** | Reviewing what the automated inspection found (hot / idle resources) and dispatching an AI judgement |
| **Skills** | Management page | Turn your team's process and standards into Skills so it works your way |
| **Admin** | Management pages | Under "More" (since 2026-10-10): models, role permissions, account onboarding and other console settings. **Administrators only.** |
| **What's New** card | Chat topic | Track AWS launches, filtered against the services your account actually uses |

> **There is no "Security" item in the sidebar.** Security's **chat** capability was always a subset of Investigation's, so it folded in there; every security **dashboard** is still present, reached from the **Security posture** pill above the Investigation composer (below).

Clicking a **chat topic** doesn't drop you into a blank chat — you land on that topic's **landing page**: pulsing logo + a topic headline + 4 random starter cards + a composer.

**Every topic that has dashboards reaches them from the pill row above the composer** — **left-aligned with the chat box**, a single row that never wraps (it scrolls horizontally on narrow screens), with **no** category label in front of it:

| Topic | Pills | Opens |
|---|---|---|
| Investigation | ⟨Operations overview⟩ ⟨Security posture⟩ | 7 operational dashboards / 4 security dashboards (§2.2, §2.4) |
| Cost | ⟨Spend & savings⟩ | the cost dashboards (§2.3) |
| Cases | ⟨Case progress⟩ | 4 case dashboards (§2.5) |

The pill names are deliberately **coarse-grained**: one pill = one dashboard tree, so adding panels to a tree never adds pills to this row. The row shows both on the landing page and inside a conversation, and a dashboard opened from a pill gets a **Back** button at the top left that returns you to the conversation you came from.

### 2.1 Notifications

The first nav entry, with an **unread count badge** beside the label (capped at `99+`, refreshed roughly every 60 seconds). **Opening the page marks every notification as read** and zeroes the badge on the spot — there is no "mark all read" button and no read/unread filter. If you want to keep one for later, note it down yourself. There is a **↻ Refresh** in the header so you don't have to wait for the 60-second poll.

The page header also carries **its own account picker**. It switches the account view for **AWS Health and Lifecycle/EOS only** — it **does not filter the inbox**, which is one shared account-level list.

The left side has two groups, **4 + N** entries in total:

**(A) AWS Health (live against the AWS Health API — 3 blocks plus one separately-authorised sub-page)**

| Block | What's in it |
|---|---|
| **Service health** | Public events on the AWS side. A "**Status history**" external link at the top right |
| **Your account health** | **Only** issues that concern your account (scope other than PUBLIC). A "**View in console**" external link at the top right |
| **Scheduled changes** | **A third, independent block** (not part of account health): **Calendar** (default) / **List** / **Timeline** views, headed by "next 7 / 30 / 60 days · N changes" count cards |
| **Lifecycle / EOS** | See (B) below |

- Each block lists **at most 50 entries** (up to 300 events fetched in total, each description trimmed to 800 characters); beyond that the footer reads "N more — view in the console".
- Every card has a "**Show full notification**", which only then fetches the detail by ARN; on failure it says "Failed to load details. Retry, or view it in the console."
- Without a Business / Enterprise Support plan the whole group says plainly: "Health Dashboard requires a Business or Enterprise Support plan. View it directly in the console."
- ⚠️ **The organisation-wide Health view currently cannot run** — the deployment's IAM lacks the permission for it, so the "whole organisation" scope badge and the "most widely affected" row **never appear**.

**(B) Lifecycle / EOS** (the fourth item in the AWS Health group — the largest single block in this topic)

It scans **RDS / Aurora, EKS, Lambda, ElastiCache, OpenSearch and EMR** across all regions and gives you:

- **4 risk cards**: already expired / due within 7 days / within 30 days / within 90 days
- **Supported ratio** and **risk distribution by service**
- **An upcoming-expiry list** (each row reading "N days left" or "expired N days ago")
- **AWS Health end-of-support notifications** — this part is the **authoritative source**, straight from AWS
- A footer stating **how many regions were scanned**; results are **cached server-side for 60 minutes**
- In the organisation view it adds **risk distribution by account**, and you can click an account to drill in

> ⚠️ This item has its **own capability gate** (`nav:notifications:eos`) — **having the Notifications entry does not give you this**. Of the six preset roles, **only Administrator** can see it. Its absence for other roles is not a bug, it's a missing grant.

**(C) Event notifications (the persistent inbox — the source of the badge)**

One entry per event type with a count badge (the badge uses the **real total in the inbox**, unaffected by the display cap).

**The actions differ between the two kinds of card** — this is the easiest thing to get wrong:

| Card | Buttons |
|---|---|
| **Health event card** | Investigate deeply / Ask about this / Show full notification — **no console button** (the console link lives at block level) |
| **Inbox event card** | Investigate deeply / Ask about this / Console (only when the event carries a link) / Show full notification (only when there's a body) |

Two buttons with the same name, on **completely different cost models**:

| Button | Clicked from | What happens |
|---|---|---|
| **Investigate deeply** | **Inbox card** | Opens a new Investigation conversation with **Deep Dive turned on automatically** (0 tokens, BFF straight to DevOps Agent) and **sends the prepared investigation description immediately** |
| **Investigate deeply** | **Health card** | Also opens a conversation and sends immediately, but **turns on no deep-dive switch at all** — it uses the Investigation topic's ordinary model plus read-only tools to cross-reference affected resources, and **that costs model tokens** |
| **Ask about this** | Both cards | Opens an ordinary conversation carrying the event, answered immediately by the model |

> ⚠️ Two things to note:
> 1. Both buttons **send on click** — they do not prefill the prompt for you to edit first.
> 2. **Only "Investigate deeply" carries the account you selected on the Notifications page; "Ask about this" does not** — on a multi-account deployment "Ask about this" may end up asking about whatever account the chat side is currently on.
>
> The inbox **never starts an investigation on its own** — something only happens when you click. The inbox is **account-level** (everyone with access to that account sees the same list), duplicate events inside 5 minutes are collapsed, entries expire after roughly 90 days, and a list **shows only the newest 200**; when truncated the group footer says so honestly — "Showing the latest {n} of {total}" (or "Showing the latest {n}; older notifications are not shown" when even the total is unavailable).

**Five event sources are on out of the box** — but **each one also has a hard filter**, which is the most common reason for "it's on but nothing arrives":

| Event source | What it actually pushes |
|---|---|
| **AWS Health** | Only **actual-impact events** with `category=issue`. Scheduled changes and account notifications **never enter the inbox** — they only show in the live Health view above |
| **CloudWatch alarms** | Only when an alarm **enters the ALARM state** |
| **GuardDuty** | Only findings of **severity ≥ 7.0** |
| **Trusted Advisor** | Only checks with **status=ERROR** |
| **Cost Anomaly** | Anomalies raised by Cost Anomaly Detection |

Five more **ship disabled**: AWS Backup, EC2 Spot interruption, Auto Scaling launch failure, RDS DB instance events, Config compliance. A default-off type only appears in the left list once a real event has arrived; while empty it says "No events of this type yet. This event source is off by default — enable the matching EventBridge rule first." To turn one on: method B takes a deploy-time flag such as `-c webNotifBackupJob=on`; under method A you **Enable** the matching rule in the EventBridge console (the rule names come from the same source on both paths).

> ⚠️ Three deployment differences:
> 1. **Cost Anomaly** and **Trusted Advisor** can only emit events in **us-east-1** (they are global services on the AWS side). Method B prints a synth warning when you deploy elsewhere; method A only states it in the rule description.
> 2. **Method B excludes NotiOps' own `notiops-inspection-*` operational alarms; method A (one-click CFN) currently has no such filter** — so a one-click deployment's inbox may show NotiOps' own operational alarms. This is a known gap, being closed under the "both paths must have the same features" rule.
> 3. `/health/dashboard/count`, "other notifications", "event log" and "unhandled issue count" are returned by the backend but **no component renders them** — don't go looking.

### 2.2 Investigation

> 🔴 **Security questions belong here now too** (as of 2026-09-11 "Security" is no longer a chat topic; only its dashboards remain). The reason is blunt: the Security topic's chat side mounted only the 8 core tools and its system prompt had nothing security-specific, whereas Investigation mounts the full 21 CloudWatch + CloudTrail read-only tools — the very same security question got a **worse** answer over there. So the starter-question pool grew from 6 to **12**: the Security topic's 6 moved across as a set (security findings, publicly accessible S3 buckets, security groups open to `0.0.0.0/0`, IAM permission risk review, IAM users without MFA, cloud security best practices). The landing page draws 4 cards from those 12 and the in-conversation chip row draws 3 (the sample sizes didn't change — you just see more variety).

Headline "Let's investigate your AWS environment", and once you are in the conversation the empty state asks "Which resource do you want to investigate?" This is the deepest topic in NotiOps — **two flat toggles** sit under the composer (both off by default, see §4.3):

| Mode | Who answers | Latency | Tokens |
|---|---|---|---|
| **Both off** (default) | NotiOps plus this topic's read-only toolset | Seconds | Billed |
| **DevOps Chat** | Your own AWS DevOps Agent, streamed | Seconds | **0** (charged to your DevOps Agent) |
| **Deep Dive** | Handed to DevOps Agent for multi-signal root-cause work, BFF calling its API directly | Minutes | **0** |

> 🔁 As of 2026-09-13 there is only **one** Deep Dive here, and it is the **0-token** one. There used to be two toggles with the same name: one spent tokens having the NotiOps model hand the work over, the other was labelled "(Direct)" and bypassed the model entirely. One capability behind two entry points, differing only in whether you burn a round of tokens first — nobody had a basis for choosing, so the direct one stayed and the "(Direct)" qualifier went away with it.

> ⚠️ A known display inconsistency: **in the Investigation topic**, replies from the direct path are persisted without a provenance marker, so **after a reload the footer reads "AWS Bedrock (&lt;model name&gt;)" instead of AWS DevOps Agent**. It is correct on the turn itself and changes after a refresh. Billing is unaffected — that turn really did cost 0 tokens.

**The default (both toggles off) already does a lot.** This topic mounts the **full CloudWatch + CloudTrail read-only toolset** (21 tools; other topics get only 8 core ones), so you can ask directly about active alarms, alarm history, metrics, log groups, Logs Insights queries, and CloudTrail via `lookup_events` / `lake_query`. Every topic also has native read-only boto3 tools: RDS instance list / detail / recent events / metrics, EC2 instance list / detail (including `stateReason` and `stateTransitionReason`, so "why did it reboot last night" is answerable), and security groups.

**There are 7 dashboards** (reached via the **Operations overview** pill above the composer; the other pill, **Security posture**, opens the 4 in §2.4):

1. **Alarm Overview** — ALARM / OK / insufficient-data counts plus the list of active alarms
2. **Active Alarms** — every row has both an **Investigate** and a **Notify** button
3. **Recent Changes**
4. **Backup Health** — 7-day job totals / failures, with an Investigate button per failed job; when unavailable it says "Backup data unavailable (AWS Backup not in use, or no permission)."
5. **AWS Health** — needs Business / Enterprise Support, otherwise "AWS Health unavailable (requires Business/Enterprise Support)." plus an "Open console" link
6. **EOL Risk** — a multi-region scan (the UI warns it can take ~45 s), reporting at-risk / total / supported %, with a retry on timeout
7. **Event Inbox**

> The **Investigate** buttons on dashboards deliberately **do not turn on deep dive** — they just write a good question for the model and answer in seconds. Only the **Event Inbox** cards carry deep dive, and they turn on **Deep Dive**.
>
> ⚠️ **Retired on the same day (2026-09-11).** Investigation and Security each used to have a **thumbnail landing page** (a few small cards with a number, which you clicked into for detail), topped by an org-level "**distribution by account**" card (alarms for Investigation; GuardDuty high-severity + TA issues for Security, one clickable row per account). Moving to "pills + two-pane browser" deleted both landing pages, and **those two overview cards went with them**. The backend endpoints (`/investigate/alarms/org-summary`, `/security/org-summary`) are **still there**, so a future "posture by account" view can just read them — no backend rework needed.

### 2.3 Cost

Headline "Let's optimise your cloud costs". The nav label is **Cost** (never "FinOps").

**In the chat**: inside this topic NotiOps additionally mounts two official AWS MCP servers (`aws-pricing-mcp-server` and `billing-cost-management-mcp-server`) as in-process subprocesses, narrowed to an **18-tool read-only allowlist**. That is what makes "why did this month go up", "which instances cost the most" and "what is our SP coverage" answerable with real numbers.

> ⚠️ Two boundaries: (1) those MCP servers are mounted **only in the Cost topic** — other topics get 7 core tools; (2) they are **not** mounted when you are browsing a member account (their credentials are pinned to the deployment account), so native read-only boto3 fallbacks substitute, with a slightly narrower reach.
>
> **Amazon Nova Pro** has been disabled by default in the model catalogue since 2026-10-10, so it normally isn't in the model menu at all; if an administrator ticks it back on under More → Admin → Models, it is tagged "Not recommended" in this topic, noting that Claude / DeepSeek are better for cost analysis.

**Dashboards** (reached from the **Spend & savings** pill above the composer): **7 are visible by default** — spend overview, optimisation & risk, key progress, month-over-month movers, cost deep dive, cost by tag, and cost anomalies. Four more **CUR reports** (cost trend / credits / extended support / Savings Plans) only appear once a **cost MCP server** is connected; without one the whole block is hidden, and with one the left rail runs to **at most 11 entries**. **Neither deployment path connects one by default** — you turn it on at deploy time, in one of two ways:

- **Let NotiOps deploy one for you** (recommended): on method B, `COST_MCP_SELF_HOST=true ./setup.sh`; on method A, fill in `CurTable=<db>.<table>` (an existing CUR) or pick `ProvisionCur=yes` (NotiOps creates the CUR as well). It only queries a CUR in **the deployment account and Region** — a CUR in another account is not supported yet; use the other way for that.
- **Point at one you already run**: on method B, `COST_AGENT_MCP_URL` + `COST_AGENT_FN_ARN`; on method A, `CostAgentMcpUrl` + `CostAgentFunctionArn`.

A newly created CUR has to wait for AWS's first delivery (up to 24 hours); until then these 4 reports say the customer-CUR data source is temporarily unavailable, and they switch over on their own once it is ready — no second deployment needed. Details: [DEPLOYMENT.en.md §14.2](DEPLOYMENT.en.md) and [DEPLOYMENT_ONECLICK.en.md §2.12](DEPLOYMENT_ONECLICK.en.md).

**Cost Deep Dive** covers 4 scenarios (CloudWatch / data transfer / EC2 compute / S3 storage) over pre-created Athena named queries, producing an "AI insight (please verify)" plus "Download raw data CSV ↓". NotiOps creates those named queries automatically the moment the CUR is first ready: method B's "CUR + Athena" step (whether it creates a CUR or reuses one) gets there by default; method A only does it when you pick `ProvisionCur=yes` — filling in `CurTable` alone doesn't count (see §8.6). Without those named queries it reports `no_named_queries` / `named_query_not_found` explicitly instead of handing you an empty table.

Every cost page carries the footnote: **excludes support, discounts and tax; cost data lags by roughly 1–2 days**.

### 2.4 Security posture — a dashboard tree under Investigation

> 🔴 **As of 2026-09-11 "Security" is no longer a chat topic, and the sidebar no longer has that item either** — only these 4 dashboards remain. Ask security **questions** in **Investigation** (§2.2): the toolset there is fuller and the answers are better, and the Security topic's 6 starter questions moved across as a set.
>
> **There is exactly one entry**: go to **Investigation** and click the **Security posture** pill above the composer. The page header carries a **Back** button at the top left that returns you to the conversation you came from.
>
> What about old conversations: history rows still tagged "Security" **display as "Investigation" automatically** (normalised on read — nothing for you to do), and asking further questions in them uses Investigation's full toolset.

**The dashboard has exactly 4 items**, each authorised card by card:

| Card | What's in it | What to watch for |
|---|---|---|
| **TA security checks** | A three-colour summary (OK / needs attention / at risk) + the check list + drill-down into the **flagged resource detail** for any check, each row with its own **Investigate** button | Needs Business / Enterprise Support (otherwise "Requires a Business / Enterprise Support plan."); ⚠️ Trusted Advisor is **always read from us-east-1** regardless of your deployment region; **check names and drill-down table headers are always in English** |
| **Security Hub** | **Counts across four severity tiers** (Critical / High / Medium / Low) + the **top 8 high-severity findings** | ⚠️ It only queries active findings in the **deployment region**; counts come from one `GetFindings` call (ACTIVE + NEW/NOTIFIED, **max 100**), so they are a **sample** and read low when you have many findings. When Security Hub is off: "Security Hub is not enabled." |
| **GuardDuty** | **Counts across four severity tiers** (Critical / High / Medium / Low) + the **top 8 high-severity findings** (title, score, finding type · region, each row with its own **Investigate** button) | ⚠️ It only queries active findings in the **deployment region**, and only through the **first** detector; when GuardDuty is off: "GuardDuty not enabled." |
| **Security bulletins** | Official public AWS security bulletins, **last 30 days** | A public source, so it still renders even when cross-account credentials fail |

The **Investigate** button on each card (and on each row of the TA drill-down table) hands off to a new Investigation conversation and **does not turn on deep dive** — it just writes a good question for you. The server caches per account for **5 minutes**, so a finding you just remediated on the AWS side won't vanish immediately.

> **To see Security Hub across the whole organisation and all regions** you need a Security Hub delegated administrator plus an `ALL_REGIONS` finding aggregator. Method B (`setup.sh`) asks about this on a multi-account deployment (**off by default**); method A (one-click CFN) has no such step, so do it in the console yourself.
>
> **Who sees this pill**: admins always do; a non-admin needs `nav:security`. Two of the six preset roles carry it — **Support-Ops** and **Viewer** (added 2026-09-11; before that none did, which meant "only admins can get into the security module" — never the intent). Every other role still needs an administrator to grant it explicitly. The pill is also **fail-closed**: while the capability call is failing, a non-admin temporarily won't see it at all (the Operations overview pill next to it is the opposite — fail-open). ⚠️ Because it lives inside the Investigation topic, **anyone without `nav:investigate` never reaches this row at all** — which is exactly the Viewer role's situation today (see §2.10).
>
> ⚠️ Permission is enforced **per card**: revoke a card and the BFF strips its data out too, and the left-hand tree stops listing it — you never get a panel that opens onto nothing.
>
> ⚠️ Method A has a deploy parameter `AgentReadOnlyAccess` (default Yes). It decides how widely the agent **can read**, not whether it can write: Yes attaches the AWS managed `ReadOnlyAccess` policy to the agent's role; No leaves only the curated read-only grants (cost, logs, metrics, RDS / EC2 describe and the like), a narrower set — Security Hub / GuardDuty findings, for example, are then out of its reach, so security questions like these fail in chat for lack of permission. Either way, the agent's role has no write permission on your infrastructure.

### 2.5 Cases

Headline "Let's handle your AWS Support cases". The **9 Support case tools are mounted on every non-IM topic**, so you can work with cases from any conversation without switching topic first.

**What you can do:**

- **Read**: "list all my open cases" — supports `open` / `resolved` / `all`, defaults to 20, scans at most 3 pages / 300 cases, newest first.
- **Read a thread**: open one case and see its correspondence (up to 10 recent communications, each body trimmed to 2000 characters; a separate tool pages further back).
- **Create / reply / close**: all three are **propose → you confirm → execute**, see §8.

**Creating a case: just say what you want — don't wait for a template**

State the intent ("create a new support case for me") and the assistant **pops an editable "Create support case" card straight away**. ⚠️ It will **not** hand you a text template to fill in and send back — don't wait for one, it isn't coming.

The fields on the card:

| Field | Notes |
|---|---|
| **Service** | ⚠️ Not a dropdown caret — a "**Type to search services**" search box with a suggestion list (it shows "Loading…" while fetching). Candidates come from the live `DescribeServices` catalog, cached 6 hours per UI language; **the count changes as AWS adds services**, and the UI never shows a total |
| **Category** | Linked to the service; with no service picked it says "Pick a service first" |
| **Case type / Severity / Language** | All have defaults |
| **Description** | **Required**, capped at **2000 characters** |
| **Which account \*** | Appears only when there is a deployment account **plus ≥1 enabled member account**; on a single-account deployment the whole field is hidden |

- **Preview** only becomes clickable once **subject, service (a real one picked from the catalog), category and description** are all present and this card hasn't been executed yet.
- If the catalog can't be fetched the card shows a warning, and service / category validation is **relaxed**.
- Clicking **Cancel** sends no request to the backend at all.
- After you confirm, the card gives you the case number and "— Open in the AWS console", tagged either "**verified**" (the system read the case back) or "**status pending**" — **the latter does not mean the creation failed**.

**If you paste structured fields yourself** (say a "subject / service / severity / description" block copied from elsewhere), the assistant parses it into a **read-only review card** you confirm to create directly. When the service can't be resolved the card says "(could not match a service — go back and supply the service name)" and **Confirm is disabled**.

**It probes entitlement before showing you the form** (`case_capability`, 15-minute cache). If the probe fails it tells you why (`support_plan_required` / `access_denied` / `cross_account_unavailable`) and **exactly which IAM actions are missing** (`support:DescribeServices`, `support:DescribeSeverityLevels`, `support:CreateCase`) rather than letting you fill in a doomed form.

> The AWS Support API requires a **Business / Enterprise On-Ramp / Enterprise** support plan. On Basic / Developer the create card is replaced by a bilingual notice plus an "Open Support Center" console link.

**The case dashboard** (via the **Case progress** pill above the composer; "← Back" at the top left returns to the conversation you came from) — **4 entries** in the left rail:

| Page | What's in it |
|---|---|
| **Open cases overview** | A severity donut plus the top 5 services. On a multi-account deployment it is headed by an "**Org overview · N accounts · M cases in progress**" card (**15-minute cache**; ⚠️ **member accounts only, excluding the deployment account**; accounts it couldn't read are called out separately) |
| **Waiting on you** | Cases where the ball is in your court, each showing "waiting N days" |
| **High severity / Incident** | High-severity and incident-type cases |
| **Response health** | Three columns: on-track / at-risk / over target |

> ⚠️ Two things about the numbers:
> 1. **Response health is NotiOps' own estimate, not an official SLA** (`DescribeCases` returns no SLA field). It compares hours since the last communication against a per-severity target — critical 0.25 h / urgent 1 h / high 4 h / normal 12 h / low 24 h.
> 2. The dashboard statistics only cover **the most recent 100 cases**.
>
> There is **no "trend analysis" page** in the rail — don't go hunting for "6-month trends / AI recommendations", there is no entry point in production. Likewise the Cases topic **does not mount DevOps Agent**, so none of the §4.3 toggles are rendered here, and the case list has no "escalate to a Support case in one click" button.
>
> The suggested-question chips in the Cases topic are built **from your real case data** (e.g. "Look at my 3 open cases", "Analyse latest case #&lt;id&gt;"), so what you see differs from what your colleague sees.

### 2.6 Inspection

**Inspection is deliberately not a chat topic** — clicking it goes straight to dashboards, with no landing page. What you see are the findings from NotiOps' own scheduled inspection runs.

Two groups, **4 pages**:

- **Findings**: **High load**, **Idle & cost**
- **Configuration**: **Inspection scope**, **Thresholds & schedule**

Opening a finding gives you a **read-only drawer** (closeable three ways). Inside is a **Deep analysis** button: fill in an optional "Additional context (optional)" → click "Dispatch judgement", and it really dispatches a DevOps Agent judgement, then tells you "Judgement dispatched. Come back in 1-3 minutes and click Refresh at the top right." and shows a ⏳ **Judging** badge. **A second judgement cannot be dispatched for the same finding** (the button is gone).

When you **trigger an inspection run manually**, the confirmation states the cost verbatim: it really calls GetMetricData and dispatches an AI judgement (both billed), consumes today's run slot, cannot be undone, and skips accounts that already ran successfully today.

> **Two things you must know:**
> 1. **One-click deployment (method A) has no Inspection at all** — there is no Inspection item under the sidebar's "More" (the whole tab is not delivered; see §2.10). Only a browser still holding an old front-end bundle, or a direct call to the `/inspection/*` API, ever sees the message that resource inspection is not in this deployment and that the one-click minimal base installs Web Chat only — use the full deployment (method B, `setup.sh`) if you need it (the API returns `inspection_not_deployed`).
> 2. On the full deployment (method B) inspection **runs as soon as it is installed — there is nothing to enable first**: the deployment account is onboarded automatically on every deploy, and both inspection types (high load / idle) run once a day at **02:00 UTC** by default, across all of the deployment account's Regions; the scheduler wakes every 15 minutes only to check whether a run is due. Like a manual run, every run really calls GetMetricData and, when there are findings, dispatches DevOps Agent judgements (both billed). Change the run time under "Thresholds & schedule"; to bring other accounts into scope, onboard them under More → Admin → Accounts (see §6.4); exclude resources you don't want scanned under "Inspection scope". Findings are written to a dedicated table.
>
> The scope / schedule / threshold / manual-run actions are granted by **none** of the six preset roles — only an administrator (permission `*`) can use them.

### 2.7 Skills

Skills is an item under the sidebar's **More** group (not buried under Customize). It lets you write your team's process, standards and domain knowledge into Skills so NotiOps works your way. See §5.

### 2.8 The What's New card

This one is **not in the topic list** — it is a card pinned to the bottom of the sidebar, titled **What's New** with the subtitle "Latest AWS launches, tied to your business".

It is **the only nav entry with no capability gate at all** — everyone can see it. Clicking it opens a fresh what's-new conversation with **web search already on**, but it **deliberately fetches nothing**: pick one of 6 preset chips, or ask your own question.

The time window can be a look-back in days (default 7) or explicit start / end dates, so "last month", "month-to-date" and "past 30 days" all work. Data comes from the official AWS What's New API (paginated, up to 60 pages / 2000 items, full history); if that fails it falls back to RSS, which only reaches back about 14 days — and in that case the report carries an explicit "incomplete window" warning. If both fail it tells you to use web search instead.

Asking "**what's relevant to my account?**" is genuinely personalised: it takes that account's **top 12 services by Cost Explorer spend over 30 days** as the filter (and a member account is queried with **its own session**, never deployment-account credentials).

### 2.9 Admin and Customize

- **Admin** — an 8-page admin console, see §6. It sits under the sidebar's **More** group, after Inspection and Skills (it was promoted to top level on 2026-09-11 and moved back into "More" on 2026-10-10 at the user's request), and only administrators see it.
- **Customize** — ⚠️ **currently not rendered at all.** The "More" group now holds Inspection / Skills / Admin, but Customize is still left out of it (`SHOW_CUSTOMIZE_ITEM = false` in `Sidebar.tsx`). Its Connectors and Plugins pages are still "Coming soon" placeholders; it will come back when there is something behind them.

### 2.10 An entry is missing? That's permissions or deployment method

> First check whether "More" is expanded. **Inspection / Skills / Admin all live in the sidebar's "More" group, and it starts out collapsed** — it only opens by itself when the current page is one of them; otherwise you expand it yourself (it remembers whether you left it open or closed). If the entry still isn't there once it's expanded, read on; if none of the three is available to you (role, deployment, or a Modules switch — see the three reasons below), "More" itself isn't shown. For example, on a method-A deployment a user in the Cognito `member` group (mapped to **Viewer** by default) sees no "More" at all: that role does grant Inspection, but method A doesn't ship it, and Skills and Admin aren't part of that role.

Whether a nav entry renders is decided by a **server-computed capability list** (fetched once after sign-in via `GET /me/capabilities`). Three possible reasons:

1. **Your role doesn't have that permission.** The six preset roles are **Administrator**, **Viewer**, **FinOps**, **Support-Ops**, **Developer** and **Service manager**. Note:
   - `nav:security` (the security-posture dashboards) is granted only by **Support-Ops** and **Viewer** — added 2026-09-11; before that no preset role had it, which meant "only admins can get into the security dashboards";
   - **No preset role** grants `nav:customize`;
   - **only Developer** grants `nav:skills`;
   - ⇒ so a default non-admin user can't reach Customize either (and right now Customize isn't rendered for anyone, administrators included — it is not part of the "More" group; `SHOW_CUSTOMIZE_ITEM = false`, see §2.9).
2. **This deployment doesn't ship that feature.** Some nodes depend on deploy-time environment values: all of Inspection depends on the inspection table, the Cost "daily anomaly" card depends on the cost-analyzer function, and the 4 CUR reports depend on a cost MCP server's endpoint. **Method A hardcodes the inspection table and the cost-analyzer function to empty**, so those two never appear under method A; a cost MCP server is not connected by default on either path, and appears once you turn it on at deploy time (the two ways are in §2.3).
3. **An administrator switched the whole tab off on the Modules page.** Module switches **override** individual permissions — off means nobody sees it (except the chat tab, which is always on).

> The loading policy is deliberately split: **Notifications / Investigation / Cost / Cases / Skills** show while capabilities are still loading (fail-open), while **Admin / Inspection** stay hidden while loading (fail-closed). So for an instant after the page opens the nav may be an entry or two short — that's expected. The same rule governs the pill row above the composer: Operational / Cost / Case progress follow their own topic and fail open, while **Security posture** is **fail-closed** — a non-admin won't see it until the capability list arrives.
>
> Permissions also apply **per card**: even when you can open Cost or Security, the BFF strips cards you lack permission for out of the response rather than relying on the frontend to hide them.

---

## 3. Three end-to-end walkthroughs

The three most common paths, each starting from what you actually have in hand.

### 3.1 Walkthrough 1: a CloudWatch alarm at 3 a.m. — find the root cause

**What you have**: a red badge on Notifications in the web (in this release no real-time alarm cards reach IM groups; see §14).

1. Open **Notifications** and find the CloudWatch alarm under "Event notifications".
2. Decide the depth:
   - **Just look first**: click **Ask about this** — a normal conversation, answered in seconds.
   - **Go straight to root cause**: click **Investigate deeply** — it opens a new Investigation conversation with **Deep Dive** on (0 tokens).
3. If you stay in the **default mode**, just keep asking in the Investigation topic — it has the full CloudWatch + CloudTrail read-only toolset:
   - "How many times has this alarm fired in the last 24 hours?"
   - "Pull the ERROR lines from `/aws/lambda/xxx` for that window"
   - "Did anyone change this resource during that window?" (CloudTrail queries are narrowed by event name + resource id + a tight window, never a broad sweep)
4. If you did turn on **Deep Dive**:
   - The chat shows "🚀 **Deep investigation started**" plus a title, description, execution id and a DevOps Agent console deep link; the direct path additionally marks it "(direct, 0 tokens)" and gives you a copyable **investigation id**.
   - Analysis steps stream live into the right-hand **Thinking** panel; when nothing new arrives, a heartbeat line appears roughly every 40 seconds.
   - It waits synchronously for at most **14 minutes** (polling every 8 s). On timeout it tells you the investigation is still running on the AWS side, and you resume later just by saying "show me the result of that investigation" (the direct path also offers a "🔄 Check investigation result (0 tokens)" button).
   - On completion you get "✅ **Investigation complete**" followed by the DevOps Agent's own text as **Summary / Root cause / Mitigation plan** (clipped at 4000 / 6000 / 4000 characters). **NotiOps does not re-summarise it** — what you read is the original.
5. **Want a mitigation plan**: below the conclusion is a DevOps Agent console button whose label is **conditional** — "🛠️ View this investigation in the DevOps Agent console (includes the mitigation plan)" when a plan exists, and "🛠️ Generate a mitigation plan in the DevOps Agent console (switch to the Root cause tab after it opens)" when it doesn't. You can also just ask for a mitigation plan in the conversation.
6. **Keep a record**: the full investigation is written as a self-contained HTML report to S3 and linked in chat as "🌐 View the online report", followed by "🔍 Investigation trace" — the investigation timeline: what the Agent checked at each step and what it saw (the same page as the button on the IM report card). Both also appear in Sources; the objects are removed by a lifecycle rule after roughly 7 days, so download anything you need to keep. If the trace page could not be generated, the chat says so and points you at the DevOps Agent console.

> ⚠️ On a turn with **Deep Dive** on, NotiOps **removes every direct environment-query tool** and keeps only the dispatch tool — that turn it is **physically unable** to look at CloudWatch itself. So "look in seconds first, then decide whether to go deep" is usually the faster order.

### 3.2 Walkthrough 2: the monthly bill jumped — run a cost review

1. Open the **Cost** topic, click the **Spend & savings** pill above the composer, and start with **spend overview** and **month-over-month movers** — find with your eyes which service and which account grew.
2. Go back to the conversation and dig in. Express the time range **in words** (there is no date picker):
   - "Top 10 services by cost over the past 30 days, compared with the previous 30 days"
   - "Which instance types drove the EC2 increase?"
   - "What are our Savings Plans coverage and utilisation right now, and how much is left to save?"
3. To **split by a specific dimension**: use **Cost Deep Dive** (CloudWatch / data transfer / EC2 compute / S3 storage), which gives an AI insight plus a raw CSV download, or the **cost by tag** page.
4. To **watch for anomalies**: use the **cost anomalies** page, or let the Cost Anomaly events in Notifications push them to you.
5. To **hand something to your leadership**: just say "write this review up as a full report". Long content isn't smeared into the chat — it lands in S3 and the reply gets an **online view** link (~7 days) and a **Markdown download** link (~12 hours).
6. **Cross-account**: switch account in the topbar and ask again. Note that the cost dashboards' scope badge follows — the deployment (payer) account shows "org aggregate (payer)", a member account shows "<name> · <account id> (cost filtered)".

> Cost data lags roughly **1–2 days** and **excludes support, discounts and tax**. Keep both in mind when comparing periods.

### 3.3 Walkthrough 3: you're stuck — file a Support case and follow it to closure

1. From any conversation: "help me open a case" / "create a new support case for me".
2. It **probes entitlement first**. If the support plan or an IAM permission is missing it tells you which, and **exactly which action** is missing, instead of wasting your typing.
3. Once cleared you get an **editable form card**: Service (searchable), Category (linked), case type, severity, language, description (≤2000 chars). On a multi-account deployment the card also carries an **account dropdown** (only when there are ≥2 choices, defaulting to the conversation's account).
4. Click **Preview** to check, then **Create case**. This goes through the BFF's `POST /actions/execute`: **the server performs the actual write with the parameters you confirmed — the LLM is not in the write path.**
5. After the write the BFF **re-reads the case** and returns a `verified` flag — create: found; reply: found **and** the latest communication matches what you sent; close: found **and** the status is resolved/closed. The card shows "verified" versus "status pending", with a console link beside it.
6. **Follow up**: reply and close use the same propose → confirm → execute flow, on cards titled "Reply to Support Case" / "Close Support Case" with Cancel / Confirm buttons, and success messages "Replied to the case successfully" / "Closed the case successfully".
7. **Review**: check "Waiting on you" and "Response health" on the Cases dashboard, or ask "which cases did I file in the last 30 days?".

> Escalating from an investigation: the **"Escalate to AWS Support" button has been removed** (§8), but the capability is intact — just say "escalate this to a human" / "open a case for this" and you land on the create-case card.

---

## 4. Cross-topic mechanics

Everything in this section behaves the same in **every** topic. Learn it once.

### 4.1 The account picker (topbar)

- It lives in the **conversation topbar** (not the composer toolbar), tooltip "Switch account for this view". The first option is the **deployment account**, followed by each onboarded member account shown as "name · 123456789012".
- **On a single-account deployment the dropdown is hidden entirely** — nothing to switch, so no clutter.
- The choice is **per conversation**; **the dashboards keep a separate selection** of their own, and the two don't interfere.
- The selected account is sent as `account_id` with every message, and the model is re-told the current account each turn, followed by a hard instruction: **never mix accounts**.
- **Every answer's footer prints which 12-digit account it answered for** — an orange dot for a member account, a blue dot for the deployment account.
- The create-case card has its own account dropdown as well (§2.5).

### 4.2 Model selection

- It sits at the **right end of the composer toolbar**, showing the current model name and a caret. The choice applies **to this conversation only**, and is remembered.
- **The list you see is the set your administrator enabled** under More → Admin → Models (fetched from the server's `/models`). The bundled fallback catalog is: **Kimi K3** (the bundled default), Grok 4.7, GLM 5.3, Claude Sonnet 5.5, Claude Opus 5.5, DeepSeek V3.2, GPT-5.6 Terra, GPT-6 Sol. A new conversation starts on your administrator's default model (also Kimi K3 unless they changed it).
- While the catalog loads the menu says it is reading available models; if the administrator enabled none it says so and **the Send button is disabled**. If the server catalog can't be read you get an amber degradation banner — it does not pretend the bundled list is your administrator's list.
- **Claude Haiku 4.5** and **GPT-5.6 Luna** are retired and unselectable; as of 2026-10-10 **Grok 4.6, GLM 5, Claude Sonnet 5, Claude Opus 5 and GPT-5.6 Sol** have also been replaced by the newer same-family versions above, and **Amazon Nova Pro** is switched off altogether. An old conversation still pinned to any of these falls back silently to the catalog default.
- If an administrator re-enables Amazon Nova Pro, it is tagged "Not recommended" in the **Cost** topic.
- When a turn is answered by **your own DevOps Agent**, the model selector **disappears entirely** (that path doesn't go through our Bedrock models), while sending still works.

### 4.3 Who answers, and how deep

A small row of **flat toggles** sits under the composer, choosing who answers this conversation and how deeply. **By default none is on and NotiOps answers directly.**

> 🔁 Changed on 2026-09-13: this used to be a single "answer mode" dropdown with four items. Once the duplicate item was retired, no topic has more than two left — hiding two toggles behind a dropdown you have to open first is just an extra click, so they went back to being flat. The same change removed the permanently greyed "FinOps" placeholder from the Cost topic.

- The toggles are **mutually exclusive**: turning one on turns the other off, so a turn can never be dispatched down two paths. The choice is remembered per conversation.
- Topics offer different sets:

| Topic | Which toggles appear |
|---|---|
| **Investigation** | **DevOps Chat**, **Deep Dive** (two) |
| **Cost** | **Deep Dive** (one) |
| **General / Cases / What's New** | **None** (the row isn't rendered at all) |

Hover a toggle and the tooltip says, in one sentence, "who answers + how long + what it costs you":

| Toggle | What the tooltip says |
|---|---|
| **DevOps Chat** | Chat with your own AWS DevOps Agent — 0 NotiOps tokens, no model setup, billed to your Agent; NotiOps tools and Skills aren't attached this turn |
| **Deep Dive** | Hand it to AWS DevOps Agent for multi-signal root cause + a report, usually minutes, **0 tokens**; your wording is passed through as-is. Off = NotiOps does instant read-only triage |

> These lines were shortened on 2026-09-11 so each is one line covering only "who answers + how long + what it costs". **Nothing that changes your decision was cut** — "0 tokens" and "tools and Skills aren't attached" are still there; what went are the details about enabling Bedrock and where approval-needing actions get confirmed (both are in this guide).

> ⚠️ **There is now exactly one Deep Dive toggle, and it is the 0-token one.** Before 2026-09-13 there were two with the same name: one spent tokens having the NotiOps model hand the work over, the other was labelled "(Direct)" and had the BFF call the API itself. One capability behind two entry points, differing only in whether you burn a round of tokens first — nobody had a basis for choosing, so only the direct one stayed and the "(Direct)" qualifier went with it. **If an older conversation still remembers the hand-over one, it falls back to off when you open it** — there is no switch for it in the UI any more, and leaving it on would mean running something you can neither see nor turn off.

- Before you pick, the composer probes deep-investigation availability for this account. When unavailable, the DevOps-Agent-dependent toggles are **greyed with an N/A badge**, and the tooltip states the exact reason (no Agent Space in the deployment account, or the selected account isn't onboarded); anything already enabled is turned off automatically. The probe itself **fails open** (toggles stay clickable) rather than hiding the feature.
- If **deep dive is off but the model tries a deep-dive tool anyway**, you get: "DevOps Agent deep investigation is off. Turn on the Deep investigation toggle under the composer and try again; for now you can use this topic's read-only tools (alarms/metrics/logs/events/resource state) for immediate triage."
- Know the **cost of the 0-token path**: your wording is **passed through verbatim** to the DevOps Agent (a fixed function derives the title from your first sentence, and the description is your own text), and it won't answer conceptual questions for you first.

### 4.4 The "/" menu

Type `/` in the composer (or click the `/` button in the toolbar) to open the menu.

> **This menu contains only your Skills** — Web Chat has **no built-in slash commands** at all. The `/case`-style commands are IM-only.

- The header reads "Skills" plus the total count; each row is `/<skill_id>` + a **Preset** or **Custom** tag + the name + the description. The list is **neither sampled nor truncated**.
- Keep typing to filter; `↑ / ↓` to move, `Enter` to pick, `Esc` to close.
- ⚠️ **The "/" menu filters on `skill_id` and the Skill's original name, not the localised name shown in the UI.** Preset Skills have English original names, so in a Chinese UI a Chinese word like 「成本」 matches **nothing** in the "/" menu — use the ID (e.g. `/cost-spike-triage`) or an English word instead. The search box on the Skills page is the one that matches the display name in your current language.
- Two fixed exits at the bottom: **Manage skills** and **Add skill**.
- Empty states are "No skills yet" and "No matching skill".
- Picking one prefills `Use the "<name>" skill` in the composer, which you can send or edit.
- ⚠️ The composer placeholder reads "Message NotiOps… (/command · $skill)", but **the `$` trigger is not implemented** — only `/` opens a menu.

### 4.5 Web search

A toggle in the toolbar, **icon only — the word "Web" was dropped on 2026-09-13** (the globe glyph already says it, and the horizontal space went to the flat toggle row). On, it may search the public web this turn (official AWS docs, launch posts and so on). Hovering it — or reading it with a screen reader — still gives you "Web search". **The What's New entry turns it on for you.**

> ⚠️ The toggle **renders in every region**, but the underlying search capability is **only wired up in us-east-1**. In any other region clicking it doesn't error — it simply finds nothing.

### 4.6 Time ranges: there is no date picker

**Web Chat has no date or time-range picker anywhere.** Instead, every turn injects **today's date** along with the model, web-search state and current account, so you express the range **in plain language**:

- "past 7 days", "this month", "month-to-date", "past 30 days"
- "last month"
- explicit dates: "2026-08-01 to 2026-08-31"

It translates that into the tools' start / end parameters.

### 4.7 The two right-hand panels: Sources and Thinking

Both share one right-hand rail, so only one is visible at a time.

**Sources**: every answer's footer has a Sources button with a count; it opens the right-hand "Sources" dock (with a Close button, and "No sources" when empty). `http(s)` sources are clickable, open in a new tab, and show their hostname underneath. **If the answer saved a long report, Sources also carries a "Full report (downloadable)" entry.**

**Thinking**: the step-by-step reasoning and tool-call trail, titled "Thinking", with a "Live" badge while in progress. The entry point is a low-key grey text button "**View thinking · {n} steps**", rendered **above the body of that reply** (not below it), at most one per reply — it only appears when the reply has process steps, and the steps are not saved, so once you reload the page (or open the conversation on another device) earlier replies no longer have it.

- It **auto-opens on the first thinking step** (collapsing Sources to make room). Once you close it manually it **never auto-opens again** (remembered in browser local storage).
- **DevOps Agent investigation steps and ordinary model reasoning share this one panel**; during an investigation the panel header gains a "View in the DevOps Agent console" link.

### 4.8 Long reports: view online, or download

Long content isn't smeared into the chat. It is written to S3, and the **runtime** — not the model — appends two deterministic links at the end of the reply:

- **🌐 View the full report online** (web page, link valid for about 7 days)
- **📥 Download the full report** (Markdown, link valid for about 12 hours)

The same report also shows up in Sources as "Full report (downloadable)".

> The online link is served through CloudFront + OAC. **If the deployment has no report CDN domain configured**: the model-mediated path falls back to a 12-hour presigned URL, while the **direct (0-token) path has no presigned fallback and simply omits the link**. The "about 7 days" isn't the CDN link expiring — it's the bucket's lifecycle rule on the `reports/` prefix deleting the object.

> ⚠️ Two things you must know:
>
> 1. **A failed save is silent.** When the S3 write fails the runtime only logs `report_link_skipped` on its own side — it **does not throw and does not tell you in the UI**. What you see is a turn that ends normally but **with no link at the end**. If you asked for a report and got no link, just ask again.
> 2. **The online link is not authenticated.** Anyone holding the URL can read the whole report without signing in to NotiOps. So **forwarding the link means handing over the content** — treat it as internal material.

### 4.9 Stop generating

While an answer is streaming, **the Send button becomes a square stop button** (tooltip "Stop generating"). Pressing it:

- **aborts only that conversation** — other conversations keep running;
- **keeps whatever text already arrived**, appending `_(stopped)_`.

### 4.10 The answer footer: who answered, and how many tokens

Every answer is signed:

| Footer | Meaning |
|---|---|
| `AWS Bedrock (<model name>) · N tokens` | Answered by one of our Bedrock models |
| `Model gateway (<model name>) · N tokens` | The administrator put an OpenAI-compatible gateway first among the model sources, and the gateway answered this turn (see §6.5) |
| `AWS DevOps Agent` | Answered by your own DevOps Agent (usage is charged to your DevOps Agent) |
| `NotiOps` | A deterministic answer that never went through a model |

- **The token count renders only when it is greater than zero**, so 0-token paths never show a misleading "0 tokens".
- There is **no money figure** in the footer — only the token count and the signature.
- ⚠️ One exception: **in the Investigation topic, a direct-path reply is signed `AWS Bedrock (&lt;model name&gt;)` after a reload** (it is persisted without a provenance marker). That's a display issue, not a real model call — that turn really did cost 0 tokens.

### 4.11 Managing conversations

- The list is **grouped by topic**: "Pinned" first, then General / Investigation / Cost / Cases / What's New, each sorted by most recently updated. **Empty groups aren't rendered**, so the number of groups you see changes as you use it. **There is no "Security" group** — as of 2026-09-11 it is no longer a chat topic, and history rows tagged "Security" appear under Investigation (§2.4).
- Each group collapses, and **the collapsed state survives a reload**; "Collapse all / Expand all" only appears once there are at least two non-empty groups.
- The "…" menu on each row: **Rename** (inline; `Enter` saves, `Esc` cancels), **Pin / Unpin**, **Delete** (with a "Delete this chat?" confirmation). Deletion is **immediate** (it doesn't wait for the TTL) and also clears the conversation context this chat had accumulated on the DevOps Agent side.
- Rows also carry two small dots: "Generating a reply…" while an answer streams, and "New reply unread" if it finished while you were elsewhere. So **you can safely walk away after starting a long investigation** and find it later.
- Conversations and messages carry a **30-day TTL**, but **every message you send in a conversation resets the clock** — so the real rule is "**deleted after 30 days idle; kept indefinitely while in use**". The number of days is set by the deployment's `WEB_CHAT_TTL_DAYS`, users can't change it, and **there is no warning before expiry**.

### 4.12 Language and appearance

See §1.2. Two things people ask about: the UI **defaults to English**; and the UI language **does not** decide the answer language — it answers in whatever language you asked in.

---

## 5. Skills (your own capability packs)

### 5.1 The problem it solves

A Skill is how you write down the process in your head — "when we check RDS we always look at these four metrics first, then check this standard, then report in this format" — and hand it to NotiOps to execute. The page puts it as: teach NotiOps your process, team standards and domain knowledge, so it works your way.

> **Creating, editing and managing Skills only exists in Web Chat.** The skill **management** commands were retired wholesale from the IM side on 2026-09-06 — typing `/skills` in Feishu / Slack / DingTalk now returns the `/help` menu (0 tokens). But IM still **uses** Skills: asking via `/agent notiops` still injects them (both surfaces share the same S3 storage). The difference is that the IM path injects the Skill catalog **with no relevance gate**, while the web filters it per turn against your question.

> ⚠️ **Skills are permission-gated.** You need `nav:skills` to see the entry at all; create/edit, import, rollback and publish-to-DevOps-Agent each additionally need `action:skills:edit` / `:import` / `:rollback` / `:devops-agent`. Of the six preset roles **only Administrator and Developer** get `nav:skills` — `role:viewer` (the default mapping for the Cognito `member` / `read-only` groups), `role:finops`, `role:support` and `role:service-manager` do not. **Granting `action:skills:*` without `nav:skills` does not work** (you can't even list them). If Skills isn't under "More" in your sidebar, ask an administrator to add it under More → Admin → Access control.

### 5.2 Eleven presets, out of the box

The first time any container lists Skills on a fresh deployment, **11 official Skills are seeded automatically** (marked with author `notiops-system`) — no admin action required:

`aws-health-events`, `aws-well-architected-review-devops`, `cost-spike-triage`, `eks-operation-review`, `idle-resource-scan`, `rds-health-review`, `security-posture-review`, `service-quota-check`, `sp-ri-coverage-analysis`, `support-case-history-rca`, `whats-new-report`

The list separates **Preset skills** from **My skills**, tags each card **Preset** or **Custom**, and offers search over name / ID / description plus sorting by "Recently updated" or "By name".

> ⚠️ **Don't edit a preset Skill in place and expect it to last.** The body of a preset Skill (author `notiops-system`) is maintained by NotiOps: editing it directly **only holds until the next seeding run** — the next container seeding (or a manual re-seed by an administrator) overwrites it with the packaged official version, and your edit is **silently lost**. Likewise, a preset you hard-delete is re-created on the next cold start.
>
> **For a lasting customisation, copy it into a new custom Skill (a new Skill ID).**
>
> ⚠️ There is a related trap: **editing a preset Skill in the Chinese UI loads the Chinese body, and saving writes that Chinese body into the main body.** Combined with the overwrite above, what you observe is "my edit worked, then some time later it reverted to the English original". Edit in the English UI, or just create a new Skill.

### 5.3 Two ways to invoke a Skill

**① Pick it explicitly** — type `/` and choose from the menu (§4.4). The full Skill body is then injected in the language you asked in. If the Skill ships `references/` files, they are offered as an **on-demand list** the agent can pull with `read_skill_reference` — and that read is restricted to **that Skill's declared file allowlist**, **document extensions only**, ≤256 KB per file, with **path traversal, scripts and cross-skill reads all blocked**.

**② Natural-language matching** — this route is protected by a **code-level keyword gate, not a prompt instruction**: a hit on the `skill_id` or the name counts as relevant; a hit only in the description needs **≥2 distinct overlapping terms** after bilingual stopword removal (English words ≥3 characters plus CJK 2-grams). **When nothing is relevant the Skill catalog is not injected at all** — so mis-triggering is *impossible*, not merely discouraged.

### 5.4 Writing one, or importing a zip

- **Add skill**: write it in the page (name + description + body).
- **Upload skill**: `.zip` only, in the Claude / Agent-Skills format. `SKILL.md` may be at any level, needs `name` + `description` in its frontmatter, and a body of at least 20 characters. `references/` and `assets/` are kept only for document extensions (md/txt/json/yaml/csv/tsv/pdf/images). macOS `__MACOSX/` and `._` noise is ignored.
- ⚠️ **`scripts/` and executable extensions are stripped silently**: the import still succeeds, but **the UI only says "imported" — it does not itemise what was stripped**. If it matters, diff the file list yourself.
- Limits: the **UI rejects anything over 6 MB before uploading** (that's the one number you can see); the server additionally rejects zips over 10 MB, more than 2000 entries, any single file over 8 MB, or more than 32 MB inflated in total — **none of which the UI surfaces**, so hitting one just shows a backend error.

> A Skill is really just files in the data bucket created at deploy time: `skills/<id>/meta.json` + `versions/<version>.md` (preset Chinese bodies live in `versions/<version>.zh.md`) + `files/` for references. **Drop a well-formed Skill into the bucket and it appears — no redeploy needed.**

### 5.5 Version history and rollback

Every Skill has a **version history** with **Run with this version** and **Make latest** for rollback. Edit / import / rollback are **three separately authorised actions**, so an administrator can grant them independently.

### 5.6 Publishing to DevOps Agent

**Publish to DevOps Agent** installs the Skill into a DevOps Agent Agent Space (this account or a member account). Once published the card shows a "Published ×N" badge, and supports **Re-publish** and **Remove**. It **uploads documents only, never scripts**, so the read-only boundary is unaffected. With no onboarded Agent Space it tells you to onboard one first under More → Admin → Accounts.

**When a Skill meets a DevOps Agent path, the composer tells you which of two things will happen:**

| Path | Behaviour |
|---|---|
| **Deep Dive** (handed to DevOps Agent) | The Skill **must already be published**, or it won't activate this turn |
| **Either direct path** | The Skill body is **inlined** into what's sent this turn (**no publishing needed**), but its `references/` files are **unreachable** on this path |

> ⚠️ Skills published here **do not affect the AI judgement used by resource inspection** — inspection uses a separate, dedicated Agent Space whose judgement skills ship with the code, deliberately isolated so the two can't cross-activate.

### 5.7 Boundaries

- **No scripts.** A Skill is a document (an instruction sheet), not an executable.
- Every Skill runs **locally**; publishing to DevOps Agent only unlocks the deep-investigation enhancement. The old per-skill `execution_mode` (local / devops-agent / both) **no longer exists** — the conversation's DevOps Agent switch decides now.
- Skills share the same `skills/` storage prefix that the IM side used to use.

---

## 6. Administration and customisation (admin view)

This section is for administrators. Ordinary users don't see the Admin entry.

### 6.1 The admin console: 3 sections, 8 pages

| Section | Page | Purpose |
|---|---|---|
| **Access control** | **Roles** | Define roles and tick what they can see / do |
| | **Users** | Manage users |
| | **Group mapping** | Map Cognito groups to roles |
| **Cloud environment** | **Accounts** | Onboard / enable member accounts (the source of cross-account capability), and DevOps Agent onboarding |
| | **Lifecycle** | EOS / lifecycle |
| **System** | **Modules** | Switch whole features on / off by tab |
| | **IM integration** | Feishu / Slack / DingTalk configuration |
| | **Models** | Decide which models users can pick in the model menu |

### 6.2 Roles and permissions

- The permission tree is **card-granular**: a role can be given just a few cards from the Cost page. Each group has an **"Entire"** checkbox (select the whole subtree), group headers are **tri-state**, and cards covered by an ancestor "Entire" render **ticked but disabled**.
- The `role:admin` row is **read-only** and can't be changed.
- **Deleting a role that is still in use** is refused with `role_in_use`.
- "Administrator" means membership of the Cognito `admin` group, whose permission is `*`.
- **The six preset roles**: Administrator, Viewer, FinOps, Support-Ops, Developer, Service manager. The key points (consistent with §2.10): `nav:security` (the security-posture dashboards) is granted only by **Support-Ops** and **Viewer** (added 2026-09-11); **no** preset role grants `nav:customize`; only Developer grants `nav:skills`; and none of the presets grants Inspection's four action permissions (scope / schedule / thresholds / manual run).
- ⚠️ One known rough edge: the UI **does let an administrator grant the Admin tab itself to a custom role**. Think before you do.

### 6.3 Module switches

The Modules page switches features on / off **by tab** (showing Enabled / Disabled), and **it overrides individual permissions** — off means nobody sees it. The API only accepts tab-level nodes and refuses to change always-on (chat) or admin-only (Admin) nodes.

### 6.4 Accounts: where cross-account comes from

Which accounts a user can pick in the topbar depends on which member accounts are onboarded and enabled on this page. "Member account onboarding" has two routes. On a multi-account deployment (method B's `./setup.sh --multi-account`, or method A with `DeployMode=MultiAccount`), click **Onboard** for an account in the organization (deployed through StackSets); step 2, the DevOps Agent association, then starts by itself — if it has not completed or has failed, click **Associate** on that row to retry. Everything else uses **Manual onboarding** on the same page: enter the account ID → Generate link → have that account's administrator sign in **as that account** and deploy → paste the stack Outputs back → Test connection → Save & activate. The collection role in the member account is created by the template — **don't create it by hand**. It carries the AWS managed `ReadOnlyAccess` policy **plus, by default, permission to open / reply to / resolve Support cases** (set the template parameter `EnableSupportCaseWrite=false` to keep it strictly read-only). Full steps: [DEPLOYMENT.en.md §0.1.1](DEPLOYMENT.en.md).

> ⚠️ **One-click (method A) multi-account stacks not yet updated to v1.0.30**: step 2 fails there. Step 1 already created the collection role in the member account, step 2 tries to create a role with the same name → `EntityAlreadyExists` → rollback. Update the stack to the current version first (every update re-runs the step that rolls out the StackSets, which sets `CreateCollectionRole` to `no` on the member DevOps Agent StackSet), then click **Associate**; accounts whose step 2 failed before just need one more click after the update. How to update the stack (and what to know before you do) is in [DEPLOYMENT_ONECLICK.en.md §5](DEPLOYMENT_ONECLICK.en.md).

### 6.5 Models

The user's model menu equals the set enabled on this page. When none is enabled, users are told explicitly that the administrator hasn't enabled any model for web chat and to ask them to enable one under More → Admin → Models, and **the Send button is disabled**.

There are three **model sources**: this account's IAM, a Bedrock API key (Bedrock in another account), and an **OpenAI-compatible gateway** (LiteLLM, New API and similar: a public HTTPS address plus a key).

- Drag the sources into order. **Only the first one is used**; if it fails, the call fails, and NotiOps **does not switch to the next source on its own**. Each source keeps its own default model.
- The gateway address and key are stored in this deployment account's Secrets Manager (`notiops/litellm-config`); the key is never shown back on the page. Only public HTTPS addresses are accepted, and changing the gateway address does not carry the old key over: enter it again. "Clear" only writes an empty value; the old key stays in Secrets Manager as the previous version until the next write, so revoke it on the gateway side to retire it for good.
- When the gateway is first, web chat, questions in IM after `/agent notiops` (the same agent) and background tasks (such as translating AWS Health events) all use it; if a background task cannot read the gateway settings, it does not quietly switch to Bedrock, and the Health event is pushed in its original text instead. Only the IM bot's own model features (such as case analysis in IM) always use a Bedrock source (this account's IAM or the Bedrock API key).
- On save, the server makes one test call with the first source's default model (when the gateway is first, it also tests the Bedrock source IM uses). It blocks the save only when the configuration is definitely wrong; a transient failure is saved with a warning.
- Answers from the gateway are signed "Model gateway (…)". When a gateway call fails, the answer says what kind of problem it was (unreachable, key rejected, no upstream credential on the gateway for this model, unknown model name, and so on) and points to this page.

Claude Sonnet 5.5 / Opus 5.5 and GPT-6 Sol need their AWS Marketplace agreement accepted in the deployment account. If it has not been, see §15 for what to change on this page -- re-enabling Claude Sonnet 5 / Opus 5 alone only fixes Web; IM also needs 5.5 disabled.

### 6.6 IM integration

Feishu / Slack / DingTalk onboarding is configured here. For how to *use* the IM surface, see **Part 2**.

### 6.7 Customize: currently a placeholder

⚠️ Both **Connectors** and **Plugins** under Customize still say "Coming soon" and do nothing. **Skills is not here** — it is under the sidebar's "More" group (§5).

---

## 7. Web Chat sample phrasings

Copy them, or edit them. These are the actual strings behind the starter cards in the UI.

### 7.1 General (the 12-card pool on the new-chat home)

```
Scan for idle and under-utilised resources, list optimisation opportunities
Investigate a CloudWatch alarm and find the root cause
Analyse this month's cost anomalies and identify the main drivers
Generate a prioritised security posture report
Run an RDS health check and surface hidden risks
Review my Support cases - which ones need attention
Check service quotas approaching their limits
Assess SP/RI coverage and savings headroom
Show AWS launches relevant to me
Find publicly accessible S3 buckets and open security groups
Find untagged resources and categorise them
Help me design a highly available application architecture
```

### 7.2 Investigation (security included — 12 in total)

The first 6 are operational, the last 6 security — after "Security" stopped being a chat topic on 2026-09-11 that group moved across wholesale, so it is now **one pool**. The landing page draws 4 cards from these 12; the in-conversation chip row draws 3.

```
Investigate a resource's current state
Did my EC2 instance reboot last night?
Help me interpret this error log
Troubleshoot why I can't SSH into my EC2
Which CloudWatch alarms fired recently?
Analyze the likely root cause of this incident
What security findings do I have?
Which S3 buckets are publicly accessible?
Which security groups are open to 0.0.0.0/0?
Review my IAM permission risks
Which IAM users don't have MFA enabled?
What are cloud security best practices?
```

Following up on an existing investigation (not a starter card — type these):

```
Show me the result of that investigation
Check the result of this investigation, [[investigation:<id>]]
```

When you pick **DevOps Agent** as the chat object, the home swaps to a fixed set of four:

```
Anything unusual in this account recently?
Help me find out why this EC2 instance rebooted
Is my RDS healthy right now?
Which recent changes could affect availability?
```

### 7.3 Cost

```
Analyse this month's cost anomalies
Which services are my top 10 by cost
What actionable savings opportunities do I have
How has my cost been trending recently
What is our SP/RI coverage
Find untagged resources
```

### 7.4 Security — merged into 7.2

> As of 2026-09-11 "Security" is no longer a chat topic; these 6 moved as-is into the **§7.2 Investigation** pool (above). The number is kept so the links to the sections below don't break. The security **dashboards** are still there — see §2.4 for how to reach them.

### 7.5 Cases

```
List all my open cases
Analyse and explain one of my recent cases
List my cases by severity
Draft a reply for one of my cases
Which cases did I file in the last 30 days?
Summarise the overall state of all my cases
Create a new support case for me
Escalate this to a human / open a case for this
```

### 7.6 What's New

```
What did AWS launch in the last 3 days?
Which recent launches relate to the services my account uses?
Give me this week's AWS launch digest
What's new in Bedrock recently?
Which recent launches are AI / generative-AI related?
Which AWS trends and flagship launches are worth attention right now?
```

### 7.7 Skills

```
Use the "<skill name>" skill
/<skill_id>          # e.g. /rds-health-review - filters as you type
```

---

## 8. Web Chat: things to know

### 8.1 Who guarantees "read-only"

Web Chat's read-only property is **four layers** deep — but **the four layers are not equally strong**:

1. **IAM permissions** — **this is the only hard boundary**. Even if all three layers above it were bypassed, the permissions themselves don't allow a change to your resources: the roles Web Chat uses to reach your account are read-only on your infrastructure; apart from NotiOps' own resources (its tables, buckets and the like), the only write they carry is AWS Support case create / reply / resolve, and that only runs after you confirm it (see the end of this section; a member account's role can be made strictly read-only with the template parameter `EnableSupportCaseWrite=false`). ⚠️ Method A's deploy parameter `AgentReadOnlyAccess` (default Yes) only decides how widely the agent **can read** and doesn't touch this boundary: Yes attaches the AWS managed `ReadOnlyAccess` policy to the agent's role; No leaves only the curated read-only grants (cost, logs, metrics, RDS / EC2 describe and the like), a narrower set. Either way, the agent's role has no permission to change your infrastructure.
2. **A read-only tool layer** — the tools handed to the model are describe / get / list only.
3. **A command-level denylist** — it blocks calls that are technically reads but shouldn't happen: `secretsmanager get-secret-value`, `ssm get-parameter --with-decryption`, `kms decrypt`, `ecr get-login-password`. ⚠️ **This layer is only in effect on the deployment-account general-query path** (the global read-only fallback MCP's `call_aws`). Querying a **member account** switches to native read-only APIs behind an assumed role, and that path has only a **read-verb prefix allowlist** and **no command-level denylist on top** — it relies on the member account's own IAM role (read-only on your infrastructure).
4. **A read-only system prompt** — it requires evidence before conclusions, **forbids emitting any change command**, forbids invented resource IDs, and only ever shows `describe-*` / `get-*` / `list-*` examples. ⚠️ The source comments say it plainly: **don't over-trust this layer, it is defence in depth, not a security boundary**. The same goes for layers 2 and 4.

> A known residual gap (acknowledged by design): `lambda get-function-configuration` and `ecs describe-task-definition` are legitimate reads, but their responses carry environment variables. Don't put secrets in either place.

> The IM surface's default DevOps Agent direct path guarantees read-only a **different** way (a read-only agent and read-only role on the DevOps Agent side, plus a change-wording regex on the NotiOps side); after `/agent notiops`, IM uses the scheme above (the same AgentCore Runtime and the same read-only role, with only the AWS docs search and read-only query tools mounted, plus web search after `/web on`). See "Who guarantees this 'read-only'" in §9.

**The single exception is writing AWS Support cases** (create / reply / close), which is designed so that:

- the model's tool only ever returns a **pending action** (`pending_user_confirmation`) plus an explicit instruction not to claim it executed — so an answer **cannot** falsely claim the write happened;
- the **server** performs the real write with the parameters you confirmed, and **the LLM is not in the write path**;
- after the write it **re-reads and verifies**, showing you the `verified` result.

### 8.2 It can be wrong — verify what matters

The caption under the composer ("NotiOps can make mistakes. Verify important findings.") is not boilerplate:

- Cost Deep Dive insights are explicitly labelled "**AI insight (please verify)**", with the raw CSV right beside them.
- Deep-dive conclusions are the DevOps Agent's own text — **NotiOps does not re-summarise them** — but they are still model output.
- When your own DevOps Agent answers, the caption changes to "DevOps Agent can make mistakes. Verify important findings."

### 8.3 Data lag and sampling

| Where | The actual number |
|---|---|
| Cost | Roughly **1–2 days** behind; **excludes** support, discounts and tax |
| Security Hub counts | One `GetFindings` call, **max 100** findings — a **sample**, not a total |
| Security dashboard | Cached **5 minutes** per account, server-side |
| Cases org overview | **15-minute** cache (stated on the page) |
| Case service catalog | Cached **6 hours** per language |
| Case entitlement probe | **15-minute** cache |
| Notification inbox | 5-minute duplicate suppression; entries expire after ~**90 days**; a list returns the newest **200** |
| The three AWS Health blocks on Notifications | **50** entries per block maximum — no paging beyond that, just truncation |
| Report links | Online ~**7 days**; Markdown download ~**12 hours** |
| Conversations | Server-expired after **30 days** by default |

### 8.4 It depends on your AWS Support plan

**Business / Enterprise On-Ramp / Enterprise** is required for: **reading and writing AWS Support cases**, **AWS Health** (once in Notifications and once as an Investigation dashboard), and **Trusted Advisor security checks**. On a lower plan every one of those places says plainly that a Business / Enterprise plan is required and gives you a console link, rather than erroring or showing empty data.

### 8.5 It depends on the deployment region

- The **web search** toggle renders everywhere, but the underlying capability is **only wired up in us-east-1**; elsewhere it doesn't error, it just finds nothing.
- The **Cost Anomaly** and **Trusted Advisor** notification event sources can only fire in **us-east-1**.

### 8.6 What one-click deployment (method A) is missing

Method A is a minimal footprint that installs only Web Chat. Compared with the full deployment (method B, `setup.sh`):

- **No Inspection** — there is no Inspection item under "More" (the whole tab is not delivered); only a stale front-end bundle or a direct API call ever shows the "use method B" message (see §2.6).
- **The Cost "daily anomaly scan" card is method-B only**; under method A the whole card is absent (the function it depends on is hardcoded empty). Note this is not the same thing as the "cost anomalies" dashboard, which both paths have.
- **By default the 4 Cost Deep Dive scenarios fail when clicked under method A** — they depend on pre-created Athena named queries, and those are only created the first time a CUR that NotiOps created is ready. Method A has that step only when you pick `ProvisionCur=yes`, and even then only after AWS's first CUR delivery (up to 24 hours) has been picked up by the check that runs every 4 hours; without it (including when you only filled in `CurTable` for an existing CUR) that step never runs, and clicking a scenario reports `no_named_queries` / `named_query_not_found` rather than an empty table.
- **The 4 CUR reports work the same on both paths**: hidden by default, shown once a cost MCP server is connected. On method A you either fill in `CurTable` / pick `ProvisionCur=yes` (NotiOps deploys one for you), or fill in `CostAgentMcpUrl` + `CostAgentFunctionArn` (point at your own) — see §2.3.
- **The notification inbox does not filter out NotiOps' own alarms** — method A's CloudWatch alarm subscription rules don't exclude self-created alarms like `notiops-inspection-*`, so NotiOps' own alarms land in your inbox too.
- **The "DevOps Agent — Credit Usage" card on the cost dashboard says "not configured" by default** — it reads the CUR that NotiOps creates, which method A only has with `ProvisionCur=yes`: until the first delivery is ready it shows "Initializing data", then real numbers.
- The 5 default-off notification event sources have to be enabled by hand in the **EventBridge console** under method A (method B takes a `setup.sh` flag).
- **Skills are identical on both paths** — method A is missing nothing here: all 11 presets, authoring, zip import and version rollback are present.

> **`EnableDeepInvestigation` (default Yes) is a main switch on method A** that governs three things at once: **Deep Dive** (0 tokens, direct), **DevOps Chat**, and **publishing a Skill to DevOps Agent**. Set it to No and all three go away. Separately, in **regions where AWS DevOps Agent is not yet available** it is **silently skipped** even when set to Yes — to tell "I turned it off myself" from "the region doesn't support it", check `DeepInvestigationStatus` in the stack Outputs.

### 8.7 Known rough edges (they don't affect correctness, but you will see them)

- ~~**Settings in the user menu is a placeholder** — clicking it only pops a "Settings · Coming soon" alert.~~ **Fixed (2026-09-11)** — the item was removed from the menu entirely (see §1.2).
- **Connectors and Plugins under Customize** are both "Coming soon".
- ~~**The FinOps answer mode in the Cost topic** is permanently greyed and labelled "Coming soon".~~ **Fixed (2026-09-13)** — that item was removed from the toolbar (see §4.3).
- **The composer placeholder mentions `$skill`**, but the `$` trigger isn't implemented — only `/` works.
- ~~**The investigation backends still say "the right-hand 'Investigation' panel"**, while the panel is actually labelled **Thinking** — it's the same panel.~~ **Fixed (v1.0.30)** — both investigation backends now say "Thinking", matching the panel title.
- **Notifications has no "mark all read" button and no read/unread filter** — opening the page marks everything read.
- **The sign-in page is English-only**, and its failure message is a hardcoded Chinese string.
- A missing UI translation renders **as its raw key** (e.g. `conv.rename`) rather than falling back to the other language. If you hit one, please file an issue.

---

# Part 2 · IM (Feishu / Slack / DingTalk), the supplementary surface

> This part covers the IM bot. It runs **in parallel** with the Web Chat console from Part 1 and shares the same read-only view of AWS, but the two are good at different things: use IM when an alarm wakes you up and you want the whole on-call group to see it in place; go back to Part 1 when you want to sit down, work through dashboards and read a full report.

---

## 9. What the bot is / is not

### What the bot CAN do ✅

| Category | Capability | How to use |
|---|---|---|
| **Investigate AWS resources** | Analyze CloudWatch metrics / logs / resource configs to find root causes | `@bot what's going on with RDS my-db CPU at 100%` |
| **Manage Support cases** | Create / list / view / reply to / **smart-analyze** / close AWS Support cases | `@bot open a case for the RDS outage` / `@bot analyze case 177968247000414` |
| **Answer AWS concept questions** | Cite AWS official docs to explain concepts, best practices, API usage | `@bot what's the difference between ALB and NLB` |
| **Proactive alarm watching** | ⚠️ **Not available in IM groups in this release**: real-time alarm push has no delivery target wired up (see §14); these events show up under Notifications in the web | — |
| **Multi-LLM switching** | When the chat object is NotiOps Agent (see §15.5), switch freely between whichever models your admin enabled (default **Kimi K3**, plus Grok 4.7, GLM 5.3, Claude Sonnet 5.5 / Opus 5.5, GPT-5.6 Terra and GPT-6 Sol — all accessed via Amazon Bedrock); per-chat / per-DM preference is remembered. When an administrator puts an OpenAI-compatible gateway first among the model sources, these conversations are answered by the gateway's default model instead and `@bot model` has no effect (see §6.5) | `@bot model opus` / `@bot model claude` / `@bot model list` |
| **Language switching** | Switch between Chinese and English; remembers your preference | `language zh` / `language en` / `please switch to English` |

### What the bot WILL NOT do ❌

> This is a product-level hard rule, **not a tunable setting**.

- ❌ **Modify your AWS environment**: it will not restart EC2, will not delete S3 objects, will not change IAM policies — any mutation request is rejected
- ❌ **Run CLI commands for you**: ask "restart i-0123" and the bot refuses; ask "how do I restart i-0123" and the bot will teach you (tutorials count as read-only)
- ❌ **Bypass IAM**: the resources you can look at = the resources the role of whoever answers you can read (by default the role your AWS DevOps Agent uses; after `/agent notiops`, the NotiOps AgentCore Runtime's read-only role). The bot will not escalate on your behalf
- ❌ **Store sensitive data beyond 7 days**: chat history is auto-cleared by DDB TTL after 7 days; locale preferences after 90 days. ⚠️ The exception is deep-investigation reports and trace pages: they live under the data bucket's `investigations/` prefix, are **not deleted automatically**, and stay there until the bucket is deleted (see §19 Q3)

> **Who enforces "read-only" (the wording changed on 2026-09-03 — go by the new version)**:
> on the IM side your question **by default goes straight to AWS DevOps Agent** with no LLM on the NotiOps
> side (that's why it costs 0 token), so on that path **refusing mutations is enforced by DevOps Agent plus
> the IAM role it assumes (read-only on your infrastructure)** — not by NotiOps spending an LLM call to guess whether you
> meant to change something. In a chat / DM that has sent `/agent notiops`, the question is answered
> with a model by the **same** AgentCore Runtime as Web Chat, and read-only rests on that runtime's scheme:
> IAM permissions (the hard boundary, read-only on your infrastructure) + a narrow tool set of AWS docs search and read-only queries
> (see §8.1, §15.5). In front of both paths NotiOps keeps one **regex second gate**
> (`platforms/common/router.py`) for obvious mutation wording and prompt injection.
> The net effect: **mutation requests never reach execution.** The one write is an AWS Support case
> (open / reply / close), and it runs only after you confirm it on the card / form (on DingTalk, by
> replying "confirm"; see §12).
> Details in [TECHNICAL_DESIGN.en.md §5 Security design](TECHNICAL_DESIGN.en.md#5-security-design);
> §4.2's "three-layer defense" describes `core/bedrock_chat.py`, which runs only on the
> rollback path (the resident ECS apps retired with `BotStack`) — **neither the web console
> nor the IM entry point runs it**; see §5.3 of that same document for the defenses that
> actually apply to each entry point.

---

## 10. Getting started: your first @ bot

### 10.1 In a channel, @ the bot

Make sure the bot has been added to the channel (admin's job), then:

```
@NotiOps hello
```

The bot usually replies within 1–2 seconds with a quick greeting and a hint at what it can help with. This is the simplest way to verify connectivity.

### 10.2 In a DM, just talk to it

If you only need it for yourself, **no @ required** — just send a message:

```
hello
```

In a DM, the bot accepts every message by default (no @ trigger needed).

### 10.3 Automatic language locking on your first message

The bot auto-detects the language of your first message and **locks to that language**:

- Feishu: DM lock for 30 days / channel thread lock for 7 days
- Slack: same as above
- DingTalk: DM lock for 30 days; **no lock inside a group** — DingTalk has no threads, so the whole group would be the only scope; every group message is language-detected on its own (see §17.2)

Later short messages (`why?` / `继续`) won't suddenly flip the whole investigation to English just because they're English — **the first message decides the language for the whole round**.

> Want to switch manually? See §16.

---

## 11. Investigate AWS resources

### 11.1 Standard investigation flow

The bot only opens a deep investigation when you **explicitly ask for one** — with the `/investigate` command (`/调查`), or with wording such as "deep dive", "investigate", "root cause" or "RCA" (Chinese 深度调查 / 深入排查 / 根因分析 / 深挖 work too). ⚠️ The slash in front of the command **is optional**: when the **first word** of your message is `investigate` / `inv` / `investigation` / `调查` / `調查` / `排查` / `深度调查` followed by a space or punctuation, it is dispatched as the command too — `@NotiOps 排查 RDS 慢` or `@NotiOps inv rds slow` opens a deep investigation, while `@NotiOps 排查一下 RDS 慢` (the word runs straight on into other characters) does not:

```
@NotiOps deep dive into why i-0abc123def456 in IAD has such high CPU
```

An ordinary question without such wording (say, "help me look at why i-0abc123def456 in IAD has such high CPU") does **not** open an investigation; it goes straight to this chat's chat object to answer (your own DevOps Agent by default — see §13.4 / §15.5).

The bot will:

1. **Recognise that you want a deep dive** (a deterministic rule match — 0 tokens, no model call)
2. **Dispatch to DevOps Agent right away** — there is no edit form and nothing more to click; your message goes over as the investigation description as-is, and NotiOps does not rewrite or summarise it
3. Post a "**Deep investigation dispatched**" card (see §11.2) with a button that opens this investigation in the DevOps Agent console
4. From then on that card **refreshes in place about once a minute**, appending DevOps Agent's new progress (see §11.3; DingTalk messages can't be edited, so there is no refresh there — see §17.2)
5. When it finishes, the card title becomes "✅ Investigation completed · Ns · see report below" (or "⚠️ Investigation failed"), and a **report card** follows in the chat (see §11.4). How long it takes depends on the problem and on the size of the account

### 11.2 The "Deep investigation dispatched" card

```
Deep investigation dispatched
─────────────────────
✅ Dispatched. DevOps Agent is investigating.

⚡ Direct to DevOps Agent · no model usage · Account: 111122223333 (deployment account)

[ 🔬 Open this investigation ]
```

- The button opens this investigation in the DevOps Agent console; when there is no deep link for it, it becomes "🌐 Operator home" instead.
- The footer says **which account** is being investigated — a report on the wrong account looks exactly like one on the right account, so it's worth a glance.
- **There is no edit form**: NotiOps doesn't ask you for missing dimensions. To help DevOps Agent pinpoint the problem faster, **put them in your message**: account, Region, resource ID / ARN, time window, plus an alarm name or a log / error snippet.

### 11.3 Progress card explained

Progress isn't a separate card: the card above **refreshes in place** (Feishu / Slack):

```
🔍 Investigating · 125s elapsed
─────────────────────
(new entries from DevOps Agent's investigation journal, appended one by one)

⚡ Direct to DevOps Agent · no model usage · Account: 111122223333 (deployment account)

[ 🔬 Open this investigation ]
```

- A progress Lambda pulls DevOps Agent's investigation journal **once a minute** and appends any new entries to this card; until the first entry arrives the body reads "⏳ Agent is analyzing the issue and planning steps…".
- The card always has **one** button ("🔬 Open this investigation", or "🌐 Operator home" when there's no deep link), and it still works after the investigation ends.
- When it finishes, the title becomes "✅ Investigation completed · Ns · see report below" or "⚠️ Investigation failed · Ns", and the report card follows as a separate message (§11.4).
- **DingTalk has no refreshing card**: a DingTalk message can't be edited after it is sent, so the acknowledgement says this one won't update itself; follow the link in it to watch progress in the DevOps Agent console, and the finished report is still delivered back to the conversation (see §17.2).

### 11.4 Report card explained

When an investigation finishes, the channel gets **one** card. Its first line is the
question you asked — that is how you tell cards apart when several investigations
are running in the same channel:

```
✅ NotiOps Report
─────────────────────
🎯 Investigation target · Why is CPU pinned on EC2 i-0abc123def456
Event · Investigation
Status · COMPLETED    Priority · P2
Task · abcdef0123456789
─────────────────────
## Summary
CPU sustained >95% over the past hour; top processes nginx + php-fpm.

## Root cause
Application-layer CPU bound. nginx is configured with worker_connections=1024,
which is too few — many requests are queueing up.
─────────────────────
[ 📊 View full report ]   [ 🔍 Investigation trace ]
[ 🆘 Escalate to AWS Support ]

🔗 Links stay valid for 7 days · no console login required
```

Where the three buttons go:

| Button | Opens | Console login |
|---|---|---|
| 📊 View full report | The complete report page on S3 (full Summary + Root cause) | No |
| 🔍 Investigation trace | The investigation timeline: what the Agent checked at each step and what it saw | No |
| 🆘 Escalate to AWS Support | Open a Support case from this report (becomes "Sync to Case" once a case is linked) | Yes |

> The report card carries **no** "🔬 Open this investigation" (DevOps Agent console
> deep link). The first two buttons open links that need no login and **stay valid
> for about 7 days**: the pages sit behind the report CDN (CloudFront), and after
> 7 days the bucket's lifecycle rule deletes them, so save a page before then if you
> need to keep it. On the few deployments without a report CDN (or when that copy
> could not be written), the links fall back to S3 presigned URLs that stay valid only
> for **a few hours (at most about 12)** — the footnote on the card then says exactly
> that. A console deep link, by contrast,
> requires an active AWS Console session. Mixing both into one row of buttons forces
> the footnote below them to claim "no login required" and "login required" at the
> same time. If you want the raw console page (including after those links have
> expired), the progress card still has its "🔬 Open this investigation" button
> (see §11.3) and it stays clickable after the investigation finishes.

**The card body is the opening slice of the full report.** When the report is longer
than a card can hold, the body ends with
"⚠️ This card shows only the beginning of the report — full content via *📊 View full report*"
— the content behind that button is **not** truncated. Conversely, no such line means
what you see on the card is the whole thing.

> 🔴 Before v1.0.22 this was **two** cards ("📝 Report Summary" + "✅ NotiOps Report"),
> and the first one's body came from an LLM summary with a 1024-token budget — a
> reasoning model's thinking tokens ate that budget, so it frequently rendered nothing
> but "report truncated due to token limits", and occasionally nothing at all. It is now
> one card whose body is the DevOps Agent's own text, which makes the whole
> deep-investigation path **0 token**.

### 11.5 Investigation samples

| What you want to ask | Recommended phrasing |
|---|---|
| EC2 high CPU | `i-0abc123def456 in ap-east-1, CPU at 100% for the past hour` |
| RDS slow queries | `RDS my-db has lots of slow queries, find out why` |
| Lambda errors | `lambda function-foo lots of errors, check cloudwatch logs` |
| ALB 5xx spike | `ALB my-alb has been throwing 503 for 30 minutes` |
| S3 bucket size spike | `s3://my-bucket grew from 100GB to 1TB last week, find the anomaly` |
| EKS pod CrashLoop | `eks cluster prod-cluster pod xyz keeps CrashLoopBackOff` |
| Cross-service | `ALB → EKS → RDS full-stack timeout, help me trace it` |

> 💡 **Tip**: these phrasings open a **deep investigation** (§11.1) only when you put `/investigate` in front (the slash is optional, see §11.1; or use wording like "deep dive" / "root cause"); otherwise the bot treats them as ordinary questions and answers directly (by default your own DevOps Agent answers, and it reads metrics and logs too). Either way NotiOps **won't** ask you for missing dimensions, so include the resource ID / Region / time window when you send it.

---

## 12. AWS Support case management

The bot doesn't just investigate — it can also **manage AWS Support cases for you** (create / view / reply / close), so you don't have to flip to the console every time.

### 12.1 Create a case

```
@NotiOps create a case for RDS my-db restarting frequently
```

The bot opens a **create-case form**: on Feishu it is a **card form** posted into the conversation; on Slack it is a modal (when you come in from an @-mention, the bot first replies with a "🆘 Open create form" button, and one click opens it). You can fill in:

| Field | Description |
|---|---|
| **Open in which account** | Only shown when this deployment has ≥2 accounts to choose from; defaults to this conversation's current account (`/account`) |
| **Subject** | **Pre-filled** from your message with the "create case" / 开案例 wording stripped (a deterministic rule, no model call); editable |
| **Body** | Detailed description (paste raw logs if needed) |
| **Severity** | Low / Normal / High / Urgent / Critical |
| **Language** | English / Japanese / Chinese, etc. (the conversation language inside AWS Support) |
| **Contact** | Optional, contact info |

The Slack modal also asks for service name / category / case type; the Feishu card doesn't ask for these, and the bot works out the service and category itself when you submit.

Submit it, the bot calls the AWS Support API to create the case, and replies with the case ID (`12345...`).

> 🔥 **Create + dispatch investigation in one go**: the Feishu card has two submit buttons at the bottom — "🚀 Create case only" and "🤖 Create + start Agent investigation"; a Slack modal can only have one submit button, so there it is a choice inside the form (preselected: "🤖 Create case + start Agent investigation (recommended)"). The second option creates the case first, then auto-dispatches a DevOps Agent investigation framed as "investigate the root cause of this case". One action = "file the ticket + start self-diagnosis".

> 📌 **Different shape on DingTalk**: DingTalk has no native modal and no button callbacks, so the same information goes through "bot replies with a plain-text template → you copy the whole block, edit it and send it back → you reply 'confirm'". The template is six lines (Description / Severity / Language / Case type / Service / Subject) and only Description is mandatory; the case that gets filed is identical. See §17.2.

### 12.2 List my cases

```
@bot my cases
@bot list my cases
```

The bot lists the **5** cases most recently created in this account over the last 90 days (**any status**, newest first), each with its status, severity and creation date, plus buttons such as "💬 Details" and "✏️ Reply". To see cases by status, use the row of filter buttons at the bottom of the list: 👤 Waiting for me / 🔵 Unresolved / 🛠️ In progress / ✅ Resolved. ⚠️ Writing a status into your message **does not filter** — only those buttons do; DingTalk messages have no buttons, so there you follow the AWS console link at the end of the message to see cases by status.

### 12.3 View a specific case

```
@bot case 177968247000414
@bot view case 177968247000414
@bot how's case 177968247000414 doing
```

The bot returns case details + the latest reply history.

### 12.4 Reply to a case

```
@bot reply to case 177968247000414 — already upgraded RDS to r5.large, no more restarts
@bot reply to case 177968247000414 fixed by upgrading instance class
```

> The **full** case ID is required (the long number AWS gave the case; a number shorter than 6 digits is not taken as a case ID), otherwise the bot lists your recent cases first so you can pick one.
>
> 🔒 **A reply phrased like this is not sent straight away**: the bot puts the text it picked up from your message into the reply form (Feishu / Slack; on DingTalk, a confirmation message), and it is added to the case only after you check it, edit it if needed, and press Send. To do it in one step, use the explicit command `/reply-case 177968247000414 <text>` (Chinese `/回复案例`) — the text is in the command, so the command itself is the confirmation and it is sent directly. **The leading slash is required**: without it, "reply-case 177968247000414 …" reads no differently from a sentence, so it too goes into the reply form for you to confirm first.

### 12.5 Smart case analysis (LLM rollup + next steps)

When you want the LLM to read the entire case thread and tell you "what now":

```
@bot analyze case 177968247000414
@bot summarize case 177968247000414
@bot help me analyze case 177968247000414
@bot analyze case 177968247000414 — what's wrong with it
@bot summarize case 177968247000414 and suggest a reply
@bot 分析 case 177968247000414
@bot 总结 case 177968247000414
@bot 案例分析 177968247000414
```

> Phrasings like "review case …", "help me understand case …" or "what's wrong with case …" do **not** trigger smart analysis — they only open the case's details; use one of the phrasings above, with the full case ID. Questions like "what should I reply to case …" are read as a **reply**: the bot does not send anything — it puts the text it picked up into the reply form for you to confirm (see §12.4). To ask how to reply, use one of the "summarize case …" / "analyze case …" phrasings above — the analysis card includes a suggested reply.

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

### 12.6 Close a case

```
@bot close case 177968247000414
@bot resolve case 177968247000414
@bot 177968247000414 is resolved, close the case
```

---

## 13. Ask AWS concept / docs questions

> ℹ️ No deployment switch is involved. Who answers depends on this chat's **chat object** (§15.5): by default your own DevOps Agent answers directly; only after you switch to NotiOps Agent (`@bot agent notiops`) does NotiOps search the official AWS docs and answer with a model.

### 13.1 How to ask

Just @ the bot — as long as your message doesn't ask for a deep dive ("deep dive", "root cause", …) and doesn't start with a command word such as "investigate" / 调查 / 排查, it is answered as an ordinary question and no investigation is opened (see §13.4):

```
@bot what's the difference between ALB and NLB
@bot what does Lambda cold start mean
@bot how is CloudWatch alarm evaluation period calculated
@bot how do I add a cross-account trust to an IAM role
```

### 13.2 Answer style

When the chat object is **NotiOps Agent** (`@bot agent notiops`, see §15.5), the bot calls **AWS Knowledge MCP** to retrieve official docs, then answers with this chat's current model (**Kimi K3** by default, see §15), **with verifiable sources attached** (sample below). On the default **DevOps Agent direct** path, your own DevOps Agent answers instead (0 NotiOps tokens, no sources block).

```
NotiOps Agent answer
─────────────────────
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
─────────────────────
**Progress**

- (the lookup / query steps of this turn, one per line; only the latest 8 are kept)
─────────────────────
**Sources**

- [Application Load Balancer overview](https://docs.aws.amazon.com/...)
- [Network Load Balancer overview](https://docs.aws.amazon.com/...)
- [Choose between ALB and NLB](https://docs.aws.amazon.com/...)
─────────────────────
Agent: NotiOps | Model: global.moonshotai.kimi-k3 · Account: 111122223333 (deployment account)
```

**Key points**:
- **"Sources"** = what this turn's searches actually brought back (AWS docs search, plus web search after `/web on`), not made-up references; at most 5 are listed, and only on the finished card
- **"Progress"** = the steps taken this turn, so you can see what it looked at; only the latest 8 are kept
- **The footer** `Agent: NotiOps | Model: …` (the model id follows this chat's current model; when the bot cannot confirm which model actually answered this turn, it shows just `Agent: NotiOps`, with no model) = explicit signal that this is a model-generated NotiOps Agent answer, not a hard-coded "official answer"; the part after it is the account this turn was about
- On the default DevOps Agent direct path the card is titled "DevOps Agent answer", has **no** "Sources" section, and its footer reads "⚡ Direct to DevOps Agent · no model usage · Account: …"

### 13.3 Concept question samples

| Category | Examples |
|---|---|
| **Service comparison** | `how to choose between ECS and EKS`, `SQS standard vs FIFO difference` |
| **API usage** | `S3 multipart upload max size`, `how to configure Lambda concurrency limits` |
| **Best practices** | `how to avoid IAM role chaining`, `VPC peering vs transit gateway choice` |
| **Error interpretation** | `what is a Throttling exception`, `common causes of UnauthorizedOperation` |
| **Configuration options** | `what is a KMS multi-region key`, `RDS multi-AZ vs read replica` |

### 13.4 When the bot routes to investigation vs Q&A

The bot **doesn't guess** your intent — it goes by the literal rules below:

| What you said | What the bot does |
|---|---|
| `what is ALB` | Ordinary Q&A |
| `check 5xx for ALB my-alb` | Ordinary Q&A — "check" is not a request to dig deep, resource name or not |
| `排查一下 RDS 慢` | Ordinary Q&A — 排查 runs straight on into other characters, so it is not the command |
| `how do I solve Lambda cold start` | Ordinary Q&A |
| `deep dive into lambda foo's cold starts` / `/investigate lambda foo has bad cold starts` | Dispatches a deep investigation (§11) |
| `inv rds slow` / `排查 RDS 慢` / `调查 RDS 慢` | Dispatches a deep investigation — the first word is a command word followed by a space, i.e. `/investigate` without the slash |

Decision rule: **only an explicit request to dig deep** dispatches a deep investigation — the `/investigate` / `/调查` command (the slash is optional: the first word of the message is `investigate` / `inv` / `investigation` / `调查` / `調查` / `排查` / `深度调查` followed by a space or punctuation), or wording anywhere in the message such as "deep dive", "investigate", "root cause", "RCA" (Chinese 深度调查 / 深入排查 / 根因分析 / 深挖 too); whether or not the message has a resource ID / Region / time window makes no difference. Everything else is an ordinary question for this chat's chat object (your own DevOps Agent by default, §15.5) — which still reads metrics, logs and configuration as needed. This step is a deterministic rule match: no model call, 0 tokens. ⚠️ The rule is literal: a concept question such as "what is RCA" or 「什么是根因分析」 dispatches an investigation too — to ask about the concept, word it without those terms.

---

## 14. Passive scenario: receiving proactive alarm cards

> ⚠️ **In this release no real-time alarm cards reach IM groups.** The push Lambda (`notiops-push-handler`) exists only on `setup.sh` deployments (one-click creates neither the function nor the `notiops-push-*` rules); whether it sends anything depends only on its own environment variables (`PUSH_TARGET_CHAT_ID` and the like), and `setup.sh` doesn't set them — so even with the `notiops-push-*` rules enabled, each event only logs a "Push disabled" line and returns (neither Feishu's `notify_chat_ids` nor DingTalk's `webhook_url` has any say in this). For now, look at these events under **Notifications** in the Web Chat sidebar (both deployment paths have it; 5 sources are on by default, see §2.1). The only proactive messages an IM group **does** receive are, on `setup.sh` deployments, the Feishu daily operations notice ("每日运维通知") and the Health (PHD) event forwarding — see the scheduled-digest section of [im-bot-interaction.md](im-bot-interaction.md) (Chinese only). §14.1 – §14.3 below describe the design of this push path (the code is there; this release just has no delivery target wired up).

### 14.1 How auto-investigation on alarms works

Once the push path is wired up, the bot listens to 5 event sources (one `notiops-push-<source>` rule each, all created disabled):

| Event source | Trigger condition |
|---|---|
| CloudWatch Alarm | Alarm state changes to ALARM |
| AWS Backup | Backup job FAILED / EXPIRED / ABORTED |
| GuardDuty | New finding (default severity ≥ 7) |
| Cost Anomaly | Anomalous cost change |
| Trusted Advisor | Check status flips to ERROR |

> AWS Health is not in this table: it has no `notiops-push-*` rule. On `setup.sh` deployments it goes through the separate PHD forwarding instead (into Feishu groups) — see the start of this section.

**On event trigger**:

1. Push handler Lambda receives the EventBridge event
2. 5-minute deduplication (same resource only investigated once per 5 minutes)
3. **Auto-dispatch** to DevOps Agent — the investigation request text is normalized by the bot from the event
4. The channel receives a **⚠️ Proactive watch: <event summary>** header card
5. Same progress-card → report-card flow as a manual investigation

### 14.2 Alarm card sample

```
⚠️ Proactive watch · CloudWatch Alarm
─────────────────────
Alarm name: high-cpu-prod-rds
State: ALARM
Reason: Threshold Crossed: 1 datapoint [98.5] > 85.0

DevOps Agent has automatically started an investigation...
```

Everything afterwards is the same as the report card flow in §11.

### 14.3 Silencing

A specific event source too noisy for a channel? Admins can switch it off individually by disabling its EventBridge rule — it takes effect immediately, no redeploy:

```bash
# Disable GuardDuty push (admin-side)
aws events disable-rule --name notiops-push-guardduty --region <deployment-region>
```

Detailed config options in [DEPLOYMENT.en.md §7](DEPLOYMENT.en.md#7-enable--tune-push-mode).

---

## 15. Model and chat object

> This section is really **two things**: **15.1 - 15.4 cover "which model"** (`model`), and **15.5 covers "who answers this question"** (`agent`). Don't conflate them: the model **only matters when the chat object is the NotiOps Agent** -- the AWS DevOps Agent path never passes through our Bedrock models.

The aliases the bot accepts are whatever your admin enabled for the IM surface in the model catalogue (the common ones are below); **anyone in a chat can switch between them** (no admin gate). Ask `@bot model list` for the live set:

| alias | model | notes |
|---|---|---|
| `kimi` | **Kimi K3** | **Default** (the catalogue's `default_model`). Bedrock Converse; no explicit prompt caching (implicit caching did take effect in internal testing) |
| `claude` | **Claude Sonnet 5.5** | Reliable tool-use and good in Chinese & English in internal testing; supports prompt caching |
| `opus` | **Claude Opus 5.5** | The strongest reasoning, for deep analysis / complex root causes; supports prompt caching |
| `grok` | **Grok 4.7** | Bedrock Converse; ⚠️ no explicit prompt caching, so long conversations cost more on input than Claude |
| `gpt` | **GPT-5.6 Terra** (experimental) | Bedrock Mantle Responses API; tool-use is less reliable than the ones above. Suggested for experimentation only. |
| `gpt_sol` | **GPT-6 Sol** | Bedrock Converse (global cross-region inference profile — the same path as Kimi / Grok), not Mantle, so it does not make the separate `us-east-2` call that GPT-5.6 does |

> ⚠️ **`@bot model list` also shows `gpt_luna` (GPT-5.6 Luna, enabled for IM only as shipped) — don't pick it for now.** The NotiOps Agent side doesn't recognise that alias: after switching, every question is actually answered by the default model (Kimi K3 unless your admin changed it), and the card footer shows just `Agent: NotiOps`, with no model (the bot can't confirm which model answered). An administrator can disable it under More → Admin → Models, after which it no longer appears in `@bot model list`, and chats / DMs pinned to it fall back to the default model.

> ⚠️ **Claude Sonnet 5.5 / Opus 5.5 (`claude` / `opus`) and GPT-6 Sol (`gpt_sol`) need their AWS Marketplace agreement accepted once in the deployment account.** Until then, every question on these aliases fails (the NotiOps Agent replies "The model call was denied") — including chats / DMs that were already set to `claude` / `opus` / `gpt_sol` before the upgrade (back then those meant Claude Sonnet 5 / Opus 5 / GPT-5.6 Sol): as long as nobody has saved anything under More → Admin → Models, the upgrade points these aliases at the new versions in the table above, so those chats start failing without anyone switching. For each model whose agreement is not accepted, an administrator picks one of:
>
> - **Accept its agreement once in the deployment account**; its alias then works as normal.
> - **Not accepting Claude 5.5 for now**: under More → Admin → Models in the web console, re-enable **Claude Sonnet 5** / **Claude Opus 5** **and disable** **Claude Sonnet 5.5** / **Claude Opus 5.5**, then tell IM users to switch with `@bot model claude-sonnet-5` / `@bot model claude-opus-5`. Re-enabling 5 without disabling 5.5 **only fixes Web** -- on IM, `claude` / `opus` still point to 5.5. Once 5.5 is disabled, chats / DMs already pinned to `claude` / `opus` fall back to the default model, and sending `@bot model claude` again replies "Unknown model" with the list of options.
> - **Not accepting GPT-6 Sol for now**: disable **GPT-6 Sol**; chats / DMs pinned to `gpt_sol` likewise fall back to the default model.

> ⚠️ **GPT-5.6 is currently an experimental tier.** Under tool-use the model occasionally leaks OpenAI internal protocol fragments or low-quality tokens into the reply, more often than Claude / Kimi. Treat it as a "try out an OpenAI model" tier, and stay on the default `kimi` or on `claude` for everyday use.
>
> Note: by default all models are accessed through Amazon Bedrock (managed security, compliance monitoring, and cost controls); when an administrator puts an OpenAI-compatible gateway first among the model sources, conversations and background tasks go to that gateway and its upstream providers instead (see §6.5). This is sample code for educational/reference purposes, not production-ready; test and harden it against your organization's security and compliance requirements before any real use.

### 15.1 Commands

```
@bot model              # show current model in this chat / DM
@bot model list         # list all aliases
@bot model opus         # switch the whole chat to Claude Opus 5.5
@bot model claude       # switch to Claude Sonnet 5.5
@bot model default      # clear preference, back to the admin's default_model (Kimi K3 unless changed)
```

### 15.2 Scope

- Sent in a **group chat** → switches the model for **everyone in the channel**.
- Sent in a **DM** → only affects that DM, doesn't touch any group.

This is how a single bot deployment serves several scenarios: everyday
channels stay on the default `kimi`, while a channel dedicated to deep
analysis / complex root causes can switch to `opus`, all under one stack.

### 15.3 Notes on switching to `gpt` (experimental)

GPT-5.6 Terra (`gpt`) uses the **Bedrock Mantle Responses API** (OpenAI-compatible
protocol), which differs from the Bedrock InvokeModel / Converse path that Claude / Kimi / Grok use
(`gpt_sol` is GPT-6 Sol and goes through Converse, so none of the points below are about it):

- **Reliability**: Under tool-use (concept Q&A / read-only lookups) GPT-5.6 occasionally writes OpenAI internal protocol fragments (`to=functions.<tool>`) or low-quality tokens into the reply, so its "half-broken" rate is higher than Claude / Kimi. **Prefer the default `kimi` or `claude` for serious use**; treat `gpt` as a "try it / compare" tier.
- **Cross-region call**: GPT-5.6 requests go to the Region recorded on that model's catalogue entry (`us-east-2` as shipped), whichever Region you deployed to. When your deployment Region is not `us-east-2`, selecting `gpt` triggers a cross-region HTTPS POST — from `us-east-1`, latency is ~50ms higher than Claude / Kimi but otherwise transparent.
- **Region**: no deployment parameter changes it; the model's ⓘ under More → Admin → Models in the web console shows the Region, but it is read-only there.
- **Reasoning effort**: GPT-5.x has an explicit reasoning-depth knob; NotiOps does not set it (the service default applies), and neither the deployment nor the console offers a way to change it.
- **Tool use**: Identical surface to Claude / Kimi — the same read-only tools (AWS docs search, read-only AWS queries, plus web search after `/web on`) work via automatic protocol translation.

### 15.4 Resolution priority

```
1. Per-chat preference (set via `@bot model X` in a channel) — 30d TTL
2. Per-DM preference (set in a DM) — 30d TTL
3. Admin default (the catalogue's default_model, set under More → Admin → Models in the web console; Kimi K3 unless changed)
4. Final fallback: if the catalogue can't be read, the built-in catalogue, whose default is also Kimi K3
```

To permanently switch the default for every chat, an administrator
changes the default model under More → Admin → Models in the web console.
IM picks the change up within about a minute after saving — **no redeploy**.

### 15.5 Chat object: `agent` decides who answers in this chat

Same concept as the chat-object row on the Web "New chat" home (§1.4): the IM surface has **two** chat objects, anyone can switch at any time, and **the first one is the default**.

| Chat object | Command | Who answers | Tokens on the NotiOps side |
|---|---|---|---|
| **AWS DevOps Agent** | `agent devops` (default) | The DevOps Agent in your own AWS account, direct | **0** |
| **NotiOps Agent** | `agent notiops` | Our AgentCore runtime, with read-only tools attached | **Consumes tokens** (using the model from §15.1) |

```
@bot agent              # show who answers in this chat (viewing never changes anything)
@bot agent notiops      # switch to the model-backed NotiOps Agent
@bot agent devops       # switch back to the AWS DevOps Agent (default)
@bot agent default      # clear the preference, back to the default (AWS DevOps Agent)
```

- The Chinese forms work identically: `/智能体 notiops`, 「智能体 devops」. This is **deterministic routing, 0 tokens** -- switching itself costs nothing.
- **Scope and resolution order are word-for-word the same as `model`**: sent in a **group chat** it applies to the whole chat from then on (including other people's questions); sent in a **DM** it only affects your DM. The preference has a **30-day TTL**, so a chat that goes quiet for two weeks reverts to the default. Feishu / Slack / DingTalk each record it **independently** (see §17.3).
- `/help` lists this row (`/agent notiops|devops`).
- **Switching objects does not carry history**: the two paths aren't the same upstream at all, so switching does not move the earlier conversation across. To continue a previous turn, switch back first.
- **`model` / `web` only matter on the NotiOps Agent path**: the AWS DevOps Agent path doesn't go through our Bedrock models. You can still send `model` -- it changes the NotiOps Agent path.
- **`investigate` / `case` / scheduled digests are all unaffected.** `agent` only decides "who gets this free-form question".

---

## 16. Language preferences (Chinese / English switching)

### 16.1 Three ways to trigger

```
language        # Show current language + brief help
language zh     # Switch to Chinese (effective immediately, 90-day preference)
language en     # Switch to English (effective immediately)

please switch to English   # Natural-language switch, equivalent to language en
切换到英文                  # Same
请用英文回复                # Same
switch to chinese          # Equivalent to language zh
```

### 16.2 Language priority chain

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

### 16.3 Common confusion

**Question**: I just said `language zh`, but the bot's next reply is still in English?

**Cause**: that message likely happened to be inside a thread, and thread lock outranks everything except user preference.

**Fix**: **user preference is the top layer** and overrides every lock. If `language zh` failed to write (the admin checks the worker log `/aws/lambda/notiops-im-worker-<platform>`; on one-click deployments it is `/aws/lambda/<StackName>-im-worker-<platform>`), ask the admin to clear your `locale#user#<uid>` row.

---

## 17. DingTalk platform notes

DingTalk runs the **same Lambda webhook shape** as Feishu / Slack and carries the identical intent set — there is no "DingTalk is missing half the features". What remains are **permanent** limits of the DingTalk IM protocol itself (a sent message cannot be edited; card buttons have no callback), not a delivery schedule. This section spells out what is identical and what merely looks different.

### 17.1 Capabilities identical to Feishu / Slack

| Feature | Available on DingTalk |
|---|---|
| @ bot in groups / DM the bot | ✅ |
| Deep investigation dispatch (`/investigate i-xxx high CPU` / `deep dive into RDS my-db slow queries`, …; see §13.4) | ✅ |
| Concept Q&A (`what is EKS` / `ALB vs NLB`) | ✅ |
| Model switching (`@bot model claude/kimi/gpt`) | ✅ |
| Chat-object switching (`@bot agent notiops/devops`) | ✅ (one shared implementation across all three platforms -- see §15.5) |
| Language switching (`language zh/en` / natural language) | ✅ |
| AWS Support case create / list / view / reply / close / analyze | ✅ |
| Investigation report markdown writeback | ✅ (the app robot posts the report back into **the conversation that asked** — no extra setup) |
| Proactive push (daily operations notice / real-time alarms / inspection push) | ❌ none of them reaches DingTalk in this release: the daily notice is Feishu-only; real-time alarm push isn't wired up on any platform (§14); inspection push is the only kind that would go to DingTalk (sent to the custom robot added to the group, i.e. the secret's `webhook_url`), but the group must first be registered as a push target, and this release **has no way** to do that (no web entry, `setup.sh` doesn't ask, and no tool ships for it). Chat and investigation dispatch are unaffected |
| Progress feedback | Partial: ordinary answers append their progress; deep investigations **don't update themselves** (follow the link in the acknowledgement to watch progress in the DevOps Agent console), see §17.2 |
| Zero-change promise (any mutation request is refused; by default enforced by DevOps Agent + the read-only role, and after `/agent notiops` by the NotiOps AgentCore Runtime's read-only role + read-only tools, with a NotiOps-side regex second gate on both paths; the one write is a Support case that runs only after you confirm it — see §9) | ✅ |

> 📌 **Skills (your own capability packs) are deliberately not in that table**: as of 2026-09-06 skill intents were **retired from the IM side altogether** — Feishu, Slack and DingTalk alike no longer offer skill selection / switching / upload. The full Skills experience lives in Web Chat; see §5.

### 17.2 DingTalk-side shape differences (permanent, not a schedule issue)

DingTalk's IM protocol differs from Feishu / Slack in ways we can't paper over. None of these will go away in a later release; the capability is there, it just looks different:

- **Progress is appended, not refreshed in place**: a DingTalk message **cannot be edited once sent**, so there is no Feishu / Slack-style card that refreshes in place. For ordinary answers DingTalk appends progress as **new messages** in the conversation, so throttling goes the **opposite** way and gets tighter — at most 2 interim progress messages per run (around 120s and 360s), so progress doesn't bump the whole group's unread badge every time; progress still arrives, it just scrolls instead of mutating in place. **Deep investigations append no progress at all**: the acknowledgement says this one won't update itself; follow its link to watch progress in the DevOps Agent console, and the finished report is delivered back to the conversation.
- **No next-step one-click dispatch buttons**: DingTalk card buttons can only open a URL — there is **no "button → callback to our server" channel** — so the next-step suggestions at the end of a report appear as **plain text items** on DingTalk and you re-send one as a message. This is a platform limit; the Feishu / Slack one-click buttons cannot exist on DingTalk.
- **No native modal forms → case creation uses a copy-paste text template**: Feishu / Slack's "open a case form, fill fields" has no DingTalk equivalent. On DingTalk you say "open a case" and the bot replies with **a six-line plain-text template** (Description / Severity / Language / Case type / Service / Subject, fenced by a horizontal rule above and below, each line pre-filled with its default and its options). You **copy the whole block, edit it, and send it back** — only Description is mandatory, everything else can stay at its default. The bot then shows a confirmation card and you reply "**confirm**" for the case to actually be filed. The fence lines are stripped automatically and never end up in the case body.
- **Dangerous actions are confirmed by replying "confirm", not by clicking**: likewise, write operations such as closing a case take a second confirmation as a reply on DingTalk.
- **Inspection push has at most one target**: the only proactive push that goes to DingTalk is inspection push (not configurable in this release, see §17.1), and its sending address is tied to the group that holds the custom robot, so there can be at most **one** enabled push target; Feishu / Slack can have several.
- **Markdown tables are not rendered**: DingTalk parses standard markdown but **does not support tables**, so tables in a report are downgraded to readable text lines.
- **No thread subtopic semantics**: DingTalk has no Slack `thread_ts` analogue — the whole group is the only scope available. So the automatic language lock applies **in 1-on-1 DMs only** on DingTalk (locked for 30 days); inside a group every message is language-detected on its own, because otherwise one English question would flip the entire group to English. Pin the language with `language zh/en` (see §16) — an explicit preference always wins. Simpler inbound, but we lose Feishu / Slack's "follow-up in thread without re-@" trick.
- **Every inbound is for the bot**: DingTalk bots don't see general group chatter, only @-mentions and DMs. So the bot doesn't have to decide "is this for me?" — it always is. Net: cleaner inbound flow, but no thread-implicit-follow-up.

### 17.3 Preferences are platform-isolated

`@bot model` and `language` preferences are keyed by `(platform, chat_id)` / `(platform, user_id)`, so **a Feishu preference doesn't carry to DingTalk and vice versa**. The same user can run Claude in a Feishu DM and Grok in a DingTalk group, independently.

---

## 18. IM Sample Phrasings

The bot supports both Chinese and English — pick whichever you prefer.

### 18.1 Chinese samples

| 意图 | 推荐说法 |
|---|---|
| 你好 | `你好` / `早上好` / `在吗` |
| 看 EC2 状态 | `查 i-0abc123 的 CPU` |
| 看 RDS 性能 | `RDS my-db 慢查询多, 看下原因` |
| 看 Lambda 错误 | `lambda function-foo 大量 error` |
| 看 S3 异常 | `s3://my-bucket 上周空间暴涨, 查异常` |
| 看跨服务问题 | `从 ALB 到 EKS 到 RDS 全链路超时, 帮我串一下` |
| 创建 case | `创建一个 case 处理 RDS 故障` / `提一个工单` |
| 列出 case | `我的 case` / `列出我的 case` |
| 查 case | `case 177968247000414` |
| 回复 case | `回复 case 177968247000414 已经修好` |
| 关闭 case | `关闭 case 177968247000414` |
| 概念问题 | `ALB 和 NLB 有什么区别` / `什么是 KMS multi-region key` |
| 切语言 | `language en` / `请切换到英文` |

### 18.2 English samples

| Intent | Recommended phrasing |
|---|---|
| Greeting | `hi` / `hello` / `good morning` |
| EC2 check | `check i-0abc123 CPU usage` |
| RDS performance | `RDS my-db has slow queries, please look` |
| Lambda errors | `lambda function-foo many errors` |
| S3 anomaly | `s3 my-bucket size spiked last week` |
| Cross-service | `ALB → EKS → RDS timeout, help me trace` |
| Create case | `open a case for RDS issue` / `file a ticket` |
| List cases | `my cases` / `list my cases` |
| View case | `case 177968247000414` |
| Reply to case | `reply to case 177968247000414 — issue resolved` |
| Close case | `close case 177968247000414` |
| Concept | `what's the difference between ALB and NLB` / `what is KMS multi-region key` |
| Switch language | `language zh` / `switch to chinese` |

---

# Part 3 · Common to both surfaces

> The two sections below apply to Web Chat and IM alike.

---

## 19. FAQ

### Q1: Can I have the bot restart an EC2 for me?

**No**. The bot is read-only on your infrastructure (the only write is an AWS Support case that runs only after you confirm it) — a product-level hard rule that cannot be bypassed: by default it is
enforced by AWS DevOps Agent plus the IAM role it assumes (read-only on your infrastructure); after `/agent notiops`, by the
NotiOps AgentCore Runtime's read-only role and read-only tools; on both paths NotiOps adds a regex
second gate (see §9). See [TECHNICAL_DESIGN.en.md §5 Security design](TECHNICAL_DESIGN.en.md#5-security-design).

Workaround: **ask the bot how to restart it** (tutorial-style), and it will teach you the CLI commands. You review them, then run them yourself.

### Q2: How does the bot know about my AWS resources?

The bot **does not read** resources such as your CloudWatch / EC2 / RDS itself. By default it hands questions and investigations to your own **AWS DevOps Agent**, which reads your resources using the role you authorized for it; once the chat object is switched with `/agent notiops` (§15.5), free-form questions are answered by the NotiOps AgentCore Runtime, which reads with its read-only role (the same runtime as Web Chat — see §8.1).

The bot's Lambda role can do **more** than "send messages". It can:

- send and receive IM messages (the platform credentials live in Secrets Manager);
- start DevOps Agent deep investigations, read their progress, and chat with DevOps Agent directly;
- invoke the NotiOps AgentCore Runtime (the `/agent notiops` path);
- call Bedrock models (smart case analysis, and working out the service when a case is filed);
- **open / reply to / resolve AWS Support cases** (only after you confirm on the card / form, or reply "confirm" on DingTalk);
- AssumeRole into NotiOps' trigger role and collection role in onboarded member accounts (needed to dispatch investigations and open cases across accounts);
- read and write NotiOps' own DynamoDB tables, plus the reports and Skills in its data bucket.

### Q3: How long is my chat data retained?

| Type | TTL |
|---|---|
| Chat events / investigation context | 7 days |
| Investigation report HTML (S3) | **Not deleted automatically**: there is no lifecycle rule on the `investigations/` prefix, so the objects stay in the data bucket until the bucket itself is deleted. The card's links point at a copy under `reports/` (deleted by the lifecycle rule after about 7 days, and the links stop working with it); without a report CDN the links are presigned URLs (valid for a few hours, at most about 12) |
| Language preference | 90 days |
| DM lock | 30 days |
| Channel thread lock | 7 days |
| Investigation lock | 24 hours |
| Push event dedup | 5 minutes |

Everything except the investigation reports is cleaned up automatically by DDB TTL — no manual intervention needed.

### Q4: The bot suddenly stopped responding, what do I do?

Follow the §20 process and ask an admin to investigate. Common causes:
- IM credentials expired or changed (the admin re-enters them under Web Chat More → Admin → IM Integration, or edits that secret in Secrets Manager directly)
- Bedrock throttling (occasional during peak hours; it only affects the places that use a model — `/agent notiops` answers and smart case analysis)

### Q5: Can I add the bot to non-production channels?

Yes. **We strongly recommend trying it in a test channel for 1–2 weeks first**. By default the bot answers in every chat it is invited to; admins can narrow that down with a chat allowlist: on one-click deployments it is the stack parameter `ImAllowedChatIds` (labelled **IM chat/channel allow list** on the parameters page — see [DEPLOYMENT_ONECLICK.en.md](DEPLOYMENT_ONECLICK.en.md)); on `setup.sh` deployments, add `imAllowedChatIds` to the `context` block of `infra/cdk.json` and re-run `./setup.sh` (see [DEPLOYMENT.en.md §8.1](DEPLOYMENT.en.md)).

### Q6: Are the bot's replies model-generated? Will it hallucinate?

- **Investigation reports**: generated by DevOps Agent actually reading your resources, with a trace.html for verification — no fabrication
- **Concept Q&A**: by default your own DevOps Agent answers directly (0 NotiOps tokens, no sources block); only after you switch the chat object to NotiOps Agent (`@bot agent notiops`, see §15.5) is it the conversation's Bedrock model (Kimi K3 by default) + AWS official docs retrieval (Knowledge MCP), with the URLs under "Sources" that you can click to verify (see §13.2)
- **Intent detection**: a deterministic rule match with no model call (0 tokens); the rules are in §13.4
- **Investigation progress**: the progress card adds DevOps Agent's own investigation-journal entries one by one; NotiOps calls no model and writes no narration of its own (§11.3)

If a concept answer disagrees with what you know, **click the URL under "Sources" and read the AWS official docs yourself** (a DevOps Agent direct answer has no sources block, so look it up in the AWS docs directly) — that's ground truth.

### Q7: Will creating an AWS Support case via the bot incur extra Support fees?

No. The bot just calls the AWS Support API on your existing account. Cases themselves are not metered separately (case counts are included with your Support plan).

### Q8: When investigating, will DevOps Agent do "unexpected" things?

DevOps Agent is read-only by design (uses your authorized role, which should only have a ReadOnly policy attached). The bot only passes investigation request text on dispatch — **no mutating instructions**.

But **the precondition is**: the role you give DevOps Agent has not accidentally been granted write permissions. We recommend ops audits this role periodically.

---

## 20. Feedback & support

### 20.1 Feedback channels

To request a feature or report a problem: open an issue on the public repository's Issues page (the GitHub icon to the right of your name at the bottom left of Web Chat opens the repository home — see §1.2), or tell the administrator who runs this NotiOps deployment.

⚠️ **Don't give feedback by @-ing the bot with "I wish you could…"** — nothing records it: the message is treated as an ordinary question and handed to this chat's chat object to answer (your own DevOps Agent by default), and the bot's logs only keep metadata such as error types, never message text, so the administrator can't find it in the logs either.

### 20.2 Where to get help

| Problem | Who to contact |
|---|---|
| Bot didn't reply | Internal channel admin / IT ops |
| Bot replied but the content is clearly wrong | Send a screenshot to the admin; the admin checks the worker log `/aws/lambda/notiops-im-worker-<platform>` (on one-click deployments, `/aws/lambda/<StackName>-im-worker-<platform>`) — it holds metadata such as error types but no message text, so include your original message in the screenshot |
| Investigation report won't open | Most likely the link has expired: the card's links stay valid for about 7 days; when the card's footnote says "a few hours (at most about 12)", the deployment has no report CDN and uses S3 presigned URLs, which stop working within hours. The report is still in the bucket, but the link is not renewed — to look at this investigation again, use the progress card's "🔬 Open this investigation" button (on DingTalk, the link in the acknowledgement) to open it in the DevOps Agent console; that needs a console login (see §11.4) |
| I don't have permission to investigate this resource | This is a permission issue of the role of whoever answers you (by default the role your DevOps Agent uses; after `/agent notiops`, the NotiOps AgentCore Runtime's read-only role), not the bot's problem |
| AWS Support case creation failed | Read the error the bot returned — likely Support plan limit or severity not allowed |

### 20.3 Want to learn more?

- [TECHNICAL_DESIGN.en.md](TECHNICAL_DESIGN.en.md) — technical design, module boundaries, security rules
- [DEPLOYMENT.en.md](DEPLOYMENT.en.md) — deployment manual (for ops engineers)

---
