/**
 * 一个 Skill 是否依赖 **DevOps Agent 替代不了的 NotiOps 工具**（2026-11-02 加）。
 *
 * NotiOps 自己的 agent（AgentCore 上那个，agent-build/NotiOpsWebChat/app/NotiOpsWebChat/main.py 的 @tool 函数）
 * 有一批工具，AWS DevOps Agent 里**没有**：它只有自己的 use_aws / use_kubectl / fs_read / datetime 等。
 * 而定时任务、深度调查（直连）、DevOps 对话这三条路都是把 Skill 交给 DevOps Agent 执行的。
 *
 * 2026-11-02 用户用定时任务跑预置的 whats-new-report：DevOps Agent 读到了 Skill（触发标记生效），却拿不到
 * aws_whats_new / aws_whats_new_report → 报告没生成，还白花了一次调查时间。发布、建定时任务、每次定时运行前、
 * 两条直连路径都靠这里判断：发布对话框警告；定时任务拒绝创建、到点时直接暂停；直连路径不发出去并说明原因。
 *
 * 只拦 **DevOps Agent 没有替代办法**的那几个（NOTIOPS_ONLY_TOOLS）。agent 的其余工具 DevOps Agent 都能用自己的办法
 * 做到（SUBSTITUTABLE_TOOLS：读 AWS 数据用 use_aws；参考文件读它本地安装的那份 Skill；文档有自己的检索；报告它自己会出），
 * 拦它们只会误伤 —— 预置的 aws-well-architected-review-devops 正文里提到 read_skill_reference，而它本来就是为
 * DevOps Agent 写的。tests/skill_tools.test.mjs 读 agent 源码核对：main.py 里每个 @tool（含 async def）必须恰好落在
 * 这两份清单之一 —— agent 加了新工具，就得有人明确判断它属于哪一类。
 * 成本 MCP 的工具（awslabs cost / pricing、cost-agent）两份都不进：它们的名字就是 AWS API 的名字（get_cost_and_usage…），
 * DevOps Agent 用 use_aws 也能调到同样的 API。
 */

// DevOps Agent 没有替代办法：What's New 不是 AWS API（读的是公开 RSS 源）；公网搜索它也没有。
export const NOTIOPS_ONLY_TOOLS = Object.freeze(["aws_whats_new", "aws_whats_new_report", "web_search"]);

// DevOps Agent 能用自己的办法做到：不拦。
export const SUBSTITUTABLE_TOOLS = Object.freeze([
  "aws_docs_read", "aws_docs_search", "aws_readonly", "create_case_from_template", "ec2_describe_instance",
  "ec2_list_instances", "ec2_security_groups", "escalate_to_support", "generate_mitigation_plan",
  "get_investigation_result", "investigate_live", "rds_describe_instance", "rds_list_instances", "rds_metrics",
  "rds_recent_events", "read_skill_reference", "save_report", "start_investigation", "support_case_communications",
  "support_case_create", "support_case_get", "support_case_reply", "support_case_resolve", "support_cases_list",
  "support_list_services", "support_list_severities",
]);

// 整词匹配：`\b` 把下划线算词内字符，所以 aws_whats_new 不会命中 aws_whats_new_report 的前半段（那里由后者自己命中）。
const TOOL_RE = new RegExp(`\\b(${NOTIOPS_ONLY_TOOLS.join("|")})\\b`, "g");

/** 这些文本里出现了哪些 DevOps Agent 替代不了的 NotiOps 工具名（去重、排序）。 */
export function notiopsToolsIn(...texts) {
  const found = new Set();
  for (const t of texts) for (const m of String(t || "").matchAll(TOOL_RE)) found.add(m[1]);
  return [...found].sort();
}

/**
 * 一个 Skill 用到的、DevOps Agent 替代不了的 NotiOps 工具：规范正文 + 每个本地化正文（预置 Skill 有 SKILL.zh.md 这类译文）。
 * 某个语言的正文读不到就跳过 —— 规范正文总在，漏看一份译文的代价远小于为此把整条路径卡死。
 *
 * @param {object} skill  getSkill() 的返回值（至少 skill_id / version / body / body_i18n）
 * @param {{ getSkill?: Function }} [deps] 仅供测试注入
 */
export async function skillNotiopsTools(skill, { getSkill } = {}) {
  if (!skill) return [];
  const texts = [skill.body || ""];
  const locales = Array.isArray(skill.body_i18n) ? skill.body_i18n : [];
  if (locales.length) {
    const g = getSkill || (await import("./skills.mjs")).getSkill;
    for (const loc of locales) {
      try {
        const s = await g(skill.skill_id, skill.version, loc);
        if (s?.body_locale === loc && s.body) texts.push(s.body);
      } catch { /* 读不到这份译文：跳过 */ }
    }
  }
  return notiopsToolsIn(...texts);
}
