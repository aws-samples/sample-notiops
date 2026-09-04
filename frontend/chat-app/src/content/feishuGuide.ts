/**
 * Admin「集成 IM」→ 右侧抽屉里的**飞书机器人配置详细步骤**（zh / en）。
 *
 * 为什么内容放这里、不放 i18n.ts:
 * 这是一份**成段的操作文档**（七节、含命令块与两列表），拆成 40 多个 `admin.notif.*`
 * key 塞进 i18n.ts 之后，谁改一句都要在两个文件间对照，段落顺序也不再看得出来。
 * i18n.ts 留给**界面文案**（按钮、标签、提示），成段文档按 locale 整块给 —— 与
 * `docs/IM_WEBHOOK_SETUP.md` / `.en.md` 一一对应，改文档时对照着改这份。
 *
 * ⚠️ 与那两份文档的关系:文档是给「拿着仓库和 CLI 的人」看的，本文件是给
 * **只有一个浏览器的客户**看的 —— 所以这里的每一步都必须能在控制台/飞书网页上完成，
 * 出现的命令只有两类:飞书要求的随机串生成（openssl）与排错时看日志（aws logs）。
 * 别把 `put-secret-value` 那套搬进来 —— 那一步现在就是本页的两个输入框。
 */
import type { Locale } from "../i18n";

export type GuideBlock =
  | { k: "h"; tx: string }                    // 小节标题
  | { k: "p"; tx: string }                    // 段落
  | { k: "ol"; items: string[] }              // 有序步骤
  | { k: "ul"; items: string[] }              // 无序要点 / 排错对照
  | { k: "code"; tx: string }                 // 命令或 scope 清单（等宽、可选中复制）
  | { k: "warn"; tx: string }                 // 踩过的坑，橙色高亮
  | { k: "kv"; rows: [string, string][] }     // 「项 → 改成」两列表
  // 本部署真实的 webhook 地址 + 一键复制。**唯一一个内容不在本文件里的块** ——
  // 值由 BFF 查出来、经 AdminPanel 传进抽屉（FeishuGuideDrawer 的 webhookUrl prop），
  // 这里只标"渲染在这个位置"。周边文案（按钮字样、查不到时的说明）在 i18n.ts，
  // 因为那是界面文案不是操作说明（同本文件头那条分工）。
  | { k: "webhookUrl" };

