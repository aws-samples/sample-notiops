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

const SECRET_ID = process.env.FEISHU_SECRET_NAME || "notiops/im-bot-feishu";
const sm = new SecretsManagerClient({});

const APP_ID_RE = /^cli_[a-zA-Z0-9]+$/;
const CHAT_ID_RE = /^oc_[a-zA-Z0-9]+$/;

/** 脱敏：只留后 4 位。 */
const mask = (v) => (!v || v.length <= 4 ? "****" : `****${v.slice(-4)}`);
/** 回传值若是脱敏形态(****xxxx) → 保留原值。 */
const mergeIfMasked = (nv, ov) => (typeof nv === "string" && nv.startsWith("****") && nv.length <= 8 ? ov : nv);

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
  const data = (await readSecret()) || {};
  return {
    feishu: {
      app_id: data.app_id || "",
      app_secret: mask(data.app_secret || ""),
      verification_token: mask(data.verification_token || ""),
      encrypt_key: mask(data.encrypt_key || ""),
      notify_chat_ids: data.notify_chat_ids || "",
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
