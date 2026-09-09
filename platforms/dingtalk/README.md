# NotiOps — DingTalk (钉钉) Adapter

让钉钉用户通过群里 `@NotiOps <自然语言>`、单聊、`/命令` 触发 DevOps Agent 调查与
AWS Support 案例操作，结果回到**原会话**。

**Webhook + Lambda 架构**（与飞书 / Slack 同构）：钉钉把消息 POST 到 API Gateway HTTP API
→ ingress Lambda 验签后秒回 ACK → 异步投给 worker Lambda 干活。平台无关的业务逻辑在
[`../../core/`](../../core/) 与 [`../common/`](../common/) 里三平台共享；本目录只放钉钉专属
代码（基础设施由仓库根 CDK 的 `ImStack` 统一定义，见
[`infra/lib/constructs/im-core.ts`](../../infra/lib/constructs/im-core.ts)）。

> ⚠️ **本目录有两条形态并存，别混**：
>
> | | 位置 | 状态 |
> |---|---|---|
> | **Lambda Webhook（现行）** | 本目录顶层：`lambda_ingress.py` / `lambda_worker.py` / `caps.py` / `sender.py` / `dt_messages.py` / `append_progress.py` / `case_text.py` | ✅ 在用 |
> | **Fargate 常驻长连接（旧）** | [`app/`](app/) 子目录 + [`Dockerfile`](Dockerfile) + [`infra/lib/bot-stack.ts`](../../infra/lib/bot-stack.ts) | 🗄️ 保留作回滚路径，**新代码一行都不复用它** |
>
> 旧形态用 `dingtalk-stream` SDK 的 Stream 模式（websocket 长连接）。**Lambda 侧绝不能
> import `app/main.py`** —— 它在缺凭证时进 `while True: time.sleep(3600)`，在 Fargate 上
> 那是"等人填凭证"，在 Lambda 上是必然超时。所以 `strip_at_mention` 这类纯字符串变换在
> `lambda_worker.py` 里**各留一份**（两处要一起改，两边注释都写了）。
> 旧形态的退役单独一个 MR。

## 架构

```
钉钉: @NotiOps 帮我列出 IAD 所有 EC2
         │ (HTTPS POST, 机器人「消息接收模式 = HTTP 回调」)
         ▼
┌──────────────────────────────────────────────┐
│ API Gateway HTTP API（$default catch-all）   │
│  未鉴权 —— 验签在 ingress 自己算 HMAC        │
└──────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────┐
│ notiops-im-ingress-dingtalk (Lambda, 20s)    │
│  lambda_ingress.py                           │
│  1. 验签：timestamp(毫秒) + sign             │
│     stringToSign = f"{timestamp}\n{appSecret}"│
│     sign = base64(HMAC_SHA256(appSecret, ·)) │
│     时间窗 1 小时；失败 → 401 空 body        │
│  2. 异步投 worker（InvocationType=Event）    │
│  → 秒回 200（钉钉 ~3s 没 2xx 就重推）        │
│  ⚠️ 没有 👀 表情这一步（见下「能力边界」）    │
└──────────────────────────────────────────────┘
         │ (async invoke，整个入站报文原样转发)
         ▼
┌──────────────────────────────────────────────┐
│ notiops-im-worker-dingtalk (Lambda, 900s)    │
│  lambda_worker.py                            │
│  1. msgId 幂等去重（ddb_state.put_new_event）│
│  2. sender.bind()：把 sessionWebhook 绑进程  │
│     （finally 里 clear()，否则回复串会话）   │
│  3. locale 解析（命令类不自动检测；只在单聊锁）│
│  4. 「确认」先截（case_text.maybe_handle_confirm）│
│  5. 规范化成 ImMessage →                     │
│     platforms.common.router.dispatch         │
│     → platforms.dingtalk.caps.DingtalkCaps   │
└──────────────────────────────────────────────┘
         │
         ▼
   DevOps Agent investigates
         │
         ▼
┌──────────────────────────────────────────────┐
│ report-handler Lambda                        │
│  (shared/report_delivery/)                   │
│  按 DDB 行的 platform 字段路由 → dingtalk    │
│  sender：群走 groupMessages/send，            │
│  单聊走 oToMessages/batchSend                 │
└──────────────────────────────────────────────┘
```

