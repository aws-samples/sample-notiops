/**
 * Skills 存储（S3）—— 与 IM 端 core/skill_registry.py **完全同构**，共享同一份 skills。
 *
 * S3 布局（bucket = SKILLS_BUCKET = notiops 的 dataBucket，前缀 skills/）:
 *   skills/<skill_id>/meta.json          索引：name, description, latest_version, versions[], status...
 *   skills/<skill_id>/versions/<ver>.md  该版本的 prompt 正文
 *
 * web 端这一版只做 list/get/save(create+update)/delete，够 Customize 页用；
 * 版本号沿用语义化（首版 1.0.0，更新 patch+1），与 IM 端一致，互不冲突。
 */
import {
  S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { inflateRawSync } from "node:zlib";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BUCKET = process.env.SKILLS_BUCKET || "";
const PREFIX = "skills";
const s3 = new S3Client({});

const metaKey = (id) => `${PREFIX}/${id}/meta.json`;
const verKey = (id, ver) => `${PREFIX}/${id}/versions/${ver}.md`;
// 本地化正文（仅预置 skill 用）：与规范正文同版本号，扩展名前加语言后缀。
//   规范(英文/原文)：versions/<ver>.md   ；中文：versions/<ver>.zh.md
// 规范 SKILL.md 始终是开放标准可导出的英文；zh 只是「展示/注入」用的译文覆盖，不影响世界 B 导出。
const verKeyLoc = (id, ver, loc) => `${PREFIX}/${id}/versions/${ver}.${loc}.md`;
// 支持本地化正文的语言集合（当前仅中文；英文=规范正文本身，不另存）。
const BODY_LOCALES = new Set(["zh"]);
// skill_id == Agent Skills 开放标准里的 `name`（小写 kebab，2-64 位）——两边同一套约束，
// 这样一个 skill 既是 NotiOps 的 prompt-template（世界 A），导出后也是合法的 SKILL.md（世界 B）。
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
// 附属文件（references/ assets/…）在 S3 里的存放前缀：skills/<id>/files/<relpath>。
// 只对世界 B（DevOps Agent skill zip）有意义；世界 A 注入只用 body，故不影响 IM/web-agent。
const filesPrefix = (id) => `${PREFIX}/${id}/files/`;
// “脚本”判定：暂时禁止（DevOps Agent 也拒 scripts/，未来有沙箱再开）。
// 导入时命中的文件会被剥离并计数，import 仍成功（比直接报错体验好）。
const SCRIPT_EXT_RE = /\.(py|js|mjs|cjs|ts|sh|bash|zsh|rb|ps1|bat|cmd|pl|php|exe)$/i;
const isScriptPath = (p) => /(^|\/)scripts?\//i.test(p) || SCRIPT_EXT_RE.test(p);
// 附属文件白名单（Agent Skills 允许的非可执行文档：md/txt/pdf/图片/数据）。其余忽略。
const ASSET_EXT_RE = /\.(md|markdown|txt|json|ya?ml|csv|tsv|pdf|png|jpe?g|gif|svg|webp)$/i;
const SKILL_FORMAT = "agent-skill/v1";

// 注：早期版本有 execution_mode（local / devops-agent / both）让客户在配置页指定 skill 的执行方式，
// 已废弃——所有 skill 本地都能跑；是否发布到 DevOps Agent 只是**解锁深度调查增强**，由对话里的
// DevOps Agent 开关决定本轮是否走 investigate_live。不再解析/落库/导出该字段（见 SKILL.md frontmatter）。

const _now = () => new Date().toISOString();

async function _streamToString(body) {
  if (!body) return "";
  if (typeof body.transformToString === "function") return body.transformToString("utf-8");
  const chunks = [];
  for await (const c of body) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf-8");
}

async function _getJson(key) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return JSON.parse(await _streamToString(r.Body));
  } catch (e) {
    if (e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

async function _getText(key) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return await _streamToString(r.Body);
  } catch (e) {
    if (e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) return "";
    throw e;
  }
}

// skill_id 必须是 ASCII kebab-case（与 ID_RE 一致）。中文/非 ASCII 字符**丢弃**
// （不保留中文，否则生成的 id 不合法、/skill 也不好打）。全丢光则给个兜底 id。
function slugify(name) {
  const s = (name || "").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return s || `skill-${Date.now().toString(36)}`;
}