const ZH: GuideBlock[] = [
  { k: "h", tx: "1. 准备飞书自建应用" },
  { k: "p", tx: "飞书开放平台 → 开发者后台 → 创建自建应用（已有应用直接沿用，不用新建）。「添加应用能力」里开启「机器人」。" },
  { k: "p", tx: "权限管理里开通下面这批 scope —— 长连接与 webhook 用的是同一批，已有应用一条都不用加:" },
  {
    k: "code",
    tx: [
      "cardkit:card:read      cardkit:card:write     cardkit:template:read",
      "im:chat                im:chat.access_event.bot_p2p_chat:read",
      "im:message             im:message.group_at_msg:readonly",
      "im:message:readonly    im:message.p2p_msg:readonly",
      "im:message:send_as_bot im:resource",
    ].join("\n"),
  },
  { k: "p", tx: "权限改完要「创建版本并发布」，等企业管理员通过才生效。" },

  { k: "h", tx: "2. 拿两把钥匙（顺序很重要）" },
  {
    k: "ol",
    items: [
      "事件与回调 → 加密策略 → Encrypt Key:自己填一串随机字符串（建议 ≥32 位）。",
      "同一页上的 Verification Token 直接给出，复制下来。",
      "把两个值填进本页的 Encrypt Key / Verification Token，点「保存」。",
    ],
  },
  { k: "p", tx: "需要一个随机串的话，在任意终端跑:" },
  { k: "code", tx: "openssl rand -hex 24" },
  { k: "warn", tx: "webhook 模式下这两把钥匙是唯一鉴权手段:IM 入口在冷启动时硬校验，任一为空就直接起不来 —— 这是故意的，宁可入口起不来，也不要开一个谁都能伪造请求的公网地址。所以必须先在这里保存，再去做第 4 / 5 步。" },
  { k: "p", tx: "保存后本页只回显后 4 位（`****xxxx`）。回传脱敏值 = 不修改，所以只想改群组时不用重填钥匙。日志侧这两个值连长度都不打。" },

  { k: "h", tx: "3. 拿 Webhook 地址" },
  { k: "p", tx: "就是下面这个 —— 点「复制」，第 4 / 5 步的「请求地址」都填它。结尾那个「/」要保留。" },
  { k: "webhookUrl" },
  {
    k: "ul",
    items: [
      "飞书的「事件」和「回调」用的是同一个地址 —— 入口按请求体自己分流，不靠路径区分。",
      "这个地址也可以在 CloudFormation 控制台 → 你的栈 → Outputs → FeishuWebhookUrl 里看到（一键部署的栈名默认 notiops，那里还有一个 ImNextSteps 告诉你还差哪一步；脚本部署看 ImStack 的同名 Output）。两处是同一个值。",
      "地址是随部署生成的，换个部署就变 —— 别把别人截图里的那串填进去。",
    ],
  },
  { k: "warn", tx: "只装了 web 的栈没有这个地址（上面会显示取不到，Outputs 里也不会出现 FeishuWebhookUrl）。一键部署要在参数页的 What to install 选 web+feishu，然后更新栈。" },

  { k: "h", tx: "4. 事件配置" },
  { k: "p", tx: "事件与回调 → 事件配置:" },
  {
    k: "kv",
    rows: [
      ["订阅方式", "选「将事件发送至开发者服务器」（原来是「使用长连接接收事件」的改这里）"],
      ["请求地址", "第 3 步的 FeishuWebhookUrl"],
      ["订阅的事件", "确认 im.message.receive_v1 在列表里"],
    ],
  },
  { k: "p", tx: "保存时飞书立刻发一次 URL challenge，通过即变绿。" },

  { k: "h", tx: "5. 回调配置（卡片按钮全靠它）" },
  { k: "p", tx: "事件与回调 → 回调配置:" },
  {
    k: "kv",
    rows: [
      ["订阅方式", "选「将回调发送至开发者服务器」"],
      ["请求地址", "同一个 FeishuWebhookUrl"],
      ["订阅的回调", "card.action.trigger"],
    ],
  },
  { k: "warn", tx: "漏了 card.action.trigger 的症状是「按钮点了没反应」，不报错、日志里也看不出来。" },
  { k: "p", tx: "卡片按钮这条路飞书有约 3 秒硬超时:入口收到就异步投给 worker、立刻回空响应，真正的活在 worker 里干完再回来改卡片 —— 所以点完是「卡片稍后自己变」，不是「转圈等结果」。" },

  { k: "h", tx: "6. 验证" },
  { k: "p", tx: "把机器人拉进一个群，发「@机器人 你好」，应当收到回复。看日志:" },
  {
    k: "code",
    tx: [
      "aws logs tail /aws/lambda/notiops-im-ingress-feishu --since 5m",
      "aws logs tail /aws/lambda/notiops-im-worker-feishu  --since 5m",
    ].join("\n"),
  },
  {
    k: "ul",
    items: [
      "ingress 有日志、worker 没有 → 验签过了但投递失败，看 ingress 的报错。",
      "ingress 里有 401（signature / token）→ 两把钥匙和飞书控制台不一致，回到第 2 步。",
      "两个都没日志 → 飞书根本没发出来，检查第 4 步的订阅方式是否真的切走了长连接。",
    ],
  },

  { k: "h", tx: "7. 推送群组（出方向）" },
  { k: "p", tx: "本页的「推送群组 Chat ID」只管**出方向**:每日报告、告警推送、调查回调发到这些群。把机器人拉进群后取群的 oc_ 开头 chat id 填进来，点「测试」会真发一条消息过去。" },
  { k: "p", tx: "群里 @机器人 的收方向不用在这里登记 —— 那由第 4 步的事件订阅决定。" },
];

