/**
 * Admin「集成 IM」→ 右侧抽屉里的 **Slack 机器人配置详细步骤**（zh / en）。
 *
 * 分工与 [feishuGuide.ts](feishuGuide.ts) / [dingtalkGuide.ts](dingtalkGuide.ts) 一致:
 * 成段的操作文档整块按 locale 给，界面文案（按钮、标签）留在 i18n.ts。内容与
 * `docs/IM_WEBHOOK_SETUP.md` §2 / `.en.md` 一一对应，改文档时对照着改这份。
 *
 * ⚠️ 读者是**只有一个浏览器的客户** —— 所以文档里那段 `aws secretsmanager
 * put-secret-value` **不要搬进来**，那一步现在就是本页上面的两个输入框。留下的命令只有
 * 排错时看日志的 `aws logs tail`（那个没有控制台替代的一行等价物）。
 *
 * ⚠️ Slack 与另两个平台差别最大的三处，抽屉里必须说清（否则客户一定会走错）:
 *   1. **三处 Request URL 填的是同一个地址**（Events / Interactivity / Slash Commands）
 *      —— 不说的话客户会去找另外两个不存在的地址。
 *   2. **「未配置」不等于「空」** —— 方式 B 里这两个 secret 由 CDK 建、值是随机串，
 *      忘了填的表现是「密钥不对」（`invalid_auth` / 401），不是「空」。
 *   3. **不要开 Socket Mode** —— 开了 Slack 就不再往 Request URL 发请求，而且这个错
 *      在日志里看不出来（根本没有请求进来）。
 */
import type { Locale } from "../i18n";
import type { GuideBlock } from "./feishuGuide";

