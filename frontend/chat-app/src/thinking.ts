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
 *   · `reasoning` —— 模型思考增量（只有明文那部分：Kimi K3 / GLM 5.3 是明文；Grok 是加密链
 *     redactedContent，拿不到也不该拿）。2026-10-10 起它**只**进这条时间线，气泡里不再另有一份；
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

/** 掐断时留在末尾的标记 —— 让人知道「后面还有、只是没收」。2026-10-10 起思考只在这个面板里展示
 *  （气泡里那份不封顶的折叠灰字已删），无声截断会让人以为模型就想到这儿。 */
export const THOUGHT_TRUNCATED_MARK = " …";

/** 把一段思考收进上限；超了就截到「上限 − 标记长度」再补标记，结果长度恰好等于上限。 */
const clampThought = (text: string): string =>
  text.length > MAX_THOUGHT_CHARS
    ? text.slice(0, MAX_THOUGHT_CHARS - THOUGHT_TRUNCATED_MARK.length) + THOUGHT_TRUNCATED_MARK
    : text;

/** 时间线里的一步。`repeat` 是"这行连续出现了几次"（1 不显示）。 */
export type TimelineStep = ThinkingStep & { repeat?: number };

/**
 * BFF 自己发的等待期提示（不是后台真在做的事）→ 不进时间线。
 * 判据用 kind 而不是文案匹配：文案会随 i18n / 措辞调整变，kind 是契约。
 */
export function isWaitHint(kind?: string): boolean {
  return kind === "coldstart" || kind === "working";
}

/**
 * 「镜像」进度行（kind=mirror，`bff/web-chat/devops_chat.mjs::makeSink().mirror`）：同一句话刚作为
 * 过程行（investigation_step）进过时间线，这一条只用来刷新气泡里的等待行 → **不再记一次**。
 * 以前 DevOps 对话的每个阶段名都在面板里出现两次（同文同类合成「×2」），摘要那条更是 400 字与
 * 120 字截断各一行（#32 ②）。
 */
export const MIRROR_KIND = "mirror";

/**
 * 气泡等待行的文字：去掉进度文字末尾自带的省略号，没有进度时用 `fallback`。等待行后面紧跟一个会动的
 * 「…」（`.tk-dots`），而 BFF / agent 发来的进度大多自带「…」（「DevOps Agent 正在思考…」
 * 「Connecting to DevOps Agent…」），拼起来就是「……」（#32 ②）。
 */
export function waitingText(progress: string | undefined, fallback: string): string {
  const s = (progress || "").replace(/(?:\s*(?:…|\.\.\.))+\s*$/u, "").trimEnd();
  return s || fallback;
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
  if (isWaitHint(step?.kind) || step?.kind === MIRROR_KIND) return steps as TimelineStep[];

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
    // 已截断过（到上限且带标记）→ 后面的增量一律丢，别白造新数组。只看长度不够：恰好拼到上限、
    // 还没超的那一刻没有标记，下一个增量来了才知道后面还有 —— 那时要补上标记，而不是悄悄丢掉。
    if (last.text.length >= MAX_THOUGHT_CHARS && last.text.endsWith(THOUGHT_TRUNCATED_MARK)) {
      return steps as TimelineStep[];
    }
    return [...steps.slice(0, -1), { ...last, text: clampThought(last.text + delta) }];
  }
  const text = clampThought(delta.trimStart());
  if (!text) return steps as TimelineStep[];
  return cap([...steps, { text, kind: "thought", ts }]);
}

/** 面板是否有内容可展示（空时不该出现入口按钮/自动弹面板）。 */
export const hasThinking = (steps?: readonly TimelineStep[]): boolean => (steps?.length ?? 0) > 0;
