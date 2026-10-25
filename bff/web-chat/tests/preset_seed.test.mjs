/**
 * 预置 skill 种子器（bff/web-chat/skills.mjs 的 seedPresetSkills）—— 2026-10-24 补回 cost-usage-analysis。
 *
 * 背景：cost-usage-analysis 是 07-16 用户点名要的预置（指定时间段的成本 + 用量分析并给建议），08-06 统一
 * 种子时被当成「旧 seed 孤儿」软删（status=archived，author 还是旧 seed 写的 "NotiOps"）。现网桶里就躺着
 * 这样一条。只把目录放回 preset-skills/ 不够：saveSkill 更新已有记录时保留原 status，补回的 skill 会
 * 照样藏在列表外。这里钉：
 *   · 全新部署：12 个预置全部种进去，cost-usage-analysis 是 active、作者 notiops-system；
 *   · 老环境（现网那条归档记录的样子）：恢复成 active、作者夺回、出新版本，列表里看得到；
 *   · 客户编辑过的归档记录（updated_by = 客户）：不复活、不覆盖；
 *   · 再跑一次是幂等的：全部 unchanged，不再 bump 版本、不再归档。
 *
 * 运行：cd bff/web-chat && npm test
 */
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.SKILLS_BUCKET = "test-skills-bucket";   // 必须在 import skills.mjs 之前设

let fails = 0;
let ok = 0;
async function t(name, fn) {
  try { await fn(); ok++; console.log(`  ok   ${name}`); }
  catch (e) { fails++; console.log(`  FAIL ${name}\n       ${e?.message || e}`); }
}

// ── 内存版 S3：只实现种子器和 listSkills 用到的四个命令 ──
const store = new Map();
const s3lib = await import("@aws-sdk/client-s3");
s3lib.S3Client.prototype.send = async function (cmd) {
  const i = cmd.input || {};
  if (cmd instanceof s3lib.GetObjectCommand) {
    if (!store.has(i.Key)) { const e = new Error("NoSuchKey"); e.name = "NoSuchKey"; throw e; }
    return { Body: [store.get(i.Key)] };
  }
  if (cmd instanceof s3lib.PutObjectCommand) {
    store.set(i.Key, Buffer.isBuffer(i.Body) ? i.Body : Buffer.from(String(i.Body)));
    return {};
  }
  if (cmd instanceof s3lib.ListObjectsV2Command) {
    const keys = [...store.keys()].filter((k) => k.startsWith(i.Prefix || "")).sort();
    if (!i.Delimiter) return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false };
    const prefixes = new Set(keys.map((k) => {
      const rest = k.slice((i.Prefix || "").length);
      const cut = rest.indexOf(i.Delimiter);
      return cut < 0 ? null : (i.Prefix || "") + rest.slice(0, cut + 1);
    }).filter(Boolean));
    return { CommonPrefixes: [...prefixes].map((Prefix) => ({ Prefix })), IsTruncated: false };
  }
  if (cmd instanceof s3lib.DeleteObjectsCommand) {
    for (const o of i.Delete?.Objects || []) store.delete(o.Key);
    return {};
  }
  throw new Error(`内存 S3 没实现 ${cmd.constructor.name}`);
};

const { seedPresetSkills, listSkills, PRESET_AUTHOR } = await import("../skills.mjs");

const ID = "cost-usage-analysis";
const META = `skills/${ID}/meta.json`;
const meta = () => JSON.parse(store.get(META).toString("utf-8"));
const PRESET_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "preset-skills");
const PRESETS = readdirSync(PRESET_DIR).filter((d) => existsSync(join(PRESET_DIR, d, "SKILL.md")));

// 现网数据桶里那条的样子（2026-10-24 只读核过：status=archived、author=NotiOps、无 updated_by、版本 1.0.0）
function seedLegacyArchived(extra = {}) {
  store.set(META, Buffer.from(JSON.stringify({
    skill_id: ID, name: "Cost & Usage Analysis", description: "old seed description", status: "archived",
    latest_version: "1.0.0", author: "NotiOps", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-08-06T16:41:44.680Z",
    versions: [{ version: "1.0.0", changelog: "Preset skill", created_at: "2026-01-01T00:00:00Z", created_by: "NotiOps" }],
    ...extra,
  })));
  store.set(`skills/${ID}/versions/1.0.0.md`, Buffer.from("# Cost & Usage Analysis (for a given time window)\n\nold body ..."));
}

console.log("preset_seed: 预置 skill 种子器（补回 cost-usage-analysis）");

await t("preset-skills/ 里有 12 个预置，cost-usage-analysis 在内、中英正文都有", () => {
  assert.equal(PRESETS.length, 12, PRESETS.join(","));
  assert.ok(PRESETS.includes(ID));
  assert.ok(existsSync(join(PRESET_DIR, ID, "SKILL.zh.md")));
});

await t("全新部署：12 个全部 created，cost-usage-analysis 是 active、作者 notiops-system、带中文正文", async () => {
  store.clear();
  const r = await seedPresetSkills({});
  assert.equal(r.seeded, 12, JSON.stringify(r.details));
  assert.equal(r.archived, 0);
  const m = meta();
  assert.equal(m.status, "active");
  assert.equal(m.author, PRESET_AUTHOR);
  assert.equal(m.latest_version, "1.0.0");
  assert.deepEqual(m.body_i18n, ["zh"]);
  assert.equal(m.i18n?.zh?.name, "成本与用量分析");
});

await t("老环境（现网那条归档记录）：恢复成 active、作者夺回、出 1.0.1，列表里看得到", async () => {
  store.clear();
  seedLegacyArchived();
  const r = await seedPresetSkills({});
  const d = r.details.find((x) => x.id === ID);
  assert.equal(d?.action, "updated+reactivated", JSON.stringify(d));
  const m = meta();
  assert.equal(m.status, "active");
  assert.equal(m.author, PRESET_AUTHOR);
  assert.equal(m.latest_version, "1.0.1");
  assert.ok(store.get(`skills/${ID}/versions/1.0.1.md`).toString("utf-8").includes("# Cost & Usage Analysis"));
  const listed = (await listSkills()).map((s) => s.skill_id);
  assert.ok(listed.includes(ID), listed.join(","));
});

await t("再跑一次是幂等的：全部 unchanged，不 bump 版本、不再归档", async () => {
  const r = await seedPresetSkills({});
  assert.equal(r.seeded, 0, JSON.stringify(r.details.filter((x) => x.action !== "unchanged")));
  assert.equal(r.archived, 0);
  assert.equal(meta().latest_version, "1.0.1");
  assert.equal(meta().status, "active");
});

await t("客户编辑过的归档记录（updated_by = 客户）：不复活、不覆盖", async () => {
  store.clear();
  seedLegacyArchived({ updated_by: "cognito-sub-123" });
  const r = await seedPresetSkills({});
  const d = r.details.find((x) => x.id === ID);
  assert.equal(d?.action, "kept-customer-edited", JSON.stringify(d));
  const m = meta();
  assert.equal(m.status, "archived");
  assert.equal(m.author, "NotiOps");
  assert.equal(m.latest_version, "1.0.0");
});

console.log(fails ? `\n${fails} failed` : `\n${ok} ok, 0 failed`);
process.exit(fails ? 1 : 0);
