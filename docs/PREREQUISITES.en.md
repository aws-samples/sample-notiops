# Prerequisites (read this before running `setup.sh`)

> This page answers exactly one question: **what does my machine and my AWS account need before
> I run `./setup.sh`, and how do I fix it if they don't?**
> The deployment steps themselves live in [DEPLOYMENT.en.md](DEPLOYMENT.en.md); this page is the
> long form of its §2 Prerequisites.

---

## 0. The thirty-second version

Run the self-check once from the repository root. It covers every item below and prints a fix for
each one it doesn't like:

```bash
bash scripts/preflight.sh
```

- exit code `0` = you can run `./setup.sh`
- exit code `1` = something required is missing; fix it as printed, then re-run

The check is **read-only**: it installs nothing, writes no files, and calls exactly two read-only
AWS APIs (`sts:GetCallerIdentity` / `bedrock:ListFoundationModels`). It is safe to run against a
production account. It picks its language from `$LANG`; `--lang=en` / `--lang=zh` force it.

**The single most common miss** (roughly 90% of failures) -- install boto3 *and* activate the venv:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
source .venv/bin/activate      # <- do not skip this line
./setup.sh
```

---

## 1. First, pick your path -- Option A needs none of this

NotiOps has two deployment paths, and their prerequisites are wildly different:

| | Option A: one-click (CloudFormation) | Option B: `setup.sh` |
|---|---|---|
| Local installs | **none** | everything on this page |
| Local AWS credentials | **not needed** (you click in the console) | required |
| Interactive terminal | not needed | **required** |
| All you actually need | a browser that can sign in to the AWS console | a prepared workstation |
| Guide | [DEPLOYMENT_ONECLICK.en.md](DEPLOYMENT_ONECLICK.en.md) | [DEPLOYMENT.en.md](DEPLOYMENT.en.md) |

**If you just want to see NotiOps running, or you don't have a prepared workstation, use Option A.**
The rest of this page only matters for Option B.

---

## 2. Required tools

| Item | Requirement | Check | If missing |
|---|---|---|---|
| Python | **>= 3.10** (3.12+ recommended) | `python3 --version` | macOS: `brew install python@3.12`<br>Amazon Linux 2023: `sudo dnf install -y python3.12` |
| Node.js | **>= 22** (required by the CDK) | `node --version` | `brew install node`, or `nvm install 22` |
| npm | ships with Node.js | `npm --version` | as above |
| AWS CLI | **v2, and >= 2.13** | `aws --version` | [install guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html). **v1 is never supported** |
| jq | any version | `jq --version` | `brew install jq` / `sudo dnf install -y jq` |
| **uv** | any version | `uv --version` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` or `brew install uv` |
| **boto3** | in the interpreter setup.sh will use | see [§3](#3-boto3-the-easiest-one-to-miss) | see [§3](#3-boto3-the-easiest-one-to-miss) |
| git | any version | `git --version` | only needed to clone; irrelevant if you already have the sources |
| AWS CDK CLI | — | — | **ignore this one**; `setup.sh` runs `npm install -g aws-cdk` if it's missing |
| Container runtime | — | — | **not needed.** Since 2026-09-03 neither docker nor finch is required, including for IM |

> ⚠️ **`setup.sh` only checks whether a command exists -- it never checks versions.** Every
> version floor above is a real runtime requirement, but `setup.sh`'s preflight uses `command -v`,
> so an old version sails straight through and fails mid-deploy -- by which point half the cloud
> resources already exist. `scripts/preflight.sh` exists to close exactly that gap: it really does
> compare versions.

### 2.1 Why Python is 3.10, not just "present"

`setup.sh` builds a Lambda dependency layer with:

```
pip install --platform manylinux2014_x86_64 --only-binary=:all: ...
```

`pip` validates each target wheel's `Requires-Python` (boto3, botocore and urllib3 all declare
`>= 3.10`) against **the interpreter that is currently running**. So even with boto3 already
installed, a 3.9 interpreter fails right there.

> ⚠️ **macOS still ships 3.9.x at `/usr/bin/python3`.** After installing Homebrew's Python,
> confirm that `command -v python3` resolves to `/opt/homebrew/bin/python3` and not
> `/usr/bin/python3`.

### 2.2 Why uv gets its own callout

`agentcore deploy` invokes `uv` **unconditionally** to package the agent's Python dependencies.
Missing it does **not** stop the deploy -- it **silently degrades**:

```
agent deploy fails -> no Runtime ARN -> the BFF falls back to echo mode
                   -> but the web tier deploys fine and the script still prints a Chat URL
```

What the customer sees: "the deploy clearly succeeded, but when I ask it anything it just repeats
my message back at me." `setup.sh`'s preflight does block this one (unless `SKIP_AGENT=true`), but
install uv up front anyway.

> ℹ️ uv's official installer targets `~/.local/bin`, which is often not on a non-interactive
> shell's PATH -- **open a new terminal** after installing, then confirm with `uv --version`.

---

## 3. boto3: the easiest one to miss

`setup.sh` **does not check for boto3**, and three Python scripts import it on **your machine**
during the final stage of the deploy:

- uploading the read-only inspection skill
- backfilling the inspection index
- seeding the model catalogue

Each dies on `ModuleNotFoundError` -- and `setup.sh` **still prints "Deployment complete!" and
exits 0**. The result: the web UI opens and chats, but the inspection skill and the model catalogue
are empty. A deploy that looks successful and is quietly missing features.

### The right way

