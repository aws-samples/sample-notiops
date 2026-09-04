/**
 * 等待期提示的两阶段契约（纯逻辑 + 假时钟，不触网、不真等）。
 * 运行：node bff/web-chat/tests/wait_hint.test.mjs
 *
 * 盯的是 2026-09-03 那个现网反馈：「连着问问题，依然会看到『正在启动服务（空闲后的首次
 * 请求，约 10 秒）…』」。所以这里的核心断言是**反向**的：一旦后台真实信号（响应头到达 /
 * agent ready 帧）说明容器活着，之后任何一条提示都**不允许**再出现冷启动措辞。
 * 这类断言只有把定时器注入进来才能写（否则要真的等 15 秒），故 createWaitHint 收了
 * setTimeoutFn/setIntervalFn 四个口子。
 */
import assert from "node:assert/strict";
import { createWaitHint, WAIT_MSGS } from "../wait_hint.mjs";

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

/**
 * 极简假时钟：只实现 setTimeout/setInterval/clear* 与 advance(ms)。
 * interval 用"到点就按 every 续期"的方式模拟，够本用例（单个 interval）用。
 */
function fakeClock() {
  let now = 0, seq = 0;
  const jobs = new Map(); // id → {at, every, fn}
  return {
    setTimeoutFn: (fn, ms) => { const id = ++seq; jobs.set(id, { at: now + ms, every: 0, fn }); return id; },
    setIntervalFn: (fn, ms) => { const id = ++seq; jobs.set(id, { at: now + ms, every: ms, fn }); return id; },
    clearTimeoutFn: (id) => jobs.delete(id),
    clearIntervalFn: (id) => jobs.delete(id),
    advance(ms) {
      const target = now + ms;
      // 一步步跳到下一个到期任务，保证 interval 在一次 advance 里能触发多轮。
      for (;;) {
        let next = null;
        for (const [id, j] of jobs) if (j.at <= target && (next === null || j.at < jobs.get(next).at)) next = id;
        if (next === null) break;
        const j = jobs.get(next);
        now = j.at;
        if (j.every > 0) j.at = now + j.every; else jobs.delete(next);
        j.fn();
      }
      now = target;
    },
    pending: () => jobs.size,
  };
}

/** 起一个 hint，返回 {hint, emitted, clock}；emitted 收集 [text, kind]。 */
function harness(locale = "zh") {
  const clock = fakeClock();
  const emitted = [];
  const hint = createWaitHint({
    locale,
    emit: (text, kind) => emitted.push({ text, kind }),
    setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    setIntervalFn: clock.setIntervalFn, clearIntervalFn: clock.clearIntervalFn,
  });
  return { hint, emitted, clock };
}

/** 冷启动措辞的判据：只认 starting 组里的原文（避免把断言写成脆弱的关键字匹配）。 */
const COLDSTART_TEXTS = new Set([...WAIT_MSGS.zh.starting, ...WAIT_MSGS.en.starting]);

console.log("wait_hint — 等待期提示两阶段契约");

t("5 秒之前一个字都不发（热路径不闪现「加载中」）", () => {
  const { hint, emitted, clock } = harness();
  hint.start();
  clock.advance(4999);
  assert.equal(emitted.length, 0);
  clock.advance(1);
  assert.equal(emitted.length, 1);
});

t("响应头一直不回 → 才说冷启动（这是唯一有依据的场景）", () => {
  const { hint, emitted, clock } = harness();
  hint.start();
  clock.advance(25_000); // 5s + 10s + 10s
  assert.equal(emitted.length, 3);
  for (const e of emitted) {
    assert.equal(e.kind, "coldstart");
    assert.ok(COLDSTART_TEXTS.has(e.text), `非 starting 文案漏进冷启动阶段: ${e.text}`);
  }
});