function _bumpPatch(ver) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(ver || "1.0.0");
  if (!m) return "1.0.1";
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** 列出全部 active skills（每个读一次 meta.json）。返回精简列表供前端展示。 */
export async function listSkills() {
  if (!BUCKET) throw new Error("SKILLS_BUCKET not configured");
  // 首次访问自动注入预置 skills（每个容器只尝试一次，幂等且非致命）——保证客户开箱即见官方 skill，
  // 不必等管理员手动 seed；已存在则 seedPresetSkills 内部会跳过，成本极低。
  await _ensurePresetsSeeded();
  const out = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: `${PREFIX}/`, Delimiter: "/", ContinuationToken: token,
    }));
    for (const p of r.CommonPrefixes || []) {
      const id = p.Prefix.replace(`${PREFIX}/`, "").replace(/\/$/, "");
      if (id === "_audit" || !id) continue;
      const meta = await _getJson(metaKey(id));
      if (!meta || meta.status === "archived") continue;
      out.push({
        skill_id: meta.skill_id || id,
        name: meta.name || id,
        description: meta.description || "",
        updated_at: Date.parse(meta.updated_at || "") || 0,
        // 列表管理用：author 区分预置(notiops-system)/客户自建；版本号 + 版本数行内展示。
        author: meta.author || "",
        latest_version: meta.latest_version || "",
        version_count: Array.isArray(meta.versions) ? meta.versions.length : 0,
        // 世界 B（DevOps Agent）上传状态，供前端展示「已上传/未上传」徽标与按钮态。
        devops_agent: meta.devops_agent || null,
        format: meta.format || "",
        // 多语言展示文本（仅预置 skill 有；客户自建通常为空 → 前端照原文展示）。
        i18n: meta.i18n || null,
      });
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  out.sort((a, b) => b.updated_at - a.updated_at);
  return out;
}

/** 取单个 skill（含正文 body）。
 *  locale 给定且该 skill 有对应语言的本地化正文（meta.body_i18n 含该语言）→ 返回译文正文，
 *  否则返回规范正文（英文/原文）。仅预置 skill 会有本地化正文；客户自建照原文。 */
export async function getSkill(skillId, version, locale) {
  if (!BUCKET) throw new Error("SKILLS_BUCKET not configured");
  const meta = await _getJson(metaKey(skillId));
  if (!meta) return null;
  const ver = version || meta.latest_version || "1.0.0";
  const loc = String(locale || "").trim().toLowerCase();
  const hasLoc = BODY_LOCALES.has(loc) && Array.isArray(meta.body_i18n) && meta.body_i18n.includes(loc);
  let body = "";
  if (hasLoc) body = await _getText(verKeyLoc(skillId, ver, loc));
  if (!body) body = await _getText(verKey(skillId, ver));   // 译文缺失/为空 → 回退规范正文
  return {
    skill_id: meta.skill_id || skillId,
    name: meta.name || skillId,
    description: meta.description || "",
    body,
    // 本轮返回正文的语言（用于前端标注/回退判断）；无译文则为规范正文语言标记 ""。
    body_locale: hasLoc && body ? loc : "",
    // 该 skill 有本地化正文的语言列表（供前端判断是否可切换）。
    body_i18n: Array.isArray(meta.body_i18n) ? meta.body_i18n : [],
    version: ver,
    latest_version: meta.latest_version || ver,
    updated_at: Date.parse(meta.updated_at || "") || 0,
    author: meta.author || "",
    devops_agent: meta.devops_agent || null,
    format: meta.format || "",
    // 多语言展示文本（仅预置 skill 有；客户自建通常为空 → 前端照原文展示）。
    i18n: meta.i18n || null,
    // 附属文件清单（世界 B 打包用）：只回相对路径，正文不含 body。
    files: Array.isArray(meta.files) ? meta.files : [],
  };
}

/** 版本历史（最新在前）：[{version, changelog, created_at, created_by, is_latest}]。 */
export async function listVersions(skillId) {
  if (!BUCKET) throw new Error("SKILLS_BUCKET not configured");
  const meta = await _getJson(metaKey(skillId));
  if (!meta) return [];
  const latest = meta.latest_version;
  return [...(meta.versions || [])].reverse().map((v) => ({
    version: v.version,
    changelog: v.changelog || "",
    created_at: v.created_at || "",
    created_by: v.created_by || "",
    is_latest: v.version === latest,
  }));
}

/** 回滚：把 latest_version 指向某个历史版本（正文不动，只改指针）。 */
export async function rollbackSkill(skillId, version) {
  if (!BUCKET) throw new Error("SKILLS_BUCKET not configured");
  const meta = await _getJson(metaKey(skillId));
  if (!meta) throw new Error("skill not found");
  if (!(meta.versions || []).some((v) => v.version === version)) {
    throw new Error(`version not found: ${version}`);
  }
  meta.latest_version = version;
  meta.updated_at = _now();
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: metaKey(skillId),
    Body: Buffer.from(JSON.stringify(meta), "utf-8"), ContentType: "application/json",
  }));
  return { ok: true, latest_version: version };
}

