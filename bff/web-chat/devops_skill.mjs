/**
 * 把 NotiOps 的 Skill（S3 里那份 SKILL.md）带进**两条直连 DevOps Agent 的路径**。
 *
 * 背景：`/` 选一个 skill 后，前端一直都会把 `skill_id` 传给 BFF（Composer → chat.ts →
 * `/stream`），但只有走**我们自己 agent runtime** 的那条路会真的注入它
 * （agent-build/.../main.py 的 "Skills（客户自定义能力）注入" 段）。两条直连路径
 * （「DevOps 对话」CreateChat/SendMessage、「深度调查（直连）」CreateBacklogTask）此前
 * 直接把 `skill_id` 丢掉 —— 客户点了 skill、发出去、**一切正常**，只是那份作业指导
 * 压根没参与回答。这是最贵的那类缺陷：没有报错、没有日志，只有"这个 skill 好像不太灵"。
 *
 * 这条路径上没有模型可以"被 system prompt 约束"，也没有 `read_skill_reference` 工具，
 * 所以做法只有一个：**把 skill 正文内联进发给 DevOps Agent 的那段文字**。
 * DevOps Agent 自己读它、自己执行 —— NotiOps 侧照旧 0 token（正文的 token 计在客户
 * 自己的 DevOps Agent 额度里，与他直接在 DevOps Agent 网页上贴一份作业指导等价）。
 *
 * 两个刻意的取舍：
 *   ① **附属文件（references/）不内联**。SKILL.md 用渐进式披露引用它们，全量内联可能是
 *      几十 KB，且大多数轮次根本用不到。这里改为在正文末尾**如实说明**它们取不到
 *      （已发布到该 Agent Space 的 skill 则提示"读你本地安装的那份"）—— 宁可让 DevOps
 *      Agent 知道自己缺料，也不能让它按半份指导硬答。
 *   ② **正文超长即截断并明说**（MAX_SKILL_BODY）。SendMessage 的 content 上限未公开，
 *      一个几百 KB 的 skill 撞上限会让整轮以一句 ValidationException 收场；截断 + 说明
 *      至少还能跑，且用户看得见发生了什么。
 */

/** 内联进 content 的 skill 正文上限（字符）。超出即截断并在正文里说明。 */
export const MAX_SKILL_BODY = 24000;

/** `CreateBacklogTask.description` 的 API 硬上限（字符）。超了 DevOps Agent 回 ContentSizeExceededException(413)，
 *  调查根本发不起来（与 inspection/domain/payload.py 的 DESCRIPTION_LIMIT 同一个数）。
 *  ⚠️ MAX_SKILL_BODY（24000）管的是「DevOps 对话」SendMessage；深度调查要守的是这一个 ——
 *  原来深度调查也照 24000 内联，预置的 aws-well-architected-review-devops（约 19,000 字）一选就发不起来。 */
export const DESCRIPTION_LIMIT = 10000;

/** 发布到 DevOps Agent 时追加进 skill 描述的**触发标记**（巡检用的是同一个技巧：NOTIOPS_INSPECTION）。
 *  DevOps Agent 按任务描述**语义匹配**挑 skill，没有「指定 skill」的参数；任务描述和 skill 描述里出现
 *  同一个不会撞车的标记，它才能稳定地选中这一份。 */
export const SKILL_MARKER_PREFIX = "NOTIOPS_SKILL:";
export const skillMarker = (id) => `${SKILL_MARKER_PREFIX}${String(id || "").trim()}`;

/** 发布用的描述：原描述 + 一句触发说明。压成单行（SKILL.md 的 frontmatter 只认单行描述）；已带标记就不重复加。 */
export function withSkillMarker(description, id) {
  const d = String(description || "").replace(/\s+/g, " ").trim();
  const m = skillMarker(id);
  if (d.includes(m)) return d;
  const note = `Use this skill when the task description contains ${m}.`;
  return d ? `${d} ${note}` : note;
}

/** 该 skill 是否已发布到 DevOps Agent（世界 B）。已发布 → 它自己那边有完整的一份（含附属
 *  文件），提示它去读本地安装的版本；未发布 → 如实说明附属文件在这条路径上取不到。 */
