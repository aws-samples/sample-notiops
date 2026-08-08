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
| 🛠 [Deployment Guide](docs/DEPLOYMENT.en.md) | Step-by-step from `./setup.sh` to first smoke test (web console + optional IM) |
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
- 🛎️ **Proactive observation**: 6 EventBridge sources (CloudWatch / Health /
  Backup / GuardDuty / Cost / Trusted Advisor), independently switchable
- 📋 **Full AWS Support case management**: create / list / view / reply /
  **smart-analyze** (LLM rollup of the case thread) / resolve
- 💬 **AWS concept Q&A**: Bedrock + Knowledge MCP for official-doc retrieval,
  answers carry 📚 source citations
- 🤖 **Multi-LLM switching**: per-session model preference, all served through
  **Amazon Bedrock** (managed security, compliance, and cost controls)
- 🌍 **Bilingual**: Chinese / English auto-detect + explicit switching
- 🛡 **Zero-Change Promise**: 3-layer defense (inbound regex / system prompt /
  outbound audit) — the assistant never mutates your cloud
- 💬 **IM channels**: Slack / Feishu full-feature

---

## Getting started

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

### Deploy modes: single-account (default) vs multi-account

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
        AWS investigation     EventBridge × 6
        (via STS AssumeRole)  (CloudWatch / Health / Backup /
                               GuardDuty / Cost Anomaly / TA)
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