/** 查 skill_id 是否已存在（创建时前端实时查重用）。 */
export async function skillExists(skillId) {
  if (!BUCKET || !skillId) return false;
  return (await _getJson(metaKey(skillId))) !== null;
}

/** 新建或更新（按 skill_id upsert，写一个新版本 + 更新 meta）。返回保存后的精简对象。
 * mode='create' 时若 id 已存在则报错（防止覆盖别人的 skill）；mode='update' 才允许覆盖。 */
export async function saveSkill({ skill_id, name, description, body, author = "web", mode = "", i18n, body_i18n, forceAuthor = false }) {
  if (!BUCKET) throw new Error("SKILLS_BUCKET not configured");
  const id = (skill_id && ID_RE.test(skill_id)) ? skill_id : slugify(name);
  if (!ID_RE.test(id)) throw new Error("invalid skill_id (need lowercase a-z, 0-9, -)");
  if (!body || body.trim().length < 20) throw new Error("prompt too short (min 20 chars)");

  const existing = await _getJson(metaKey(id));
  if (mode === "create" && existing) {
    throw new Error(`skill_id 已存在：${id}（换个 ID 或改为编辑现有 skill）`);
  }
  const version = existing ? _bumpPatch(existing.latest_version) : "1.0.0";

  // 1) 写版本正文（规范：英文/原文）
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: verKey(id, version),
    Body: Buffer.from(body, "utf-8"), ContentType: "text/markdown",
  }));
  // 1b) 本地化正文（仅预置 skill 传入 body_i18n = { zh: "..." }）：与规范正文同版本号另存。
  //     每次保存都随新版本重写，保证 meta.body_i18n 只指向 latest_version 存在的译文。
  const bodyLocales = [];
  if (body_i18n && typeof body_i18n === "object") {
    for (const loc of Object.keys(body_i18n)) {
      const lc = String(loc).trim().toLowerCase();
      const txt = String(body_i18n[loc] || "").trim();
      if (!BODY_LOCALES.has(lc) || txt.length < 20) continue;
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: verKeyLoc(id, version, lc),
        Body: Buffer.from(txt, "utf-8"), ContentType: "text/markdown",
      }));
      bodyLocales.push(lc);
    }
  }

  // 2) 写/更新 meta（结构与 skill_registry 对齐）
  const meta = existing || {
    skill_id: id, parameters: [], tags: [], status: "active",
    author, created_channel: "web", created_at: _now(), versions: [],
  };
  // 更新已有 skill 时默认保留原 author（尊重创建者）；仅当 forceAuthor=true 才改写——
  // 用于预置 seed 归一化：把历史 seed 误写的 author 纠正为 PRESET_AUTHOR。普通编辑不传此参。
  if (forceAuthor && author) meta.author = author;
  meta.name = (name || id).trim();
  meta.description = (description || "").trim();
  meta.format = SKILL_FORMAT;          // 标记为 Agent Skills 开放标准
  // i18n：预置 skill 的多语言展示文本 { zh:{name,description}, en:{...} }。显式传入则落库；
  // 传 null 显式清除；未传（undefined）保留已有——避免普通编辑把预置译文清掉。
  if (i18n !== undefined) { if (i18n) meta.i18n = i18n; else delete meta.i18n; }
  // body_i18n：本次实际写出的本地化正文语言列表（指向新版本号）。显式传入 body_i18n 才更新，
  // 否则清空（因为旧版本的译文不再随新版本号存在，避免 meta 指向缺失的译文文件）。
  if (body_i18n !== undefined) {
    if (bodyLocales.length) meta.body_i18n = bodyLocales; else delete meta.body_i18n;
  }
  meta.latest_version = version;
  meta.updated_at = _now();
  meta.updated_by = author;
  meta.updated_channel = "web";
  meta.versions = [...(meta.versions || []), {
    version, changelog: existing ? "updated via web" : "initial version",
    bump_level: existing ? "patch" : "initial", created_at: _now(), created_by: author,
  }];
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: metaKey(id),
    Body: Buffer.from(JSON.stringify(meta), "utf-8"), ContentType: "application/json",
  }));
  return { skill_id: id, name: meta.name, description: meta.description, updated_at: Date.now() };
}

/** 删除整个 skill（meta + 所有版本）。 */
export async function deleteSkill(skillId) {
  if (!BUCKET) throw new Error("SKILLS_BUCKET not configured");
  if (!ID_RE.test(skillId)) throw new Error("invalid skill_id");
  // 列出该 skill 前缀下所有对象，批量删除
  const keys = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: `${PREFIX}/${skillId}/`, ContinuationToken: token,
    }));
    for (const o of r.Contents || []) keys.push({ Key: o.Key });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  if (keys.length) {
    await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys } }));
  }
  return { ok: true };
}