export function isPublishedToDevopsAgent(skill) {
  const up = skill?.devops_agent?.uploads;
  return !!up && typeof up === "object" && Object.keys(up).length > 0;
}

/**
 * 读一份 skill 正文，供直连路径内联。
 *
 * @param {object} p
 * @param {string} p.skillId       本轮显式选中的 skill id（空 → 返回 null，不算错误）
 * @param {string} [p.skillVersion] 指定版本（缺省 = latest）
 * @param {string} [p.locale]      "zh" | "en" —— 有对应语言正文则取译文，否则回退规范正文
 * @returns {Promise<object|null>} skill 对象（含 body）；`null` = 本轮没选 skill
 * @throws 读取失败（S3 抖动 / 该 skill 已被删）—— **必须让调用方看见**，
 *         否则就退化成"选了 skill 但静默没生效"，正是本模块要消灭的那个缺陷。
 */
export async function loadSkillForDirect({ skillId, skillVersion, locale }) {
  const id = String(skillId || "").trim();
  if (!id) return null;
  const { getSkill } = await import("./skills.mjs");
  const skill = await getSkill(id, String(skillVersion || "").trim() || undefined,
                              String(locale || "").trim() || undefined);
  if (!skill || !skill.body) {
    throw Object.assign(new Error("skill_not_found_or_empty"), { name: "SkillUnavailable" });
  }
  return skill;
}

/** 版本标记：`v1.2.0` / `""`。 */
const vtag = (skill) => (skill?.version ? ` v${skill.version}` : "");

/** 展示名（优先 name，兜底 skill_id）。 */
export const skillLabel = (skill) => String(skill?.name || skill?.skill_id || "").trim();

/** 附属文件说明。返回 "" = 这个 skill 没有附属文件（绝大多数情况，零开销）。 */
function refsNote(skill, en) {
  const n = Array.isArray(skill?.files) ? skill.files.length : 0;
  if (!n) return "";
  if (isPublishedToDevopsAgent(skill)) {
    return en
      ? `\n[This skill ships ${n} reference file(s). It is already published to this Agent Space, so read them from your installed copy of the skill.]`
      : `\n[该 Skill 附带 ${n} 个参考文件（references/）。它已发布到这个 Agent Space，请从你本地安装的同名 Skill 里读取。]`;
  }
  return en
    ? `\n[This skill ships ${n} reference file(s) (references/) that are NOT available here. If the body tells you to load one, do your best with what is given and say plainly which file you could not read.]`
    : `\n[该 Skill 另有 ${n} 个参考文件（references/），在这条路径上**取不到**。正文若要求读取某个 references/ 文件，请按已给出的信息尽力执行，并如实说明哪个文件没能读到。]`;
}

/** 正文（必要时截断 + 说明）。 */
function bodyOf(skill, en) {
  const body = String(skill?.body || "");
  if (body.length <= MAX_SKILL_BODY) return body;
  const cut = body.slice(0, MAX_SKILL_BODY);
  return cut + (en
    ? `\n\n[... truncated: this skill body exceeds ${MAX_SKILL_BODY} characters. Work with the part above and say plainly that it was truncated.]`
    : `\n\n[……以下省略：该 Skill 正文超过 ${MAX_SKILL_BODY} 字符已被截断。请按上面这部分执行，并如实说明正文被截断了。]`);
}

/**
 * 把 skill 正文包进要发给 DevOps Agent 的那段文字。
 *
 * @param {object} p
 * @param {string} p.text    用户本轮原话（永远保留在末尾 —— skill 是"怎么做"，原话是"做什么"）
 * @param {object} p.skill   `loadSkillForDirect` 的返回值；falsy → 原文原样返回
 * @param {boolean} [p.en]   用户提问语言是英文
 * @param {"chat"|"investigate"} [p.mode] 直答 / 发起一次深度调查
 * @returns {string}
 */
