/**
 * 「思考过程」时间线的**纯**累积逻辑（无 React、无 DOM，可单测）。
 *
 * ## 为什么要有这个模块
 *
 * 2026-09-03 现网反馈：Grok 问「如何降低我的 EC2 成本？」要跑很久，但用户能看到的全部过程
 * 就是气泡里那几句灰字、且"每隔一段时间才出来一点"。长任务缺过程反馈 → 看起来像卡死。
 *
 * 后台其实一直在发东西，只是都被当成**瞬态**处理、彼此覆盖：
 *   · `progress` —— 一行"正在做什么"（工具调用等），前端下一条就把上一条盖掉；
 *   · `reasoning` —— 模型思考增量（Grok 的明文那部分；加密链 redactedContent 拿不到也不该拿）；
 *   · `thinking_step` —— 本次新增，agent 侧把工具调用（含入参摘要）与工具返回摘要发出来。
 * 这里把三路合并成一条**持久**时间线，供右侧面板展示，长任务结束后还能回看。
 *
 * ## 三条硬规则（都在 thinking.test.ts 里钉住）
 * 1. **不收 BFF 自己的等待期提示**（kind=coldstart/working，见 bff/web-chat/wait_hint.mjs）。
 *    那是"我们在等"的 UI 提示，不是模型/工具做了什么；收进来会让时间线看着像后台在忙。
 * 2. **连续的 reasoning 增量合成一段**。模型的思考是逐字流过来的，一条一步的话面板会变成
 *    几百行碎片。
 * 3. **连续重复的同一行只记一次并计数**（`repeat`）。工具进度行常常一模一样地重复
 *    （多区域轮询同一个 API），逐条堆积会把真正的新信息挤出屏幕。
 */
import type { ThinkingStep } from "./api/chat";

/** 时间线长度上限。纯粹是内存/渲染的保护；到顶后丢**最旧**的（新的更有用）。
 *  正常一轮合并后是十几到几十步，跑到 500 的只可能是异常刷屏。 */
export const MAX_THINKING_STEPS = 500;

/** 单段思考文本的上限：超了就掐掉（面板只是过程回看，不是全文存档）。 */
const MAX_THOUGHT_CHARS = 8000;

/** 时间线里的一步。`repeat` 是"这行连续出现了几次"（1 不显示）。 */
export type TimelineStep = ThinkingStep & { repeat?: number };

/**
 * BFF 自己发的等待期提示（不是后台真在做的事）→ 不进时间线。
 * 判据用 kind 而不是文案匹配：文案会随 i18n / 措辞调整变，kind 是契约。
 */
export function isWaitHint(kind?: string): boolean {
  return kind === "coldstart" || kind === "working";
}

const cap = (arr: TimelineStep[]): TimelineStep[] =>
  arr.length > MAX_THINKING_STEPS ? arr.slice(arr.length - MAX_THINKING_STEPS) : arr;

/**
 * 追加一步（progress / thinking_step 都走这里）。
 * 返回**新数组**（React state 要靠引用变化触发渲染），入参不改。
 */
export function appendStep(
  steps: readonly TimelineStep[],
  step: { text?: string; kind?: string; detail?: string },
  ts: number,
): TimelineStep[] {
  const text = (step?.text || "").trim();
  if (!text) return steps as TimelineStep[];
  if (isWaitHint(step?.kind)) return steps as TimelineStep[];

  const kind = (step.kind === "tool" || step.kind === "result" || step.kind === "thought"
    ? step.kind
    : "status") as TimelineStep["kind"];

  const last = steps[steps.length - 1];
  if (last && last.text === text && last.kind === kind) {
    // 升级：agent 先在 contentBlockStart 发一句"调用 X"（无 detail），工具入参齐了再发一条
    // 同文的 thinking_step 带 detail（region=… 之类）。同文同类且**新的有 detail、旧的没有** →
    // 原地把上一行换成带 detail 的版本（不新增行、不计 repeat），让那行长出参数细节。
    if (step.detail && !last.detail) {
      return [...steps.slice(0, -1), { ...last, detail: step.detail, ts }];
    }
    // 规则 3：否则（真正的重复行，如多区域轮询同一 API）→ 只加计数，不新增一行。
    const merged: TimelineStep = { ...last, repeat: (last.repeat || 1) + 1 };
    return [...steps.slice(0, -1), merged];
  }
  return cap([...steps, { text, kind, detail: step.detail || undefined, ts }]);
}

/**
 * 追加一段模型思考增量。规则 2：紧邻的思考并进最后那一段（同一次"想"）。
 * 一旦中间插过工具/状态行，就另起一段 —— 那确实是新一轮思考。
 */
export function appendReasoning(
  steps: readonly TimelineStep[],
  delta: string,
  ts: number,
): TimelineStep[] {
  if (!delta) return steps as TimelineStep[];
  const last = steps[steps.length - 1];
  if (last && last.kind === "thought") {
    const text = (last.text + delta).slice(0, MAX_THOUGHT_CHARS);
    if (text === last.text) return steps as TimelineStep[]; // 已到上限，别白造新数组
    return [...steps.slice(0, -1), { ...last, text }];
  }
  const text = delta.slice(0, MAX_THOUGHT_CHARS).trimStart();
  if (!text) return steps as TimelineStep[];
  return cap([...steps, { text, kind: "thought", ts }]);
}

/** 面板是否有内容可展示（空时不该出现入口按钮/自动弹面板）。 */
export const hasThinking = (steps?: readonly TimelineStep[]): boolean => (steps?.length ?? 0) > 0;
