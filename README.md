# NotiOps

> 🌐 **Language**: [English](README.md) · [中文](README.zh.md)

> ⚠️ **Disclaimer**: This is sample code, for non-production usage. You should
> work with your security and legal teams to meet your organizational security,
> regulatory, and compliance requirements before deployment. It is provided for
> educational/reference purposes and is not a production-ready product.

![NotiOps web console](docs/screenshot-web-en.png)

**NotiOps** is AWS sample code for a **read-only cloud operations console** — a
browser-based chat app where an engineer asks about their AWS environment in
plain language and gets back a near real-time, cited answer: incident
investigations with a root-cause narrative, cost/FinOps analysis, resource
health inspection, and full AWS Support case management — all without leaving
the web UI or touching the AWS Console.

The same assistant is also available **inside your team's chat tools (Slack /
Feishu)**: `@mention` the bot in an alert channel to run an investigation and
read the report where the alert already landed. On top of on-demand questions,
it does **proactive push** across six AWS signal sources (CloudWatch, AWS
Health, Backup, GuardDuty, Cost Anomaly, Trusted Advisor).

All models are served through **Amazon Bedrock** (managed security, compliance,
and cost controls), with per-session model switching and automatic
English/Chinese localization. A **zero-change promise** is enforced by a
three-layer guardrail (inbound filter → system prompt → outbound audit): the
assistant reads and reasons, but never mutates your cloud — safe to hand to
on-call engineers without granting write access.

---

## Quick links

| Doc | Purpose |
|---|---|
| 🚀 [One-click Deploy](docs/DEPLOYMENT_ONECLICK.en.md) | Browser only: upload one CloudFormation template, ~4.5 minutes to a running Web Chat (Web Chat only) |
| 🛠 [Deployment Guide](docs/DEPLOYMENT.en.md) | Full install: step-by-step from `./setup.sh` to first smoke test (web console + optional IM) |
| 👤 [User Guide](docs/USER_GUIDE.en.md) | End-user manual + conversation samples + FAQ |
| 🏗 [Technical Design](docs/TECHNICAL_DESIGN.en.md) | Module boundaries / data flow / security / 3-layer defense |
| 🧑‍💻 [CONTRIBUTING](CONTRIBUTING.md) | Conventions (i18n / security / PR process) |

---

## Features

- 🖥️ **Web console (read-only)**: a browser chat app for incident investigation,
  cost/FinOps analysis, resource-health inspection, and AWS Support case
  management — plain-language in, cited answers out
- 🔍 **Ad-hoc investigation**: ask a single sentence, get a complete report
  (markdown summary + HTML + trace) — typically ~1-3 minutes in internal testing
  (varies with query complexity, account size, and model)
- 🛎️ **Proactive observation**: 10 EventBridge sources (CloudWatch / Health /
  Cost Anomaly / Trusted Advisor / GuardDuty / Backup / EC2 Spot interruption /
  Auto Scaling launch failure / RDS / Config), each independently switchable —
  five are on by default
- 📋 **Full AWS Support case management**: create / list / view / reply /
  **smart-analyze** (LLM rollup of the case thread) / resolve
- 💬 **AWS concept Q&A**: Bedrock + Knowledge MCP for official-doc retrieval,
  answers carry 📚 source citations
- 🤖 **Multi-LLM switching**: an operator-managed model catalogue — pick which
  models your deployment offers, set the default, and choose the models used by
  backend tasks, all from the Admin console with no redeploy. Users keep a
  per-session model preference. Every model is served through **Amazon Bedrock**
  (managed security, compliance, and cost controls), on either IAM or a Bedrock
  API key
- 🌍 **Bilingual**: Chinese / English auto-detect + explicit switching
- 🛡 **Zero-Change Promise**: 3-layer defense (inbound regex / system prompt /
  outbound audit) — the assistant never mutates your cloud
- 💬 **IM channels**: Slack / Feishu full-feature