const ZH: GuideBlock[] = [
  { k: "h", tx: "1. 新建 Slack App" },
  { k: "p", tx: "api.slack.com/apps → Create New App → From scratch，起个名字、选中要装的 workspace。Slack 这边是**新建应用**，没有「在已有应用上开个能力」的路。" },

  { k: "h", tx: "2. 勾权限（Bot Token Scopes）" },
  { k: "p", tx: "左侧 OAuth & Permissions → Bot Token Scopes → Add an OAuth Scope，把下面 7 条加上。右列是**缺了会看到的症状** —— 照着排错比回来数一遍快:" },
  {
    k: "kv",
    rows: [
      ["app_mentions:read", "收群里的 @机器人；缺了就是「@ 了没反应」"],
      ["chat:write", "发消息 / 更新卡片；缺了一句话都发不出"],
      ["im:history", "读私聊正文；缺了「DM 里机器人收到空消息」"],
      ["im:write", "在私聊里回复；缺了 DM 无回复"],
      ["channels:history", "读公开频道会话（线程里追问要用）；缺了线程追问没反应"],
      ["groups:history", "同上，私有频道"],
      ["mpim:history", "读群 DM（多人私聊）；缺了群 DM 里追问没反应"],
    ],
  },
  { k: "p", tx: "另外两条**可选**，缺了不影响答案:`reactions:write`（提问后先加一个 👀 表示收到，缺了只是没这个表情）、`commands`（第 6 步注册斜杠命令才需要，不注册也能用）。" },
  { k: "p", tx: "「针对历史消息提问」用的就是上面这几条 `*:history`，不用额外加权限。Slack 没有「引用某条消息」这个事件字段 —— 在那条消息的 thread 里回复就是它唯一的形态。" },
  { k: "p", tx: "勾完点页面上方 Install to Workspace（或 Reinstall），拿到 `xoxb-` 开头的 Bot User OAuth Token。" },
  { k: "warn", tx: "**改了 scope 必须重新安装一次**，token 才会带上新权限 —— 光在页面上勾完保存，旧 token 权限不变。本页的「测试凭证」会把缺的 scope 逐条报出来，可以用它确认到底装成功没有。" },

  { k: "h", tx: "3. 填两个凭证（就在本页上面）" },
  {
    k: "ol",
    items: [
      "Bot Token:OAuth & Permissions 页顶部的 Bot User OAuth Token（`xoxb-` 开头）。",
      "Signing Secret:Basic Information → App Credentials → Signing Secret（点 Show 才显示，32 位小写十六进制）。",
      "两个都粘进本页对应输入框 → 保存 → 点「测试凭证」。",
    ],
  },
  { k: "warn", tx: "⚠️ **「未配置」不等于「空」 —— Slack 这两个 Secret 最容易骗人的地方。** 脚本部署（方式 B）里它们由 CDK 创建，**值是一串随机字符**、不是空串。所以「忘了填」的表现不是报错说没配，而是**「密钥不对」**:bot token 没填 → Slack 回 `invalid_auth`，机器人一句话都发不出；signing secret 没填 → 每个请求验签 401，Slack 后台显示 URL 校验不通过。本页因此按**值的形状**判断配过没有（`xoxb-` 前缀 / 小写十六进制），显示「未配置」就是真的还没填过。" },
  { k: "p", tx: "保存后本页只回显后 4 位（`****xxxx`）。回传脱敏值等于「保持不变」，所以只改一个字段时不用把另一个重新粘一遍。两个值都不进日志，连长度都不记。" },
  { k: "warn", tx: "signing secret 是入口 Lambda **冷启动时**读的 —— 刚保存完，已经热着的执行环境还拿着旧值。所以改完立刻回 Slack 点 Retry 有可能还是 401，等几分钟再试一次即可（不是没保存成功）。" },

  { k: "h", tx: "4. 拿回调地址" },
  { k: "p", tx: "就在下面，点「复制」。第 5 步三处都填这一个，注意保留结尾的斜杠。" },
  { k: "webhookUrl" },
  {
    k: "ul",
    items: [
      "也可以在 CloudFormation 控制台 → 你的堆栈 → Outputs 里看 `SlackWebhookUrl`（一键部署的堆栈默认叫 notiops；脚本部署在 ImStack 上同名输出）。两处是同一个值。",
      "地址按部署生成、每次部署都不一样 —— 别用别人截图里的那个。",
    ],
  },
  { k: "warn", tx: "没装 Slack 的部署没有这个地址（上面的框会说查不到，Outputs 里也没有 `SlackWebhookUrl`）。一键部署请在「安装哪些能力」里勾上 Slack 后更新堆栈；脚本部署重跑 ./setup.sh 选 2) Slack。" },

  { k: "h", tx: "5. 三处 Request URL —— 全填同一个" },
  { k: "p", tx: "回到 Slack App 配置页，下面三处填的是**同一个地址、一字不差**:" },
  {
    k: "kv",
    rows: [
      ["Event Subscriptions", "Enable Events 打开 → Request URL 粘上第 4 步的地址"],
      ["Interactivity & Shortcuts", "打开 → Request URL 同一个（按钮、弹窗提交走这里）"],
      ["Slash Commands", "第 6 步注册命令时逐条填，也是同一个（可选）"],
    ],
  },
  { k: "p", tx: "Event Subscriptions 保存时 Slack 会**立刻发一次校验请求**，地址下面出现绿色 Verified 才算过 —— 这是全流程里唯一能验证 signing secret 的动作（没有任何 API 能验它，所以本页的「测试凭证」只验 bot token）。校验过不了先回第 3 步确认 signing secret。" },
  { k: "p", tx: "校验通过后，在同一页 **Subscribe to bot events** 里加这 4 个事件:" },
  { k: "code", tx: "app_mention      message.im\nmessage.channels message.groups" },
  { k: "warn", tx: "⚠️ **不要开 Socket Mode。** 它与 webhook 互斥 —— 一开 Slack 就不再往 Request URL 发任何请求，而且这个错在日志里**看不出来**（根本没有请求进来，看起来像地址填错）。也不需要 App-Level Token（`xapp-` 开头），那是长连接时代的东西。" },

  { k: "h", tx: "6. 斜杠命令（可选，不注册也能用）" },
  { k: "p", tx: "Slash Commands → Create New Command 逐条建，Request URL 都是第 4 步那个:`/devops`、`/agent`、`/web`、`/account`、`/investigate`、`/case`、`/cases`、`/model`、`/language`、`/help`。" },
  { k: "p", tx: "**注册纯粹是为了拿 Slack 原生的 `/` 自动补全** —— 每条命令都能不带斜杠用:`@机器人 agent notiops`、`@机器人 web on` 与 `/agent notiops`、`/web on` 完全等价（私聊里连 @ 都不用）。" },
  { k: "p", tx: "为什么不能替你注册:命令注册表在**你自己的 App 配置里**，改它需要一把有写权限、12 小时过期、只能人工在 Slack 后台生成的 configuration token —— NotiOps 不持有、也不打算持有你 IM 的写凭证。" },
  { k: "warn", tx: "Slack 的命令名只接受小写字母 / 数字 / 连字符 / 下划线，**中文命令注册不上**（飞书可以）。Slack 上的中文入口靠另外两条，都能用:**中文自然语言**（「帮我调查一下 xxx」「我要开案例」）和 **`@机器人 调查 xxx`**。" },
  { k: "warn", tx: "📌 **`/skills` 已退役**（skill 能力完整保留在本 Web 控制台）。如果你按旧文档注册过它，请到 Slash Commands 里**手工删掉** —— 注册表在你自己的 App 里，我们改不了。不删也不出错，只是它还会出现在自动补全里。" },

  { k: "h", tx: "7. 验证与排错" },
  { k: "p", tx: "在频道里 `/invite @你的机器人`，然后 `@机器人 hi`。看日志:" },
  {
    k: "code",
    tx: [
      "aws logs tail /aws/lambda/notiops-im-ingress-slack --since 5m",
      "aws logs tail /aws/lambda/notiops-im-worker-slack  --since 5m",
    ].join("\n"),
  },
  {
    k: "ul",
    items: [
      "两个都没日志 → 请求根本没到:回第 5 步确认 Request URL 已 Verified、4 个 bot events 都加了、Socket Mode 是关的。",
      "ingress 有 401 → 验签失败，signing secret 与 Slack 后台不一致。回第 3 步。",
      "ingress 有日志、worker 没有 → 验签过了但派发失败，读 ingress 里的报错。",
      "机器人在场但一句话不说 → bot token 不对（`invalid_auth`）。用本页「测试凭证」确认。",
    ],
  },
  { k: "p", tx: "Slack 特有的两个坑，都不是故障:" },
  {
    k: "ul",
    items: [
      "**`dispatch_failed` / 3 秒超时**:入口 Lambda 冷启动没赶上 Slack 的 3 秒硬上限，第二次就好。一直报才是 Secret 没填对（看 ingress 有没有 401）。",
      "**点按钮说「弹窗打开失败，请再试一次」**:Slack 的弹窗令牌只有约 3 秒有效期，冷启动时赶不上。机器人会自动回一条带「再试一次」按钮的消息，点一下就立刻打开 —— 这是设计行为。",
    ],
  },
  { k: "p", tx: "打了斜杠命令、Slack 客户端当场回「不是有效命令」是另一回事:那是**没注册**（第 6 步），请求根本没发出来，别去翻日志。" },
];