// ── zip 导入（Claude Skills 格式）──────────────────────────────────────────
// 纯 Node unzip：解析**中央目录**（每个合法 zip 末尾的权威索引），而非顺序读本地头。
// 这样能可靠处理所有主流工具的产物——包括用数据描述符（bit3）的流式 zip（zip CLI /
// Java / Python 流式写入都会产生），其本地头里 compSize=0，顺序解析会失败。
// 同时强制大小上限，防 zip 炸弹 / 超大上传拖垮 Lambda（生产环境客户上传不可信）。
const MAX_ZIP_BYTES = 10 * 1024 * 1024;          // 输入 zip ≤ 10MB
const MAX_ENTRIES = 2000;                         // 条目数上限
const MAX_FILE_UNCOMPRESSED = 8 * 1024 * 1024;    // 单文件解压后 ≤ 8MB
const MAX_TOTAL_UNCOMPRESSED = 32 * 1024 * 1024;  // 全部解压后合计 ≤ 32MB

const EOCD_SIG = 0x06054b50, CD_SIG = 0x02014b50, LFH_SIG = 0x04034b50;

function _findEocd(buf) {
  // EOCD 在文件尾部（22 字节定长 + 可选注释 ≤64KB），从尾部回扫定位签名。
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function _unzip(buf) {
  if (buf.length > MAX_ZIP_BYTES) throw new Error(`zip 过大（>${MAX_ZIP_BYTES >> 20}MB）`);
  const eocd = _findEocd(buf);
  if (eocd < 0) throw new Error("不是有效的 zip（找不到中央目录）");
  const total = buf.readUInt16LE(eocd + 10);          // 条目总数
  let cd = buf.readUInt32LE(eocd + 16);               // 中央目录起始偏移
  if (total > MAX_ENTRIES) throw new Error(`zip 条目过多（>${MAX_ENTRIES}）`);

  const files = {};
  let totalOut = 0;
  for (let e = 0; e < total && cd + 46 <= buf.length; e++) {
    if (buf.readUInt32LE(cd) !== CD_SIG) break;
    const method = buf.readUInt16LE(cd + 10);
    const compSize = buf.readUInt32LE(cd + 20);
    const uncompSize = buf.readUInt32LE(cd + 24);
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const commentLen = buf.readUInt16LE(cd + 32);
    const lho = buf.readUInt32LE(cd + 42);            // 本地头偏移
    const name = buf.toString("utf8", cd + 46, cd + 46 + nameLen);
    cd += 46 + nameLen + extraLen + commentLen;        // 移到下一条中央目录项

    if (name.endsWith("/")) continue;                  // 目录项
    if (uncompSize > MAX_FILE_UNCOMPRESSED) throw new Error(`zip 内文件过大：${name}`);
    // 本地头的 name/extra 长度可能与中央目录不同，按本地头重新定位数据起点。
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== LFH_SIG) continue;
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let out;
    try {
      out = method === 0
        ? Buffer.from(comp)
        : inflateRawSync(comp, { maxOutputLength: MAX_FILE_UNCOMPRESSED });
    } catch {
      continue;  // 单条目解压失败（含超限）不致命，跳过
    }
    totalOut += out.length;
    if (totalOut > MAX_TOTAL_UNCOMPRESSED) throw new Error("zip 解压后总大小超限");
    files[name] = out;
  }
  return files; // { "<path>": Buffer }
}

/** 解析 Agent Skills 开放标准的 SKILL.md（YAML frontmatter: name/description + Markdown 正文）。
 * 只取标准的 name/description（顶层标量），忽略嵌套结构——无需引入 YAML 依赖。 */