From the repository root, **before** running `setup.sh`:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
source .venv/bin/activate      # <- do not skip this line
./setup.sh
```

### Two counter-intuitive details

**(1) Installing into the system `python3` is not enough.**
`setup.sh` creates its own `.venv`, and it does **not** pass `--system-site-packages` -- so a
system-level boto3 is invisible from inside that venv. It has to go into `.venv` (or you pre-create
that `.venv` yourself, as above).

**(2) `source .venv/bin/activate` is not optional.**
Of the post-deploy scripts, two use the `.venv` interpreter and two more call a **bare `python3`**.
Activating the venv in your outer shell is what makes a bare `python3` resolve into
`.venv/bin/python3` -- that is what covers all four call sites at once.

> ℹ️ Pre-creating `.venv` is safe: the `python3 -m venv .venv` inside `setup.sh` does not clear
> already-installed packages when the venv already exists, and its internal `activate` /
> `deactivate` do not undo an activation you did in the outer shell. The four lines above will not
> be washed away.

---

## 4. AWS account and credentials

| Item | Requirement |
|---|---|
| Credential validity | `aws sts get-caller-identity` returns successfully |
| Permissions | able to create CloudFormation / Lambda / DynamoDB / API Gateway / IAM roles / Secrets Manager / Bedrock AgentCore resources (fine-grained list in [DEPLOYMENT.en.md](DEPLOYMENT.en.md) §2.4) |
| Region | the target region must offer both Bedrock and Bedrock AgentCore |
| **Bedrock model access** | you must grant access to the model catalogue's default model under **Bedrock console -> Model access** |

Expired credentials are the most common case here:

```bash
aws sso login --profile <profile>              # SSO
aws configure --profile <profile>             # long-term keys
export AWS_PROFILE=<profile>
```

> ⚠️ **"Bedrock API reachable" is not the same as "model enabled".** `setup.sh` does **not check
> model access at all.** Without it the deploy succeeds end to end, and then the **very first
> message** you send in the web UI fails on permissions. Enable the default model in the Bedrock
> console before you deploy.

`scripts/preflight.sh` probes Bedrock reachability using whichever region it finds in
`AWS_REGION` / `AWS_DEFAULT_REGION` / `aws configure get region`. **Note it probes your local
default region**, while `setup.sh` asks you separately which region to deploy into. When the two
disagree, the one you pick in `setup.sh` is what counts:

```bash
export AWS_REGION=<the region you intend to deploy to>
bash scripts/preflight.sh
```

---

## 5. It must run in an interactive terminal

`setup.sh` asks interactive questions (region, account confirmation, IM platforms, and more). The
places where it reads input have **no non-interactive fallback**.

> ⚠️ **Run non-interactively, `setup.sh` exits 1 at the first prompt and prints nothing at all.**
> The logs give you no reason -- this is the hardest failure mode to diagnose on your own.

So none of these work:

```bash
./setup.sh </dev/null      # x
nohup ./setup.sh &         # x
yes | ./setup.sh           # x
./setup.sh | tee out.log   # x -- any pipe at all breaks it
```

**For a hands-off deploy, use Option A** ([DEPLOYMENT_ONECLICK.en.md](DEPLOYMENT_ONECLICK.en.md)) --
it was designed for exactly the "never open a terminal" case.

---

## 6. Disk and network

| Item | Requirement | Notes |
|---|---|---|
| Free disk | **>= 10 GB** recommended | Measured: `node_modules` ~600 MB, `.venv` ~350 MB, the Lambda dependency layer ~40 MB, plus one `cdk synth` output directory per run (measured up to ~430 MB; removable afterwards) |
| PyPI | `https://pypi.org` reachable | Python dependencies and the cross-downloaded Lambda-layer wheels |
| npm registry | `https://registry.npmjs.org` reachable | the CDK and `infra/`'s dependencies |
| AWS APIs | service endpoints in the target region reachable | — |

> ℹ️ Behind a corporate proxy or an internal mirror: configure `HTTPS_PROXY`, `pip`'s `index-url`
> and `npm`'s `registry` **before** running `setup.sh`. If either source is unreachable, the
> failure lands mid-deploy -- after some cloud resources already exist.

---

## 7. What prerequisites cannot cover

This section exists so the green check doesn't give you false confidence. **All of the following
can still happen with a fully green self-check:**

| Situation | Why a preflight can't catch it |
|---|---|
| The region doesn't offer Bedrock AgentCore | `setup.sh`'s region menu does **no capability validation**; an unsupported region only fails mid-deploy |
| Bedrock model access not granted | the check can only verify API reachability; enablement is something you confirm in the console (see [§4](#4-aws-account-and-credentials)) |
| One specific IAM action is missing | the check verifies credential validity, not a policy simulation; which action is missing comes from the CloudFormation failure events |
| Service quotas too low (Lambda concurrency, VPCs per region, ...) | depends on the account's existing usage; not predictable locally |
| The network drops mid-deploy | resources already created stay in the account; re-running `setup.sh` continues |

When you hit these, follow the troubleshooting section in [DEPLOYMENT.en.md](DEPLOYMENT.en.md).

---

## 8. Quick reference

| Symptom | Fix |
|---|---|
| Deploy "succeeded" but every question just echoes my message back | `uv` is missing and the agent degraded silently. Install uv, open a new terminal, re-run |
| Deploy "succeeded" but the inspection skill / model catalogue is empty | boto3 is missing. Redo the four lines in [§3](#3-boto3-the-easiest-one-to-miss) |
| pip fails on `Requires-Python` while building the layer | Python < 3.10. Install 3.12 and confirm `command -v python3` points at it |
| The script exits 1 with no output at all | you're not in an interactive terminal. See [§5](#5-it-must-run-in-an-interactive-terminal) |
| The first message in the web UI fails on permissions | Bedrock model access not granted. See [§4](#4-aws-account-and-credentials) |
| Credential errors | `aws sso login --profile <profile>`, or reconfigure the profile |
| Not sure what's actually missing | `bash scripts/preflight.sh` |
