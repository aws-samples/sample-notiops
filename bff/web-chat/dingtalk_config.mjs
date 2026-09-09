/**
 * 钉钉机器人配置（Admin「集成 IM」页的钉钉分页）。
 *
 * 与 [feishu_config.mjs](feishu_config.mjs) 同构、**刻意不合并**：两个平台的字段集、
 * 校验规则、以及"测试发送"能做到什么，三样都不一样（钉钉没有 verification_token /
 * encrypt_key，验签用的就是 app_secret；钉钉也没有"往任意群发一条测试消息"的接口）。
 * 合成一个模块的结果是一堆 `if (platform === ...)` 分支，而这一页最贵的 bug 恰好是
 * **界面骗人**（见下面 `mask` 那段）—— 分支越多越藏得住。路由分发在 index.mjs。
 *
 * 存储 = Secrets Manager 单 secret `notiops/im-bot-dingtalk`（与飞书同构：一个 secret，
 * JSON 里放字段）。**按字面名引用、不做跨栈 CFN import** —— 理由同 feishu_config.mjs。
 * 数据面读同一个 secret 的是 `shared/dingtalk_api.py::secret_id()`（ARN → NAME → 字面名）。
 *
 * ⚠️ 命名陷阱（这一页唯一容易出人命的地方）
 * ─────────────────────────────────────────
 * "webhook url" 在钉钉这里有**两个完全相反**的含义：
 *
 *   · 本模块回给前端的 `webhook_url` —— NotiOps 的**入站**回调地址（IM ingress
 *     HTTP API），客户要把它粘进钉钉开放平台。它是**公开入口**，不是凭证，**不脱敏**。
 *   · secret 里的 `webhook_url`（本模块对外叫 **`push_webhook_url`**）—— 客户那个
 *     **自定义机器人**的推送地址。**这个 URL 本身就是凭证**（谁拿到都能往那个群里
 *     发消息，见 shared/dingtalk_api.py::push_webhook_url），所以必须脱敏、必须限制
 *     host、绝不进日志。
 *
 * 两者同名会导致把凭证当公开地址明文回显。所以对外的字段名故意分成
 * `webhook_url`（只读、公开）和 `push_webhook_url`（凭证、脱敏）。
 *
 * ARCC 未查询（MCP server 本次会话连不上）—— 本模块按标准做法处理凭证与出站地址：
 * 脱敏回显、host 允许清单、不记日志。
 */
