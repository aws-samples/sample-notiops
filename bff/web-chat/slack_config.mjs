/**
 * Slack 机器人配置（Admin「集成 IM」页的 Slack 分页）。
 *
 * 与 [feishu_config.mjs](feishu_config.mjs) / [dingtalk_config.mjs](dingtalk_config.mjs)
 * 同构、**刻意不合并** —— 而且 Slack 与那两个平台的差别比它们彼此之间大得多：
 *
 * ⚠️ **存储形状不一样：Slack 是两个「纯字符串」secret，不是一个 JSON secret。**
 * ───────────────────────────────────────────────────────────────────────
 *   · `notiops/slack-bot-token`      —— 整个 SecretString 就是 `xoxb-…` 本身
 *   · `notiops/slack-signing-secret` —— 整个 SecretString 就是那串验签密钥本身
 *
 * 飞书/钉钉是「一个 secret，JSON 里放字段」。这里**不能**照抄成 JSON：数据面读它们的
 * 三处（`platforms/slack/caps.py`、`platforms/slack/app/main.py`、
 * `platforms/slack/app/progress_sender.py`）都是 `get_secret_value(...)["SecretString"].strip()`
 * ——**没有 `json.loads`**。写成 JSON 等于把 `{"bot_token":"xoxb-…"}` 整串当 token 发给
 * Slack，症状是 `invalid_auth`，而管理台上一切正常。
 * （`platforms/slack/lambda_ingress.py` 对 signing secret 额外兼容了 JSON 形态，
 * 但 bot token 那三处没有 —— 所以本模块**一律写纯字符串**。）
 *
 * ⚠️ **名字不在 `notiops/im-bot-*` 命名空间里**，是 Socket Mode 时代的历史遗留。别为了
 * 命名整齐去改：现网所有已配好的 Slack 机器人会当场失效（数据面按这两个名字读）。
 * 加平台/改名都要同步 `infra/lib/constructs/web-chat-core.ts` 里 `imBotSecretNames`
 * 那份清单 —— 漏了的症状**不是 403**，是 GET 整页 500（index.mjs 用 Promise.all）。
 *
 * ⚠️ **「未配置」不等于「空」—— 这是本模块唯一容易骗人的地方。**
 * ───────────────────────────────────────────────────────────────
 * 方式 B（setup.sh）里这两个 secret 由 `notiops-backend-stack.ts` 用
 * `new secretsmanager.Secret(...)` 建，**没给 `secretStringValue`** ⇒ Secrets Manager
 * 会**随机生成**一个值。所以"忘了填"的现网表现不是「secret 为空」，而是**「密钥不对」**
 * （bot token → `invalid_auth`，一句话都发不出；signing secret → 每个请求 401，Slack
 * 后台显示 URL 校验不通过）。方式 A（一键 CFN）这两个 secret 根本不存在，读会
 * `ResourceNotFoundException` —— 两条路径的"没配"长得完全不一样。
 *
 * 本模块统一按**形状**判定「配过没有」（见 `BOT_TOKEN_RE` / `SIGNING_RE`），而且
 * **保存时的校验与显示时的判定用同一个谓词** —— 否则会出现「保存成功了却一直显示
 * 未配置」这种客户无法自救的死循环。
 *
 * ARCC 未查询（MCP server 本次会话连不上）—— 本模块按标准做法处理凭证：脱敏回显、
 * 不记日志、错误响应里不回显客户填的值。
 */
