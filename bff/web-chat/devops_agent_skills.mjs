/**
 * 世界 B 打通：把 NotiOps 的 Skill 上传到 AWS DevOps Agent 的 Agent Space（Asset API）。
 *
 * 背景：
 *   - NotiOps 自己的 Skills = 世界 A（S3 里的 prompt-template，注入 NotiOps agent）。
 *   - DevOps Agent 的 skill = 世界 B（后端 Asset，深度调查时按 description 自动激活）。
 *   本模块让一个 skill 从世界 A 一键**发布**到世界 B：把 SKILL.md（+ references/ 附属文档）
 *   打成 zip，调 aidevops:CreateAsset(assetType=skill) 上传；已上传过则 UpdateAsset 覆盖。
 *
 * 目标 Agent Space 两种：
 *   1) 本部署账号自己的 Agent Space（DEVOPS_AGENT_SPACE_ID，默认凭证直接调）。
 *   2) 跨 payer 成员账号：读 da#<acct> 记录，AssumeRole 进 trigger_role_arn
 *      （ExternalId=accountId），用成员账号的 agent_space_id 调 Asset API。
 *
 * 约束：zip ≤6MB、≤100 文件、无 scripts（skills.mjs 导入时已剥离）。read-only 边界不受影响
 *   ——这里只是把「文档型 skill」装进 Agent Space，激活由 DevOps Agent 自行判断。
 */
import { deflateRawSync } from "node:zlib";
import * as zlib from "node:zlib";
import { getSkillWithFiles, buildSkillMd, setSkillDevopsStatus } from "./skills.mjs";

const REGION = process.env.AWS_REGION || "us-east-1";
const SELF_AGENT_SPACE = process.env.DEVOPS_AGENT_SPACE_ID || "";
const SELF_ACCOUNT = process.env.LOCKED_ACCOUNT_ID || process.env.AWS_ACCOUNT_ID || "";
const CONFIG_TABLE = process.env.CONFIG_TABLE || "notiops-config";
// Asset API 里 skill 类别的 assetType。开放标准里就叫 "skill"；用 env 兜底以防服务改名。
const SKILL_ASSET_TYPE = process.env.DA_SKILL_ASSET_TYPE || "skill";
const MAX_ZIP_BYTES = 6 * 1024 * 1024;   // DevOps Agent 硬限制

// —— agent_types：Skill 类 Asset 的**必填**元数据 ——
// CreateAsset/UpdateAsset 的 metadata map 里，skill 必须带 agent_types（大写枚举字符串数组），
// 否则服务端报 "agent_types is required for Skill knowledge items"。
// 合法值：GENERIC, CHAT, INCIDENT_TRIAGE, INCIDENT_RCA, INCIDENT_MITIGATION, PREVENTION,
//   CHANGE_REVIEW, CHANGE_RELEASE, QUALITY_ASSURANCE_TESTING, RELEASE_SHEPHERD,
//   RELEASE_READINESS_REVIEW, RELEASE_TESTING。
// GENERIC = 对所有 agent 类型可用，且**不能与其它值同时出现**（必须单独发送）。默认用 GENERIC
// （最稳、清掉必填错误、对任意调查场景都可激活）。可被 skill meta.devops_agent.agent_types 覆盖。
const VALID_AGENT_TYPES = new Set([
  "GENERIC", "CHAT", "INCIDENT_TRIAGE", "INCIDENT_RCA", "INCIDENT_MITIGATION", "PREVENTION",
  "CHANGE_REVIEW", "CHANGE_RELEASE", "QUALITY_ASSURANCE_TESTING", "RELEASE_SHEPHERD",
  "RELEASE_READINESS_REVIEW", "RELEASE_TESTING",
]);

/** 归一化 agent_types → 合法的非空大写枚举数组。GENERIC 与其它值互斥（含 GENERIC 就只发 GENERIC）。
 * 传入为空/全非法 → 回退 ["GENERIC"]（默认，且清掉服务端必填错误）。 */
function normalizeAgentTypes(raw) {
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const up = arr.map((v) => String(v || "").trim().toUpperCase()).filter((v) => VALID_AGENT_TYPES.has(v));
  const uniq = [...new Set(up)];
  if (uniq.length === 0 || uniq.includes("GENERIC")) return ["GENERIC"];
  return uniq;
}