import {
  SecretsManagerClient, GetSecretValueCommand, UpdateSecretCommand, CreateSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import { ApiGatewayV2Client, GetApisCommand } from "@aws-sdk/client-apigatewayv2";

const SECRET_ID = process.env.DINGTALK_SECRET_NAME || "notiops/im-bot-dingtalk";
let sm = new SecretsManagerClient({});
let agw = new ApiGatewayV2Client({});

/** 测试接缝：注入假 Secrets Manager / API Gateway 客户端（风格同 feishu_config.mjs）。 */
export function __setClients(overrides = {}) {
  if (overrides.sm) sm = overrides.sm;
  if (overrides.agw) agw = overrides.agw;
  if (overrides.resetCache) webhookUrlCache = undefined;
  if (overrides.fetch) doFetch = overrides.fetch;
}

/**
 * AppKey 的形状。
 *
 * **刻意宽松**：钉钉的 AppKey 历史上有过 `ding` 前缀、`suite` 前缀和纯随机串三种，
 * 官方文档没有承诺过格式。这里只挡住"明显不是 key 的东西"（空白字符、太短、带
 * `/` 或 `:` 说明客户粘错了整行）。收紧到 `^ding` 的代价是**误拒一个合法 key，
 * 而客户在界面上没有任何绕过手段** —— 那比放过一个错值贵得多（错值的表现是
 * 机器人不回话，日志里有明确的 accessToken 报错）。
 */
const APP_KEY_RE = /^[A-Za-z0-9_-]{8,}$/;

/**
 * 自定义机器人推送地址的允许清单（host + 路径）。
 *
 * 这个值会被写进 secret，之后由**投递 Lambda**（shared/report_delivery/
 * dingtalk_sender.py）POST 调查报告全文过去。也就是说：能往这里写任意 URL 的人
 * 就能把报告内容外发到自己的服务器上。管理台已经有 nav:admin 门禁，但"管理员填错
 * 一个域名"和"报告被静默外发"之间不该只隔一层门禁。
 *
 * 只允许 `https://oapi.dingtalk.com/robot/send?access_token=…`（钉钉自定义机器人
 * 唯一的形态）。留空是合法的 —— 巡检广播 / 主动通知本来就是可选功能。
 */
const PUSH_HOST = "oapi.dingtalk.com";
const PUSH_PATH = "/robot/send";

/**
 * 脱敏：只留后 4 位。
 *
 * **空值必须回显空串，不能回显 `****`** —— 与 feishu_config.mjs 同一条契约，理由也一样：
 * 全新安装时 CDK 建出来的 secret 里 `app_key` / `app_secret` 是**空串**，回 `****`
 * 会让客户以为已经配好、跳过钉钉那边的凭证复制，最后拿一个"机器人完全不回话"去
 * 查回调地址（钉钉连 URL 校验都没有，所以那一步不会给任何提示）。
 *
 * 长度 ≤4 的非空值整串遮掉 —— 后 4 位就是全部。
 */
const mask = (v) => (!v ? "" : v.length <= 4 ? "****" : `****${v.slice(-4)}`);
/** 回传值若是脱敏形态(****xxxx) → 保留原值。空串不以 **** 开头，所以「清空」仍是清空。 */
const mergeIfMasked = (nv, ov) => (typeof nv === "string" && nv.startsWith("****") && nv.length <= 8 ? ov : nv);

/* ───────────────── 入站回调地址（给抽屉里的「复制」按钮）───────────────── */

/**
 * 钉钉入站回调地址 = IM 入口 HTTP API 的 endpoint（`…-im-ingress-dingtalk`）。
 *
 * 与飞书那份逐字同理（按名字查、查不到回空串不抛），区别只有平台后缀。
 * 缓存独立在本模块里，所以不会与飞书那份互相污染。
 */
let webhookUrlCache;

async function resolveWebhookUrl() {
  if (webhookUrlCache !== undefined) return webhookUrlCache;
  const prefix = process.env.IM_INGRESS_API_NAME_PREFIX || "";
  if (!prefix) return (webhookUrlCache = "");
  const wanted = `${prefix}dingtalk`;
  try {
    let next;
    do {
      const r = await agw.send(new GetApisCommand({ MaxResults: "100", NextToken: next }));
      const hit = (r.Items || []).find((a) => a.Name === wanted);
      // 结尾补 `/`：与 CfnOutput DingtalkWebhookUrl 一字不差（$default stage 不入路径）。
      if (hit?.ApiEndpoint) return (webhookUrlCache = `${hit.ApiEndpoint}/`);
      next = r.NextToken;
    } while (next);
    return (webhookUrlCache = "");
  } catch (e) {
    // 只记异常类型名（docs/LOGGING_STANDARD.md）；这条路失败不影响配置读写。
    console.warn(`[BFF] resolve dingtalk webhook url failed: ${e?.name || "Error"}`);
    return (webhookUrlCache = "");
  }
}

async function readSecret() {
  try {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
    return JSON.parse(r.SecretString || "{}");
  } catch (e) {
    if (e?.name === "ResourceNotFoundException") return null;
    throw e;
  }
}

/** GET：读配置，敏感字段脱敏。secret 不存在 → 空表单（首次配置场景）。 */
export async function apiGetDingtalkConfig() {
  const [data, webhookUrl] = await Promise.all([
    readSecret().then((d) => d || {}),
    resolveWebhookUrl(),
  ]);
  return {
    dingtalk: {
      // app_key 不是凭证（单独拿它发不出任何东西，钉钉换 token 要 key+secret 成对），
      // 与飞书 app_id 同口径：明文回显，否则客户没法核对自己填的是哪个应用。
      app_key: data.app_key || "",
      app_secret: mask(data.app_secret || ""),
      // secret 里叫 `webhook_url`，对外叫 `push_webhook_url` —— 见文件头「命名陷阱」。
      push_webhook_url: mask(data.webhook_url || ""),
      // 客户要粘进钉钉开放平台的**公开入口地址**，不是凭证 —— 不脱敏。
      // 空串 = 查不到（没装 IM / 前缀不符 / 无权限），界面退回「去 Outputs 里找」。
      webhook_url: webhookUrl,
    },
  };
}

/** PUT：校验 + 合并（脱敏字段不覆盖）+ 写回。 */
export async function apiPutDingtalkConfig(body) {
  if (!body || body.platform !== "dingtalk" || !body.config || typeof body.config !== "object") {
    return { error: "platform must be 'dingtalk' and config object is required", status: 400 };
  }
  const cfg = body.config;
  if (cfg.app_key && !APP_KEY_RE.test(cfg.app_key)) {
    return {
      error: `Invalid DingTalk app_key format: ${cfg.app_key} (expected at least 8 characters, letters/digits/-/_ only)`,
      status: 400,
    };
  }
  const existing = (await readSecret()) || {};
  const pushUrl = mergeIfMasked(cfg.push_webhook_url ?? "", existing.webhook_url ?? "");
  if (pushUrl) {
    let u;
    try { u = new URL(pushUrl); } catch { u = null; }
    if (!u || u.protocol !== "https:" || u.hostname !== PUSH_HOST || u.pathname !== PUSH_PATH) {
      // 报错里**不回显客户填的 URL** —— 它可能是一个有效凭证，而错误响应会进浏览器
      // 控制台 / 前端日志。只说要求是什么。
      return {
        error: `Invalid DingTalk push webhook: expected https://${PUSH_HOST}${PUSH_PATH}?access_token=...`,
        status: 400,
      };
    }
  }
  const updated = {
    // 先摊开原有内容：`card_template_id`（Tier 2 卡片模板）和 CDK 建 secret 时生成的
    // `placeholder` 都不在这个表单里，摊开才不会被这次保存悄悄抹掉。
    ...existing,
    app_key: cfg.app_key ?? existing.app_key ?? "",
    app_secret: mergeIfMasked(cfg.app_secret ?? "", existing.app_secret ?? ""),
    webhook_url: pushUrl,
  };
  const payload = JSON.stringify(updated);
  try {
    await sm.send(new UpdateSecretCommand({ SecretId: SECRET_ID, SecretString: payload }));
  } catch (e) {
    if (e?.name === "ResourceNotFoundException") {
      await sm.send(new CreateSecretCommand({ Name: SECRET_ID, SecretString: payload }));
    } else throw e;
  }
  return { message: "DingTalk config updated successfully" };
}

/* ───────────────── 测试（钉钉服务端 API 原生）───────────────── */

const NEW_API = "https://api.dingtalk.com";
let doFetch = (...a) => fetch(...a);

/**
 * POST /test：验证凭证，能推就顺手推一条。
 *
 * 钉钉**没有**"往任意群发一条测试消息"的接口 —— 机制 2（`groupMessages/send`）要
 * `openConversationId`，那个 id 只能从机器人收到的回调报文里拿；机制 3
 * （`oToMessages/batchSend`）要 staffId。所以这里做的是两件**能做到**的事：
 *
 *   1. 用 app_key / app_secret 换一次 access_token —— 这是凭证是否正确的**权威判据**
 *      （错了钉钉直接返回 errcode，而不是"发出去了但没人收到"）；
 *   2. 如果填了自定义机器人推送地址，往那个地址发一条 markdown。
 *
 * 刻意**不**假装"已发送到你的群里"：飞书那边的测试是真发一条到 chat_id，钉钉做不到，
 * 文案上必须说清差别，否则客户会等一条永远不会来的消息（「不许静默降级」）。
 */
export async function apiTestDingtalkSend(body) {
  if (body?.platform !== "dingtalk") return { error: "platform must be 'dingtalk'", status: 400 };
  const secret = await readSecret();
  const appKey = String(secret?.app_key || "").trim();
  const appSecret = String(secret?.app_secret || "").trim();
  if (!appKey || !appSecret) {
    return { success: false, message: "DingTalk app_key/app_secret not configured yet" };
  }
  let token;
  try {
    const r = await doFetch(`${NEW_API}/v1.0/oauth2/accessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appKey, appSecret }),
    });
    const j = await r.json();
    token = j?.accessToken;
    if (!token) {
      // 钉钉的错误体是 {code, message}；`message` 是钉钉自己的文案，不含我们的凭证。
      return { success: false, message: `DingTalk credential check failed: ${j?.code || r.status} ${j?.message || ""}`.trim() };
    }
  } catch (e) {
    return { success: false, message: `DingTalk credential check failed: ${e?.name || "Error"}` };
  }
  const pushUrl = String(secret?.webhook_url || "").trim();
  if (!pushUrl) {
    return {
      success: true,
      message: "Credentials are valid (access token obtained). No custom-robot webhook is configured, "
        + "so nothing was sent — that is expected: DingTalk has no API to post a test message into an "
        + "arbitrary group. To verify end to end, @-mention the robot in your group.",
    };
  }
  try {
    const r = await doFetch(pushUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: {
          title: "NotiOps test notification",
          text: "### ✅ NotiOps test notification\n\nIf you see this message, the DingTalk push webhook is correct.",
        },
      }),
    });
    const j = await r.json();
    if (j?.errcode === 0) return { success: true, message: "Credentials are valid and a test message was pushed." };
    // errmsg 由钉钉给出（典型：加签校验失败 / 关键词不匹配 / access_token 无效）。
    // **不回显 pushUrl** —— 它本身是凭证。
    return { success: false, message: `Credentials are valid, but the push webhook rejected the message: errcode=${j?.errcode} ${j?.errmsg || ""}`.trim() };
  } catch (e) {
    return { success: false, message: `Credentials are valid, but the push webhook request failed: ${e?.name || "Error"}` };
  }
}