export function buildSkillContent({ text, skill, en = false, mode = "chat" }) {
  const raw = String(text || "");
  if (!skill?.body) return raw;
  const name = skillLabel(skill);
  const head = mode === "investigate"
    ? (en
        ? `[Run this investigation strictly according to the following operating guide (a NotiOps Skill named "${name}"${vtag(skill)}). The user's own words follow it.`
        : `[请**严格按下面这份作业指导**（NotiOps Skill「${name}」${vtag(skill)}）执行本次调查。用户原话在其后。`)
    : (en
        ? `[The user explicitly selected the Skill "${name}"${vtag(skill)}. Handle this turn strictly according to the operating guide below, and open with one short sentence saying you are using that skill. Answer in the SAME language the user asked in.`
        : `[用户显式选择使用 Skill「${name}」${vtag(skill)}。请**严格按下面这份作业指导**处理本轮请求，`
          + `并在开头用一句话说明正在使用该 Skill。**整条回复都必须用与用户提问相同的语言**。`);
  const close = en ? "=== end of skill ===" : "=== Skill 结束 ===";
  return `${head}\n=== Skill: ${name} ===\n${bodyOf(skill, en)}\n${close}${refsNote(skill, en)}]\n\n${raw}`;
}

/**
 * 已发布到 DevOps Agent 的 skill：**不贴正文**，引用它在这个 Agent Space 里安装的那份
 * （触发标记 + 名称 + 已安装版本）。正文和 references/ 都在 DevOps Agent 那边，这里只说「用哪一份」。
 *
 * @param {object} p
 * @param {string} p.text    要调查的内容（永远放在末尾）
 * @param {object} p.skill   skill 对象（至少有 skill_id / name）
 * @param {object} p.upload  这个 Agent Space 的上传记录（`uploadRecordFor` 的返回值）
 * @param {string} [p.lead]  标记之后、引用说明之前的额外几行（定时任务用它写「第几次运行」）
 */
export function buildSkillReference({ text, skill, en = false, upload, lead = "" }) {
  const raw = String(text || "");
  const name = skillLabel(skill);
  const id = String(skill?.skill_id || "").trim();
  const ver = upload?.uploaded_version ? ` v${upload.uploaded_version}` : "";
  const head = en
    ? `[Run this investigation with the skill "${name}" (${id}${ver}) installed in this Agent Space: its full operating guide and reference files are in your installed copy, so they are not repeated here. The user's own words follow.]`
    : `[请使用已安装在这个 Agent Space 的 Skill「${name}」（${id}${ver}）执行本次调查：完整的作业指导和参考文件都在你本地安装的那份里，这里不再附正文。用户原话在其后。]`;
  return `${skillMarker(id)}\n${lead}${head}\n\n${raw}`;
}

/**
 * 深度调查（直连）要发的 description。按顺序：
 *   ① 内联正文放得下 → 照旧内联（用的是最新版正文）；
 *   ② 放不下、但 skill 已发布到这个 Agent Space → 改成引用（`buildSkillReference`）；
 *   ③ 都不行 → 抛 `SkillTooLong`，调用方要**明说并且不发起**调查 —— 截断后硬发等于按半份指导调查，
 *      而 API 那一侧超限只会回一句 413。
 *
 * @param {number} [p.reserve] 调用方还要加在前面的字数（startInvestigation 的 "[notiops-web-chat] "）
 * @returns {{ description: string, mode: "inline" | "reference" }}
 */
export function buildInvestigationDescription({ text, skill, en = false, upload = null, reserve = 32 }) {
  const budget = DESCRIPTION_LIMIT - reserve;
  const inline = buildSkillContent({ text, skill, en, mode: "investigate" });
  if (inline.length <= budget) return { description: inline, mode: "inline" };
  if (upload) {
    const ref = buildSkillReference({ text, skill, en, upload });
    if (ref.length <= budget) return { description: ref, mode: "reference" };
    throw Object.assign(new Error("investigation_text_too_long"),
      { name: "SkillTooLong", size: ref.length, limit: DESCRIPTION_LIMIT, published: true });
  }
  throw Object.assign(new Error("skill_too_long_for_investigation"),
    { name: "SkillTooLong", size: inline.length, limit: DESCRIPTION_LIMIT, published: false });
}
