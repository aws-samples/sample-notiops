/**
 * Admin「集成 IM」→ 右侧抽屉里的**钉钉机器人配置详细步骤**（zh / en）。
 *
 * 与 [feishuGuide.ts](feishuGuide.ts) 同一套块词汇（`GuideBlock` 由那份拥有并导出），
 * 分工也一样：i18n.ts 放界面文案，成段的操作文档按 locale 整块放在这里，与
 * `docs/IM_WEBHOOK_SETUP.md` / `.en.md` 的钉钉章节一一对应 —— 改文档时对照着改这份。
 *
 * ⚠️ 读者是**只有一个浏览器的客户**：每一步都必须能在钉钉网页和本页上完成。
 * 出现的命令只有排错看日志那一类。
 *
 * ⚠️ 钉钉与飞书的三处能力差异必须写进来，不能靠"没提到"来暗示（「不许静默降级」）：
 *   ① 只有一个 Secret（AppSecret 同时用于换 token 和验签），没有 Encrypt Key /
 *      Verification Token —— 客户照飞书那份找不到对应输入框会以为页面漏了；
 *   ② 保存消息接收地址时**没有** URL challenge —— 这是最贵的一条：填错不报错，
 *      症状是"机器人完全不回话"，客户会去查凭证；
 *   ③ 卡片按钮只能是**链接**、已发消息改不了 —— 所以钉钉侧的交互形态与飞书不同，
 *      不是实现没做完。
 */
import type { Locale } from "../i18n";
import type { GuideBlock } from "./feishuGuide";

