# IM Webhook 配置指南（飞书 / Slack / 钉钉）

飞书、Slack、钉钉都走 **API Gateway HTTP API + Lambda webhook**（不再需要常驻容器和长连接）。
这份文档只讲**你要在 IM 平台控制台点什么**，是 **部署完成之后** 的那一步。

> **三类读者，都适用**：
> - **一键部署（方式 A）**：参数页的 **What to install** 选了 `web+feishu` / `web+slack` /
>   `web+dingtalk`
>   （见 [DEPLOYMENT_ONECLICK.md §2.11](DEPLOYMENT_ONECLICK.md#211-加装-im-机器人飞书lark-或-slack)），
>   栈已经开完，剩下的就是这份文档 —— 先看 §0 那条 🅰️ 说明（只有四处不同），然后照 §1 / §2 / §3 做。
> - **新部署（方式 B，`setup.sh`）**：先按 [DEPLOYMENT.md](DEPLOYMENT.md) §3 建好应用、配好权限、拿到钥匙，
>   跑完 `setup.sh`，然后回到这里填请求地址。
> - **已有长连接部署**：飞书是**原地切换**，不需要新建应用、不需要改权限，
>   只改「订阅方式 + 请求地址」两项，并补两把钥匙（§1.2）。
>   **钉钉没有这条路** —— 老部署里钉钉跑的是已退役的 Fargate 长连接形态，
>   现在要按 §3 新建一个企业内部应用。
>
> ⚠️ **顺序是硬的**：请求地址必须在「栈已部署」**且**「钥匙已写进 Secret」之后才填。
> 反了的症状是飞书 / Slack 显示「校验失败」，看起来像地址填错了；
> **钉钉连「校验失败」都不显示 —— 它保存地址时什么都不验，只是机器人不回话**（见 §3.4）。

### 🔴 本版本支持的 IM 平台：飞书 / Lark、Slack、钉钉

| 平台 | 本版本 | 说明 |
|---|:--:|---|
| 飞书 / Lark | ✅ | Lambda webhook，本文 §1 |
| Slack | ✅ | Lambda webhook，本文 §2 |
| 钉钉 DingTalk | ✅ | Lambda webhook，本文 §3（2026-09-08 起） |
| Microsoft Teams | ❌ **不可用** | `platforms/teams/` 是空目录，只有设计意图，没有实现 |

> Microsoft Teams 是**已知的待办**，不在本版本内。要在 Teams 上用 NotiOps，
> 目前唯一的办法是走 Web Chat（浏览器），它的能力集与 IM 侧一致。

---

## 0. 先拿到 Webhook 地址

**最省事的一条：管理控制台 →「集成 IM」→ 切到你的平台分页 →「查看详细配置步骤」→ 第 3 步。**
本部署真实的地址就显示在那里，带一个「复制」按钮 —— 不用开 CloudFormation 控制台、
不用跑 CLI，两条部署路径（方式 A / 方式 B）都一样。地址由后端按名字查 IM 入口的
HTTP API 得到，所以栈名叫什么都不影响。

> **这一页覆盖飞书和钉钉两个平台**（各有独立的分页和抽屉，取到的是各自那个入口的地址）。
> **Slack 的地址目前只在 Outputs 里。**
>
> 抽屉里那一块显示「取不到地址」时，说明这个部署没装这个平台（比如只装了 `web`、
> 或者只装了飞书而你在看钉钉那页），或者查询没有权限 —— 退回下面的 CLI / Outputs
> 取法即可，两处是同一个值。

下面是 CLI 取法（脚本部署、自动化、以及 Slack 都用这个）。`ImStack` 部署完会按装了哪些平台输出对应的 CfnOutput：

```bash
aws cloudformation describe-stacks --stack-name ImStack --region <REGION> \
  --query 'Stacks[0].Outputs[?OutputKey==`FeishuWebhookUrl`||OutputKey==`SlackWebhookUrl`||OutputKey==`DingtalkWebhookUrl`]' \
  --output table
```

形如 `https://<随机>.execute-api.<region>.amazonaws.com/`。**结尾那个 `/` 要保留**。

每个平台有**自己的**一个 HTTP API 和 ingress（`FeishuWebhookUrl` / `SlackWebhookUrl` /
`DingtalkWebhookUrl` 是三个不同的地址，别互相填错）。但**同一个平台内部只有一个地址**：
飞书的「事件」和「回调」两处填同一个；Slack 的 Events / Interactivity / Slash Commands
三处填同一个；钉钉只有「消息接收地址」这一处要填。
HTTP API 用的是 `$default` catch-all 路由（任意方法、任意路径都进 ingress），
ingress 按请求体自己分流，不靠路径区分 —— 所以地址后面**加不加子路径都能通**，
但建议就按 Outputs 里给的原样填。

> 📌 **2026-09-01 起这个地址换了形态**：以前是 Lambda Function URL
> （`https://<随机>.lambda-url.<region>.on.aws/`），现在前面加了一层 API Gateway
> HTTP API。原因和取舍见 §5。**从旧版本升级上来的部署，这个地址会变** ——
> 重新取一次 Outputs，回到 §1.3 / §1.4（或 §2.3 / §3.4）把新地址填一遍。旧地址不会保留。

> 🅰️ **一键部署（方式 A）的读者**：你没有 `ImStack` —— IM 是**主栈的加装项**（参数页的
> **What to install** 选 `web+feishu` / `web+slack` / `web+dingtalk`，见
> [DEPLOYMENT_ONECLICK.md §2.11](DEPLOYMENT_ONECLICK.md#211-加装-im-机器人飞书lark-或-slack)）。差别只有下面四条，
> §1 / §2 / §3 的每一步照做即可：
> - **地址从主栈的 Outputs 取**：上面那条命令把 `--stack-name` 换成你的栈名（默认 `notiops`）。
>   OutputKey 一模一样，另外还多一个 `ImNextSteps` 告诉你还差哪一步。
> - **secret 名字完全一致**（`notiops/im-bot-feishu` / `notiops/im-bot-dingtalk` /
>   `notiops/slack-bot-token` / `notiops/slack-signing-secret`），本文所有命令原样可用。
> - **Slack 那两个 secret 要你手建**（`aws secretsmanager create-secret`，见 §2.2）——
>   模板不建 secret；**飞书和钉钉**那两个在管理控制台「集成 IM」页保存凭证时会由后端自动创建。
> - **安装选项必须包含你要配的那个平台**：只装 `web` 的栈没有这个 HTTP API，
>   Outputs 里也不会出现 `FeishuWebhookUrl` / `SlackWebhookUrl` / `DingtalkWebhookUrl`。
>   ⚠️ **一次只能选一个 IM 平台** —— `web+feishu` / `web+slack` / `web+dingtalk` 是互斥的
>   单选。要同时装两个 IM，走方式 B（`setup.sh` 可以多选）。

---

## 1. 飞书

### 1.1 权限：切 webhook 不用改，但**要补一条表情权限**

长连接和 webhook 用的是同一批 scope —— 切换本身一条都不用动。你现有 App 里这套
（新部署见 [DEPLOYMENT.md](DEPLOYMENT.md) §3.1 第 4 步的可导入 JSON）继续沿用：

```
cardkit:card:read / cardkit:card:write / cardkit:template:read
im:chat / im:chat.access_event.bot_p2p_chat:read
im:message / im:message.group_at_msg:readonly / im:message.p2p_msg:readonly
im:message:readonly / im:message:send_as_bot / im:resource
```

⚠️ **2026-09-03 起新增一条 `im:message.reaction:write`**（在「正在思考」卡片之前先给用户
一个 👀 表情，让"收到了"的反馈从秒级降到毫秒级）。这条**是可选的**：

- 加了：提问后立刻看到表情，然后才是卡片。
- 没加：调用返回非零码，只在 ingress 日志留一条 `quick_ack.feishu: reactions.create code=…`
  的 WARNING，**答案完全不受影响** —— 只是少了那个即时反馈。

加完权限要去**版本管理与发布**里**重新发一个版本**才生效（飞书的权限是随版本下发的，
只在权限页点保存没用）。

**「针对历史消息提问」不需要再加权限。** 你对着一条历史消息（别人发的、NotiOps 发的、
你自己发的都算）点「回复」/「在话题中回复」再问 NotiOps 时，它会用上面已有的
`im:message` / `im:message:readonly` 把那条消息的正文取回来当背景。取不到的时候
（bot 不在那个会话里 / 消息已撤回 / 那条只有图片或文件没有文字）会**明确回你一句**
「没能读到你回复的那条历史消息…」，然后只按你这一句作答 —— 不会静默假装没有引用。

### 1.2 拿两把钥匙（**顺序很重要**）

长连接模式下 `Encrypt Key` 和 `Verification Token` 是**不用的** —— 所以如果你是从长连接
切过来的，Secret 里这两个键很可能是**空串**（`app_id` / `app_secret` 有值，这两个没有）。
webhook 模式下这两个就是**唯一的
鉴权手段** —— ingress 在冷启动时会硬校验，两者任一为空就直接崩
（[lambda_ingress.py](../platforms/feishu/lambda_ingress.py) 文件头「硬约束 A」）。
这是故意的：宁可 Lambda 起不来，也不要开一个谁都能伪造请求的公网入口。
**也就是说这一步不是"检查一下"，是必做的。**

自查（只看键名和空/非空，不打印值）：

```bash
aws secretsmanager get-secret-value --secret-id notiops/im-bot-feishu \
  --region <REGION> --query SecretString --output text \
| python3 -c 'import json,sys
d = json.load(sys.stdin)
for k in sorted(d):
    print("  %s: %s" % (k, "NON-EMPTY" if str(d[k]).strip() else "EMPTY"))'
```

1. 飞书开放平台 → 你的 App → **事件与回调 → 加密策略**
   - **Encrypt Key**：自己填一串随机字符串（建议 ≥32 位）。生成：
     ```bash
     openssl rand -hex 24
     ```
   - **Verification Token**：这一页直接给出，**复制下来**。

2. 把两个值存起来（**必须先做这一步，再去填请求地址**）。两条路，选一条：

   **推荐 · 管理控制台**（不需要 CLI、不需要凭证）：Web 界面 → **管理控制台 → 集成 IM**，
   填 `Encrypt Key` / `Verification Token`（和 `App ID` / `App Secret` 在同一张表单里），
   点保存。这一页还内置了飞书那一半的四步速览与「查看详细配置步骤」右侧抽屉，
   内容与本文一致 —— 只有浏览器的客户走这条。

   保存后页面只回显后 4 位（`****xxxx`）；**回传脱敏值 = 不修改**，所以以后只改推送群组时
   不用重填钥匙。**空值回显为空白输入框**（不是 `****`）—— 看到空白就是还没配。

   **备选 · CLI**（自动化 / 批量部署时用）：
   ```bash
   # 先读出现有 JSON 再改，别整体覆盖 —— app_id / app_secret 等键要原样保留
   aws secretsmanager get-secret-value --secret-id notiops/im-bot-feishu \
     --region <REGION> --query SecretString --output text > /tmp/fs.json

   # 编辑 /tmp/fs.json，补上这两个键：
   #   "encrypt_key": "<第1步生成的>",
   #   "verification_token": "<第1步复制的>"

   aws secretsmanager put-secret-value --secret-id notiops/im-bot-feishu \
     --region <REGION> --secret-string file:///tmp/fs.json
   rm -f /tmp/fs.json
   ```

> **为什么顺序不能反**：第 3 步保存请求地址时，飞书会立刻发一次
> URL challenge。Secret 里还没有 `encrypt_key` 的话 ingress 冷启动就 crash，
> 飞书那边显示「校验失败」，看起来像 URL 配错了。

### 1.3 事件配置：长连接 → 开发者服务器

**事件与回调 → 事件配置**：

| 项 | 改成 |
|---|---|
| 订阅方式 | 从「使用长连接接收事件」→ **「将事件发送至开发者服务器」** |
| 请求地址 | 第 0 步拿到的 `FeishuWebhookUrl` |
| 订阅的事件 | 确认 `im.message.receive_v1` 在列表里（原本就有，不用动） |

保存时飞书做 URL challenge，通过即绿。

### 1.4 回调配置：同一个 URL

**事件与回调 → 回调配置**：

| 项 | 改成 |
|---|---|
| 订阅方式 | → **「将回调发送至开发者服务器」** |
| 请求地址 | **同一个** `FeishuWebhookUrl` |
| 订阅的回调 | 确认 `card.action.trigger`（卡片按钮全靠它，漏了按钮点了没反应） |

> 卡片按钮这条路飞书有 **~3s 硬超时**。ingress 收到就异步投 worker、立刻回空响应，
> 真正的活在 worker 里干完再 PATCH 卡片 —— 所以点按钮后是「卡片稍后自己变」，
> 不是「转圈等结果」。

### 1.5 验证

在群里 `@机器人 你好` → 应当回复。然后：

```bash
aws logs tail /aws/lambda/notiops-im-ingress-feishu --region <REGION> --since 5m
aws logs tail /aws/lambda/notiops-im-worker-feishu  --region <REGION> --since 5m
```

> ⚠️ **上面这两个名字只对方式 B(`./setup.sh`)成立。方式 A(一键部署)必须先解析。**
> 本文件后面所有 `/aws/lambda/notiops-im-*` 都同理。
>
> 原因:方式 A 的函数名带栈名前缀(`<栈名>-im-ingress-feishu`,防止与 `setup.sh` 的部署
> 撞名),而**日志组名是 CloudFormation 生成的随机名**(`<栈名>-FeishuIngressLogs<hash>-<随机>`)
> —— 它连 `/aws/lambda/` 前缀都没有,拿栈名拼不出来。方式 A 刻意不写死日志组名:写死
> `/aws/lambda/<函数名>` 会撞上 Lambda 服务自建的同名组,`NAME_CONFLICT_VALIDATION`
> 让整栈在 9 秒内失败(理由见 `infra/lib/constructs/im-core.ts` 的 `explicitLogGroupNames`)。
>
> 从栈里查(逻辑 ID 前缀是稳定的,别去猜后面的 hash):
>
> ```bash
> STACK=<你开栈时填的栈名>   # 例如 notiops
> REGION=<REGION>
> lg() { aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
>   --query "StackResources[?starts_with(LogicalResourceId,'$1')].PhysicalResourceId" --output text; }
>
> aws logs tail "$(lg FeishuIngressLogs)" --region "$REGION" --since 5m
> aws logs tail "$(lg FeishuWorkerLogs)"  --region "$REGION" --since 5m
> # Slack 换成 SlackIngressLogs / SlackWorkerLogs;进度刷新是 ImProgressLogs
> ```
>
> 唯一的例外是部署 Lambda:它的日志组**是**写死的 `/aws/lambda/<栈名>-stager`。

- ingress 有日志、worker 没有 → 验签过了但投递失败（看 ingress 的报错）
- ingress 里有 `401 (signature/token)` → 两把钥匙和控制台不一致，回到 §1.2
- 两个都没日志 → 飞书没发出来，检查订阅方式是否真的切走了长连接

**飞书报「校验失败」/ 手动 `curl` 拿到 `HTTP 500 {"message":"Internal Server Error"}` 时，
先分清是哪一种** —— 两种成因症状一模一样，但处理完全不同：

```bash
aws logs tail /aws/lambda/notiops-im-ingress-feishu --region <REGION> --since 5m \
  | grep -E "INIT_REPORT|RuntimeError|Task timed out"
```

| 日志里看到 | 含义 | 怎么办 |
|---|---|---|
| `RuntimeError: feishu secret missing encrypt_key/verification_token` | **钥匙没填**，ingress 冷启动即崩 —— 这是**故意**的 fail-fast（§1.2 / §5.2 第 1 条） | 回到 §1.2 把两把钥匙写进 Secret，再重填请求地址 |
| `INIT_REPORT ... Status: timeout`，但同一份日志里 `REPORT` 那行是 `Memory Size: 2048 MB` 且**没有** `Task timed out` | **正常形态，不用管**（2026-09-02 起）。init 放不下 Lambda 的 10s INIT 硬上限，Lambda 会把它挪进首次 invoke 重跑并成功（`Duration` ~10.4s < `Timeout=20`）。冷请求确实超过飞书的 3s，但这本来就靠 §6 的保活解决 | 只确认 `MemorySize=2048` / `Timeout=20` 没被改小(见下一行)，然后去看保活规则在不在（§6.2） |
| 同上，但 `Memory Size` **小于 2048 MB**，或出现 `Task timed out after 10.00 seconds` | ingress 的**内存/超时被改小了** —— init 重跑也撞上函数超时，入口对外恒返 500 | 这才是回归 —— ingress 必须是 `MemorySize=2048` / `Timeout=20`（1024MB 也不够，`im-core.ts` 里那两行有注释记了三档实测数据） |
| 什么都没有（连 `INIT_START` 都没有） | 请求根本没到 Lambda | 地址填错，或 §0 的 URL 取自别的栈 |

### 1.6 回滚

⚠️ **2026-09-03（IM 重构 M2）起，回滚不再是"改一个开关"**：`BotStack`（ECS Fargate 长连接）
已经退役 —— `infra/bin/app.ts` 不再实例化它，新装机根本没有那批容器。webhook 是 IM 的**唯一**
运行路径。

真要回长连接，顺序是：

1. 在 `infra/bin/app.ts` 里把 `new BotStack(...)` 加回来（源码与三个 Dockerfile **故意保留**在
   仓库里，就是为了这一步）；
2. 装 `finch` 或 `docker`（`BotStack` 里那 5 处 `ContainerImage.fromAsset("../")` 需要）；
3. `cd infra && npx cdk deploy BotStack`（会建 VPC / ECS / ECR 并 build 镜像，~20 分钟）；
4. 最后才把 §1.3 / §1.4 的**订阅方式改回「长连接」**。

**M2 之前装机的账号**里 `BotStack` 可能还在（`desiredCount=1`，起着、按 Fargate 计费，但收不到
任何事件；Slack 那个还会因为 Socket Mode 已关而 crash-loop —— 属预期）。那种情况下回滚仍是分钟级：
改订阅方式即可。确认不回滚了就直接删掉整个栈省钱（它**没有任何 CFN Export**，不会被别的栈引用）：

```bash
aws cloudformation delete-stack --stack-name BotStack --region <REGION>
# 或者先只缩到 0，保留回滚余地：
aws ecs update-service --cluster <BotStack 的 cluster> \
  --service <FeishuBotService> --desired-count 0 --region <REGION>
```

---

## 2. Slack（新建 App）

### 2.1 创建 App + 权限

[api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch。

**OAuth & Permissions → Bot Token Scopes**：

| scope | 干什么 | 缺了的症状 |
|---|---|---|
| `app_mentions:read` | 收 `@bot` | 群里 @ 没反应 |
| `chat:write` | 发消息 / 更新卡片 | 一句都发不出 |
| `im:history` | 读 DM 正文 | DM 里 bot 收到空消息 |
| `im:write` | 在 DM 里发 | DM 无回复 |
| `channels:history` | 读公开频道会话（线程续聊） | 线程里追问没反应 |
| `groups:history` | 读私有频道会话 | 同上，私有频道 |
| `commands` | 斜杠命令 | `/devops` 报 dispatch_failed |
| `reactions:write` | 提问后先加 👀 表情（即时反馈） | **只少表情，答案不受影响**；日志里是 `quick_ack.slack: reactions.add error=missing_scope` |
| `mpim:history` | 读**群 DM**（多人私聊）会话 | 群 DM 里追问没反应；「针对历史消息提问」在群 DM 里读不到那条 |

装到 workspace，拿到 `xoxb-...`。

**「针对历史消息提问」用的就是上面这几条 `*:history`，不用额外加权限。** Slack 没有
「引用某条消息」这个事件字段 —— 在那条消息的 thread 里回复就是它的唯一形态，所以
NotiOps 取的是**该 thread 的父消息**（`conversations.replies`，只取第一条）。NotiOps
自己发的是 Block Kit 卡片，正文在 `blocks` 里而不是 `text`，这两种都能读。读不到时会
**明确回你一句**再按你那一句作答，不静默。

> ⚠️ **不要开 Socket Mode**。Socket Mode 与 webhook 互斥，开了 Slack 就不再往
> Request URL 发请求。也不需要 App-Level Token（`xapp-...`）—— 那是长连接时代的东西。

### 2.2 两个 Secret

```bash
# Bot Token（OAuth & Permissions 页，xoxb- 开头）
aws secretsmanager put-secret-value --secret-id notiops/slack-bot-token \
  --region <REGION> --secret-string 'xoxb-...'

# Signing Secret（Basic Information → App Credentials）
aws secretsmanager put-secret-value --secret-id notiops/slack-signing-secret \
  --region <REGION> --secret-string '<signing secret>'
```

两条**必读的前置**：

1. **`notiops/slack-signing-secret` 由 `NotiOpsBackendStack`（主栈）创建**，不是 `ImStack`。
   如果你是从 Socket Mode 升级上来的老部署，这个 Secret 原来不存在（Socket Mode 由
   App Token 鉴权，用不到它）—— 光部 `ImStack` 不够，得先把主栈部一次，
   否则 `put-secret-value` 直接 `ResourceNotFoundException`。

2. ⚠️ **这两个 Secret 不是空的，是 CDK 生成的随机串。** CDK 的
   `new secretsmanager.Secret(...)` 不给 `secretStringValue` 时会让 Secrets Manager
   **随机生成**一个值（不是空串）。后果：忘了填不会报「secret 为空」，而是表现成
   「密钥不对」——
   - bot token 没填 → Slack 返回 `invalid_auth`，bot 一句话都发不出；
   - signing secret 没填 → 每个请求验签失败 401，Slack 那边显示 URL 校验不通过。

   判断填过没有（不打印值）：`LastChangedDate` 明显晚于 `CreatedDate` 才算填过。
   ```bash
   aws secretsmanager describe-secret --secret-id notiops/slack-signing-secret \
     --region <REGION> --query '{Created:CreatedDate,LastChanged:LastChangedDate}'
   ```

### 2.3 三处 Request URL —— 全填同一个

`SlackWebhookUrl`，三处一字不差：

1. **Event Subscriptions** → Enable Events → Request URL
   保存时 Slack 立刻发 `url_verification`，ingress 会回 challenge（**先填好 §2.2 的
   signing secret**，否则验签过不了）。
   然后 **Subscribe to bot events** 加：
   `app_mention` · `message.im` · `message.channels` · `message.groups`
2. **Interactivity & Shortcuts** → 打开 → Request URL（按钮、弹窗提交都走这里）
3. **Slash Commands** → 逐条 Create New Command，Request URL 都是同一个
   （**这一步是可选的** —— 见 §2.4 末尾：所有命令都能不带斜杠用，注册只是为了拿 Slack
   原生的 `/` 自动补全）

### 2.4 斜杠命令清单

| Command | 说明 |
|---|---|
| `/devops` | 直接跟 DevOps Agent 对话（0 token） |
| `/agent` | 换对话用的 agent：`/agent devops`（默认，0 token）\| `/agent notiops`（走模型，**会消耗 token**）；不带参数是查看当前值 |
| `/web` | NotiOps Agent 的联网搜索开关：`/web on` \| `/web off`（默认关；DevOps 直连那条路上不生效） |
| `/account` | 换"问哪个账号"：`/account <12 位账号 id>` \| `/account list` 看可选清单 \| `/account default` 回到部署账号；不带参数是查看当前值 |
| `/investigate` | 发起深度调查 |
| `/case` · `/cases` | 案例：开 / 列表 / 查看 / 回复 |
| `/model` | 切换模型（`/model list` 看清单） |
| `/language` | 切中英文（`/language zh` \| `/language en`） |
| `/help` | 命令菜单 |

> 📌 **升级提示：`/skills` 已于 2026-09-06 从 IM 侧退役**（skill 能力完整保留在 Web
> 控制台）。如果你之前按旧文档注册过它，请到 Slack App 配置的 **Slash Commands** 里
> **手工删掉**这一条 —— 注册表在你自己的 App 里，我们改不了。不删也不会出错：打了
> `/skills` 会 0 token 回一张命令菜单，只是它还会出现在自动补全里。

> ⚠️ Slack 的 command 名只接受小写字母/数字/连字符/下划线，**中文命令注册不上**
> （飞书那边 `/调查`、`/开案例`、`/智能体`、`/联网` 是可以的）。Slack 上的中文入口靠另外两条，都能用：
> **中文自然语言**（「帮我调查一下 xxx」「我要开案例」）和 **`@bot 调查 xxx`**。
> 语言切换本身也支持中文说法（「切换成中文」）。

> 💡 **注册斜杠命令是可选的 —— 上面每一条都能不带斜杠用。** 解析器里斜杠本身是可选的
> （[`core/nl_router.py`](../core/nl_router.py) 的 `_cmd()`：`^\s*/?\s*(?:...)`），所以
> `@bot agent notiops`、`@bot web on`、`@bot 智能体 notiops`、`@bot 联网 on` 与
> `/agent notiops`、`/web on` **完全等价**（DM 里连 `@bot` 都不用）。注册买到的只是 Slack
> 原生的 `/` 自动补全与参数提示。
>
> 为什么不能替你注册：斜杠命令的注册表在**你自己的 Slack App 配置里**，改它要一把
> workspace configuration token（写权限、12 小时过期、只能人工在 Slack 后台生成）——
> NotiOps 不持有、也不打算持有你 IM 的写凭证。飞书没有这层注册表（`/智能体` 就是一条
> 普通消息文本），所以飞书侧一步都不用做。
>
> **没注册时的症状**：Slack 客户端**当场就拦下了**（Slackbot 回一句「不是有效命令」），
> 请求根本不会到 API Gateway —— 所以 ingress / worker 日志里查不到任何东西，别去翻日志。
> 这与 `dispatch_failed` 是两回事：后者是命令**已注册**、但 3 秒内没应答（见 §2.5）。

### 2.5 验证

在频道里 `/invite @你的bot`，然后 `@bot hi`；再试 `/help`。

```bash
aws logs tail /aws/lambda/notiops-im-ingress-slack --region <REGION> --since 5m
aws logs tail /aws/lambda/notiops-im-worker-slack  --region <REGION> --since 5m
```

Slack 特有的两个坑：

- **`dispatch_failed` / 3s 超时**：ingress 冷启动太慢。第二次就好；一直报就是 Secret 没填对，
  看 ingress 日志有没有 401。
- **点按钮说「弹窗打开失败，请再试一次」**：Slack 的 `trigger_id` 只有 ~3 秒有效期，
  worker 是异步启动的，冷启动时会赶不上。worker 会自动回一条带「再试一次」按钮的消息，
  点一下就立刻开 —— 这是**设计行为**，不是故障
  （[lambda_worker.py](../platforms/slack/lambda_worker.py) 文件头第 2 条）。

---

## 3. 钉钉 DingTalk（新建企业内部应用）

> 与飞书那节不同，钉钉这边是**新建一个应用**（没有"原地切换"的路 —— 老部署里钉钉跑的是
> 已退役的 Fargate 长连接形态，现在这条是 Lambda webhook）。
>
> **本页每一步都能只在浏览器里做完**：管理台 →「集成 IM」→ 切到**钉钉**分页 → 右上角
> 「查看详细配置步骤」，抽屉里是同一份步骤，还直接给出本部署的消息接收地址 + 复制按钮。
> 内容与本节一一对应（源文件 [`content/dingtalkGuide.ts`](../frontend/chat-app/src/content/dingtalkGuide.ts)）。
> 下面额外给出 CLI 的做法，供脚本部署和自动化用。

### 3.1 创建应用 + 开机器人能力（**不用**逐条勾权限）

[open-dev.dingtalk.com](https://open-dev.dingtalk.com) → 应用开发 → 企业内部应用 →
创建应用。填名称和简介即可，**不需要**填服务器出口 IP。

进应用后：左侧「机器人」→ 开启机器人能力，填机器人名称与图标 → 保存。
最后到「版本管理与发布」**发布一个版本** —— 不发布的话机器人加不进群。

钉钉这边**不需要**像飞书那样逐条勾权限：机器人收发消息走的是机器人能力自带的通道，
与飞书那批 `im:` / `cardkit:` scope 不是一回事，也没有 Slack 那张 Bot Token Scopes 表。

### 3.2 两个凭证（**顺序很重要**）

左侧「凭证与基础信息」→ 复制 **AppKey** 与 **AppSecret**（AppSecret 点一下才显示）。

⚠️ **钉钉只有这一个 Secret。** AppSecret 同时做两件事：换 access token、以及校验入站
请求头里的 `sign`。所以这里**没有**飞书那样的 `Encrypt Key` / `Verification Token`
—— 界面上少两个输入框是**故意**的，不是漏了。

与飞书同一条口径：**ingress 冷启动时会硬校验这两个值，缺任一就直接起不来**
（宁可入口起不来，也不要开一个谁都能伪造请求的公网地址）。所以顺序是：
**先把凭证存进去，再去 §3.4 填地址。**

### 3.3 把凭证存进 Secret

**方式一（推荐，只有浏览器就够）**：管理台 →「集成 IM」→ 钉钉分页 → 填 AppKey /
AppSecret → 「保存」。Secret 不存在时后端会替你建。保存后页面只回显 AppSecret 的
**后 4 位**（`****xxxx`）；**回传脱敏值 = 不修改**，所以以后只想改推送地址时不用重填
AppSecret。这个值在日志里**连长度都不打**。

**方式二（CLI）**：

```bash
aws secretsmanager put-secret-value --secret-id notiops/im-bot-dingtalk \
  --region <REGION> \
  --secret-string '{"app_key":"ding...","app_secret":"...","webhook_url":""}'
```

- Secret 名两条部署路径**完全一致**：`notiops/im-bot-dingtalk`。
- `webhook_url` 这个键放的是 §3.7 的**自定义机器人推送地址**（可选，留空即可）。
  ⚠️ 它跟「消息接收地址」是**方向相反**的两个东西，同名很容易搞混：
  前者是我们**往钉钉发**（是凭证），后者是钉钉**往我们发**（是公开入口地址）。
- 只想改一个字段时先 `get-secret-value` 拿全量再整份写回 ——
  `put-secret-value` 是**整体替换**，不是合并。管理台的保存按钮替你做了合并。

### 3.4 开 HTTP 模式并填消息接收地址

地址就是 §0 拿到的那个（Output 名 `DingtalkWebhookUrl`），**结尾的 `/` 要保留**。
回到应用的「机器人」页：

| 填哪里 | 填什么 |
|---|---|
| 消息接收模式 | 选「**HTTP 模式**」（默认是 Stream 模式，**必须改**） |
| 消息接收地址 | §0 的 `DingtalkWebhookUrl` |
| 发布 | 改完保存，再到「版本管理与发布」**发布一次** |

钉钉只有这**一个**地址要填：机器人没有独立的「按钮回调」通道，消息事件和卡片回传走
同一条 URL（飞书要填「事件」+「回调」两处，Slack 要填三处）。

> ⚠️ **钉钉保存这个地址时不做任何校验。** 没有飞书那种 URL challenge —— 不会当场变绿，
> 也不会报错。所以**填错一个字符、或者凭证还没保存，表现完全一样：机器人一句话不回**。
> 这是钉钉这条路上最贵的一个坑：症状不指向原因，客户往往会去反复检查凭证。
> 唯一可靠的排错入口是 §3.5 的两条日志命令 —— 入口有没有收到请求，
> 一眼就把「钉钉没发出来」和「我们没认出来」分开了。

### 3.5 加进群并验证

群设置 → 智能群助手 → 添加机器人 → 选刚发布的那个应用机器人。
然后在群里发 `@机器人 你好`，应当收到回复。

```bash
aws logs tail /aws/lambda/notiops-im-ingress-dingtalk --region <REGION> --since 5m
aws logs tail /aws/lambda/notiops-im-worker-dingtalk  --region <REGION> --since 5m
```

| 日志里看到 | 含义 | 怎么办 |
|---|---|---|
| 两个都没日志 | 钉钉根本没发出来 | 回 §3.4：消息接收模式真的切成 HTTP 了吗、地址一字不差吗、版本发布了吗 |
| ingress 里有 `401` | `sign` 校验没过 | AppSecret 与钉钉控制台不一致，回 §3.2 / §3.3 |
| ingress 里有 `timestamp skew` 类报错 | 时间窗对不上（钉钉的验签带 1 小时窗口） | 机器上的时间与钉钉相差超过 1 小时；这条基本只出现在自建 NTP 异常的环境 |
| ingress 有日志、worker 没有 | 验签过了但投递失败 | 看 ingress 那条 ERROR 本身 |
| `RuntimeError: dingtalk app_secret unavailable (...)` | **凭证没填**，ingress 冷启动即崩 —— 与飞书同一条**故意**的 fail-fast（§5.2 第 1 条） | 回 §3.3 存好凭证，再重填地址 |

冷启动那一档的形态（`INIT_REPORT ... Status: timeout` 但 `REPORT` 那行内存正常）与
飞书**逐字相同**，判法直接看 §1.5 那张表；三个 ingress 的内存/超时是同一组数
（`MemorySize=2048` / `Timeout=20`），保活也是同一条规则（§6）。

### 3.6 与飞书 / Slack 的差异（**平台能力差异，不是没做完**）

钉钉机器人的平台原语比飞书少几样，所以同一个功能在钉钉里长得不一样。这些差异我们**写
出来**而不是靠"没提到"暗示：

| 差异 | 钉钉侧的形态 |
|---|---|
| **卡片按钮只能是链接** | 钉钉的 ActionCard 按钮全部是 URL 跳转，没有「点一下回传给服务器」这种交互。所以需要确认的操作（开案例、启动调查）在钉钉里**用回复关键词完成**。 |
| **已发出的消息改不了** | 钉钉没有更新消息的接口，所以没有飞书那种「卡片自己变」的进度条；长任务改成**追加一两条**进度消息。 |
| **机器人不能给消息贴表情** | 收到指令时没有 👀 / 👍 那种即时反馈，取而代之的是一条**文字回执**。 |
| **群里主动推送要另配一个地址** | 机器人自己那条回复通道是钉钉在回调里给的**一次性会话地址**（`sessionWebhook`，收到消息后约 **90 分钟**内有效），做不了「定时主动发」。要主动推送见 §3.7。 |

命令入口与另外两个平台**一致**：`/devops`、`/agent`、`/web`、`/account`、`/investigate`、
`/case`、`/model`、`/language`、`/help` 都能用，中文说法（`/调查`、`/开案例`、`/智能体`、
`/联网`）和不带斜杠的形式（`@机器人 agent notiops`）也都能用 —— 钉钉没有 Slack 那层
斜杠命令注册表，所以**一步都不用注册**。

#### 那么在钉钉怎么开案例？（**没有弹窗表单，但有一张可复制的模版**）

飞书 / Slack 里 `/case` 会弹一个表单让你填主题、严重等级、语言。钉钉弹不出来 ——
按上面那条「按钮只能是链接」，钉钉没有「点按钮回传给服务器」这条路，也就没有弹窗表单。
所以钉钉把那张表单换成一张**纯文本模版**：你发一句「开案例」，机器人回这个 ——

```
📋 开案例模版
🏷️ 账号: 111122223333(部署账号)
复制整段,改完发回来。只有「问题描述」必填,其余根据实际情况进行修改即可。

问题描述:
严重等级: 2  (1 低 · Low / 2 中 · Normal / 3 高 · High / 4 紧急 · Urgent / 5 严重 · Critical)
语言: 1  (1 中文 / 2 English / 3 日本語 / 4 한국어)
案例类型: 1  (1 技术问题 / 2 账单和账户 / 3 提高服务限制)
涉及服务: 0  (0 自动判断 / 1 ec2 / 2 rds / …; 清单外直接写名字,如 bedrock / msk / glue)
标题: 自动  (留「自动」= 按你的描述生成)

问题描述可以换行多写几段,都会进案例正文。
发回来后我先给你一张确认卡,回「确认」才真的开工单。
```

**只有「问题描述」必填**，其余五项都已经预填好默认值：

| 那一行 | 留着不改会怎样 | 想改的话 |
| --- | --- | --- |
| 问题描述 | **必填** —— 空着就把模版再发你一遍 | 一句话或者好几段都行，换行接着写就是（都会进案例正文） |
| 严重等级 | 中 · Normal | 填**序号**（`4`）、**英文 code**（`urgent`）或**标签原文**（`紧急`）都认。选项跟着你的 Support 计划走：Basic / Developer 不会印出用不了的档 |
| 语言 | 跟着当前会话语言（中文群默认「中文」） | 同上三种写法 |
| 案例类型 | 技术问题 | 同上 |
| 涉及服务 | `0` = **自动判断**（按你的描述挑服务和类别） | 填序号，或者直接写服务名（`bedrock`、`msk`）—— 清单里没有的照样认 |
| 标题 | 「自动」= 从问题描述里取 | 直接写你自己的标题（括号照原样保留） |

- 认不出的值会**明确告诉你**「这一项用了默认值」，不会静默套默认；
- 要开在别的账号，先发 `/account <12 位账号>`（见 §4.2），模版和确认卡都会回显当前账号；
- 发回来后机器人回一张**确认卡**（主题 / 严重等级 / 语言 / 问题描述），你回一句 **确认**
  才真的开，回 **取消** 就作废，30 分钟内有效；
- 整个模版流程**不消耗任何模型 token**（渲染是拼字符串、回填是关键词匹配）。自己填了
  「涉及服务」+「案例类型」时，连那一次服务分类也省掉了。

> 💡 **知道自己要报什么就不用走模版** —— 一句话照样开：
>
> ```
> 开案例 RDS 连接数暴涨，应用大面积超时 severity=high language=en
> ```
>
> 问题描述直接写在同一句里（它同时是案例主题和问题正文），可选参数跟在后面：
> `severity=low|normal|high|urgent|critical`、`language=zh|en`、
> `type=technical|account`、`service=...`、`category=...`。同样先回确认卡。
> 只说「开案例」三个字时回的才是模版 —— 机器人**绝不会**拿「开案例」当案例主题去开单。

> 💡 **`/案例 <描述>` 也能开案例** —— `/案例 RDS 连接数暴涨` 与 `开案例 RDS 连接数暴涨`
> 等价，同样先回确认卡。判断规则：`案例` 后面跟**案例号**就是看详情，跟**一段描述**就是
> 开案例，什么都不跟（或只跟 `列表` / `我的` / `最近` / `全部` 这类过滤词）才是列最近的。
> 最明确的写法仍然是 `开案例`（或 `/开案例`、`create-case`、`提工单`）。

其余案例动作也都是一句话，注意都是**动词+名词连成一个词**：`/案例` 列最近的、
`/案例 <案例号>` 或 `/查看案例 <案例号>` 看详情、`/分析案例 <案例号>`、
`/回复案例 <案例号> <内容>`、`/关闭案例 <案例号>`（关闭同样要回 **确认**）。
英文同义词也都在：`/case`、`/view-case`、`/analyze-case`、`/reply-case`、`/close-case`。

### 3.7 主动推送（可选：自定义机器人）

巡检广播、告警、定时报告这类**没人先说话**的推送，钉钉必须走「自定义机器人」：
群设置 → 智能群助手 → 添加机器人 → **自定义** → 复制它的 Webhook 地址 →
填进管理台钉钉分页的「自定义机器人推送地址」（或 §3.3 那个 JSON 的 `webhook_url` 键）。

> ⚠️ **那串地址本身就是凭证** —— 谁拿到都能往这个群发消息，而报告投递会把长报告
> **全文** POST 过去。所以：管理台只回显后 4 位、只接受
> `https://oapi.dingtalk.com/robot/send` 这一个形态、日志里不会出现它，
> 报错也不会把你填的 URL 回显出来。**别贴到工单或截图里。**

**群里 @机器人 的问答不需要这一项** —— 那条路用的是回调里带的一次性会话地址，
零额外配置。留空即可。

填好后点管理台的「**测试凭证**」：它先用 AppKey / AppSecret 换一次 access token
（凭证是否正确的**权威判据**），填了推送地址的话再往那个群真发一条。

> 钉钉**没有**「往任意群发一条测试消息」的接口。所以没填推送地址时，这个按钮
> **只验凭证、什么都不发**，界面上也会**如实这么说**（不假装"已发送到你的群里"）。
> 那种情况下要端到端验证，回 §3.5 在群里 @ 一句。

---

## 4. 群允许清单（allowlist，可选，三个平台都支持）

只允许特定群/频道用 bot：

```bash
cd infra && npx cdk deploy ImStack --output ../.cdk-out --region <REGION> \
  -c imAllowedChatIds="oc_xxx,C0123ABC"
```

飞书填 `oc_` 开头的 chat id，Slack 填 `C`/`D` 开头的 channel id，
钉钉填 `conversationId`（群里 @ 一句后从 worker 日志里拿），逗号分隔。
留空 = 不限制（与长连接时代行为一致）。

> 📌 **钉钉这一层落在 worker、不在 ingress**（飞书 / Slack 是两处都拦）。因为钉钉的
> `conversationId` 在**验签之后**才解得出来 —— ingress 拦不了一个自己还没看见的字段。
> 对客户的可见行为一样：不在清单里的群，bot 完全不回话。代价是被挡的请求会多花一次
> worker 的冷启动，量级上可以忽略。变量名也因此不同（钉钉 `ALLOWED_CONVERSATION_IDS`，
> 飞书 `ALLOWED_CHAT_IDS`，Slack `ALLOWED_CHANNEL_IDS`）—— `-c imAllowedChatIds` 这个
> **部署参数三个平台共用一个**，不用分开填。

### 4.1 同一个群里装两个 bot（测试环境 + 生产环境）

**可以**，而且它们不会互相抢答：@ 谁谁回，另一个完全静默 —— 连「思考中」的表情都不打。

判据是 bot 自己的 `open_id`：飞书**没有** Slack 那种独立的 `app_mention` 事件，
bot 在群里是成员时，群里的每一句话都会作为 `im.message.receive_v1` 投过来，
事件里只有一个 `mentions` 数组装着这条消息 @ 到的**所有**人/bot。所以「@ 的是谁」
由 bot 自己比对：启动后查一次 `GET /bot/v3/info` 拿到自己的 `open_id`，
只有 `mentions` 里出现这个 id 才响应。

因此：

- **不带 @ 的群内闲聊两个 bot 都不响应** —— 群消息必须 @ 才触发（私聊不需要）。
- **`@产品 @NotiOps 看下这个` 这种混合 @ 会触发** —— 只要被 @ 的人里有它。
- **万一 bot 查不到自己的 `open_id`**（凭证过期、网络抖动），它在群里**装死**而不是
  见到 @ 就抢答 —— 宁可让你立刻发现「它不理我了」，也不要在装了两个 bot 的群里
  多答一次而你分不清是谁答的。这时候**私聊仍然可用**，去看 ingress 日志里的
  `bot identity: GET /bot/v3/info` 那行 ERROR（抖动会在一分钟内自愈）。

> Slack 侧不需要这一层：它有独立的 `app_mention` 事件，平台已经替我们分好了。

### 4.2 多账号：`/account` 换「问哪个账号」

启用了多账号（方式 A 的 `DeployMode=MultiAccount`，或方式 B 的
`./setup.sh --multi-account`）之后，IM 里可以用 `/account` 决定这一轮问的是哪个账号：

| 打什么 | 结果 |
|---|---|
| `/account` | 看当前问的是哪个账号 |
| `/account list` | 列出可选的账号（部署账号 + 已在 Web 上启用的成员账号） |
| `/account 444455556666` | 切过去；**群里设一次对整群生效**，私聊里只对你自己生效 |
| `/account default` | 回到部署账号 |

三件事需要先说清楚，否则很容易误会：

1. **账号上车（新增 / 启用 / 停用）只在 Web 控制台做，IM 只读那份清单。**
   IM 侧**没有**、也不会有上车入口 —— `/account` 只能在「Web 上已经启用」的账号之间选。
   在 Web 上启用一个新账号后，IM **下一条消息**就能选到它（不用重新部署、不用重启）；
   在 Web 上停用之后，IM 那边原本指着它的选择会**自动回落到部署账号**并明确告诉你为什么。
2. **两侧各自选账号，互不影响。** Web 上切到成员账号，不会把 IM 群也切过去；
   反过来也一样。共享的只有「哪些账号可选」这份清单。
3. **开案例也跟着 `/account` 走（2026-09-07 起）。** 看工单 / 开工单 / 回复 / 关闭 /
   分析，都落在当前选定的那个账号里。三个前提，缺一个都会被**明确告知**而不是静默落错：
   - 那个成员账号 onboarding 时允许了 NotiOps 代开工单（模板参数
     `EnableSupportCaseWrite`，**默认开**）。关掉时 NotiOps 会说缺哪条 action
     （`support:CreateCase` / `AddCommunicationToCase` / `ResolveCase`），
     让你自己决定是补权限还是去控制台开。
   - 那个账号自己有 Business / Enterprise On-Ramp / Enterprise 支持计划
     （AWS Support API 在 Basic / Developer 上不可用）。**注意这是按账号算的**：
     部署账号有计划不代表成员账号有。
   - 该账号在 Web 上仍处于「已启用」。停用之后跨账号凭证就拿不到了。

   卡片上会**写明这张工单开在哪个账号下**（工单号在不同账号之间可以撞号，而 AWS
   控制台链接不带账号参数 —— 不写清楚的话你点进去看到的是自己当前登录账号的工单）。

   一个例外值得单独记住：**从调查报告卡上的 🆘 升级开工单、以及「📎 同步到 case」，
   跟的是「这次调查查的那个账号」，不是「点按钮那一刻会话里选的账号」。** 报告卡可能
   几小时后才被点，那时 `/account` 早切走了 —— 跟着会话走才是错的。

> ⚠️ **如实说清残留风险**：群里**任何**能 @ 到 bot 的成员都可以把这个群切到
> **任何一个已启用**的账号 —— IM 侧没有按人的权限控制（IM 平台的身份不等于 AWS 身份，
> 我们不拿它当授权依据）。控制手段是两条：**在 Web 上只启用真的该被问到的账号**，
> 以及**用上面 §4 的群允许清单把 bot 限制在该看这些账号的群里**。
> 越权的最后一道线在 agent 侧（只允许问「部署账号 + 已启用账号」这个集合，
> 拿不到清单时是**拒绝**而不是放开）和目标账号自己那个只读角色的信任策略上。

---

## 5. 公网入口的安全边界

### 5.1 入口结构：API Gateway HTTP API → ingress Lambda

```
飞书 / Slack ──HTTPS POST──▶ API Gateway HTTP API（$default catch-all，无鉴权）
                                     │  principal = apigateway.amazonaws.com
                                     ▼
                             ingress Lambda（验签 + 解密 → 异步投 worker）
```

**入口本身是未鉴权的，而且必须是** —— 飞书 / Slack 只会发普通的 HTTPS 请求，不会给你签
SigV4。真正的门在**请求体层面**：飞书用 Encrypt Key 验签 + 解密、Verification Token 校验，
Slack 用 signing secret 做 HMAC。这一点从头到尾没有变过。

**为什么前面要加这层 API Gateway**（2026-09-01 换的）：原来直连 Lambda Function URL，
要接收裸 HTTP POST 就只能 `AuthType=NONE`，而那等价于在函数的资源策略里写
`Principal: "*"` + `lambda:InvokeFunctionUrl`。这个**策略形状**会被各家云安全基线／
自动化检测判定为「函数对全网公开」，有的还会**自动把那条许可摘掉** —— 后果是入口对
所有人返回 403（飞书也在内），IM 整条路径静默断掉，而每次重新部署又会把它加回去、
再被摘一次。检测看的是策略形状，看不到我们在请求体层面验了签，所以没有豁免的余地。

换成 HTTP API 之后，Lambda 的资源策略里 principal 是 `apigateway.amazonaws.com` +
具体的 API ARN（不再有 `*`），Function URL 整个不建 —— 那个形状消失了。
**这一步换的是"公网可达"的表达方式，不是鉴权强度**：入口该未鉴权还是未鉴权。

顺带说明两个被否掉的方案，免得再走一遍：

- **CloudFront + OAC + Function URL**：OAC 要求 Function URL 是 `AuthType=AWS_IAM`，
  而 AWS 文档明确写了，对 Function URL 用 POST/PUT 时**调用方**必须自己算请求体的
  SHA256 并带上 `x-amz-content-sha256`（"Lambda doesn't support unsigned payloads"）。
  飞书 / Slack 是通用 webhook 发送方，永远不会带这个头 —— 这条路对入站 webhook 走不通。
- **REST API 而不是 HTTP API**：REST API 能挂 WAF，但贵 3.5 倍、创建要分钟级
  （一键部署在意这个）。当前选 HTTP API，代价就是**挂不了 WAF**（只有 REST API 能），
  补偿是下面第 2 条的两层限流。要 WAF 的客户可以自己在前面套 CloudFront + WAF
  （对 HTTP API 而言是普通的自定义源，没有 Function URL 那个签名限制）。

### 5.2 五道措施

1. **验签 fail-fast** —— 飞书两把钥匙缺一即冷启动失败；Slack 验签用 stdlib HMAC +
   `compare_digest`，并拒绝时间戳偏移 > 300s 的请求（防重放）。
2. **两层限流** —— HTTP API 阶段级 50 req/s、突发 100（超出的请求由 API Gateway 直接
   429，**不进 Lambda**、不产生 Lambda 费用）；ingress 上再叠
   `reservedConcurrentExecutions=10` 兜并发。真实 IM 事件量比这低几个数量级。
3. **群允许清单**（§4）。
4. **幂等去重** —— worker 侧按 `event_id` 落 DDB，重复投递只处理一次
   （Slack 的 Events API 重试会复用同一个 `event_id`）。
5. **后端仍然只读** —— 即使有人伪造出一条能通过验签的消息（意味着钥匙已泄漏），
   拿到的也只是只读 agent 的查询结果，没有任何写权限。

日志侧：`encrypt_key` / `verification_token` / `app_secret` / signing secret
**连长度都不打**，只记异常类型名（[LOGGING_STANDARD.md](LOGGING_STANDARD.md)）。

### 5.3 还剩下的风险（如实列出）

1. **任何人都能触发一次调用** —— 入口未鉴权，验签失败也已经花掉了一次 Lambda 执行。
   上限由第 2 条的两层限流封住（可算出最坏成本），但**不为零**。
2. **验签前的攻击面是 IM 平台的 SDK** —— 飞书那条路上，验签和 AES 解密发生在
   `lark-oapi` 内部；我们自己在验签前跑的代码只有一个事件格式解析函数。
   SDK 出漏洞时这段是暴露的。缓解：SDK 版本钉死、随发布升级。
3. **没有来源 IP 限制** —— 飞书 / Slack 都公布了出口 IP 段，理论上可以只放行它们。
   现在没做：那两个段会变，写死就变成"某天早上 bot 突然不回话"，且没有任何日志能
   直接指向原因。需要这一层的客户可以自己在 HTTP API 前面套 CloudFront + WAF，
   用 IP 集规则实现（改动不影响本文的配置步骤）。

## 6. 冷启动与保活（4 分钟一次 ping）

### 6.1 问题：3 秒的硬超时，撞上十几秒的冷启动

两个数放在一起，结论就已经定了：

| | 实测值 |
|---|---|
| ingress 冷启动（**2026-09-02 本次部署后**） | **~20s**：INIT 撞上限被判 `Init Duration: 9999.98 ms / Status: timeout`，Lambda 把 init 挪进首次 invoke 重跑，那一次 `Duration: 10419.69 ms`（**成功**，因为 `Timeout=20`） |
| 同一个函数**热**的时候 | **~3.6ms**（`Duration: 3.62 ms`，同一个执行环境、无 INIT 行） |
| 飞书 / Slack 对 webhook 的超时 | **~3s 硬上限**（平台侧，改不了） |

也就是说 —— **容器只要冻结过，用户的下一次操作必然超时**。冷启动压不下去的原因是
`import lark_oapi` / `slack_sdk` 那一坨（加 boto3、加一次 `GetSecretValue`），
`im-core.ts` 里 ingress 那段长注释记了三档内存的实测数据；这也是为什么 ingress 必须是
`MemorySize=2048` / `Timeout=20`（§1.5 的表里那一行）。

> ⚠️ **2026-09-02 起这个数变了，而且方向不好**：上一次实测是 init **8.65s 跑完**（`Phase: init
> Status: error`，2048MB 下还剩 ~1.35s 余量）。本次部署后余量被吃光，init 直接撞上 Lambda 的
> **10s INIT 硬上限**。功能上没退化（webhook 的冷请求本来就超 3s，重跑那一次仍在 `Timeout=20`
> 之内、返回正常），但两件事要记住：① **`Timeout=20` 现在是硬需求**，不是余量 ——
> 调到 10s 以下会让冷启动那一次**直接失败**，而不只是慢；② **`INIT_REPORT ... Status: timeout`
> 不再是"内存被改小"的信号**（判法见 §1.5 那张表）。想把它压回去只能减少 init 本身的活，
> 加内存没用（2048 已经过了 1769MB 的单 vCPU 拐点，Python import 是单线程串行的）。

受影响的三个动作，都恰好在 3 秒那条线上：

- 飞书「事件与回调 → 事件配置」**保存请求地址**时的 URL challenge；
- 飞书 `card.action.trigger` —— 用户**点卡片按钮**；
- Slack Events API / Interactivity。

现网实测到的形态：第一次点「保存」，飞书报**「请求 3 秒超时」**；立刻再点一次就成功。
配置阶段还有"再点一次"这个自然补救动作，**卡片按钮没有** —— 用户看到的就是「操作失败」，
而且下次再点（此时容器热了）又是好的，于是它长得像"偶发抽风"，最难查。

### 6.2 做法：EventBridge 每 4 分钟敲一下 ingress

每个 ingress 函数各挂一条 `rate(4 minutes)` 的 EventBridge 规则，常量 input 是哨兵
`{"notiops_warmup": true}`，handler 第一行认出来就早返回（`platforms/common/warmup.py`）。
4 分钟是"比 Lambda 回收空闲执行环境更勤"的经验值 —— 回收没有 SLA，实测普遍 > 5 分钟。

**成本**：10,800 次/月 × ~2ms @2048MB ≈ **$0.003/月**（含 EventBridge 与 Lambda 请求费）。

**两条部署路径都有这个规则**，差别只在规则的物理名：

| | 规则名 | 为什么 |
|---|---|---|
| 方式 B（`setup.sh`） | `notiops-im-keepalive-ingress-feishu` / `-ingress-slack` | 名字固定，好在控制台里找 |
| 方式 A（一键 CFN） | 由 CloudFormation 自动生成 | 两条路径可能装在**同一个账号**里，写死名字会 already-exists |

想确认它在跑：

```bash
# 规则存在且 ENABLED（方式 A 用 --name-prefix <StackName> 找）
aws events list-rules --name-prefix notiops-im-keepalive --region <REGION> \
  --query 'Rules[].{Name:Name,State:State,Schedule:ScheduleExpression}'

# ingress 日志里每 4 分钟一条 warmup（正常形态：只有 REPORT，没有业务日志）
aws logs tail /aws/lambda/notiops-im-ingress-feishu --region <REGION> --since 10m
```

### 6.3 诚实的边界

保活只保住 **1 个**执行环境。真并发（多个群同时来事件、或调查进度卡片批量刷新）仍然会
扩容出冷容器，那些请求照旧可能超时。这条规则解决的是**绝大多数**场景（单人操作、低频
事件），**不是数学上的消除**。

要彻底消除只有 **provisioned concurrency**：2048MB 常驻 ≈ **$21/月**。没有把它设成默认值，
是因为这是个开源项目 —— 让每个装它的人默认多付 $21/月去换一个大多数人感觉不到的边角
场景，不合适。**在意这个场景的客户可以自己开**（不影响本文任何配置步骤）：

```bash
aws lambda put-provisioned-concurrency-config \
  --function-name notiops-im-ingress-feishu --qualifier <版本或别名> \
  --provisioned-concurrent-executions 1 --region <REGION>
```

> ⚠️ provisioned concurrency 只能挂在**版本或别名**上，不能挂 `$LATEST`；每次部署要重新
> 发版并搬一次配置。这也是它不适合当默认值的另一半原因。

---

## 7. 机器人会怎么回你

配置完之后，这一节是给使用者看的：**哪种问题会等多久、等的时候屏幕上有什么**。
写清楚是因为最常见的"故障"其实不是故障 —— 是一段没有任何反馈的等待。

### 7.1 提问 → 立刻一张「思考中」卡片

发完问题**马上**就会收到一张卡：

```
🤔 思考中 · 已用时 3 秒
已收到，正在让 DevOps Agent 分析。复杂问题可能要跑几分钟，
过程和结论都会更新到这张卡片上，不用重复发问。
```

然后**这张卡自己会变**：标题里的秒数在走、中间多出一段「**过程**」（机器人正在查什么、
调了哪个 API），跑完之后整张卡变成最终答案，底部挂两颗按钮（**升级成深度调查** /
**直接开案例**）。

**全程只有这一张卡片**，不会刷出一串新消息。所以：

- **不用重复发问**。再发一遍只会开一轮新的，两轮抢着答。
- 秒数在走 = 还活着。真正的"卡住"是秒数停了。

> **为什么要专门讲这个**：问题的耗时差别很大。「列一下我有几个 S3 桶」几秒就回；
> 「列出所有 S3 桶的名称**和其大小**」现网实测跑了 **347 秒** —— 桶多的时候它要逐个桶
> 去问指标。以前这 347 秒里屏幕上一个字都没有，看起来跟后台挂了一模一样。

### 7.2 刷新的节奏是**故意**越来越慢的

| 已用时 | 卡片刷新间隔 |
|---|---|
| 0–30 秒 | 2 秒 |
| 30–120 秒 | 5 秒 |
| 120 秒以后 | 10 秒 |

前 30 秒你大概正盯着屏幕，所以刷得勤；跑到几分钟的问题，你早就切去干别的了，
这时候还每 2 秒刷一次只会撞飞书 / Slack 的接口限流（Slack 建议每个频道 ~1 次/秒），
把整张卡刷成"卡住"。

**卡片被撤回**（或因为别的原因连续 3 次刷不动）时，机器人会停止刷这张卡，
但**答案不会丢** —— 它会重新发一条；连发都发不出去才退成纯文本。

### 7.3 深度调查：进度卡 + 跑完那张报告卡

`@机器人 深度调查 <问题>`（或 `/调查`）走的是另一条路：交给 DevOps Agent 后台跑，
**不占用你的会话**。你会看到两张卡：

1. **进度卡** —— 每分钟刷一次（「已受理 → 正在调查 → 已完成」）；
2. **最终报告卡** —— 跑完之后回到**同一个会话**：顶部是你当初问的那句话，
   正文是报告开头一段，底下三颗按钮（📊 查看完整报告 / 🔍 调查过程 Trace /
   🆘 升级到 AWS Support）。控制台深链「🔬 查看本次调查」只在**进度卡**上 ——
   报告卡上其余链接都是预签名的、7 天内免登录，混进一个必须登录控制台的入口，
   底下那行说明就只能同时写「无需登录」和「需要登录」。

> 🔴 **v1.0.22 起这里只有一张报告卡。** 之前是两张（「📝 Report Summary」+
> 「✅ NotiOps 报告」），前一张的正文走一次大模型摘要 —— 默认模型换成推理模型之后
> 它的 thinking token 吃光了 1024 的输出预算，于是正文经常只剩一句「报告因 token
> 限制被截断」，偶尔一个字都没有。现在合成一张、正文直接取 DevOps Agent 的原文，
> **整条深度调查链路 0 token**。
>
> ⚠️ 报告链接是 **S3 预签名地址，有效期 7 天**（不是永久链接，也不是 CloudFront）。
> 要长期留档就把文件下载下来。
>
> ⚠️ 卡片正文放不下整份报告时，末尾会多一行「⚠️ 卡片仅展示报告的开头部分 ·
> 完整内容见「📊 查看完整报告」」。那颗按钮里的内容**没有**被裁过；反过来，
> 没有这行提醒就说明卡上看到的就是全文。**「没取到正文」是另一句话**
> （「未取到报告正文…」），别把两者当成一回事。
>
> ⚠️ 「📊 查看完整报告」页是 **Summary + Root cause**，
> 「🔍 调查过程 Trace」页是 **Investigation timeline**（Agent 每一步查了什么）。
> Trace 页显示 `No records found.` 而调查明明跑完了，说明日志读取被跨账号权限挡了 ——
> 那种情况页面会把读失败的原因一并列出来，不再只留一句空提示。
>
> ⚠️ 只有进度卡刷到「已完成」、却**始终没有那张报告卡**时才是真出了问题。
> 那说明发起时的会话路由行没落上（`task#<task_id>`），排查见
> [im-bot-interaction.md](im-bot-interaction.md) 里「调查结果返回」那一节。

### 7.4 开案例的卡片上只有两颗按钮

案例开出来之后，成功卡底部是「**查看案例**」（跳 AWS 控制台）+「**查看全部案例**」。

**这里没有「启动 Agent 调查」按钮**，是有意去掉的：开案例和发起调查是两个独立决定，
把后者做成前者成功卡上的按钮，会让这张卡读起来像"案例本身还不够、你得再点一下"。
想调查就直接说（`/调查` 或「帮我调查…」）。

> 已经发在会话里的**旧卡片**上可能还带着那颗按钮 —— 点它仍然有效，不会"点了没反应"。

### 7.5 钉钉不一样：进度是**追加**，不是刷新

上面 7.1 / 7.2 讲的"一张卡自己变"是**飞书和 Slack** 的样子。钉钉做不到，所以那边的
表现和文案都不同 —— 不是 bug，是平台差异：

| | 飞书 / Slack | 钉钉 |
|---|---|---|
| 进度 | **同一张卡**原地刷新 | **另发新消息**（非终态最多 2 条：约 2 分钟、6 分钟各一条） |
| 标题里的秒数 | 一直在走 | 第一条**不显示**秒数；追加的那几条显示"发出那一刻"的真实秒数 |
| 开场话怎么说 | 「过程和结论都会**更新到这张卡片**上」 | 「过程和结论会**另发新消息**贴出来」 |
| 最终答案 | 那张卡变成答案 | 一条新消息 |

原因很实在：钉钉机器人回复用的是 `sessionWebhook`，它的返回里**只有 `errcode`，没有
消息 id** —— 没有消息 id 就没有"改哪一条"的句柄，改不了已经发出去的消息。真正的可刷新
卡片要在钉钉开放平台后台**手工注册一个卡片模板**（`cardTemplateId`），那是一次性人工
配置、没法由 CFN 自动完成，所以现在这条路留着接口没启用。

> ⚠️ **你不需要去注册这个卡片模板** —— 上面第 1~3 节的钉钉配置步骤是**完整**的，
> 没有漏掉一步。`card_template_id` 只是凭证 secret 里一个**可选**字段，当前版本
> **没有任何代码读它**，填了也不会有任何变化（控制台表单因此也不暴露它）。要不要
> 走这条路是一次产品决定，不是部署步骤 —— 而且钉钉的按钮只能跳 URL、没有"按钮回调
> 服务器"这条路，所以即使上了卡片模板，也只能换来"原地刷新"这一项，🆘 升级面板 /
> 开案例表单那些按钮在钉钉上依旧没有。

所以在钉钉上：

- **答案在新消息里，不在第一条消息里**。第一条不会变，别盯着它等。
- **第一条没有秒表是故意的**。它发出去就定格，写「已用时 0 秒」等于挂一个永远停在 0 的
  计时器 —— 那不是少给信息，是给假信息。
- **"不用重复发问"在钉钉一样成立**（三端都是）。重复发问会撞上"一个会话一次只跑一个"
  的排队，把自己排到自己后面，越急越慢。
- 群里因此会多出 1~2 条消息。上限是**硬**的（写死 2 条），不会刷屏。