**路由是确定性的、0 token**：`core/nl_router.py` 用正则把消息分到十条能力，只有「案例」
那条会调一次 LLM 抽标题/正文。详见 [`../common/router.py`](../common/router.py) 文件头。

## 出站：两条路，按"在不在会话里"分

| # | 机制 | 支持 @ | 需要 token | 用在哪 |
|---|---|---|---|---|
| 1 | `sessionWebhook`（入站报文里带的地址） | ✅ | ❌ | **所有会话内回复** |
| 2 | `POST /v1.0/robot/groupMessages/send` | ❌ | ✅ | 群的**会话外**投递（报告回写、推送） |
| 3 | `POST /v1.0/robot/oToMessages/batchSend` | ❌ | ✅ | 单聊的会话外投递（≤20 userIds/次） |

`sessionWebhook` 的有效期 **≈90 分钟**（官方示例报文里 `sessionWebhookExpiredTime -
createAt ≈ 5,402,586 ms`）。90 分钟 > Lambda 的 15 分钟上限 ⇒ **会话内的所有回复都不需要
access_token**。过期了才走机制 2/3 兜底（`sender.reply()` 自己判）。

> 🔒 **`sessionWebhook` 就是凭证**（URL 本身即鉴权）—— 绝不进日志、绝不落库、绝不写进任何
> 文件。它只在 ingress → worker 的 `Payload` 里流转。

## 能力边界（如实声明，不静默降级）

钉钉 ActionCard 的**所有按钮都是 URL 跳转**，没有"按钮 → 回调我们服务器"这条路；
也**没有消息更新接口**、**没有机器人表情回应接口**。直接后果：

| 飞书 / Slack 有 | 钉钉 | 替代做法 |
|---|---|---|
| 提问后 👀 表情（T+0.3s 反馈） | ❌ 无接口 | 首次反馈是 worker 的 ack（T+4~6s） |
| 🆘 升级面板（按钮） | ❌ | 文案里给 `开案例` 命令 |
| 开案例表单弹窗 + 账号下拉 | ❌ | `开案例 <描述>` 一句话开（**不是** `/案例 <描述>` —— bare `案例` 是列表/详情，见 `nl_router._CASE_CMD_PATTERNS`）；账号先用 `/account <12位账号>` 切；只说「开案例」不给描述 → 回一张**可复制的纯文本模版**（`im.dt.case.form.*`，六项都印全部选项与默认值；六行上下各夹一条 `━━━ ↓ 从这里开始复制 ↓ ━━━` 界线、标签加粗 —— 钉钉在相邻行之间强制插空行，六行排不紧，不框出来客户看不出要复制哪一段），用户改完整段发回来由 [`case_text.py`](case_text.py) 的 `maybe_handle_form` 接住（解析走 `nl_router.parse_case_form`，界线与落款靠 `_form_boilerplate()` 剔掉）—— **不拿意图当主题开单** |
| 进度卡**原地刷新**（`LiveCard`） | ❌ | [`append_progress.py`](append_progress.py)：**追加式**进度，t≈120s / t≈360s 最多 2 条 |
| `investigate_status` 接上进度轮询 | ❌ | 一律静态快照 + 一句"不会自动刷新" |
| 引用消息（`quoted_*`） | ❌ HTTP 回调不带 | 恒空，`router.QUOTE_AWARE_KINDS` 在钉钉上是 no-op |

因为没有可更新的消息句柄，钉钉**不写** `imtask#` 进度行（`lambda_progress` 的轮询对它没有
意义）；`link_im_investigation` 仍然照写 —— 报告回写要靠它找到会话。

真互动卡片（`card_template_id`）留作 Tier 2：普通版卡片接口官方已标注「不再支持新应用
接入」，真卡片要客户自己在开放平台搭建并发布模板，不该成为"钉钉能用"的门槛。
`sender.card_template_id()` 只留字段与判空。