import {
  SecretsManagerClient, GetSecretValueCommand, UpdateSecretCommand, CreateSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import { ApiGatewayV2Client, GetApisCommand } from "@aws-sdk/client-apigatewayv2";

const BOT_TOKEN_SECRET_ID = process.env.SLACK_BOT_TOKEN_SECRET_NAME || "notiops/slack-bot-token";
const SIGNING_SECRET_ID = process.env.SLACK_SIGNING_SECRET_NAME || "notiops/slack-signing-secret";

let sm = new SecretsManagerClient({});
let agw = new ApiGatewayV2Client({});

/** 测试接缝：注入假 Secrets Manager / API Gateway 客户端（风格同 dingtalk_config.mjs）。 */
export function __setClients(overrides = {}) {
  if (overrides.sm) sm = overrides.sm;
  if (overrides.agw) agw = overrides.agw;
  if (overrides.resetCache) webhookUrlCache = undefined;
  if (overrides.fetch) doFetch = overrides.fetch;
}

/**
 * Bot Token 的形状：`xoxb-` 前缀。
 *
 * 这里**刻意比钉钉那边严**（钉钉的 AppKey 官方从未承诺过格式，所以只挡"明显不是 key
 * 的东西"）。Slack 不一样：`xoxb-` 是官方文档、我们自己四份文档、以及 CFN 参数描述里
 * 都写明的前缀，十年没变。而且不带前缀的值在数据面上**必然** `invalid_auth` ——
 * 拒掉它不是"误拒一个可能合法的值"，是提前把一次"机器人完全不回话"的排查省掉。
 *
 * 逃生口：真遇到我们不认的新形态，Secrets Manager 控制台可以直接改（docs/IM_WEBHOOK_SETUP.md
 * §2.2 就是这么写的）—— 这句话也写进了报错文案里，客户不用来问。
 */
const BOT_TOKEN_RE = /^xoxb-[A-Za-z0-9-]{10,}$/;

/**
 * Signing Secret 的形状：32 位（这里放宽到 ≥16）**小写十六进制**。
 *
 * 为什么这个形状能当「配过没有」的判据：CDK 随机生成的那个占位值取自 Secrets Manager
 * 默认字母表（含大写与标点），32 个字符全部落在 `[0-9a-f]` 里的概率约 10⁻²⁴。所以
 * "形状对" ⇔ "人填过"，不需要去比 `CreatedDate` / `LastChangedDate`（那个会被重新部署
 * 时的改标签动作带偏，反而更会骗人）。
 */
const SIGNING_RE = /^[0-9a-f]{16,}$/;

/** Slack Bot Token Scopes：缺了会真的少功能的那几条（docs/IM_WEBHOOK_SETUP.md §2.1）。 */
const REQUIRED_SCOPES = [
  "app_mentions:read", "chat:write", "im:history", "im:write",
  "channels:history", "groups:history", "mpim:history",
];
/** 缺了只少一个 👀 表情、答案不受影响 —— 单独列出来，别混进"必需"里吓客户。 */
const OPTIONAL_SCOPES = ["reactions:write", "commands"];

/**
 * 脱敏：只留后 4 位。
 *
 * **空值/占位值必须回显空串，不能回显 `****`** —— 与飞书/钉钉同一条契约。这里更要紧：
 * 方式 B 下 secret 里躺着一个 CDK 随机串，回 `****` 会让客户以为已经配好，然后拿一个
 * 「bot 一句话都不说」去查回调地址（真因在这一页上）。
 */
const mask = (v) => (!v ? "" : v.length <= 4 ? "****" : `****${v.slice(-4)}`);
/** 回传值若是脱敏形态(****xxxx) → 保留原值。空串不以 **** 开头，所以「清空」仍是清空。 */
const mergeIfMasked = (nv, ov) => (typeof nv === "string" && nv.startsWith("****") && nv.length <= 8 ? ov : nv);

/* ───────────────── 入站回调地址（给抽屉里的「复制」按钮）───────────────── */

/**
 * Slack 入站回调地址 = IM 入口 HTTP API 的 endpoint（`…-im-ingress-slack`）。
 *
 * 与飞书/钉钉那两份逐字同理（按名字查、查不到回空串不抛），区别只有平台后缀。
 * 缓存独立在本模块里，所以不会与另两个平台互相污染。
 *
 * ⚠️ Slack 那边**三处** Request URL（Event Subscriptions / Interactivity / Slash
 * Commands）填的都是这**同一个**地址 —— 抽屉文案里必须说清，否则客户会去找另外两个。
 */
let webhookUrlCache;

async function resolveWebhookUrl() {
  if (webhookUrlCache !== undefined) return webhookUrlCache;
  const prefix = process.env.IM_INGRESS_API_NAME_PREFIX || "";
  if (!prefix) return (webhookUrlCache = "");
  const wanted = `${prefix}slack`;
  try {
    let next;
    do {
      const r = await agw.send(new GetApisCommand({ MaxResults: "100", NextToken: next }));
      const hit = (r.Items || []).find((a) => a.Name === wanted);
      // 结尾补 `/`：与 CfnOutput SlackWebhookUrl 一字不差（$default stage 不入路径）。
      if (hit?.ApiEndpoint) return (webhookUrlCache = `${hit.ApiEndpoint}/`);
      next = r.NextToken;
    } while (next);
    return (webhookUrlCache = "");
  } catch (e) {
    // 只记异常类型名（docs/LOGGING_STANDARD.md）；这条路失败不影响配置读写。
    console.warn(`[BFF] resolve slack webhook url failed: ${e?.name || "Error"}`);
    return (webhookUrlCache = "");
  }
}

/**
 * 读一个纯字符串 secret。不存在 → `""`（方式 A 的正常状态，不是错误）。
 *
 * 不做 `JSON.parse` —— 见文件头。手工建成 `{"…":"…"}` 的情况这里会原样读回，然后被
 * 形状校验判成"未配置"，界面上给的提示正是"值的形状不对" —— 比静默接受一个发不出
 * 消息的值好。
 */
async function readPlainSecret(secretId) {
  try {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
    return String(r.SecretString || "").trim();
  } catch (e) {
    if (e?.name === "ResourceNotFoundException") return "";
    throw e;
  }
}

async function writePlainSecret(secretId, value) {
  try {
    await sm.send(new UpdateSecretCommand({ SecretId: secretId, SecretString: value }));
  } catch (e) {
    if (e?.name === "ResourceNotFoundException") {
      // 方式 A（一键 CFN）不建这两个 secret，首次保存就走这里。
      await sm.send(new CreateSecretCommand({ Name: secretId, SecretString: value }));
    } else throw e;
  }
}

/** GET：读配置，敏感字段脱敏；形状不对的一律当"未配置"回空串。 */
export async function apiGetSlackConfig() {
  const [botToken, signing, webhookUrl] = await Promise.all([
    readPlainSecret(BOT_TOKEN_SECRET_ID),
    readPlainSecret(SIGNING_SECRET_ID),
    resolveWebhookUrl(),
  ]);
  return {
    slack: {
      // 形状不对（空 / CDK 随机占位 / 粘错）⇒ 回空串 = 界面显示"未配置"。
      bot_token: BOT_TOKEN_RE.test(botToken) ? mask(botToken) : "",
      signing_secret: SIGNING_RE.test(signing) ? mask(signing) : "",
      // 客户要粘进 Slack App 配置的**公开入口地址**，不是凭证 —— 不脱敏。
      // 空串 = 查不到（没装 IM / 前缀不符 / 无权限），界面退回「去 Outputs 里找」。
      webhook_url: webhookUrl,
    },
  };
}

/** PUT：校验 + 合并（脱敏字段不覆盖）+ 写回两个 secret。 */
export async function apiPutSlackConfig(body) {
  if (!body || body.platform !== "slack" || !body.config || typeof body.config !== "object") {
    return { error: "platform must be 'slack' and config object is required", status: 400 };
  }
  const cfg = body.config;
  const [oldToken, oldSigning] = await Promise.all([
    readPlainSecret(BOT_TOKEN_SECRET_ID),
    readPlainSecret(SIGNING_SECRET_ID),
  ]);
  // 合并时的"原值"只在形状对的时候才算数：否则一个 CDK 随机占位值会被
  // `****` 回传合并回去，客户以为改了、其实原封不动。
  const keepToken = BOT_TOKEN_RE.test(oldToken) ? oldToken : "";
  const keepSigning = SIGNING_RE.test(oldSigning) ? oldSigning : "";

  const token = mergeIfMasked(String(cfg.bot_token ?? "").trim(), keepToken);
  const signing = mergeIfMasked(String(cfg.signing_secret ?? "").trim(), keepSigning);

  // 报错里**绝不回显客户填的值** —— 它可能是一个有效凭证，而错误响应会进浏览器控制台。
  if (token && !BOT_TOKEN_RE.test(token)) {
    return {
      error: "Invalid Slack bot token format: expected it to start with 'xoxb-' "
        + "(OAuth & Permissions page). If Slack has issued you a token in a shape NotiOps "
        + `does not accept yet, write it directly into the '${BOT_TOKEN_SECRET_ID}' secret `
        + "in the Secrets Manager console.",
      status: 400,
    };
  }
  if (signing && !SIGNING_RE.test(signing)) {
    return {
      error: "Invalid Slack signing secret format: expected at least 16 lowercase hexadecimal "
        + "characters (Basic Information -> App Credentials -> Signing Secret; Slack's is 32). "
        + `If yours looks different, write it directly into the '${SIGNING_SECRET_ID}' secret `
        + "in the Secrets Manager console.",
      status: 400,
    };
  }

  // 只写真正变了的那个 —— 少一次写就少一次 secret 版本，也少一次不必要的 IAM 暴露面。
  const writes = [];
  if (token !== oldToken) writes.push(writePlainSecret(BOT_TOKEN_SECRET_ID, token));
  if (signing !== oldSigning) writes.push(writePlainSecret(SIGNING_SECRET_ID, signing));
  await Promise.all(writes);

  // ⚠️ signing secret 是 ingress Lambda 在**模块加载时**读的
  // （platforms/slack/lambda_ingress.py 顶层）⇒ 已经热着的执行环境还拿着旧值。
  // 这句必须回给界面，否则客户改完立刻去 Slack 点 "Retry"，看到 401 会以为没保存成功。
  return {
    message: "Slack config updated successfully. Note: the signing secret is read when the "
      + "ingress Lambda cold-starts, so warm execution environments keep the old value for a "
      + "few minutes — if Slack's URL verification still fails right after saving, retry it "
      + "in a few minutes.",
  };
}

/* ───────────────── 测试（Slack 服务端 API 原生）───────────────── */

const SLACK_API = "https://slack.com/api";
let doFetch = (...a) => fetch(...a);

/**
 * POST /test：验证 bot token，并顺手把**缺的 scope** 报出来。
 *
 * `auth.test` 是 bot token 是否有效的**权威判据**（无效直接回 `{ok:false,error:"invalid_auth"}`，
 * 而不是"发出去了但没人收到"）。响应头 `X-OAuth-Scopes` 里带着这个 token 实际拿到的
 * scope 清单 —— 顺手比一遍，把"装好了但漏勾 im:history"这类**只在特定场景才暴露**的
 * 坑提前说出来（否则客户要等到"DM 里 bot 收到空消息"才发现）。
 *
 * ⚠️ **signing secret 没有任何 API 能验证** —— 它只在 Slack 真的发一个事件过来时才会被
 * 用到。所以这里刻意**不**假装验过它，文案上必须说清：唯一的验证手段是在 Slack 后台
 * 保存 Request URL（那一步会立刻发 `url_verification`）。不许静默降级成"测试通过"。
 */
export async function apiTestSlackSend(body) {
  if (body?.platform !== "slack") return { error: "platform must be 'slack'", status: 400 };
  const [token, signing] = await Promise.all([
    readPlainSecret(BOT_TOKEN_SECRET_ID),
    readPlainSecret(SIGNING_SECRET_ID),
  ]);
  if (!BOT_TOKEN_RE.test(token)) {
    return { success: false, message: "Slack bot token is not configured yet (expected an 'xoxb-' token)." };
  }
  const signingNote = SIGNING_RE.test(signing)
    ? " The signing secret is filled in, but no API can verify it — the only check is saving the "
      + "Request URL in your Slack app (Slack sends url_verification right then)."
    : " ⚠️ The signing secret is NOT filled in yet — Slack's URL verification will fail with 401 "
      + "until you set it (Basic Information -> App Credentials -> Signing Secret).";

  let j, scopeHeader;
  try {
    const r = await doFetch(`${SLACK_API}/auth.test`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
    });
    scopeHeader = r.headers?.get?.("x-oauth-scopes") || "";
    j = await r.json();
  } catch (e) {
    return { success: false, message: `Slack credential check failed: ${e?.name || "Error"}` };
  }
  if (!j?.ok) {
    // `error` 是 Slack 自己的错误码（invalid_auth / account_inactive / token_revoked），
    // 不含我们的凭证 —— 可以原样回显。
    return { success: false, message: `Slack credential check failed: ${j?.error || "unknown_error"}` };
  }

  const granted = new Set(scopeHeader.split(",").map((s) => s.trim()).filter(Boolean));
  // 拿不到响应头（某些代理会剥掉）时 granted 是空集 —— 那就**不报缺 scope**，
  // 而不是把"读不到"说成"全都缺"。
  const missing = granted.size ? REQUIRED_SCOPES.filter((s) => !granted.has(s)) : [];
  const missingOptional = granted.size ? OPTIONAL_SCOPES.filter((s) => !granted.has(s)) : [];

  // team / user 是 workspace 与 bot 的名字，不是凭证 —— 回显它们才能让客户确认
  // "装到的是我以为的那个 workspace"。
  const who = `Connected to workspace "${j.team || "?"}" as "${j.user || "?"}".`;
  if (missing.length) {
    return {
      success: false,
      message: `${who} Missing required bot token scopes: ${missing.join(", ")}. `
        + "Add them under OAuth & Permissions, then reinstall the app to the workspace "
        + "(the token only picks up new scopes on reinstall)."
        + signingNote,
    };
  }
  const optionalNote = missingOptional.length
    ? ` Optional scopes not granted: ${missingOptional.join(", ")} `
      + "(reactions:write only costs you the 👀 acknowledgement emoji; commands only the native "
      + "slash-command autocomplete — answers are unaffected)."
    : "";
  return { success: true, message: `${who} All required bot token scopes are granted.${optionalNote}${signingNote}` };
}