const ZH: GuideBlock[] = [
  { k: "h", tx: "1. 创建钉钉企业内部应用" },
  { k: "p", tx: "钉钉开放平台（open-dev.dingtalk.com）→ 应用开发 → 企业内部应用 → 创建应用。填名称和简介即可,不需要选服务器出口 IP。" },
  { k: "p", tx: "进应用后:左侧「机器人」→ 开启机器人能力,填机器人名称与图标 → 保存。最后在「版本管理与发布」里发布一个版本(不发布的话机器人加不进群)。" },
  { k: "p", tx: "钉钉这边**不需要**逐条勾权限:机器人收发消息用的是机器人能力自带的通道,与飞书那批 im / cardkit scope 不是一回事。" },

  { k: "h", tx: "2. 拿两个凭证（顺序很重要）" },
  {
    k: "ol",
    items: [
      "左侧「凭证与基础信息」→ 复制 AppKey 与 AppSecret(AppSecret 点一下才显示)。",
      "把两个值填进本页的 AppKey / AppSecret,点「保存」。",
      "保存成功后再去做第 4 步 —— 反了的症状见那一节的警告。",
    ],
  },
  { k: "warn", tx: "钉钉只有这**一个** Secret:AppSecret 同时做两件事 —— 换 access token、以及校验入站请求头里的 sign。所以这里没有飞书那样的 Encrypt Key / Verification Token 输入框,不是页面漏了。IM 入口冷启动时会硬校验这两个值,缺任一就直接起不来(宁可入口起不来,也不要开一个谁都能伪造请求的公网地址)。" },
  { k: "p", tx: "保存后本页只回显 AppSecret 的后 4 位(`****xxxx`)。回传脱敏值 = 不修改,所以只想改推送地址时不用重填 AppSecret。日志侧这个值连长度都不打。" },

  { k: "h", tx: "3. 拿消息接收地址" },
  { k: "p", tx: "就是下面这个 —— 点「复制」,第 4 步的「消息接收地址」填它。结尾那个「/」要保留。" },
  { k: "webhookUrl" },
  {
    k: "ul",
    items: [
      "钉钉只有这**一个**地址要填:机器人没有独立的「按钮回调」通道,消息事件和卡片回传走同一条 URL。",
      "这个地址也可以在 CloudFormation 控制台 → 你的栈 → Outputs → DingtalkWebhookUrl 里看到(一键部署的栈名默认 notiops,那里还有一个 ImNextSteps 告诉你还差哪一步;脚本部署看 ImStack 的同名 Output)。两处是同一个值。",
      "地址是随部署生成的,换个部署就变 —— 别把别人截图里的那串填进去。",
    ],
  },
  // 2026-10-11 改（飞书 / Slack 两份抽屉同一句）：一键部署的 InstallOption 是**单选**
  // （infra/lib/notiops-webchat-standalone-stack.ts 的 allowedValues 只有 web / web+feishu /
  // web+slack / web+dingtalk，三个 Install* 条件都是等值判断）。原文「把钉钉选上」读起来像加选 ——
  // 三个 IM 分页又总是都显示，装着飞书的管理员照这句换了值，更新栈就把正在用的飞书机器人去掉了。
  // 脚本部署是多选（IM_PLATFORM_CHOICE 逗号分隔），只填新平台的话现网那个会被当成「这次不带」。
  { k: "warn", tx: "没装钉钉的栈没有这个地址(上面会显示取不到,Outputs 里也不会出现 DingtalkWebhookUrl)。一键部署:参数页的 What to install 选 web+dingtalk,然后更新栈 —— 这一项是单选,一键部署一次只装一个 IM 机器人,从别的机器人换过来会把那个机器人去掉;脚本部署:重跑 ./setup.sh,在「IM 平台选择」那一步把 3) 钉钉选上(已经在用的平台一起选,例如 1,3)。" },

  { k: "h", tx: "4. 开 HTTP 模式并填地址" },
  { k: "p", tx: "回到应用的「机器人」页:" },
  {
    k: "kv",
    rows: [
      ["消息接收模式", "选「HTTP 模式」(默认是 Stream 模式,必须改)"],
      ["消息接收地址", "第 3 步的 DingtalkWebhookUrl"],
      ["发布", "改完保存,再到「版本管理与发布」发布一次"],
    ],
  },
  { k: "warn", tx: "钉钉保存这个地址时**不做任何校验** —— 没有飞书那种 URL challenge,不会当场变绿也不会报错。所以填错一个字符、或者凭证还没保存,表现都只是「机器人一句话不回」。顺序反了同样白等。排错先看第 5 步的日志:入口有没有收到请求,一眼就分开了「钉钉没发出来」和「我们没认出来」。" },

  { k: "h", tx: "5. 加进群并验证" },
  { k: "p", tx: "群设置 → 智能群助手 → 添加机器人 → 选刚发布的应用机器人。然后在群里发「@机器人 你好」,应当收到回复。看日志:" },
  {
    k: "code",
    tx: [
      "aws logs tail /aws/lambda/notiops-im-ingress-dingtalk --since 5m",
      "aws logs tail /aws/lambda/notiops-im-worker-dingtalk  --since 5m",
    ].join("\n"),
  },
  {
    k: "ul",
    items: [
      "两个都没日志 → 钉钉根本没发出来,回到第 4 步确认消息接收模式真的切成了 HTTP、地址一字不差、版本已发布。",
      "ingress 里有 401 → sign 校验没过,AppSecret 与钉钉控制台不一致,回到第 2 步。",
      "ingress 里有「timestamp skew」类报错 → 机器上的时间与钉钉相差超过 1 小时(钉钉的验签带时间窗)。",
      "ingress 有日志、worker 没有 → 验签过了但投递失败,看 ingress 的报错。",
    ],
  },

  { k: "h", tx: "6. 与飞书的差异（不是没做完）" },
  { k: "p", tx: "钉钉机器人的平台能力比飞书少几样,所以同一个功能在钉钉里长得不一样:" },
  {
    k: "ul",
    items: [
      "卡片上的按钮只能是**链接**:钉钉的 ActionCard 按钮全部是 URL 跳转,没有「点一下回传给服务器」这种交互。所以需要确认的操作(开案例、启动调查)在钉钉里用回复关键词完成。",
      "已发出去的消息改不了:钉钉没有更新消息的接口,所以没有飞书那种「卡片自己变」的进度条,长任务改成追加一两条进度消息。",
      "机器人不能给消息贴表情:所以收到指令时没有 👍 那种「已收到」的即时反馈,取而代之的是一条文字回执。",
      // 2026-10-11 改：原文「群里主动推送要另配一个自定义机器人地址(见第 7 步)…做不了「定时主动发」」
      // 与第 7 步打架、理由也过时了 —— 调查报告早就走服务端 API（dingtalk_sender._deliver_to_chat →
      // dingtalk_api.send_group / send_oto）投回会话；而这一版没有任何主动推送投钉钉：lambda4_notifier
      // 与 phd_event_forwarder 只发飞书，push_handler 的 `_push_configured()` 只认没有任何栈设置的
      // PUSH_TARGET_* / DINGTALK_PUSH_WEBHOOK_URL 环境变量。那一条是本版本的范围、不是平台差异，
      // 所以在这个「平台差异」列表里要明说，免得读成「钉钉做不到」。
      "机器人自己的回复通道是一次性的:它是钉钉在回调里给的会话地址,只在收到消息后约 90 分钟内有效。所以调查报告不走它,而是走服务端 API 投回发起调查的那个会话,不用另配。每日通知、Health 和实时事件推送这一版都不投钉钉 —— 这一条是本版本的范围,不是钉钉平台做不到;第 7 步那个自定义机器人地址的用途见第 7 步。",
    ],
  },

  // 2026-10-11 与 i18n.ts 的 `admin.notif.dt.pushUrlHint` 同一次改（理由与代码出处见那条的注释）：
  // 原文说「巡检广播、告警、定时报告」都走这个地址 —— 告警与定时报告在这一版根本不投钉钉，
  // 巡检推送也还配不起来；这个地址眼下实际起作用的只有报告回贴的兜底。
  { k: "h", tx: "7. 自定义机器人推送地址（可选）" },
  { k: "p", tx: "这个地址是群里另加的「自定义机器人」的 Webhook:群设置 → 智能群助手 → 添加机器人 → 自定义 → 复制它的 Webhook 地址,填进本页的「自定义机器人推送地址」。这一版只有两处会用到它:调查报告回贴的兜底(正常走服务端 API 投回发起调查的会话,投不出去才改发到这个群);以及巡检推送 —— 但巡检只有完整部署(setup.sh)才有,而本版本还没有把群登记成巡检推送目标的途径。每日通知、Health 和实时事件推送都不投钉钉。" },
  // 「别选加签」与 docs/DEPLOYMENT.md §3.3 第 8 步同一条：dingtalk_sender 的加签密钥只认
  // DINGTALK_PUSH_WEBHOOK_SECRET(_ARN) 环境变量，哪条部署路径都不设，本页也没有这一格 ⇒ 发出去
  // 的消息不带签名。「测试凭证」同样不签名，所以选了加签会在那里当场看到拒收。
  // 另两种安全设置也要说（2026-10-11，与 docs/IM_WEBHOOK_SETUP.md §3.7 那段 ⚠️ 同口径）：只写「别选
  // 加签」，客户自然会选「自定义关键词」，而「测试凭证」那条测试消息里有 NotiOps —— 测试通过、
  // 真实报告却投不进去，这正是最难查的那种失败。
  { k: "warn", tx: "添加自定义机器人时,安全设置别选「加签」:这一版没有地方保存加签密钥,我们发出去的消息不带签名,会被钉钉拒收(填好地址后点「测试凭证」会显示推送地址拒收了那条消息)。另两种也保证不了投递:「自定义关键词」要求每条消息都含那个词,而我们发出的报告不保证含有 ——「测试凭证」那条测试消息里有 NotiOps,所以它通过不代表真实报告也能投进去;「IP 地址(段)」要固定的出口 IP,而我们没有。这个地址眼下实际用到的只有调查报告回贴的兜底(见上),所以这一项可以留空。" },
  { k: "warn", tx: "那串地址**本身就是凭证** —— 谁拿到都能往这个群发消息。所以本页只回显后 4 位、只接受 https://oapi.dingtalk.com/robot/send 这一个形态,日志里也不会出现它。别贴到工单或截图里。" },
  { k: "p", tx: "群里 @机器人 的问答**不需要**这一项 —— 那条路用钉钉回调里带的一次性会话地址,不需要任何额外配置。留空即可。" },
  { k: "p", tx: "填好后点「测试凭证」:它先用 AppKey / AppSecret 换一次 access token(凭证是否正确的权威判据),填了推送地址的话再往那个群真发一条。钉钉**没有**「往任意群发测试消息」的接口,所以没填推送地址时测试只验凭证、什么都不发 —— 那时要端到端验证,请回第 5 步在群里 @ 一句。" },
];