## 钉钉开放平台一次性配置

在 https://open-dev.dingtalk.com → 你的**企业内部应用**。**权威、带顺序和排错的版本在
[`../../docs/IM_WEBHOOK_SETUP.md`](../../docs/IM_WEBHOOK_SETUP.md) §3**（回调地址必须等
`ImStack` 部署完之后再填），下面只是速查。

### 1. 建应用 + 加机器人
**应用开发 → 企业内部应用 → 创建应用** → 左侧**应用能力 → 机器人 → 配置**。
设置机器人名称（用户 @ 时显示的）和图标。

### 2. 消息接收模式选「HTTP 模式」
机器人配置页 → **消息接收模式** 选 **HTTP 模式**（不是 Stream 模式）→ **消息接收地址**
填 `ImStack` 输出的 `DingtalkWebhookUrl`。

### 3. 拿凭证
**凭证与基础信息 → AppKey / AppSecret** 复制下来。`AppSecret` 同时是**验签的密钥** ——
ingress 冷启动时硬校验，为空直接崩（故意的：空 secret = 请求完全可伪造）。

### 4. 申请权限（只有报告回写需要）
**权限管理** → 勾上「企业内机器人发送消息权限」。只影响**会话外**投递（报告跑完回贴、
每日推送）；会话内回复走 `sessionWebhook`，不需要任何权限。

### 5. 发布版本
**版本管理与发布** → 创建新版本 → 发布。

### 6. 把机器人拉进群
群设置 → 智能群助手 → 添加机器人 → 选你的企业内部应用机器人。

## 部署