function _parseSkillMd(text) {
  let name = "", description = "", body = text;
  let i18n = null;
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/.exec(text);
  if (m) {
    const fm = m[1];
    body = m[2];
    const nameM = /^\s*name\s*:\s*(.+?)\s*$/m.exec(fm);
    const descM = /^\s*description\s*:\s*(.+?)\s*$/m.exec(fm);
    if (nameM) name = nameM[1].replace(/^["']|["']$/g, "").trim();
    if (descM) description = descM[1].replace(/^["']|["']$/g, "").trim();
    // 多语言展示文本（可选，仅预置 skill 用）：name-zh / name-en / description-zh / description-en
    //   （下划线亦可）。收进 i18n = { zh:{name,description}, en:{...} }。前端按 NotiOps 语言选，
    //   缺失回退到基础 name/description。客户自建 skill 一般不带这些键，照原文展示（见前端 gating）。
    i18n = _parseLocalized(fm);
  }
  return { name, description, i18n, body: body.trim() };
}

/** 剥掉可选的 YAML frontmatter，返回纯正文。本地化 SKILL.<loc>.md 通常不带 frontmatter，
 * 但带了也不当回事（只取正文）。 */
function _stripFrontmatter(text) {
  const m = /^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?([\s\S]*)$/.exec(text);
  return m ? m[1] : text;
}

/** 从 frontmatter 抽取 name-zh/name-en/description-zh/description-en（下划线亦可），
 * 归成 { zh:{name?,description?}, en:{name?,description?} }。全空返回 null。 */
function _parseLocalized(fm) {
  const out = {};
  for (const loc of ["zh", "en"]) {
    for (const field of ["name", "description"]) {
      const re = new RegExp(`^\\s*${field}[-_]${loc}\\s*:\\s*(.+?)\\s*$`, "m");
      const mm = re.exec(fm);
      if (mm) {
        const v = mm[1].replace(/^["']|["']$/g, "").trim();
        if (v) { (out[loc] ||= {})[field] = v; }
      }
    }
  }
  return Object.keys(out).length ? out : null;
}

/** YAML frontmatter 里 description 值的转义：含冒号/换行等特殊字符时用双引号包起来。 */
function _yamlScalar(v) {
  const s = String(v || "").replace(/\r?\n/g, " ").trim();
  if (!s) return '""';
  if (/[:#{}[\],&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

/** 把一个 skill（meta + 正文）序列化成规范的 Agent Skills 开放标准 SKILL.md 文本。
 * frontmatter 只含标准的 name + description（DevOps Agent / Claude / Cursor 等都认这两个字段），
 * 保证导出的 zip 能被任何遵循开放标准的 agent 直接吃下。 */
export function buildSkillMd({ skill_id, name, description, body }) {
  const nm = (skill_id && ID_RE.test(skill_id)) ? skill_id : slugify(name || skill_id || "");
  const lines = ["---", `name: ${nm}`, `description: ${_yamlScalar(description)}`, "---", ""];
  return lines.join("\n") + (body || "").trim() + "\n";
}

/** 导入一个 Agent Skills 开放标准的 zip（base64）。在 zip 里找 SKILL.md（任意层级），
 * 解析 frontmatter → name/description + 正文 → body。SKILL.md 同级/子级的 references/、
 * assets/ 等非可执行文档一并存到 skills/<id>/files/（供世界 B 打包 zip 上传 DevOps Agent）；
 * scripts/ 与可执行文件被**剥离**（暂不支持），返回里报告剥离数量。 */
export async function importSkillZip(base64, { skillId = "", author = "web" } = {}) {
  if (!BUCKET) throw new Error("SKILLS_BUCKET not configured");
  let files;
  try {
    files = _unzip(Buffer.from(base64, "base64"));
  } catch (e) {
    throw new Error(`无法解析 zip：${e.message}`);
  }
  // 找 SKILL.md（优先根层，其次任意层级；大小写不敏感）。
  // 过滤 macOS 打包噪声（__MACOSX/、._ 资源派生文件）与隐藏文件，避免选错。
  const keys = Object.keys(files).filter((k) => {
    const base = k.split("/").pop() || "";
    return !k.startsWith("__MACOSX/") && !base.startsWith("._") && !base.startsWith(".");
  });
  let mdKey = keys.find((k) => /(^|\/)SKILL\.md$/i.test(k));
  if (!mdKey) mdKey = keys.find((k) => /\.md$/i.test(k)); // 兜底：第一个 .md
  if (!mdKey) throw new Error("zip 里没有 SKILL.md（Agent Skills 开放标准要求一个 SKILL.md）");
  const text = files[mdKey].toString("utf-8");
  const parsed = _parseSkillMd(text);
  const name = parsed.name || mdKey.split("/").pop().replace(/\.md$/i, "");
  if (parsed.body.trim().length < 20) throw new Error("SKILL.md 正文太短（min 20 chars）");
  const id = (skillId && ID_RE.test(skillId)) ? skillId : slugify(name);

  // 附属文件：把 SKILL.md 所在目录作为 skill 根，收集根下（除 SKILL.md 外）的其它文件。
  // scripts/ 与可执行扩展名剥离；只保留白名单文档。相对路径去掉 skill 根前缀。
  const rootDir = mdKey.includes("/") ? mdKey.slice(0, mdKey.lastIndexOf("/") + 1) : "";
  const assets = [];       // [{ path, buf }]
  let strippedScripts = 0;
  for (const k of keys) {
    if (k === mdKey) continue;
    if (rootDir && !k.startsWith(rootDir)) continue;   // 只收 skill 根目录下的
    const rel = rootDir ? k.slice(rootDir.length) : k;
    if (!rel || rel.endsWith("/")) continue;
    if (isScriptPath(rel)) { strippedScripts++; continue; }
    if (!ASSET_EXT_RE.test(rel)) continue;             // 非文档类忽略
    assets.push({ path: rel, buf: files[k] });
  }

  const saved = await saveSkill({ skill_id: id, name, description: parsed.description, body: parsed.body, author });
  // 替换该 skill 的附属文件集合（先清旧，再写新）——保持与本次 zip 一致。
  await _replaceSkillFiles(id, assets);
  return { ...saved, references: assets.length, stripped_scripts: strippedScripts };
}

// ── 附属文件存储（skills/<id>/files/*）──────────────────────────────────────
/** 覆盖式写入一个 skill 的附属文件集合：删除旧 files/ 前缀，再写入新集合，并更新 meta.files。 */
async function _replaceSkillFiles(id, assets) {
  // 1) 删旧
  const oldKeys = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: filesPrefix(id), ContinuationToken: token }));
    for (const o of r.Contents || []) oldKeys.push({ Key: o.Key });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  if (oldKeys.length) await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: oldKeys } }));
  // 2) 写新
  const manifest = [];
  for (const a of assets) {
    const safe = a.path.replace(/^\/+/, "").replace(/\.\.(\/|\\)/g, "");   // 去除路径穿越
    if (!safe) continue;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: filesPrefix(id) + safe, Body: a.buf }));
    manifest.push({ path: safe, bytes: a.buf.length });
  }
  // 3) 更新 meta.files（不动版本，仅记清单）
  const meta = await _getJson(metaKey(id));
  if (meta) {
    meta.files = manifest;
    meta.updated_at = _now();
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: metaKey(id),
      Body: Buffer.from(JSON.stringify(meta), "utf-8"), ContentType: "application/json",
    }));
  }
  return manifest;
}