// ── 极简 zip 打包（deflate，带 CRC32）——零第三方依赖，够装 SKILL.md + 少量文档 ──
// node:zlib 的 crc32 在 Node 20.15+/22 可用；不可用时回退到本地实现，保证任何 runtime 都能跑。
let _crc32 = typeof zlib.crc32 === "function" ? zlib.crc32 : null;
if (!_crc32) {
  const TBL = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  _crc32 = (buf, seed = 0) => {
    let c = (seed ^ 0xffffffff) >>> 0;
    for (let i = 0; i < buf.length; i++) c = (TBL[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
    return (c ^ 0xffffffff) >>> 0;
  };
}

/** entries: [{ name, data:Buffer }] → 一个合法的 deflate zip Buffer。 */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = 0, dosDate = 0x21; // 固定时间戳（1980-01-01）——保证同内容产出确定性 zip
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf-8");
    const crc = _crc32(e.data) >>> 0;
    const comp = deflateRawSync(e.data);
    const useStore = comp.length >= e.data.length;   // 压不动就 store，取小的
    const method = useStore ? 0 : 8;
    const body = useStore ? e.data : comp;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);            // version needed
    lfh.writeUInt16LE(0, 6);             // flags
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(body.length, 18);  // compressed
    lfh.writeUInt32LE(e.data.length, 22);// uncompressed
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);            // extra len
    chunks.push(lfh, nameBuf, body);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);            // version made by
    cdh.writeUInt16LE(20, 6);            // version needed
    cdh.writeUInt16LE(0, 8);             // flags
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(dosTime, 12);
    cdh.writeUInt16LE(dosDate, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(body.length, 20);
    cdh.writeUInt32LE(e.data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);            // extra
    cdh.writeUInt16LE(0, 32);            // comment
    cdh.writeUInt16LE(0, 34);            // disk
    cdh.writeUInt16LE(0, 36);            // internal attrs
    cdh.writeUInt32LE(0, 38);            // external attrs
    cdh.writeUInt32LE(offset, 42);       // local header offset
    central.push(Buffer.concat([cdh, nameBuf]));
    offset += lfh.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);        // central dir offset
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cd, eocd]);
}

/** clientToken：同一 skill + 同一 body 长度产出稳定 token，短时间内重复请求幂等。
 * 不依赖 Date.now（会破坏幂等），用 skillId + zip 大小 + version 拼一个稳定串。 */
function clientTokenFor(skillId, ver, size) {
  return `notiops-${skillId}-${ver || "0"}-${size}`.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
}

/** 解析上传目标 → { agentSpaceId, credentials|undefined }。
 * accountId 为空 / 等于本部署账号 → 本地 Agent Space（默认凭证）。
 * 否则读 da#<acct>，AssumeRole 进 trigger_role_arn（ExternalId=accountId）。 */
// uploads 记账的稳定键：self 目标恒为 "self"（与前端 keyOf 一致，且不受 SELF_ACCOUNT 是否
// 注入影响）；跨 payer 目标用其真实账号 id。历史数据可能把 self 键成真实账号 id，见 upload 逻辑里的清洗。
function uploadKeyFor(target) {
  return target.scope === "self" ? "self" : (target.accountId || "self");
}

// export：「深度调查（直连）」(devops_investigate.mjs) 复用同一套目标解析，避免两份跨账号
// AssumeRole 逻辑漂移。签名/行为保持不变（只加 export），老调用方不受影响。
export async function resolveTarget(accountId) {
  const id = String(accountId || "").trim();
  if (!id || id === SELF_ACCOUNT) {
    if (!SELF_AGENT_SPACE) throw Object.assign(new Error("no_local_agent_space"), { code: "bad_request" });
    return { agentSpaceId: SELF_AGENT_SPACE, credentials: undefined, accountId: SELF_ACCOUNT, scope: "self" };
  }
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, GetCommand } = await import("@aws-sdk/lib-dynamodb");
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const rec = await ddb.send(new GetCommand({ TableName: CONFIG_TABLE, Key: { PK: `da#${id}`, SK: "meta" } }));
  const cfg = rec.Item;
  if (!cfg || !cfg.trigger_role_arn || !cfg.agent_space_id) {
    throw Object.assign(new Error("account_not_onboarded_to_devops_agent"), { code: "bad_request" });
  }
  const { STSClient, AssumeRoleCommand } = await import("@aws-sdk/client-sts");
  const sts = new STSClient({});
  const r = await sts.send(new AssumeRoleCommand({
    RoleArn: cfg.trigger_role_arn, RoleSessionName: "notiops-skill-upload",
    ExternalId: id, DurationSeconds: 900,
  }));
  return {
    agentSpaceId: cfg.agent_space_id,
    credentials: {
      accessKeyId: r.Credentials.AccessKeyId,
      secretAccessKey: r.Credentials.SecretAccessKey,
      sessionToken: r.Credentials.SessionToken,
    },
    accountId: id, scope: "cross-payer",
    region: cfg.region || REGION,
  };
}

