/**
 * 调查编号的可见形式与续查识别（devops_investigate.mjs 的 investigationRef /
 * extractInvestigationRef）。
 *
 * 背景（2026-09-03，客户实测）：气泡里显示的是 `execution_id: exe-ops1-…`，客户拿这串去问
 * DevOps Agent **查不到**；能查到的是 backlog task 的 uuid，写法是 `[[investigation:<uuid>]]`。
 * 于是可见文案一律换成后者。
 *
 * 这份测试钉住换形式**顺带带来的三个陷阱**——都属于"改坏了不报错、只是行为悄悄变了"：
 *
 *   1. **老写法必须继续认**。用户老会话里还贴着 `execution_id=exe-…`，点/贴回来必须仍是续查；
 *      认不出 = 在客户账号上**真的再跑一场新调查**（花钱、且答不到他要的那一场）。
 *   2. **新写法必须被认成续查**。按钮 prompt 与气泡文案现在都是 `[[investigation:…]]`，
 *      识别里少加这一条，点「查看调查结果」就变成发起新调查 —— 最贵的一种回归。
 *   3. **裸 uuid 不能想当然当引用**。用户问题里出现 uuid 是常事（各种资源 id），
 *      所以裸 uuid 只算"候选"，必须先解析出对应任务才算续查（explicit:false）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let fails = 0;
// ⚠️ `ok` 是**通过数**，收尾必须和 `0 failed` 一起打 —— `package.json` 的 test
//    脚本靠 `grep -q ', 0 failed'` 判「这个文件真的跑了」。只打「0 failed」的话
//    「一条都没跑」也是 0 failed，那正是那个守卫要防的盲区。
let ok = 0;
async function t(name, fn) {
  try { await fn(); ok++; console.log(`  ok   ${name}`); }
  catch (e) { fails++; console.log(`  FAIL ${name}\n       ${e?.message}`); }
}

console.log("investigation ref (display form + resume detection)");

process.env.DEVOPS_AGENT_SPACE_ID = "as-test-space";
const { investigationRef, extractInvestigationRef } =
  await import("../devops_investigate.mjs");

// ⚠️ 合成 UUID，只取**形状**（8-4-4-4-12）—— DevOps Agent 认的是 backlog task
//    的 uuid，用例要的只是「长这个样子」。别换成从现网抄来的真 task id：
//    这个文件在发布白名单里（`publish/include.txt` 整目录收了 `bff/`）。
const TASK = "2b7f4c10-6a3d-4e58-9f21-0c5d8e7a4b93";   // 形状：DevOps Agent 查得到的那类
const EXEC = "exe-ops1-a5f40f48-1111-2222-3333-111122223333"; // 真实形状：查不到的那个

// ── 显示形式 ──────────────────────────────────────────────────────────────
await t("有 taskId → 显示 [[investigation:<uuid>]]（不是 execution_id）", () => {
  const s = investigationRef(TASK, EXEC);
  assert.equal(s, `[[investigation:${TASK}]]`);
  assert.ok(!s.includes(EXEC), "又把 execution_id 显示给用户了 —— 那串查不到");
});

await t("没有 taskId → 退回 execution_id= 而不是空串", () => {
  // 空串会让气泡里出现"调查编号：``"，且续查按钮的 prompt 里没有任何 id 可认。
  assert.equal(investigationRef("", EXEC), `execution_id=${EXEC}`);
  assert.equal(investigationRef("  ", EXEC), `execution_id=${EXEC}`);
});

await t("两个都没有 → 空串（调用方自己决定怎么显示）", () => {
  assert.equal(investigationRef("", ""), "");
});

// ── 续查识别 ──────────────────────────────────────────────────────────────
await t("新写法：按钮 prompt 认得出，且算 explicit", () => {
  const r = extractInvestigationRef(`查一下这次调查的结果，[[investigation:${TASK}]]`);
  assert.equal(r.id, TASK);
  assert.equal(r.explicit, true);
});

await t("新写法带反引号/空格也认（气泡里是用 `` 包着显示的）", () => {
  for (const s of [`\`[[investigation:${TASK}]]\``,
                   `[[ investigation : ${TASK} ]]`,
                   `[[Investigation:${TASK}]]`]) {
    assert.equal(extractInvestigationRef(s)?.id, TASK, s);
  }
});

await t("老写法 execution_id= 仍然认（老会话里还贴着）", () => {
  const r = extractInvestigationRef(`查一下这次调查的结果，execution_id=${EXEC}`);
  assert.equal(r.id, EXEC);
  assert.equal(r.explicit, true);
});

await t("裸 exe- 仍然认", () => {
  const r = extractInvestigationRef(`帮我看看 ${EXEC} 怎么了`);
  assert.equal(r.id, EXEC);
  assert.equal(r.explicit, true);
});

await t("裸 uuid 只算候选（explicit:false）—— 解析不出就当普通新调查", () => {
  const r = extractInvestigationRef(`${TASK} 这个调查结论是什么`);
  assert.equal(r.id, TASK);
  assert.equal(r.explicit, false,
    "裸 uuid 被当成确定引用了：用户问题里随便一个 uuid 都会劫持这一轮");
});

await t("没有任何 id → null（照常发起新调查）", () => {
  assert.equal(extractInvestigationRef("为什么 RDS writer 切换后连不上"), null);
  assert.equal(extractInvestigationRef(""), null);
  assert.equal(extractInvestigationRef(null), null);
});

await t("uuid 形状要求严格：短一截不算 uuid", () => {
  assert.equal(extractInvestigationRef("5600ee55-ecde-4300-8ea4-18507e0f02"), null);
});

// ── 结构性断言：把"两条路径用同一个形式"钉在源码里 ──────────────────────────
const src = readFileSync(new URL("../devops_investigate.mjs", import.meta.url), "utf8");

await t("给用户看的编号标签里不再出现 execution_id", () => {
  // 这几串正是改前的可见文案。`escalate_to_support` / `get_investigation_result` 的
  // 入参仍是 execution_id（那条 prompt 里必须留着），所以只钉"标签"，不搞一刀切。
  for (const bad of ["（execution_id:", "(execution_id:",
                     "调查编号（execution_id）", "Investigation id (execution_id)"]) {
    assert.ok(!src.includes(bad), `可见文案里还留着 ${bad}`);
  }
});

await t("三处可见文案 + 续查按钮 prompt 都走 investigationRef（中英各一）", () => {
  const n = (src.match(/investigationRef\(taskId, executionId\)/g) || []).length;
  assert.ok(n >= 8, `只有 ${n} 处用了 investigationRef —— 有文案漏改（横幅/超时/仍在跑/按钮，中英各一）`);
});

await t("续查分支解析失败时不顺手发起新调查（explicit 必须早返回）", () => {
  const i = src.indexOf("if (ref.explicit)");
  assert.ok(i > 0, "续查分支没有处理 explicit 引用解析失败的情况");
  assert.ok(src.slice(i, i + 800).includes("return reply"),
    "explicit 引用解析失败后没有 return —— 会掉进「发起新调查」，用户要的那一场永远查不到");
});

await t("uuid 引用必须换出 executionId（journal 只能按 executionId 拉）", () => {
  assert.ok(/resolveInvestigationRef[\s\S]{0,600}GetBacklogTaskCommand/.test(src),
    "resolveInvestigationRef 没用 GetBacklogTask 换 executionId");
});

console.log(fails ? `\n${fails} FAILED` : `\nPASSED: ${ok} ok, 0 failed`);
process.exit(fails ? 1 : 0);