/** 读回一个 skill 的全部附属文件（供世界 B 打包 zip）。返回 [{ path, buf }]。 */
async function _loadSkillFiles(id) {
  const out = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: filesPrefix(id), ContinuationToken: token }));
    for (const o of r.Contents || []) {
      if (o.Key.endsWith("/")) continue;
      const g = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: o.Key }));
      const chunks = [];
      for await (const c of g.Body) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
      out.push({ path: o.Key.slice(filesPrefix(id).length), buf: Buffer.concat(chunks) });
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** 给一个 skill 打上/更新 devops_agent 上传状态（幂等 patch meta，不动版本）。 */
export async function setSkillDevopsStatus(id, status) {
  const meta = await _getJson(metaKey(id));
  if (!meta) throw new Error("skill not found");
  meta.devops_agent = { ...(meta.devops_agent || {}), ...status };
  meta.updated_at = _now();
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: metaKey(id),
    Body: Buffer.from(JSON.stringify(meta), "utf-8"), ContentType: "application/json",
  }));
  return meta.devops_agent;
}

/** 取一个 skill 的完整对象 + 附属文件缓冲（世界 B 上传用）。返回 null 表示不存在。 */
export async function getSkillWithFiles(id) {
  const s = await getSkill(id);
  if (!s) return null;
  const files = await _loadSkillFiles(id);
  return { ...s, fileBuffers: files };
}

// ── 预置 Skills 种子（随代码打包，幂等注入 S3，author=notiops-system）───────────
const __dirname = dirname(fileURLToPath(import.meta.url));
// 预置 skill 的 SKILL.md 源目录：bff/web-chat/preset-skills/<id>/SKILL.md（+ 可选 references/）。
const PRESET_DIR = process.env.PRESET_SKILLS_DIR || join(__dirname, "preset-skills");
export const PRESET_AUTHOR = "notiops-system";
// 历史（已废弃）的 CDK seed-data Lambda 曾把预置 skill 的 author 误写为 "NotiOps"，
// 导致前端按 author 判定时把官方 skill 当成「客户自建」。这些是唯一由旧 seed 写入的 author 值，
// 真正的客户自建用 Cognito sub / "web"。seed 时遇到这些历史值即夺回为 PRESET_AUTHOR（自愈已部署环境）。
const LEGACY_PRESET_AUTHORS = new Set(["NotiOps"]);
// 旧 CDK seed 曾发布、但新的 preset-skills/ 目录已不再包含的预置 skill id。这些是「孤儿」：
// 没有源目录，seedPresetSkills 主循环永远遇不到它们，既无法归一化 author 也无法删除，
// 于是在已部署环境里以 author="NotiOps" 长期显示为「客户自建」。reconcile 阶段将其归档（软删）。
// 只归档 author 仍属 LEGACY_PRESET_AUTHORS 的记录——绝不动客户自建（author=Cognito sub / "web"）。
const LEGACY_ORPHAN_PRESET_IDS = new Set(["cost-usage-analysis"]);

// SKILL.md 与本地化 SKILL.<loc>.md（如 SKILL.zh.md）都是「正文源」，不当作附属文件。
const _isSkillMdName = (name) => /^SKILL(\.[a-z]{2})?\.md$/i.test(name);

