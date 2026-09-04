/**
 * 飞书机器人通知配置（Admin「通知」板块）。
 *
 * GET  /admin/notification-config       读配置（敏感字段脱敏 ****后4位）
 * PUT  /admin/notification-config       写配置（脱敏字段回传不覆盖原值）
 * POST /admin/notification-config/test  向指定 chat_id 发测试消息
 *
 * 存储 = Secrets Manager 单 secret `notiops/im-bot-feishu`（通知基础设施的数据面：
 * 每日推送/DevOps 回调/PHD/push handler/飞书 bot 都按名读它）。**按字面名引用、
 * 不做跨栈 CFN import** —— 老管理前端(frontend-app)及其 API 未来 sunset 时本模块零影响。
 * 测试发送用 Feishu OpenAPI 原生实现（tenant_access_token + im/v1/messages），
 * 不依赖老 Python shared/feishu_sender.py。
 */
import {
  SecretsManagerClient, GetSecretValueCommand, UpdateSecretCommand, CreateSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import { ApiGatewayV2Client, GetApisCommand } from "@aws-sdk/client-apigatewayv2";

const SECRET_ID = process.env.FEISHU_SECRET_NAME || "notiops/im-bot-feishu";
let sm = new SecretsManagerClient({});
let agw = new ApiGatewayV2Client({});

/** 测试接缝：注入假 Secrets Manager / API Gateway 客户端（风格同 llm_config.mjs 的 __setClients）。 */
export function __setClients(overrides = {}) {
  if (overrides.sm) sm = overrides.sm;
  if (overrides.agw) agw = overrides.agw;
  if (overrides.resetCache) webhookUrlCache = undefined;
}

const APP_ID_RE = /^cli_[a-zA-Z0-9]+$/;
const CHAT_ID_RE = /^oc_[a-zA-Z0-9]+$/;

/**
 * 脱敏：只留后 4 位。
 *
 * **空值必须回显空串,不能回显 `****`** —— 否则「未配置」和「已配置」在界面上长得
 * 一模一样:全新安装（以及从长连接升级上来的栈，两把钥匙都是空串）会在 Encrypt Key /
 * Verification Token 里看到 `****`，客户据此认为已经配好、跳过飞书那边的加密策略，
 * 最后拿到一个「校验失败」去查请求地址。空 = 空白输入框 = 明摆着还没填。
 *
 * 长度 ≤4 的非空值仍然整串遮掉（`****`），不能露出后 4 位 —— 那就是全部。
 */
const mask = (v) => (!v ? "" : v.length <= 4 ? "****" : `****${v.slice(-4)}`);
/** 回传值若是脱敏形态(****xxxx) → 保留原值。空串不以 **** 开头，所以「清空」仍是清空。 */
const mergeIfMasked = (nv, ov) => (typeof nv === "string" && nv.startsWith("****") && nv.length <= 8 ? ov : nv);

/* ───────────────── Webhook 地址（给抽屉里的「复制」按钮）───────────────── */

/**
 * 飞书 webhook 地址 = IM 入口 HTTP API 的 endpoint。
 *
 * 客户拿这个地址原本得自己去 CloudFormation → Outputs → FeishuWebhookUrl 翻一趟，
 * 而配飞书那半个流程全在浏览器里 —— 中间插一段"去另一个控制台找一串 URL"是这条路上
 * 唯一需要离开本页的一步。所以直接查出来显示在抽屉里。
 *
 * **按名字查，不按跨栈引用拿**：`IM_INGRESS_API_NAME_PREFIX` 由 CDK 注入
 *（方式 B `notiops-im-ingress-`、方式 A `<栈名>-im-ingress-`，见
 * infra/lib/constructs/web-chat-core.ts 里那段长注释解释为什么不能直接塞地址）。
 * 与本模块按字面名读 secret 是同一套思路。
 *
 * 三种"查不到"都返回空串、**不抛错**：IM 压根没装（InstallOption=web）、
 * 前缀与实际名字不一致、GetApis 没权限。空串在界面上退回"去 Outputs 里找"的说明 ——
 * 抽屉是操作指引，不该因为一个便利功能整页打不开。
 */
let webhookUrlCache;

async function resolveWebhookUrl(platform = "feishu") {
  if (webhookUrlCache !== undefined) return webhookUrlCache;
  const prefix = process.env.IM_INGRESS_API_NAME_PREFIX || "";
  if (!prefix) return (webhookUrlCache = "");
  const wanted = `${prefix}${platform}`;
  try {
    let next;
    do {
      const r = await agw.send(new GetApisCommand({ MaxResults: "100", NextToken: next }));
      const hit = (r.Items || []).find((a) => a.Name === wanted);
      // ApiEndpoint 不带结尾的 `/`；$default stage 不出现在路径里，所以补一个 `/`
      // 就是客户要填进飞书的那个形态（与 CfnOutput FeishuWebhookUrl 一字不差）。
      if (hit?.ApiEndpoint) return (webhookUrlCache = `${hit.ApiEndpoint}/`);
      next = r.NextToken;
    } while (next);
    return (webhookUrlCache = "");
  } catch (e) {
    // 只记异常类型名（docs/LOGGING_STANDARD.md）；这条路失败不影响配置读写。
    console.warn(`[BFF] resolve IM webhook url failed: ${e?.name || "Error"}`);
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
export async function apiGetNotificationConfig() {
  const [data, webhookUrl] = await Promise.all([
    readSecret().then((d) => d || {}),
    resolveWebhookUrl("feishu"),
  ]);
  return {
    feishu: {
      app_id: data.app_id || "",
      app_secret: mask(data.app_secret || ""),
      verification_token: mask(data.verification_token || ""),
      encrypt_key: mask(data.encrypt_key || ""),
      notify_chat_ids: data.notify_chat_ids || "",
      // 抽屉第 3 步直接显示 + 一键复制；空串 = 查不到，界面退回"去 Outputs 里找"。
      // 这不是凭证，是客户要贴进飞书控制台的公开入口地址 —— 不脱敏。
      webhook_url: webhookUrl,
    },
  };
}

/** PUT：校验 + 合并（脱敏字段不覆盖）+ 写回。 */
export async function apiPutNotificationConfig(body) {
  if (!body || body.platform !== "feishu" || !body.config || typeof body.config !== "object") {
    return { error: "platform must be 'feishu' and config object is required", status: 400 };
  }
  const cfg = body.config;
  if (cfg.app_id && !APP_ID_RE.test(cfg.app_id)) {
    return { error: `Invalid Feishu app_id format: ${cfg.app_id} (should start with cli_)`, status: 400 };
  }
  for (const id of String(cfg.notify_chat_ids || "").split(",")) {
    const c = id.trim();
    if (c && !CHAT_ID_RE.test(c)) {
      return { error: `Invalid Feishu chat_id format: ${c} (should start with oc_)`, status: 400 };
    }
  }
  const existing = (await readSecret()) || {};
  const updated = {
    app_id: cfg.app_id ?? existing.app_id ?? "",
    app_secret: mergeIfMasked(cfg.app_secret ?? "", existing.app_secret ?? ""),
    verification_token: mergeIfMasked(cfg.verification_token ?? "", existing.verification_token ?? ""),
    encrypt_key: mergeIfMasked(cfg.encrypt_key ?? "", existing.encrypt_key ?? ""),
    notify_chat_ids: cfg.notify_chat_ids ?? existing.notify_chat_ids ?? "",
  };
  const payload = JSON.stringify(updated);
  try {
    await sm.send(new UpdateSecretCommand({ SecretId: SECRET_ID, SecretString: payload }));
  } catch (e) {
    if (e?.name === "ResourceNotFoundException") {
      await sm.send(new CreateSecretCommand({ Name: SECRET_ID, SecretString: payload }));
    } else throw e;
  }
  return { message: "Feishu config updated successfully" };
}

/* ───────────────── 测试发送（Feishu OpenAPI 原生）───────────────── */

const FEISHU_API = "https://open.feishu.cn/open-apis";

async function tenantToken(appId, appSecret) {
  const r = await fetch(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const j = await r.json();
  if (j.code !== 0 || !j.tenant_access_token) {
    throw new Error(`get tenant_access_token failed: code=${j.code} ${j.msg || ""}`);
  }
  return j.tenant_access_token;
}

/** POST /test：向 chat_id 发一条文本测试消息。 */
export async function apiTestNotificationSend(body) {
  const chatId = body?.chat_id;
  if (body?.platform !== "feishu") return { error: "platform must be 'feishu'", status: 400 };
  if (!chatId || !CHAT_ID_RE.test(chatId)) {
    return { error: `Invalid Feishu chat_id format: ${chatId || "(empty)"} (should start with oc_)`, status: 400 };
  }
  const secret = await readSecret();
  if (!secret || !secret.app_id || !secret.app_secret) {
    return { success: false, message: "Feishu app_id/app_secret not configured yet" };
  }
  try {
    const token = await tenantToken(secret.app_id, secret.app_secret);
    const r = await fetch(`${FEISHU_API}/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text: "✅ NotiOps test notification.\nIf you receive this message, the notification config is correct." }),
      }),
    });
    const j = await r.json();
    if (j.code === 0) return { success: true, message: "Test message sent successfully" };
    return { success: false, message: `Feishu API error: code=${j.code} ${j.msg || ""}` };
  } catch (e) {
    return { success: false, message: `Failed to send test message: ${e?.message || e}` };
  }
}