/** 在目标 Agent Space 里按 skillId（= SKILL.md 的 name）找已有 skill asset 的 assetId。
 * metadata.name 或 metadata.skill_id 命中即认为是同一个（用于 update 而非重复 create）。 */
async function findExistingAssetId(client, agentSpaceId, skillId, ListAssetsCommand) {
  let nextToken;
  do {
    const resp = await client.send(new ListAssetsCommand({
      agentSpaceId, assetType: SKILL_ASSET_TYPE, nextToken, maxResults: 50,
    }));
    // ListAssetsResponse 的列表字段是 items（不是 assets）——见 SDK schema。
    for (const a of resp.items || []) {
      const m = a.metadata || {};
      if (m.skill_id === skillId || m.name === skillId) return a.assetId;
    }
    nextToken = resp.nextToken;
  } while (nextToken);
  return null;
}

/**
 * 把一个 skill 发布到 DevOps Agent 的 Agent Space。
 * @param skillId 世界 A 的 skill_id（同时作为 SKILL.md 的 name）。
 * @param opts.accountId 目标账号（空=本部署账号的 Agent Space；否则跨 payer 成员账号）。
 * @param opts.agentTypes 可选 agent_types 覆盖（大写枚举数组）；缺省用 skill meta 里的，再缺省用 ["GENERIC"]。
 * @returns { ok, assetId, action:'created'|'updated', agentSpaceId, accountId, scope, agentTypes }
 */
export async function uploadSkillToDevopsAgent(skillId, { accountId = "", agentTypes } = {}) {
  const skill = await getSkillWithFiles(skillId);
  if (!skill) throw Object.assign(new Error("skill_not_found"), { code: "bad_request" });

  // 1) 组装 zip：根 SKILL.md（规范 frontmatter）+ references/assets 附属文档。
  const md = buildSkillMd(skill);
  const entries = [{ name: "SKILL.md", data: Buffer.from(md, "utf-8") }];
  for (const f of skill.fileBuffers || []) {
    const safe = f.path.replace(/^\/+/, "").replace(/\.\.(\/|\\)/g, "");
    if (safe) entries.push({ name: safe, data: f.buf });
  }
  if (entries.length > 100) throw Object.assign(new Error("too_many_files (max 100)"), { code: "bad_request" });
  const zip = buildZip(entries);
  if (zip.length > MAX_ZIP_BYTES) {
    throw Object.assign(new Error(`skill zip too large (>${MAX_ZIP_BYTES >> 20}MB)`), { code: "bad_request" });
  }

  // 2) 解析目标 Agent Space + 凭证。
  const target = await resolveTarget(accountId);
  const { DevOpsAgentClient, CreateAssetCommand, UpdateAssetCommand, ListAssetsCommand } =
    await import("@aws-sdk/client-devops-agent");
  const client = new DevOpsAgentClient({
    region: target.region || REGION,
    credentials: target.credentials,
  });

  // agent_types 优先级：显式入参 > skill meta.devops_agent.agent_types > ["GENERIC"]。
  // 这是 skill 类 Asset 的**必填**字段（否则服务端报 "agent_types is required for Skill knowledge items"）。
  // metadata 是 DocumentSchema（自由 JSON）→ 直接传真数组，不要 stringify。
  const finalAgentTypes = normalizeAgentTypes(agentTypes ?? skill.devops_agent?.agent_types);
  const metadata = {
    name: skillId, skill_id: skillId, description: skill.description || "",
    source: "notiops", agent_types: finalAgentTypes,
  };
  const content = { zip: { zipFile: zip } };
  const clientToken = clientTokenFor(skillId, skill.latest_version, zip.length);

  // 3) 已存在 → Update；否则 Create。ListAssets 无权限/不支持时降级为直接 Create。
  let existingId = null;
  try {
    existingId = await findExistingAssetId(client, target.agentSpaceId, skillId, ListAssetsCommand);
  } catch { /* 列举失败不致命，直接尝试 create */ }

  let assetId, action;
  if (existingId) {
    const resp = await client.send(new UpdateAssetCommand({
      agentSpaceId: target.agentSpaceId, assetId: existingId, content, metadata, clientToken,
    }));
    assetId = resp.asset?.assetId || existingId;
    action = "updated";
  } else {
    const resp = await client.send(new CreateAssetCommand({
      agentSpaceId: target.agentSpaceId, assetType: SKILL_ASSET_TYPE, content, metadata, clientToken,
    }));
    assetId = resp.asset?.assetId;
    action = "created";
  }

  // 4) 记账到 skill meta.devops_agent（前端展示「已上传」+ 目标账号/时间）。
  // 目标键统一：self → "self"，跨 payer → account_id（见 uploadKeyFor）。历史上 self 目标
  // 曾用真实账号 id 作键（早期注入过 LOCKED_ACCOUNT_ID），会与前端固定的 "self" 键错位，
  // 导致对话框只显示「发布」。这里清掉指向同一 Agent Space 的旧键，避免同一目标出现两条记录。
  const uploads = { ...(skill.devops_agent?.uploads || {}) };
  const key = uploadKeyFor(target);
  for (const [k, rec] of Object.entries(uploads)) {
    if (k !== key && rec?.agent_space_id === target.agentSpaceId) delete uploads[k];
  }
  uploads[key] = {
    asset_id: assetId, agent_space_id: target.agentSpaceId,
    scope: target.scope, account_id: target.accountId || SELF_ACCOUNT,
    uploaded_version: skill.latest_version || "", uploaded_at: new Date().toISOString(),
    agent_types: finalAgentTypes,
  };
  await setSkillDevopsStatus(skillId, { uploads, last_action: action, agent_types: finalAgentTypes });

  return { ok: true, assetId, action, agentSpaceId: target.agentSpaceId, accountId: target.accountId, scope: target.scope, agentTypes: finalAgentTypes };
}

