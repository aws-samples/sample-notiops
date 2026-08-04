/**
 * Skills 数据层 —— 接 BFF（存 S3，与 IM 端 core/skill_registry.py 共享同一份 skills）。
 *
 * 后端路由（bff/web-chat/index.mjs + skills.mjs）：
 *   GET    /skills          → 列表（精简）
 *   GET    /skills/{id}     → 单个（含 body）
 *   POST   /skills          → 新建/更新（upsert）
 *   DELETE /skills/{id}     → 删除
 * 都走 SigV4（复用 chat.ts 的 signedClient）。
 */
import { signedClient } from "./chat";

/** 某个 skill 在一个 Agent Space 里的上传记录（meta.devops_agent.uploads[account|"self"]）。 */
export interface DevopsUpload {
  asset_id: string;
  agent_space_id: string;
  scope: "self" | "cross-payer";
  account_id: string;
  uploaded_version?: string;
  uploaded_at?: string;
}
export interface DevopsAgentStatus {
  uploads?: Record<string, DevopsUpload>;   // key = account_id 或 "self"
  last_action?: string;
}

export interface Skill {
  skill_id: string;
  name: string;
  description: string;
  body?: string;          // 列表里不带 body；getSkill 才有
  version?: string;       // getSkill 返回的当前(或指定)版本
  latest_version?: string;
  updated_at: number;
  author?: string;        // 预置=notiops-system；客户自建=web/其它
  version_count?: number; // 版本数（列表行内展示）
  devops_agent?: DevopsAgentStatus | null;  // 世界 B 上传状态
  format?: string;        // "agent-skill/v1"（开放标准）
  // 多语言展示文本（仅预置 skill 有：{ zh:{name,description}, en:{...} }）。
  // 客户自建 skill 通常无此字段 → 照原文（原上传语言）展示。
  i18n?: { zh?: { name?: string; description?: string }; en?: { name?: string; description?: string } } | null;
  // 本地化正文：body_i18n = 有译文正文的语言列表（如 ["zh"]）；body_locale = getSkill 本次返回正文的语言
  // （""=规范正文/原文）。仅预置 skill 有；用于按 UI 语言展示对应语言的 Skill 正文。
  body_i18n?: string[];
  body_locale?: string;
}

/** 预置 skill 的 author 标记（后端 PRESET_AUTHOR）。只有预置才随 NotiOps 语言切换展示文本。 */
export const PRESET_AUTHOR = "notiops-system";

/** 按当前 NotiOps 语言取 skill 的展示名/描述。
 *  - 预置 skill（author=notiops-system 且带 i18n）：返回该语言的译文，缺失则回退基础 name/description。
 *  - 客户自建 skill：一律照原文（客户上传时的语言），不做任何切换。 */
export function skillDisplay(s: Skill, locale: "zh" | "en"): { name: string; description: string } {
  const isPreset = (s.author || "") === PRESET_AUTHOR;
  if (isPreset && s.i18n && s.i18n[locale]) {
    const loc = s.i18n[locale]!;
    return {
      name: (loc.name && loc.name.trim()) || s.name,
      description: (loc.description && loc.description.trim()) || s.description || "",
    };
  }
  return { name: s.name, description: s.description || "" };
}

/** 是否预置 skill（author=notiops-system，随 NotiOps 出厂）；否则视为客户自建。
 *  单一事实来源，供 /命令菜单、Customize 列表等处统一区分预置/自建。 */
export function isPresetSkill(s: Skill): boolean {
  return (s.author || "") === PRESET_AUTHOR;
}

/** DevOps Agent 上传目标（本账号 + 已接入 da# 成员账号）。 */
export interface DevopsTarget {
  account_id: string;
  agent_space_id: string;
  scope: "self" | "cross-payer";
  label: string;
}

export interface SkillVersion {
  version: string;
  changelog: string;
  created_at: string;
  created_by: string;
  is_latest: boolean;
}

/** kebab-case 化（与后端 skill_id 规则一致）。前端展示/兜底用。 */
export function slugify(name: string): string {
  const s = (name || "").trim().toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return s || `skill-${Date.now().toString(36)}`;
}

export async function listSkills(): Promise<Skill[]> {
  const s = await signedClient();
  if (!s) return [];
  const r = await s.aws.fetch(`${s.base}/skills`, { headers: { "x-notiops-id-token": s.idToken } });
  if (!r.ok) return [];
  const d = await r.json();
  return Array.isArray(d.skills) ? d.skills : [];
}

