/**
 * 等待期过程提示（"还没有任何产出"那段时间发给前端的瞬态 progress 行）。
 *
 * ## 为什么单独成模块
 *
 * 2026-09-03 现网反馈：「连着问问题，依然会看到『正在启动服务（空闲后的首次请求，约 10 秒）…』，
 * 这肯定不是空闲后的首次访问」。原实现只有**一个**时间轴：5s 一条、之后每 10s 换一条，文案里
 * 写死了"空闲后的首次请求"。于是任何**首个产出 >15s** 的普通轮次（Grok 这类先想再连着调几个
 * 工具的模型，成本类问题很常见）都会被贴上"冷启动"的标签 —— 而那一轮的容器可能早就热着，
 * 甚至刚被 /warmup 预热过（见 ChatApp 的会话预热）。提示说的不是真实后台状态。
 *
 * 修法不是改文案措辞，而是把**两种等待分开**，各自只说自己知道的事：
 *
 *   · 阶段 A `starting`：请求发出去了，但 `InvokeAgentRuntime` 连**响应头都还没回来**。
 *     热容器这一步是亚秒级的，所以"过了 5 秒还没回响应"本身就是冷启动的签名 ——
 *     这一段才允许说"正在启动服务"。
 *   · 阶段 B `working`：流已经开了（或 agent 明确发来 ready 帧），容器活着，等的是模型/工具。
 *     这一段只许说"正在分析 / 仍在处理"，不许提冷启动。
 *
 * 阶段切换由**后台真实信号**驱动，不靠猜：
 *   · `opened()` —— `client.send()` 已 resolve（响应头到达，见 agentcore.mjs 的 onOpen）。
 *   · `ready()`  —— agent entrypoint 的第一帧 `{"ready":true}`（容器里的代码真的跑起来了）。
 *     比 `opened()` 更硬；两者谁先到都切阶段 B（旧版 runtime 不发 ready，仍有 opened 兜底，
 *     不会退回"永远说冷启动"）。
 *
 * 纯瞬态：只走 progress 通道（前端收到正文即清空、不入库），任何真实产出即 `stop()`。
 * 定时器可注入 → 测试用假时钟推进（见 tests/wait_hint.test.mjs）。
 */

// 文案分两组，对应两个阶段。**不许**把冷启动措辞挪进 working 组 —— 那正是这次的 bug。
// 秒数只在 starting 组出现（那是有依据的：冷启动实测首字 ~10s，见 index.mjs 的度量注释）；
// working 组不写任何数字，因为长任务耗时本就无法预告，写了就是编。
export const WAIT_MSGS = {
  zh: {
    starting: [
      "正在启动服务（空闲后的首次请求，约 10 秒）…",
      "仍在启动服务，请稍候…",
    ],
    working: [
      "已连接，正在分析你的问题…",
      "仍在处理：正在调用工具、读取数据…",
      "这个问题比较复杂，仍在进行中…",
    ],
  },
  en: {
    starting: [
      "Starting up the service (first request after idle, ~10s)…",
      "Still starting up, hang tight…",
    ],
    working: [
      "Connected — analyzing your question…",
      "Still working: calling tools and gathering data…",
      "This one is complex — still working on it…",
    ],
  },
};

/**
 * @param {object} o
 * @param {string} o.locale        "en" → 英文文案，其余按中文。
 * @param {(text:string, kind:string)=>void} o.emit  发一条瞬态提示（BFF 侧包成 progress SSE）。
 * @param {number} [o.firstDelayMs] 首条延迟（热路径首字通常 <5s，故默认 5s 才开口，避免闪现）。
 * @param {number} [o.intervalMs]   之后的间隔。
 * @returns {{start:()=>void, opened:()=>void, ready:()=>void, stop:()=>void, phase:()=>string}}
 */
export function createWaitHint({
  locale, emit,
  firstDelayMs = 5000, intervalMs = 10000,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
} = {}) {
  const msgs = WAIT_MSGS[locale === "en" ? "en" : "zh"];
  let phase = "starting";   // starting → working → done
  let idx = 0;              // 当前阶段内的文案下标（切阶段时归零，从该阶段第一条说起）
  let firstT = null, tick = null;

  const beat = () => {
    if (phase === "done") return;
    const list = phase === "working" ? msgs.working : msgs.starting;
    emit?.(list[Math.min(idx, list.length - 1)], phase === "working" ? "working" : "coldstart");
    idx++;
  };

  const start = () => {
    if (phase === "done" || firstT || tick) return;   // 幂等：整个重试周期共用一份
    firstT = setTimeoutFn(() => { beat(); tick = setIntervalFn(beat, intervalMs); }, firstDelayMs);
  };

  const stop = () => {
    phase = "done";
    if (firstT) { clearTimeoutFn(firstT); firstT = null; }
    if (tick) { clearIntervalFn(tick); tick = null; }
  };

  // 进入阶段 B。**不立刻 beat**：热路径上响应头亚秒级就回来了，立刻发一条等于把
  // "已连接，正在分析…"闪给每一个正常轮次；留给下一个 tick 说。
  const toWorking = () => {
    if (phase !== "starting") return;
    phase = "working";
    idx = 0;
  };

  return { start, opened: toWorking, ready: toWorking, stop, phase: () => phase };
}