t("响应头已到（opened）→ 之后绝不再出现冷启动措辞【本次修的 bug】", () => {
  const { hint, emitted, clock } = harness();
  hint.start();
  hint.opened();            // 亚秒级就回来了，热容器的常态
  clock.advance(60_000);
  assert.ok(emitted.length >= 3, `应持续给反馈，实际 ${emitted.length} 条`);
  for (const e of emitted) {
    assert.equal(e.kind, "working");
    assert.ok(!COLDSTART_TEXTS.has(e.text), `冷启动措辞泄漏: ${e.text}`);
    assert.ok(WAIT_MSGS.zh.working.includes(e.text), `不是 working 组文案: ${e.text}`);
  }
});

t("opened 不立刻发消息（否则每个正常轮次都闪一条「已连接」）", () => {
  const { hint, emitted, clock } = harness();
  hint.start();
  clock.advance(1000);
  hint.opened();
  assert.equal(emitted.length, 0);
});

t("agent 的 ready 帧同样切阶段（旧 runtime 不发它，靠 opened 兜底）", () => {
  const { hint, emitted, clock } = harness();
  hint.start();
  hint.ready();
  clock.advance(15_000);
  assert.ok(emitted.length >= 1);
  assert.ok(emitted.every((e) => e.kind === "working"));
});

t("已经进 working 后，晚到的 opened/ready 不把阶段拨回去", () => {
  const { hint } = harness();
  hint.start();
  hint.ready();
  hint.opened();
  hint.ready();
  assert.equal(hint.phase(), "working");
});

t("5s 之前就 opened 且长任务：文案从 working 第一条按序往下走", () => {
  const { hint, emitted, clock } = harness();
  hint.start();
  hint.opened();
  clock.advance(5000);
  assert.deepEqual(emitted.map((e) => e.text), [WAIT_MSGS.zh.working[0]]);
  clock.advance(10_000);
  assert.equal(emitted[1].text, WAIT_MSGS.zh.working[1]);
  clock.advance(10_000);
  assert.equal(emitted[2].text, WAIT_MSGS.zh.working[2]);
  clock.advance(30_000); // 说完了就一直重复最后一条，不越界
  assert.ok(emitted.slice(3).every((e) => e.text === WAIT_MSGS.zh.working[2]));
});

t("stop() 之后彻底安静，且不留定时器（Lambda 里泄漏定时器=响应后还在跑）", () => {
  const { hint, emitted, clock } = harness();
  hint.start();
  clock.advance(6000);
  const n = emitted.length;
  hint.stop();
  clock.advance(60_000);
  assert.equal(emitted.length, n);
  assert.equal(clock.pending(), 0);
  assert.equal(hint.phase(), "done");
});

t("start() 幂等：重试循环里多次调用不会翻倍发提示", () => {
  const { hint, emitted, clock } = harness();
  hint.start(); hint.start(); hint.start();
  clock.advance(5000);
  assert.equal(emitted.length, 1);
});

t("stop() 之后再 start() 不会复活（收尾后不该再有提示）", () => {
  const { hint, emitted, clock } = harness();
  hint.stop();
  hint.start();
  clock.advance(60_000);
  assert.equal(emitted.length, 0);
});

t("英文 locale 走英文文案，且 working 组不含冷启动措辞", () => {
  const { hint, emitted, clock } = harness("en");
  hint.start();
  clock.advance(5000);
  assert.equal(emitted[0].text, WAIT_MSGS.en.starting[0]);
  hint.opened();
  clock.advance(10_000);
  assert.equal(emitted[1].text, WAIT_MSGS.en.working[0]);
  assert.ok(!COLDSTART_TEXTS.has(emitted[1].text));
});

t("working 文案不许写死秒数（长任务耗时无法预告，写了就是编）", () => {
  for (const loc of ["zh", "en"]) {
    for (const s of WAIT_MSGS[loc].working) {
      assert.ok(!/\d/.test(s), `${loc} working 文案含数字: ${s}`);
    }
  }
});

t("未知 locale 回落中文（不至于没文案）", () => {
  const { hint, emitted, clock } = harness("ja");
  hint.start();
  clock.advance(5000);
  assert.equal(emitted[0].text, WAIT_MSGS.zh.starting[0]);
});

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