const EN: GuideBlock[] = [
  { k: "h", tx: "1. Create the Slack app" },
  { k: "p", tx: "api.slack.com/apps → Create New App → From scratch. Give it a name and pick the workspace. Slack always means a NEW app here — there is no \"add a capability to an existing app\" path." },

  { k: "h", tx: "2. Grant the bot token scopes" },
  { k: "p", tx: "Left nav → OAuth & Permissions → Bot Token Scopes → Add an OAuth Scope, and add these 7. The right column is the symptom you get WITHOUT it — faster to troubleshoot from than to re-count the list:" },
  {
    k: "kv",
    rows: [
      ["app_mentions:read", "Receive @mentions in channels; without it, @mentions get no reply"],
      ["chat:write", "Send messages / update cards; without it, not a single message goes out"],
      ["im:history", "Read DM text; without it, the bot receives empty messages in DMs"],
      ["im:write", "Reply in DMs; without it, DMs get no reply"],
      ["channels:history", "Read public-channel conversations (needed for thread follow-ups)"],
      ["groups:history", "Same, for private channels"],
      ["mpim:history", "Read group DMs (multi-person); without it, group-DM follow-ups get no reply"],
    ],
  },
  { k: "p", tx: "Two more are OPTIONAL and never affect answers: `reactions:write` (adds a 👀 acknowledgement when you ask something — without it you just lose the emoji) and `commands` (only needed if you register slash commands in step 6)." },
  { k: "p", tx: "\"Ask about an earlier message\" rides on those same `*:history` scopes — nothing extra to add. Slack has no \"quoted message\" event field, so replying inside that message's thread is the only form it takes." },
  { k: "p", tx: "Then click Install to Workspace (or Reinstall) at the top of the page and copy the Bot User OAuth Token (starts with `xoxb-`)." },
  { k: "warn", tx: "**Changing scopes requires reinstalling the app** before the token carries them — ticking them and saving does NOT change an existing token. The Test credentials button on this page names each missing scope, so use it to confirm the install actually took." },

  { k: "h", tx: "3. Fill in the two credentials (right above)" },
  {
    k: "ol",
    items: [
      "Bot Token: the Bot User OAuth Token at the top of the OAuth & Permissions page (starts with `xoxb-`).",
      "Signing Secret: Basic Information → App Credentials → Signing Secret (click Show; it is 32 lowercase hex characters).",
      "Paste both into the fields on this page → Save → click Test credentials.",
    ],
  },
  { k: "warn", tx: "⚠️ **\"Not configured\" is NOT the same as \"empty\" — the one genuinely misleading thing about these two secrets.** With script deployment (method B) CDK creates them, and their value is a **random string**, not an empty one. So forgetting to fill them in does not surface as \"not configured\" — it surfaces as **\"wrong key\"**: an unset bot token makes Slack return `invalid_auth` and the bot say nothing at all; an unset signing secret makes every request fail signature verification with 401 and Slack's console show URL verification failing. That is why this page judges \"configured\" by the **shape of the value** (`xoxb-` prefix / lowercase hex) — when it says Not configured, it really has never been filled in." },
  { k: "p", tx: "After saving, this page echoes only the last 4 characters (`****xxxx`). Sending a masked value back means \"keep unchanged\", so editing one field does not require re-pasting the other. Neither value — nor even its length — is ever logged." },
  { k: "warn", tx: "The signing secret is read when the ingress Lambda **cold-starts**, so warm execution environments keep the old value for a few minutes after you save. If Slack's URL verification still returns 401 right after saving, retry it in a few minutes — it does not mean the save failed." },

  { k: "h", tx: "4. Get the request URL" },
  { k: "p", tx: "It is right here — hit Copy. All three places in step 5 want this one URL. Keep the trailing slash." },
  { k: "webhookUrl" },
  {
    k: "ul",
    items: [
      "You can also read it in the CloudFormation console → your stack → Outputs → `SlackWebhookUrl` (the one-click stack is named notiops by default; script deployments have the same output on ImStack). Both places show the same value.",
      "The URL is generated per deployment and differs between deployments — never paste the one from somebody else's screenshot.",
    ],
  },
  { k: "warn", tx: "A stack deployed without Slack has no such URL (the box above will say it could not be found, and there is no `SlackWebhookUrl` output either). For one-click deployment, include Slack under \"What to install\" and update the stack; for script deployment, re-run ./setup.sh and pick 2) Slack." },

  { k: "h", tx: "5. Three Request URLs — all the same one" },
  { k: "p", tx: "Back in the Slack app config, these three take the **same URL, character for character**:" },
  {
    k: "kv",
    rows: [
      ["Event Subscriptions", "Enable Events → paste the URL from step 4 into Request URL"],
      ["Interactivity & Shortcuts", "Turn on → same Request URL (buttons and modal submits arrive here)"],
      ["Slash Commands", "Same URL on every command you create in step 6 (optional)"],
    ],
  },
  { k: "p", tx: "Saving Event Subscriptions makes Slack send a verification request immediately — you need the green Verified under the field. That is the ONLY step in this whole flow that verifies your signing secret (no API can check it, which is why Test credentials on this page only checks the bot token). If verification fails, go back to step 3." },
  { k: "p", tx: "Once verified, add these 4 events under **Subscribe to bot events** on the same page:" },
  { k: "code", tx: "app_mention      message.im\nmessage.channels message.groups" },
  { k: "warn", tx: "⚠️ **Do NOT enable Socket Mode.** It is mutually exclusive with webhooks — turn it on and Slack stops sending anything to your Request URL, and this failure is **invisible in the logs** (no request ever arrives, so it looks like a wrong URL). You also do not need an App-Level Token (`xapp-`); that belongs to the socket era." },

  { k: "h", tx: "6. Slash commands (optional — everything works without them)" },
  { k: "p", tx: "Slash Commands → Create New Command, one per line, all with the step-4 URL: `/devops`, `/agent`, `/web`, `/account`, `/investigate`, `/case`, `/cases`, `/model`, `/language`, `/help`." },
  { k: "p", tx: "**Registering them only buys you Slack's native `/` autocomplete** — every command also works without the slash: `@bot agent notiops` and `@bot web on` are exactly equivalent to `/agent notiops` and `/web on` (and in a DM you do not even need the @mention)." },
  { k: "p", tx: "Why we cannot register them for you: the command registry lives in **your own app config**, and changing it requires a workspace configuration token — write-scoped, 12-hour expiry, only generatable by hand in Slack's console. NotiOps does not hold write credentials to your IM, and does not intend to." },
  { k: "warn", tx: "Slack command names accept only lowercase letters / digits / hyphens / underscores, so **Chinese commands cannot be registered** (Feishu allows them). Chinese entry on Slack works through the other two paths: **plain Chinese** (\"help me investigate xxx\") and **`@bot 调查 xxx`**." },
  { k: "warn", tx: "📌 **`/skills` has been retired** from IM (the full skills feature lives on in this web console). If you registered it from an older doc, **delete it by hand** under Slash Commands — that registry is in your own app and we cannot change it. Leaving it causes no error; it just keeps showing up in autocomplete." },

  { k: "h", tx: "7. Verify and troubleshoot" },
  { k: "p", tx: "In a channel, run `/invite @your-bot`, then say `@your-bot hi`. Check the logs:" },
  {
    k: "code",
    tx: [
      "aws logs tail /aws/lambda/notiops-im-ingress-slack --since 5m",
      "aws logs tail /aws/lambda/notiops-im-worker-slack  --since 5m",
    ].join("\n"),
  },
  {
    k: "ul",
    items: [
      "neither has logs → nothing reached us: back to step 5 and confirm the Request URL shows Verified, all 4 bot events are subscribed, and Socket Mode is OFF.",
      "ingress shows 401 → signature verification failed; the signing secret does not match Slack's console. Back to step 3.",
      "ingress has logs, worker has none → the signature passed but dispatch failed; read the ingress error.",
      "the bot is in the channel but says nothing → the bot token is wrong (`invalid_auth`). Confirm with Test credentials on this page.",
    ],
  },
  { k: "p", tx: "Two Slack-specific gotchas, neither of them a fault:" },
  {
    k: "ul",
    items: [
      "**`dispatch_failed` / 3s timeout**: the ingress Lambda cold-started slower than Slack's hard 3-second limit. The second try works. If it never stops, a secret is wrong (look for 401 in the ingress log).",
      "**\"Could not open the dialog, please try again\"**: Slack's modal trigger is valid for only ~3 seconds and a cold start misses it. The bot posts a message with a Try again button — one click opens it immediately. This is by design.",
    ],
  },
  { k: "p", tx: "A slash command that Slack's own client rejects with \"not a valid command\" is a different thing entirely: it is simply not registered (step 6). The request never left Slack, so there is nothing in the logs to find." },
];

export const SLACK_GUIDE: Record<Locale, GuideBlock[]> = { zh: ZH, en: EN };
