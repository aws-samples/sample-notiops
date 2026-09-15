# 部署前置条件（跑 `setup.sh` 之前请先看这一页）

> 本页只回答一个问题:**在跑 `./setup.sh` 之前,我的机器和 AWS 账号需要满足什么?不满足怎么配?**
> 部署步骤本身在 [DEPLOYMENT.md](DEPLOYMENT.md);本页是它的 §2 前置条件的展开版。

---

## 0. 三十秒版本

在仓库根目录跑一次自检,它会把下面所有条目一次查完并给出逐项处方:

```bash
bash scripts/preflight.sh
```

- 退出码 `0` = 可以跑 `./setup.sh` 了
- 退出码 `1` = 有必检项不满足,照它打印的处方修完再跑

自检是**只读**的:不装任何东西、不改任何文件,只调两个只读 AWS API
(`sts:GetCallerIdentity` / `bedrock:ListFoundationModels`)。可以放心在生产账号上跑。
它默认按 `$LANG` 选中英文,也可以 `--lang=zh` / `--lang=en` 强制。

**最常见的一条**(90% 的失败都是它)—— 装 boto3 并且**激活 venv**:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
source .venv/bin/activate      # ← 这一行不能省
./setup.sh
```

---

## 1. 先确认你要走哪条路 —— 方式 A 完全不需要本页内容

NotiOps 有两条部署路径,前置条件差别极大:

| | 方式 A:一键部署(CloudFormation) | 方式 B:`setup.sh` |
|---|---|---|
| 本地要装什么 | **什么都不用** | 本页全部条目 |
| 需要本地 AWS 凭证吗 | **不需要**(在控制台里点) | 需要 |
| 需要交互式终端吗 | 不需要 | **需要** |
| 你需要的全部东西 | 一个能登 AWS 控制台的浏览器 | 一台配好的开发机 |
| 指南 | [DEPLOYMENT_ONECLICK.md](DEPLOYMENT_ONECLICK.md) | [DEPLOYMENT.md](DEPLOYMENT.md) |

**如果你只是想把 NotiOps 跑起来看看,或者手上没有配好的开发机,直接走方式 A。**
本页剩下的内容只对方式 B 有意义。

---

## 2. 必装工具

| 项 | 要求 | 检查 | 不满足怎么办 |
|---|---|---|---|
| Python | **≥ 3.10**(文档推荐 3.12+) | `python3 --version` | macOS: `brew install python@3.12`<br>Amazon Linux 2023: `sudo dnf install -y python3.12` |
| Node.js | **≥ 22**(CDK 要求) | `node --version` | `brew install node`,或 `nvm install 22` |
| npm | 随 Node.js 一起装 | `npm --version` | 同上 |
| AWS CLI | **v2,且 ≥ 2.13** | `aws --version` | [官方安装文档](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)。**v1 一律不支持** |
| jq | 任意版本 | `jq --version` | `brew install jq` / `sudo dnf install -y jq` |
| **uv** | 任意版本 | `uv --version` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` 或 `brew install uv` |
| **boto3** | 装在 setup.sh 会用的解释器里 | 见 [§3](#3-boto3最容易漏的一项) | 见 [§3](#3-boto3最容易漏的一项) |
| git | 任意版本 | `git --version` | 只有 clone 仓库需要;已经拿到源码就不影响部署 |
| AWS CDK CLI | — | — | **不用管**,`setup.sh` 缺了会自己 `npm install -g aws-cdk` |
| 容器运行时 | — | — | **不需要**。自 2026-09-03 起 docker / finch 都不再需要,包括部署 IM |

> ⚠️ **`setup.sh` 只检查"命令在不在",不检查版本。** 上表里所有版本下限都是真实的运行要求,
> 但 `setup.sh` 的 preflight 用的是 `command -v`,版本不够它照样往下跑,失败会发生在部署中段
> ——那时候云上资源已经建了一半。`scripts/preflight.sh` 补的正是这一层:它真的比版本号。

### 2.1 Python 为什么是 3.10 而不是"有就行"

`setup.sh` 会给 Lambda 打一个依赖层,用的是:

```
pip install --platform manylinux2014_x86_64 --only-binary=:all: ...
```

`pip` 会拿目标 wheel 的 `Requires-Python`(boto3 / botocore / urllib3 都声明 `>= 3.10`)去比
**当前正在跑的解释器**。所以哪怕 boto3 已经装好了,3.9 的解释器在这一步也直接失败。

> ⚠️ **macOS 自带的 `/usr/bin/python3` 至今是 3.9.x。** 装了 Homebrew 的 Python 之后,
> 还要确认 `command -v python3` 指向 `/opt/homebrew/bin/python3` 而不是 `/usr/bin/python3`。

### 2.2 uv 为什么单独拿出来强调

`agentcore deploy` 在打 agent 的 Python 依赖包时**无条件**调 `uv`。缺它的后果**不是报错停下**,
而是**静默降级**:

```
agent 部署失败 → 拿不到 Runtime ARN → BFF 回退 echo 模式
                → 但 web 端照常部署成功,脚本照常打印 Chat URL
```

客户看到的现象是「部署明明成功了,可我一提问,它只把我说的话原样回显回来」。
`setup.sh` 的 preflight 会拦住这一种(除非 `SKIP_AGENT=true`),但仍然建议提前装好。

> ℹ️ uv 官方安装器装到 `~/.local/bin`,非交互式 shell 常常不在 PATH ——
> **装完新开一个终端**,再 `uv --version` 确认。

---

## 3. boto3:最容易漏的一项

`setup.sh` **不检查 boto3**,而部署收尾阶段有三个 Python 脚本要在**你本机**导入它:

- 上传只读巡检 skill
- 回填巡检索引
- 初始化模型目录

它们各自崩在 `ModuleNotFoundError` 上,而 `setup.sh` **仍然打印「部署完成!」并以退出码 0 结束**。
结果是:网页能开、能对话,但巡检 skill 和模型目录是空的 —— 一个看起来成功、实际缺功能的部署。

### 正确做法

在仓库根目录,**跑 `setup.sh` 之前**:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
source .venv/bin/activate      # ← 这一行不能省
./setup.sh
```

### 两个反直觉的点

**① 只装到系统 `python3` 里不够。**
`setup.sh` 自己会建 `.venv`,而且**不带** `--system-site-packages` —— 系统里的 boto3 进不去那个
venv。所以必须装进 `.venv`(或者预先建好这个 `.venv`,见下)。

**② `source .venv/bin/activate` 这一行不能省。**
收尾那三个脚本里,有两个用的是 `.venv` 里的解释器,另外两处用的是**裸 `python3`**。
提前在外层激活 venv,裸 `python3` 才会解析到 `.venv/bin/python3`,四处才能一次覆盖全。

> ℹ️ 提前建好 `.venv` 不会被覆盖:`setup.sh` 里那句 `python3 -m venv .venv` 作用在**已存在**的
> venv 上不会清掉已装的包;它内部的 `activate` / `deactivate` 也不会撤销你在外层做的激活。
> 所以上面四行的顺序是安全的,不用担心被 `setup.sh` 洗掉。

---

## 4. AWS 账号与凭证

| 项 | 要求 |
|---|---|
| 凭证有效性 | `aws sts get-caller-identity` 能成功返回 |
| 权限 | 能创建 CloudFormation / Lambda / DynamoDB / API Gateway / IAM 角色 / Secrets Manager / Bedrock AgentCore 资源(细粒度清单见 [DEPLOYMENT.md](DEPLOYMENT.md) §2.4) |
| 区域 | 目标区域必须提供 Bedrock 与 Bedrock AgentCore |
| **Bedrock 模型访问** | 必须在 **Bedrock 控制台 → Model access** 为模型目录里的默认模型开通访问 |

凭证过期是最常见的一种:

```bash
aws sso login --profile <profile>              # SSO
aws configure --profile <profile>             # 长期密钥
export AWS_PROFILE=<profile>
```

> ⚠️ **「Bedrock API 可达」不等于「模型已开通」。** `setup.sh` **完全不检查**模型访问。
> 没开通的话,部署会一路成功,但你在网页里发出的**第一句话**就会报权限错。
> 部署前顺手去 Bedrock 控制台把默认模型的访问点开。

`scripts/preflight.sh` 会用 `AWS_REGION` / `AWS_DEFAULT_REGION` / `aws configure get region` 里
拿到的区域做一次 Bedrock 可达性探测。**注意它探的是你本机的默认区域**,而 `setup.sh` 会另外问你
一次要部署到哪个区域 —— 两者不一致时,以你在 `setup.sh` 里选的为准:

```bash
export AWS_REGION=<你打算部署的区域>
bash scripts/preflight.sh
```

---

## 5. 必须在交互式终端里跑

`setup.sh` 会交互提问(选区域、确认账号、选 IM 平台等)。它读输入的地方**没有非交互兜底**。

> ⚠️ **非交互运行时,`setup.sh` 会在第一个提问处以退出码 1 退出,而且一个字都不打印。**
> 日志里看不出任何原因 —— 这是最难自己排查的一种失败。

所以下面这些方式**都不行**:

```bash
./setup.sh </dev/null      # ✗
nohup ./setup.sh &         # ✗
yes | ./setup.sh           # ✗
./setup.sh | tee out.log   # ✗ 只要有管道就不行
```

**要免交互部署,请改用方式 A**([DEPLOYMENT_ONECLICK.md](DEPLOYMENT_ONECLICK.md))——
它本来就是为「不进终端」设计的。

---

## 6. 磁盘与网络

| 项 | 要求 | 说明 |
|---|---|---|
| 可用磁盘 | 建议 **≥ 10 GB** | 实测占用:`node_modules` 约 600 MB、`.venv` 约 350 MB、Lambda 依赖层约 40 MB,再加每次 `cdk synth` 的输出目录(实测可达约 430 MB,合成完可删) |
| PyPI | `https://pypi.org` 可达 | 装 Python 依赖、交叉下载 Lambda 层的 wheel |
| npm registry | `https://registry.npmjs.org` 可达 | 装 CDK 与 `infra/` 的依赖 |
| AWS API | 目标区域的 AWS 服务端点可达 | — |

> ℹ️ 走企业代理或内网镜像源的环境:先配好 `HTTPS_PROXY`、`pip` 的 `index-url`、`npm` 的
> `registry`,**再**跑 `setup.sh`。这两个源任意一个不通,失败点都在部署中段 —— 那时云上资源
> 已经建了一部分。

---

## 7. 前置条件管不到的事

把这一节写在这里,是为了不给你错误的安全感。**下面这些即使自检全绿也可能发生:**

| 情况 | 为什么前置检查挡不住 |
|---|---|
| 区域不提供 Bedrock AgentCore | `setup.sh` 的区域菜单**不做能力校验**,选了不支持的区域要到部署中段才失败 |
| Bedrock 模型没开通访问 | 自检只能验 API 可达;开通状态要你自己去控制台确认(见 [§4](#4-aws-账号与凭证)) |
| 部署权限缺某一条具体 action | 自检只验凭证有效,不做权限模拟;缺哪条要看 CloudFormation 的失败事件 |
| 服务配额不足(Lambda 并发、VPC 数等) | 与账号历史用量有关,无法在本地预判 |
| 部署中途网络断开 | 已建的资源会留在账号里,重跑 `setup.sh` 会继续 |

遇到这些,按 [DEPLOYMENT.md](DEPLOYMENT.md) 的故障排查一节走。

---

## 8. 速查表

| 症状 | 处方 |
|---|---|
| 部署"成功"但一提问只回显我说的话 | 没装 `uv`,agent 静默降级了。装 uv,新开终端,重跑 |
| 部署"成功"但巡检 skill / 模型目录是空的 | 缺 boto3。按 [§3](#3-boto3最容易漏的一项) 的四行重来 |
| 打依赖层时 pip 报 `Requires-Python` | Python < 3.10。装 3.12 并确认 `command -v python3` 指对了 |
| 脚本没输出就退出,退出码 1 | 不在交互式终端里跑。见 [§5](#5-必须在交互式终端里跑) |
| 网页第一句话就报权限错 | Bedrock 模型没开通访问。见 [§4](#4-aws-账号与凭证) |
| 凭证相关报错 | `aws sso login --profile <profile>` 或重配 profile |
| 不确定到底缺什么 | `bash scripts/preflight.sh` |