const EN: GuideBlock[] = [
  { k: "h", tx: "1. Prepare the Feishu custom app" },
  { k: "p", tx: "Feishu Open Platform → Developer Console → create a custom app (reuse an existing one if you have it). Under app capabilities, enable Bot." },
  { k: "p", tx: "Grant the scopes below — webhook mode uses exactly the same set as long-connection mode, so an existing app needs no additions:" },
  {
    k: "code",
    tx: [
      "cardkit:card:read      cardkit:card:write     cardkit:template:read",
      "im:chat                im:chat.access_event.bot_p2p_chat:read",
      "im:message             im:message.group_at_msg:readonly",
      "im:message:readonly    im:message.p2p_msg:readonly",
      "im:message:send_as_bot im:resource",
    ].join("\n"),
  },
  { k: "p", tx: "Scope changes only take effect after you create and publish a version and your workspace admin approves it." },

  { k: "h", tx: "2. Get the two keys (order matters)" },
  {
    k: "ol",
    items: [
      "Events & Callbacks → Encryption Strategy → Encrypt Key: enter a random string you generate (32+ chars recommended).",
      "The Verification Token is shown on that same page — copy it.",
      "Paste both into the Encrypt Key / Verification Token fields on this page and click Save.",
    ],
  },
  { k: "p", tx: "Need a random string? In any terminal:" },
  { k: "code", tx: "openssl rand -hex 24" },
  { k: "warn", tx: "In webhook mode these two keys are the ONLY authentication: the IM entry point validates them at cold start and refuses to start if either is empty. That is deliberate — better a dead entry point than a public URL anyone can forge requests to. So save them here BEFORE doing steps 4 and 5." },
  { k: "p", tx: "After saving, this page only echoes the last 4 chars (`****xxxx`). Sending a masked value back means \"keep unchanged\", so you can edit the chat IDs without re-entering the keys. Neither value — not even its length — is ever logged." },

  { k: "h", tx: "3. Get the webhook URL" },
  { k: "p", tx: "It is right here — hit Copy. Both step 4 and step 5 want this same URL as their Request URL. Keep the trailing slash." },
  { k: "webhookUrl" },
  {
    k: "ul",
    items: [
      "Feishu events and callbacks use the SAME URL — the entry point routes on the request body, not the path.",
      "You can also read it in the CloudFormation console → your stack → Outputs → FeishuWebhookUrl (the one-click stack is named notiops by default and also has an ImNextSteps output; script deployments have the same output on ImStack). Both places show the same value.",
      "The URL is generated per deployment and differs between deployments — never paste the one from somebody else's screenshot.",
    ],
  },
  { k: "warn", tx: "A web-only stack has no such URL (the box above will say it could not be found, and there is no FeishuWebhookUrl output either). For one-click deployment, pick web+feishu under \"What to install\" on the parameters page and update the stack." },

  { k: "h", tx: "4. Event configuration" },
  { k: "p", tx: "Events & Callbacks → Event configuration:" },
  {
    k: "kv",
    rows: [
      ["Delivery mode", "Choose \"send events to developer server\" (change this if you were on long connection)"],
      ["Request URL", "The FeishuWebhookUrl from step 3"],
      ["Subscribed events", "Confirm im.message.receive_v1 is in the list"],
    ],
  },
  { k: "p", tx: "On save, Feishu immediately sends one URL challenge; it turns green when that passes." },

  { k: "h", tx: "5. Callback configuration (card buttons depend on it)" },
  { k: "p", tx: "Events & Callbacks → Callback configuration:" },
  {
    k: "kv",
    rows: [
      ["Delivery mode", "Choose \"send callbacks to developer server\""],
      ["Request URL", "The same FeishuWebhookUrl"],
      ["Subscribed callbacks", "card.action.trigger"],
    ],
  },
  { k: "warn", tx: "Missing card.action.trigger shows up as \"buttons do nothing when clicked\" — no error, nothing in the logs." },
  { k: "p", tx: "Feishu enforces a ~3s hard timeout on the card-button path: the entry point hands the work to a worker and returns an empty response immediately; the worker does the real work and updates the card afterwards. So a click means \"the card changes by itself shortly\", not \"a spinner while you wait\"." },

  { k: "h", tx: "6. Verify" },
  { k: "p", tx: "Add the bot to a chat and send \"@bot hello\" — you should get a reply. Check the logs:" },
  {
    k: "code",
    tx: [
      "aws logs tail /aws/lambda/notiops-im-ingress-feishu --since 5m",
      "aws logs tail /aws/lambda/notiops-im-worker-feishu  --since 5m",
    ].join("\n"),
  },
  {
    k: "ul",
    items: [
      "ingress has logs, worker has none → the signature passed but dispatch failed; read the ingress error.",
      "ingress shows 401 (signature / token) → the two keys do not match the Feishu console; go back to step 2.",
      "neither has logs → Feishu never sent anything; check that step 4 really switched away from long connection.",
    ],
  },

  { k: "h", tx: "7. Target group chats (outbound)" },
  { k: "p", tx: "The \"Target group chat IDs\" field on this page is outbound only: daily reports, alert pushes and investigation callbacks are delivered to these chats. Add the bot to a chat, copy the chat's oc_-prefixed id here, and click Test to send a real message." },
  { k: "p", tx: "Inbound (@mentioning the bot in a chat) needs no entry here — that is driven by the event subscription from step 4." },
];

export const FEISHU_GUIDE: Record<Locale, GuideBlock[]> = { zh: ZH, en: EN };