---

## Getting started

Two ways to deploy — pick one.

### Option A: one-click deploy — a browser is all you need

For environments where long-lived access keys aren't available, or where you
can't install CDK and a container runtime locally: everything happens in the AWS
Console, nothing is installed on your machine.

1. Download `notiops-webchat.template.json` from
   [Releases](https://github.com/aws-samples/sample-notiops/releases/latest);
2. Open the CloudFormation console → **Create stack** → **Upload a template file**;
3. Enter an administrator email (the temporary password is mailed there), tick
   the IAM capabilities acknowledgement, and create — measured at ~4.5 minutes.
   The stack outputs include the Web Chat URL.

⚠️ One-click deploys **Web Chat only** (frontend + BFF + agent). It does **not**
include the IM bots, scheduled inspections, the admin dashboard, or CUR/Athena
FinOps — use Option B for those. Prerequisites (region and Bedrock model access),
the resource and cost breakdown, upgrade/rollback, and one-click teardown are in
[docs/DEPLOYMENT_ONECLICK.en.md](docs/DEPLOYMENT_ONECLICK.en.md).

### Option B: `setup.sh` — the full install

```bash
# 1. Clone
git clone https://github.com/aws-samples/sample-notiops.git
cd sample-notiops

# 2. Deploy (CDK, one command; interactive on first run)
./setup.sh
# First run: confirm AWS account → pick region → pick IM platforms
# (Slack / Feishu, multi-select) → paste credentials for each (written
# straight to Secrets Manager, never to disk) → CDK bootstrap → synth →
# container build → cdk deploy --all. Re-runs only patch deltas.
```

Requires git, Node.js, Python, the AWS CDK, and a container runtime locally,
plus credentials that can deploy.

#### Deploy modes: single-account (default) vs multi-account

Decide before you run `setup.sh` — the mode is baked in at deploy time and
switching later requires a redeploy.

- **Single-account (default)** — `./setup.sh`. NotiOps operates in the deploy
  account only. Least privilege, fastest path to a working install; right for
  most trials and single-account users.
- **Multi-account** — `./setup.sh --multi-account`. Adds cross-member-account
  inspection / investigation / event forwarding across an AWS Organization. Run
  it in the **Organizations management account**, or in a member account
  registered as a **CloudFormation StackSets delegated administrator** (you do
  **not** have to be the management account). Member-account resources are
  rolled out automatically via StackSets.

For the full deployment walkthrough into your own AWS account — including the
mode comparison and how to switch — see
[docs/DEPLOYMENT.en.md](docs/DEPLOYMENT.en.md).

---

## Architecture (high-level)

```
Web console (browser)        Customer IM (Slack / Feishu)
        │                              │
        └──────────────┬───────────────┘
                       ▼
        ┌──────────────────────────────────────┐
        │   NotiOps (this repo)                 │
        │   · intent classification             │
        │   · 3-layer read-only defense         │
        │   · case management · bilingual i18n  │
        │   · MCP doc retrieval · Bedrock routing│
        │                 │                      │
        │                 ▼                      │
        │   Lambdas (collector / analyzer /      │
        │   health / notifier / cost) + handlers │
        └──────┬────────────────────┬────────────┘
               ▼                    ▼
        AWS investigation     EventBridge × 10
        (via STS AssumeRole)  (CloudWatch / Health / Cost Anomaly / TA /
                               GuardDuty / Backup / EC2 Spot / ASG /
                               RDS / Config)
```

Full architecture in
[docs/architecture-diagram.md](docs/architecture-diagram.md).

---

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Highlights:

- **Every user-visible string must be bilingual** (zh + en) via
  `core/i18n.py`'s `i18n.t(key, locale)` API — CI enforces this
- **Don't bypass the zero-change promise**: the assistant is read-only; refuse
  any mutation request
- **Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)**

---

## License

This sample code is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.
