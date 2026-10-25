/**
 * 输出崩坏守卫（agent 侧 degeneration.py，待办 #2）在浏览器这一侧的那一半：**纯**逻辑，可单测。
 *
 * agent 在每次模型调用开头发一个书签（`call_start`，第几次调用）；某次调用的输出被判成乱码
 * （Kimi K3 偶发：中英碎片用 `-` 粘连，或无限重复的 ` @`）时发 `discard`，然后自动重试一次。
 * 这里在书签处记下当时的正文与「思考过程」时间线，discard 时原样退回去 —— 用户刚看到的那段乱码
 * 消失，重试那次的输出接着往下写。BFF 落库的回答按同一个书签退回（agentcore.mjs），刷新后一致。
 *
 * 只记引用：时间线的追加函数（thinking.ts）每次都返回新数组、不改旧的，所以书签里的那份不会被改掉。
 */
export interface StreamMark<T> {
  text: string;
  timeline: T;
}

export interface StreamRewind<T> {
  /** 第 `call` 次模型调用开始了：记下此刻的正文与时间线。 */
  mark(call: number, text: string, timeline: T): void;
  /** 丢掉第 `call` 次调用：返回它开始时的样子；没记过这个书签（老 BFF、帧乱序）就返回 undefined —— 原样不动。 */
  rewind(call: number | undefined): StreamMark<T> | undefined;
}

export function createStreamRewind<T>(): StreamRewind<T> {
  const marks = new Map<number, StreamMark<T>>();
  return {
    mark(call, text, timeline) {
      if (Number.isInteger(call)) marks.set(call, { text, timeline });
    },
    rewind(call) {
      return typeof call === "number" ? marks.get(call) : undefined;
    },
  };
}