export async function getSkill(skillId: string, version?: string, locale?: "zh" | "en"): Promise<Skill | null> {
  const s = await signedClient();
  if (!s) return null;
  const qs = new URLSearchParams();
  if (version) qs.set("version", version);
  if (locale) qs.set("locale", locale);
  const q = qs.toString() ? `?${qs.toString()}` : "";
  const r = await s.aws.fetch(`${s.base}/skills/${encodeURIComponent(skillId)}${q}`, {
    headers: { "x-notiops-id-token": s.idToken },
  });
  if (!r.ok) return null;
  return r.json();
}

/** 查 skill_id 是否已存在（新建时实时查重）。 */
export async function skillExists(skillId: string): Promise<boolean> {
  const s = await signedClient();
  if (!s || !skillId) return false;
  const r = await s.aws.fetch(`${s.base}/skills/${encodeURIComponent(skillId)}/exists`, {
    headers: { "x-notiops-id-token": s.idToken },
  });
  if (!r.ok) return false;
  return (await r.json()).exists === true;
}

export async function listVersions(skillId: string): Promise<SkillVersion[]> {
  const s = await signedClient();
  if (!s) return [];
  const r = await s.aws.fetch(`${s.base}/skills/${encodeURIComponent(skillId)}/versions`, {
    headers: { "x-notiops-id-token": s.idToken },
  });
  if (!r.ok) return [];
  return (await r.json()).versions || [];
}

export async function rollbackSkill(skillId: string, version: string): Promise<void> {
  const s = await signedClient();
  if (!s) return;
  await s.aws.fetch(`${s.base}/skills/${encodeURIComponent(skillId)}/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-notiops-id-token": s.idToken },
    body: JSON.stringify({ version }),
  });
}

export async function saveSkill(input: { skill_id?: string; name: string; description: string; body: string; mode?: "create" | "update" }): Promise<Skill> {
  const s = await signedClient();
  if (!s) throw new Error("not signed in");
  const r = await s.aws.fetch(`${s.base}/skills`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-notiops-id-token": s.idToken },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `save failed (${r.status})`);
  }
  return r.json();
}

/** 上传 Claude Skills 格式 zip（base64）导入。 */
export async function importSkillZip(zipBase64: string, skillId?: string): Promise<Skill> {
  const s = await signedClient();
  if (!s) throw new Error("not signed in");
  const r = await s.aws.fetch(`${s.base}/skills/import`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-notiops-id-token": s.idToken },
    body: JSON.stringify({ zip_base64: zipBase64, skill_id: skillId || "" }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `import failed (${r.status})`);
  }
  return r.json();
}

export async function deleteSkill(skillId: string): Promise<void> {
  const s = await signedClient();
  if (!s) return;
  await s.aws.fetch(`${s.base}/skills/${encodeURIComponent(skillId)}`, {
    method: "DELETE",
    headers: { "x-notiops-id-token": s.idToken },
  });
}

/* ── 世界 B：发布到 DevOps Agent 的 Agent Space ───────────────────────────── */

/** 列出可上传的 Agent Space 目标（本账号 + 已接入的 da# 成员账号）。 */
export async function listDevopsTargets(): Promise<DevopsTarget[]> {
  const s = await signedClient();
  if (!s) return [];
  const r = await s.aws.fetch(`${s.base}/skills/devops-agent/targets`, {
    headers: { "x-notiops-id-token": s.idToken },
  });
  if (!r.ok) return [];
  return (await r.json()).targets || [];
}

export interface DevopsUploadResult {
  ok: boolean; assetId?: string; action?: "created" | "updated";
  agentSpaceId?: string; accountId?: string; scope?: string;
}

/** 把 skill 发布到 DevOps Agent（accountId 空=本账号；否则跨 payer 成员账号）。 */
export async function uploadSkillToDevops(skillId: string, accountId = ""): Promise<DevopsUploadResult> {
  const s = await signedClient();
  if (!s) throw new Error("not signed in");
  const r = await s.aws.fetch(`${s.base}/skills/${encodeURIComponent(skillId)}/devops-agent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-notiops-id-token": s.idToken },
    body: JSON.stringify({ account_id: accountId }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `upload failed (${r.status})`);
  }
  return r.json();
}

/** 从 DevOps Agent 撤下 skill（accountId 指定目标）。 */
export async function removeSkillFromDevops(skillId: string, accountId = ""): Promise<void> {
  const s = await signedClient();
  if (!s) return;
  const q = accountId ? `?account_id=${encodeURIComponent(accountId)}` : "";
  const r = await s.aws.fetch(`${s.base}/skills/${encodeURIComponent(skillId)}/devops-agent${q}`, {
    method: "DELETE",
    headers: { "x-notiops-id-token": s.idToken },
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `remove failed (${r.status})`);
  }
}