/** 递归列出某目录下所有文件（相对该目录的路径）。目录不存在返回 []。 */
function _walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || _isSkillMdName(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(..._walk(full, base));
    else out.push(full.slice(base.length + 1).split("\\").join("/"));
  }
  return out;
}

// 每个 Lambda 容器只跑一次的自动 seed 闸门（listSkills 首次调用触发）。失败不缓存，下次重试。
let _presetSeedPromise = null;
async function _ensurePresetsSeeded() {
  if (_presetSeedPromise) return _presetSeedPromise;
  _presetSeedPromise = (async () => {
    try { await seedPresetSkills({}); }
    catch { _presetSeedPromise = null; /* 失败清空，下次访问再试；不阻塞列表 */ }
  })();
  return _presetSeedPromise;
}

/** 幂等注入随代码打包的预置 skills。已存在同 id 的预置 skill（author=notiops-system）：
 * 内容变了才 bump 版本，否则跳过；从不覆盖客户自建（author != notiops-system）的同名 skill。
 * force=true 时无条件重写正文。返回 { seeded, skipped, kept, details }。 */
export async function seedPresetSkills({ force = false } = {}) {
  if (!BUCKET) throw new Error("SKILLS_BUCKET not configured");
  if (!existsSync(PRESET_DIR)) return { seeded: 0, skipped: 0, kept: 0, details: [], note: "no preset dir" };
  const ids = readdirSync(PRESET_DIR).filter((d) => {
    try { return statSync(join(PRESET_DIR, d)).isDirectory() && ID_RE.test(d); } catch { return false; }
  });
  let seeded = 0, skipped = 0, kept = 0;
  const details = [];
  for (const id of ids) {
    const mdPath = join(PRESET_DIR, id, "SKILL.md");
    if (!existsSync(mdPath)) continue;
    const parsed = _parseSkillMd(readFileSync(mdPath, "utf-8"));
    const name = parsed.name || id;
    // 本地化正文（可选）：preset-skills/<id>/SKILL.zh.md 纯 Markdown 正文（无需 frontmatter）。
    // 存在则作为中文注入/展示正文；缺失则中文回退到规范英文正文。
    const bodyI18n = {};
    for (const loc of BODY_LOCALES) {
      const lp = join(PRESET_DIR, id, `SKILL.${loc}.md`);
      if (existsSync(lp)) {
        const lt = _stripFrontmatter(readFileSync(lp, "utf-8")).trim();
        if (lt.length >= 20) bodyI18n[loc] = lt;
      }
    }
    const bodyLocaleKeys = Object.keys(bodyI18n).sort();
    const existing = await _getJson(metaKey(id));
    // 客户是否已通过 Web 编辑过它：updated_by 由 saveSkill 写入（= Cognito sub / "web"）；
    // 旧 CDK seed 从不写 updated_by，故其【缺失】= 从未被客户改动的原始 seed 拷贝。
    const _ub = existing && existing.updated_by;
    const customerEdited = !!(_ub && _ub !== PRESET_AUTHOR && !LEGACY_PRESET_AUTHORS.has(_ub));
    // 历史 seed 误写了 author（如 "NotiOps"）→ 把 author 夺回为 PRESET_AUTHOR。
    // 但【仅当客户从未编辑过它】时才夺回：客户改过（updated_by=其 sub）= 已接管为自有内容，
    // 此时保持 author 不变 → 落到下面 kept-customer 分支，正文与归属都不动（绝不覆盖客户编辑）。
    // 反之（pristine 旧拷贝）：这不是客户自建，故不走 kept-customer，也不能被 unchanged 跳过
    // （下方 contentUnchanged 分支单独处理原地归一化）。
    const needsAuthorFix = !!(existing && LEGACY_PRESET_AUTHORS.has(existing.author) && !customerEdited);
    // 客户自建 / 客户已接管的同名 skill 不动（尊重客户内容），也不覆盖。这里涵盖两类：
    //   ① 真·客户自建（author=Cognito sub / "web"）；
    //   ② 历史 seed 拷贝但客户改过（author 仍是 legacy 值，但 customerEdited=true → needsAuthorFix=false）。
    // needsAuthorFix=true 时（pristine 旧拷贝）author 虽 != PRESET_AUTHOR，但那是历史 seed 遗留、
    // 客户从未动过，故放行到下面做原地归一化。
    if (existing && existing.author && existing.author !== PRESET_AUTHOR && !needsAuthorFix) {
      kept++; details.push({ id, action: customerEdited ? "kept-customer-edited" : "kept-customer" }); continue;
    }
    // 内容是否无变化（i18n 译文 / 本地化正文变化都算变化）。needsAuthorFix 不再绕过此判断——
    // 否则历史 author 误写的 skill 每次 seed 都会被打包正文无条件覆盖（回滚客户对它的编辑）并空 bump 版本。
    let contentUnchanged = false;
    if (existing && !force) {
      const lv = existing.latest_version || "1.0.0";
      const cur = await _getText(verKey(id, lv));
      const existingBodyLoc = (Array.isArray(existing.body_i18n) ? [...existing.body_i18n] : []).sort();
      let zhSame = JSON.stringify(existingBodyLoc) === JSON.stringify(bodyLocaleKeys);
      if (zhSame) {
        for (const loc of bodyLocaleKeys) {
          const curLoc = (await _getText(verKeyLoc(id, lv, loc))).trim();
          if (curLoc !== (bodyI18n[loc] || "").trim()) { zhSame = false; break; }
        }
      }
      contentUnchanged = cur.trim() === parsed.body.trim()
        && (existing.description || "") === (parsed.description || "")
        && JSON.stringify(existing.i18n || null) === JSON.stringify(parsed.i18n || null)
        && zhSame;
    }
    // 内容无变化：正文与版本一律不动。仅当 author 需归一化时【原地 patch】meta.author（不 bump 版本、
    // 不重写正文），从而保留客户对该 skill 的任何正文编辑；否则直接跳过。
    if (contentUnchanged) {
      if (needsAuthorFix) {
        existing.author = PRESET_AUTHOR;
        existing.updated_at = _now();
        await s3.send(new PutObjectCommand({
          Bucket: BUCKET, Key: metaKey(id),
          Body: Buffer.from(JSON.stringify(existing), "utf-8"), ContentType: "application/json",
        }));
        seeded++; details.push({ id, action: "author-normalized" });
      } else {
        skipped++; details.push({ id, action: "unchanged" });
      }
      continue;
    }
    // 内容确有变化（预置正文随版本更新等）：写新版本 + 更新 meta。forceAuthor 顺带纠正历史误写的 author。
    // mode 用 ""（非 "create"）：并发冷启动下两个容器可能都看到 existing=null 并各自 create，
    // "create" 会让后到者抛「skill_id 已存在」；"" 则退化为 upsert，幂等且不抛。
    await saveSkill({ skill_id: id, name, description: parsed.description, body: parsed.body, author: PRESET_AUTHOR, mode: existing ? "update" : "", i18n: parsed.i18n, body_i18n: bodyI18n, forceAuthor: true });
    // 附属文件（references/ 等）随之注入。
    const rels = _walk(join(PRESET_DIR, id));
    const assets = rels.filter((r) => !isScriptPath(r) && ASSET_EXT_RE.test(r))
      .map((r) => ({ path: r, buf: readFileSync(join(PRESET_DIR, id, r)) }));
    if (assets.length) await _replaceSkillFiles(id, assets);
    // 此处内容确有变化（author-normalized-only 的场景已在上面 contentUnchanged 分支提前返回）。
    seeded++; details.push({ id, action: existing ? (needsAuthorFix ? "updated+author-normalized" : "updated") : "created", references: assets.length });
  }
  // ── reconcile：归档「孤儿」预置 skill（旧 seed 发布过、新 preset-skills/ 已移除的 id）──
  // 主循环只遍历 preset-skills/ 下现存目录，遇不到孤儿，故单独处理。仅软删（status=archived）
  // 且仅当【author 仍是历史 seed 值 且 客户从未编辑过】时才动——绝不误删客户自建 / 客户已接管的同名 skill。
  let archived = 0;
  for (const id of LEGACY_ORPHAN_PRESET_IDS) {
    const meta = await _getJson(metaKey(id));
    if (!meta || meta.status === "archived") continue;
    if (!LEGACY_PRESET_AUTHORS.has(meta.author)) {
      // author 已不是历史 seed 值：客户接手改写了它，尊重之，不归档。
      details.push({ id, action: "orphan-kept-customer" }); continue;
    }
    // author 仍是 legacy 值，但客户可能已通过 Web 编辑过它（普通编辑不改 author，只写 updated_by）。
    // updated_by 存在且非 preset/legacy 值 = 客户已接管为自有内容，绝不软删（否则其编辑会从列表消失）。
    const _ub = meta.updated_by;
    if (_ub && _ub !== PRESET_AUTHOR && !LEGACY_PRESET_AUTHORS.has(_ub)) {
      details.push({ id, action: "orphan-kept-customer-edited" }); continue;
    }
    meta.status = "archived";
    meta.updated_at = _now();
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: metaKey(id),
      Body: Buffer.from(JSON.stringify(meta), "utf-8"), ContentType: "application/json",
    }));
    archived++; details.push({ id, action: "orphan-archived" });
  }
  return { seeded, skipped, kept, archived, details };
}