/** 从 DevOps Agent 撤下一个已上传的 skill（DeleteAsset），并清账。目标同 upload。 */
export async function removeSkillFromDevopsAgent(skillId, { accountId = "" } = {}) {
  const skill = await getSkillWithFiles(skillId);
  if (!skill) throw Object.assign(new Error("skill_not_found"), { code: "bad_request" });
  const target = await resolveTarget(accountId);
  const uploads = { ...(skill.devops_agent?.uploads || {}) };
  // 归一化定位：优先规范键；否则回落到指向同一 Agent Space 的任意历史键（早期 self 曾以真实账号 id 记账）。
  const key = uploadKeyFor(target);
  let recKey = uploads[key] ? key
    : Object.keys(uploads).find((k) => uploads[k]?.agent_space_id === target.agentSpaceId);
  const rec = recKey ? uploads[recKey] : null;
  if (!rec || !rec.asset_id) return { ok: true, note: "not_uploaded" };

  const { DevOpsAgentClient, DeleteAssetCommand } = await import("@aws-sdk/client-devops-agent");
  const client = new DevOpsAgentClient({ region: target.region || REGION, credentials: target.credentials });
  try {
    await client.send(new DeleteAssetCommand({ agentSpaceId: target.agentSpaceId, assetId: rec.asset_id }));
  } catch (e) {
    if (!/NotFound|ResourceNotFound/i.test(String(e?.name || e))) throw e; // 已不存在视为成功
  }
  delete uploads[recKey];
  await setSkillDevopsStatus(skillId, { uploads, last_action: "removed" });
  return { ok: true, removed: rec.asset_id, accountId: target.accountId, scope: target.scope };
}

/** 列出可作为上传目标的账号：本部署账号（若有本地 Agent Space）+ 所有已接入 DevOps Agent
 * 的成员账号（da# 记录 status=active）。供前端「上传到哪个 Agent Space」下拉。 */
export async function listDevopsAgentTargets() {
  const targets = [];
  if (SELF_AGENT_SPACE) {
    targets.push({ account_id: SELF_ACCOUNT || "self", agent_space_id: SELF_AGENT_SPACE, scope: "self", label: "本账号 (This account)" });
  }
  try {
    const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
    const { DynamoDBDocumentClient, QueryCommand } = await import("@aws-sdk/lib-dynamodb");
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const r = await ddb.send(new QueryCommand({
      TableName: CONFIG_TABLE, IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :p",
      ExpressionAttributeValues: { ":p": "da#accounts" },
    }));
    for (const it of r.Items || []) {
      if (it.onboarding_status !== "active" || !it.agent_space_id) continue;
      // 已作为 self 列出的不重复。按 account_id 或 agent_space_id 任一命中即跳过——
      // LOCKED_ACCOUNT_ID 未配置时 SELF_ACCOUNT 为空，只能靠 agent_space_id 去重，
      // 否则本部署账号会既以 self 又以 cross-payer 出现（同一个 Agent Space）。
      if (it.account_id === SELF_ACCOUNT) continue;
      if (it.agent_space_id === SELF_AGENT_SPACE) continue;
      targets.push({
        account_id: it.account_id, agent_space_id: it.agent_space_id,
        scope: "cross-payer", label: it.account_alias || it.account_id,
      });
    }
  } catch { /* 无 org 模式 / 无 GSI → 只返回 self 目标 */ }
  return targets;
}
