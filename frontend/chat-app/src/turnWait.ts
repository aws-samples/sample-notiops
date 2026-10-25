/**
 * 「上一轮还在进行」（待办 #30 第 ②③ 档）的两个纯函数 —— 拆出来是为了能单测，接线在 ChatApp.tsx。
 *
 * 背景：同一个会话同一时间只能跑一轮（runtime 里 strands 的 Agent 锁）。2026-10-15 验证账号：第一轮
 * 等模型 300 秒，期间用户刷新页面、在同一会话里重发了两次，两次都被说成「本轮处理失败，请再发送一次」。
 * 现在：BFF 发 busy 事件 / 服务端记着「有一轮在跑」，界面进入等待状态 —— 显示已等多久、可以停掉它、
 * 也可以换个新对话；那一轮结束后自动重新拉消息，用户不用自己刷新。
 */

/** 已等了多久：`m:ss`（超过一小时也照样按分钟数写，等这么久本身就该停掉了）。 */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * 这一轮走不走 NotiOps agent —— 只有这条路在 runtime 里有一个会话可停（StopRuntimeSession）。
 * 对话对象是客户自己的 DevOps Agent / 阿里云 STAROps、或者这一轮是直连深度调查时，回答根本不经过
 * runtime：去停 runtime 会话不会停掉它们，只会把一个热着的 agent 容器白白打成冷启动。
 */
export function isAgentPathTurn(t: { devopsChat?: boolean; starops?: boolean; deepDirect?: boolean }): boolean {
  return !t.devopsChat && !t.starops && !t.deepDirect;
}