const EN: GuideBlock[] = [
  { k: "h", tx: "1. Create the DingTalk internal app" },
  { k: "p", tx: "DingTalk Open Platform (open-dev.dingtalk.com) → App development → Internal app → Create. A name and description are enough; no egress IP list is needed." },
  { k: "p", tx: "Inside the app: left nav → Robot → enable the bot capability, set its name and icon → Save. Finally publish a version under Version management & release (an unpublished robot cannot be added to a group)." },
  { k: "p", tx: "Unlike Feishu, DingTalk needs NO per-scope grants: robot messaging rides on the bot capability itself, which is not the same mechanism as Feishu's im / cardkit scopes." },

  { k: "h", tx: "2. Get the two credentials (order matters)" },
  {
    k: "ol",
    items: [
      "Left nav → Credentials & Basic Info → copy the AppKey and AppSecret (the secret only appears after you click to reveal it).",
      "Paste both into the AppKey / AppSecret fields on this page and click Save.",
      "Only then do step 4 — see the warning there for what happens if you invert the order.",
    ],
  },
  { k: "warn", tx: "DingTalk has exactly ONE secret: the AppSecret both fetches access tokens and verifies the inbound `sign` header. That is why there are no Encrypt Key / Verification Token fields like Feishu's — nothing is missing from this page. The IM entry point validates both values at cold start and refuses to start if either is empty (better a dead entry point than a public URL anyone can forge requests to)." },
  { k: "p", tx: "After saving, this page only echoes the last 4 chars of the AppSecret (`****xxxx`). Sending a masked value back means \"keep unchanged\", so you can edit the push URL without re-entering the secret. Neither the value — nor even its length — is ever logged." },

  { k: "h", tx: "3. Get the callback URL" },
  { k: "p", tx: "It is right here — hit Copy. Step 4 wants this as the message-receiving address. Keep the trailing slash." },
  { k: "webhookUrl" },
  {
    k: "ul",
    items: [
      "DingTalk needs only this ONE URL: robots have no separate button-callback channel, so message events and card postbacks arrive on the same address.",
      "You can also read it in the CloudFormation console → your stack → Outputs → DingtalkWebhookUrl (the one-click stack is named notiops by default and also has an ImNextSteps output; script deployments have the same output on ImStack). Both places show the same value.",
      "The URL is generated per deployment and differs between deployments — never paste the one from somebody else's screenshot.",
    ],
  },
  { k: "warn", tx: "A stack deployed without DingTalk has no such URL (the box above will say it could not be found, and there is no DingtalkWebhookUrl output either). For one-click deployment, pick web+dingtalk under \"What to install\" on the parameters page and update the stack — it is a single choice, so a one-click stack runs one IM bot at a time and switching from another bot removes that bot; for script deployment, re-run ./setup.sh and pick 3) DingTalk at the IM Platform Selection step (also pick the platforms you already use, e.g. 1,3)." },

  { k: "h", tx: "4. Switch to HTTP mode and paste the URL" },
  { k: "p", tx: "Back on the app's Robot page:" },
  {
    k: "kv",
    rows: [
      ["Message receiving mode", "Pick HTTP mode (the default is Stream mode — you must change it)"],
      ["Message receiving address", "The DingtalkWebhookUrl from step 3"],
      ["Release", "Save, then publish a version again under Version management & release"],
    ],
  },
  { k: "warn", tx: "DingTalk validates NOTHING when you save this address — there is no URL challenge, no green check, no error. So one wrong character, or credentials not yet saved, both look exactly the same: the robot never says a word. Inverting the order costs you the same silent wait. Start troubleshooting from the step 5 logs: whether the entry point received a request at all separates \"DingTalk never sent it\" from \"we rejected it\"." },

  { k: "h", tx: "5. Add it to a group and verify" },
  { k: "p", tx: "Group settings → Group assistant → Add robot → pick the app robot you just published. Then send \"@robot hello\" in that group; you should get a reply. Check the logs:" },
  {
    k: "code",
    tx: [
      "aws logs tail /aws/lambda/notiops-im-ingress-dingtalk --since 5m",
      "aws logs tail /aws/lambda/notiops-im-worker-dingtalk  --since 5m",
    ].join("\n"),
  },
  {
    k: "ul",
    items: [
      "neither has logs → DingTalk never sent anything; go back to step 4 and confirm the mode really is HTTP, the URL matches exactly, and the version is published.",
      "ingress shows 401 → signature verification failed; the AppSecret does not match the DingTalk console. Back to step 2.",
      "ingress shows a timestamp-skew error → this host's clock is more than an hour off from DingTalk's (their signature carries a time window).",
      "ingress has logs, worker has none → the signature passed but dispatch failed; read the ingress error.",
    ],
  },

  { k: "h", tx: "6. Differences from Feishu (by platform, not by omission)" },
  { k: "p", tx: "DingTalk robots expose fewer platform primitives than Feishu, so the same feature looks different here:" },
  {
    k: "ul",
    items: [
      "Card buttons can only be LINKS: every DingTalk ActionCard button is a URL jump — there is no \"click posts back to the server\" interaction. Actions that need confirmation (opening a case, starting an investigation) are therefore confirmed by replying with a keyword.",
      "Sent messages cannot be edited: DingTalk has no message-update API, so instead of Feishu's self-updating card there are one or two appended progress messages for long tasks.",
      "Robots cannot add reactions: there is no 👍-style instant acknowledgement when a command is received; a short text receipt takes its place.",
      "The robot's own reply channel is one-time: it is a session webhook that DingTalk hands us in the callback, valid for roughly 90 minutes after a message. Investigation reports therefore do not use it; they go back to the conversation that started them through the server API, with nothing extra to configure. The daily notification, Health and real-time event pushes are not sent to DingTalk in this release — that is this release's scope, not a DingTalk platform limit; for what the custom-robot URL in step 7 is used for, see step 7.",
    ],
  },

  { k: "h", tx: "7. Custom-robot push URL (optional)" },
  { k: "p", tx: "This is the webhook of a separate DingTalk \"custom robot\" added to the group: Group settings → Group assistant → Add robot → Custom → copy its webhook URL and paste it into the Custom-robot push URL field on this page. In this release only two things use it: the fallback for investigation reports (they normally go back to the conversation that started them through the server API, and land in this group only when that fails), and inspection push — but inspection exists only on the full (setup.sh) deployment, and this release has no way yet to register a group as an inspection push target. The daily notification, Health and real-time event pushes are not sent to DingTalk." },
  { k: "warn", tx: "When adding the custom robot, do not pick 加签 (HMAC sign) as its security setting: this release has nowhere to store the signing secret, so the messages we send carry no signature and DingTalk rejects them (after filling in the URL, Test credentials reports that the push webhook rejected the message). The other two cannot guarantee delivery either: a custom keyword must appear in every message, and the reports we send are not guaranteed to contain it — the Test credentials message contains NotiOps, so a passing test does not prove that real reports get through; an IP address (range) needs a fixed egress IP, which we do not have. In practice this URL is only used today as the fallback for investigation reports (see above), so you can leave it empty." },
  { k: "warn", tx: "That URL IS a credential — anyone holding it can post into that group. So this page only echoes its last 4 chars, accepts only the https://oapi.dingtalk.com/robot/send shape, and never logs it. Do not paste it into tickets or screenshots." },
  { k: "p", tx: "In-chat Q&A does NOT need this field — that path uses the one-time session webhook from DingTalk's own callback and needs no extra configuration. Leaving it empty is fine." },
  { k: "p", tx: "Once filled, click Test credentials: it first fetches one access token with the AppKey/AppSecret (the authoritative credential check), then, if a push URL is set, posts a real message to that group. DingTalk has NO API to post a test message into an arbitrary group, so with no push URL configured the test only validates credentials and sends nothing — to verify end to end in that case, go back to step 5 and @mention the robot." },
];

export const DINGTALK_GUIDE: Record<Locale, GuideBlock[]> = { zh: ZH, en: EN };