> ℹ️ 本目录**不单独部署**。钉钉适配器是融合系统的一部分，两条部署路径都支持：
>
> - **方式 A（一键 CFN）**：模板参数 `InstallOption` 选 `web+dingtalk`
> - **方式 B（`setup.sh`）**：IM 平台菜单里选 `3) 钉钉 (DingTalk)`
>
> 完整流程见 [`../../docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md)。

### 钉钉凭据怎么填（关键）

`setup.sh` / 一键模板 **都不采集任何 IM 凭据**。CDK 只创建一个**空的** Secret
`notiops/im-bot-dingtalk`；部署完成后再填：

```bash
aws secretsmanager put-secret-value --secret-id notiops/im-bot-dingtalk \
  --secret-string '{"app_key":"ding...","app_secret":"..."}' \
  --region <REGION>
```

可选字段：`card_template_id`（Tier 2 预留）、`webhook_url`（旧自定义机器人的推送地址，
cron/广播路径仍在用）。

⚠️ **ingress 是 fail-fast 的**：`app_secret` 读不到就 `raise`，Lambda 起不来。所以
**先填 secret，再去开放平台填回调地址**。钉钉在开放平台保存回调地址时**什么都不校验**
（没有 URL 挑战，也没有"测试连通性"这一步）—— 顺序反了不会报任何错，机器人只是**一直
不吭声**（一个正确配置和一个填错的配置，从开放平台看长得一模一样）；这种情况只能靠上面
「排查」里的两条 CloudWatch 日志命令去判。
Lambda 是冷启动时读 secret 的 —— 填完等旧执行环境自然回收，急的话改一下 ingress 的环境
变量强制换一批（做法见 `docs/DEPLOYMENT.md` §8.2）。

## 测试

把机器人拉进钉钉群，群里发：

```
@NotiOps 帮我列出 IAD 所有 EC2 信息
```

预期：
1. 几秒后出现「正在思考」那条消息（**没有** 👀 表情这一步，见「能力边界」）
2. 超过 2 分钟还没出结果 → 追加 1 条进度；超过 6 分钟 → 再追加 1 条（**最多 2 条**）
3. 完成后发最终答案，落款带模型 / agent / 账号
4. 超过 `MAX_BODY = 3000` 的长答案落成一份 HTML 报告，正文里给 presigned 链接
   （`platforms/common/long_answer.py`，**不截断**）
5. 案例类消息（「创建案例 …」）走 propose → **回一句「确认」** → 才真正建 case

## 排查

```bash
# ingress（收不到 / 401 / 起不来都先看这个）
aws logs tail /aws/lambda/notiops-im-ingress-dingtalk --region <REGION> --follow

# worker（收到了但没回答 / 回答不对看这个）
aws logs tail /aws/lambda/notiops-im-worker-dingtalk --region <REGION> --follow

# 改了钉钉适配器代码后重新部署（在仓库根执行）:
cd ../../infra && npx cdk deploy ImStack
```

| 症状 | 原因 |
|---|---|
| 机器人完全不理人，ingress 日志只有 `401 signature verification failed` | `notiops/im-bot-dingtalk` 里的 `app_secret` 与开放平台不一致 |
| ingress 起不来（`Runtime.ImportModuleError`） | secret 里 `app_secret` 为空 —— **故意**的 fail-fast，填上即可 |
| 回复发到了别的会话 | `sender.clear()` 没执行（worker 的 `finally` 被改坏了）—— 见 `lambda_worker.py` 坑 2 |
| 说「确认」它开始答一段废话 | `case_text.maybe_handle_confirm` 没在 `router.dispatch` **之前** —— 见 `lambda_worker.py` 坑 3 |
| `INIT_REPORT ... Status: timeout` | 正常的（冷启动装 bedrock 凭证），不影响 |

## 文件结构

平台特定（本目录）：

> API Gateway / Lambda / IAM 等基础设施**不在本目录**，由仓库根 CDK 的 `ImStack`
> (`infra/lib/constructs/im-core.ts`) 统一定义。

| 文件 | 作用 |
|---|---|
| [lambda_ingress.py](lambda_ingress.py) | webhook 入口：HMAC 验签 + 异步投 worker + 秒回 200 |
| [lambda_worker.py](lambda_worker.py) | 干活儿的：幂等 + bind session + locale + 规范化 → `common.router` |
| [caps.py](caps.py) | `DingtalkCaps` —— 十条能力在钉钉上的实现 |
| [dt_messages.py](dt_messages.py) | 渲染（`MAX_BODY = 3000`、`answer_text` / `dispatch_text` / `titled_text`） |
| [sender.py](sender.py) | `sessionWebhook` POST + 服务端 API 兜底 + access_token 缓存 |
| [append_progress.py](append_progress.py) | 追加式进度（与 `LiveCard` 同名同签，语义是追加） |
| [case_text.py](case_text.py) | 案例的纯文本交互（propose → 回「确认」→ execute） |
| [app/](app/) | 🗄️ 旧 Fargate 长连接形态（`main.py` / `case_flow.py` / `dingtalk_utils.py`） |
| [Dockerfile](Dockerfile) | 🗄️ 旧形态用它构建镜像，留作回滚路径 |
| [requirements.txt](requirements.txt) | `dingtalk-stream` 只服务旧形态；**Lambda 路径全 stdlib，不进层** |

平台无关（`../common/` 与 `../../core/` 共享）：

| 文件 | 作用 |
|---|---|
| [../common/router.py](../common/router.py) | 确定性分发（0 token）+ prompt-injection 二道门 |
| [../common/im_markdown.py](../common/im_markdown.py) | `to_dingtalk()`：保留 ATX 标题，表格降级成项目符号 |
| [../common/im_footer.py](../common/im_footer.py) | 落款（模型 / agent / 账号），三平台一个字都不重写 |
| [../common/chat_lease.py](../common/chat_lease.py) | 同会话串行化（一个会话一次只跑一轮） |
| [../common/long_answer.py](../common/long_answer.py) | 超长答案落 S3 + presigned 链接（不截断） |
| [../../core/nl_router.py](../../core/nl_router.py) | 双语正则意图路由（0 token） |
| [../../core/im_accounts.py](../../core/im_accounts.py) | 多账号：`/account` 切换 + 注册表校验 |
| [../../core/ddb_state.py](../../core/ddb_state.py) | DynamoDB 共享状态表（跨平台，带 `platform` 字段） |
