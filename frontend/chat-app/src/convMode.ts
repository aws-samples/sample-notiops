/**
 * 每会话的「谁来答这一轮」记忆 —— 让工具条上选的那一项（深度调查 / DevOps 对话），以及
 * 新对话主页选的对话对象（DevOps Agent / 阿里云 STAROps），**跨刷新**留在这个会话上，
 * 除非客户自己改。
 *
 * 要修的是什么：`devopsAgent` / `devopsAgentDirect` / `devopsChat` 三个字段只活在
 * `Conversation` 这个前端对象里，**后端不存**（`listConversations()` 回的记录里没有它们）。
 * 于是刷新页面后 ChatApp 从后端重建会话列表，三个字段一律回落 `false` ——
 * 客户实测到的就是「在调查会话里选了 DevOps 对话、发过问、刷新一下选择没了」。
 * 更糟的是它**不报错**：接着追问会静默换成 NotiOps 来答，客户只会觉得答案风格突然变了。
 *
 * 为什么放在 localStorage 而不是后端：
 *  1. 这是纯前端的一次**修复**，两条安装路径（方式A 一键 CFN / 方式B setup.sh）共用同一份
 *     `chat-app/dist` asset，落在 localStorage 天然对等，不需要动 BFF / DDB / 模板；
 *  2. 后端已经有一条更强的恢复路径且保留着 —— 历史消息里的 `via="devops-agent"`
 *     是持久化的事实（见 ChatApp 水合处），跨浏览器也成立。这里补的是它覆盖不到的两种情况：
 *     选了模式但**还没发过消息**就刷新，以及「深度调查」这类不产生 `via` 落款的模式。
 *  3. 模式是"这台机器上这个人当前怎么用"的偏好，不是需要在账号间同步的业务数据。
 *
 * 换机器 / 换浏览器 / 清了站点数据 → 回落到 `via` 那条路径，最差也只是回到今天的行为。
 * 存储读写全程 try/catch：Safari 隐私模式下 localStorage 会直接抛，绝不能让它把聊天页带崩。
 */

import { topicHasDevopsAgent, topicHasDevopsChat, topicHasStarops } from "./types";

/** 三个 DevOps 开关 + STAROps 是单选，用一个枚举表达；`off` = 都没开（= 不落盘）。
 *
 * `starops` 与前三个是**同一个单选**而不是另一个维度：它也是「这段对话谁在答」这件事实，
 * 只是答的人在**另一朵云**（客户自己的阿里云 STAROps 数字员工）。放进同一个枚举，
 * 互斥就由类型本身保证 —— 两个对象同时为真的状态在这里根本表达不出来。 */
export type DevopsMode = "agent" | "direct" | "chat" | "starops" | "off";

const KEY = "notiops.convMode";
/**
 * 最多记多少个会话。超了按插入顺序丢最旧的。
 * 只存非 `off` 的条目，所以正常用法下远到不了上限（客户得在 200 个不同会话里各选一次模式）。
 * 设这个上限纯粹是防 localStorage 被一个长期使用的浏览器慢慢撑大。
 */
const MAX = 200;

// ⚠️ 加了新模式一定要同时加进这里。漏加**不报错**：readAll 会把它当"老版本写进去的脏值"
//    静默丢掉，症状就是这个模式唯一记不住（其余模式都正常），极难往这儿找。
const VALID: ReadonlySet<string> = new Set(["agent", "direct", "chat", "starops"]);

/** 读整张表。任何异常（没有 localStorage / JSON 坏了 / 类型不对）都回空表。 */
function readAll(): Record<string, DevopsMode> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    const out: Record<string, DevopsMode> = {};
    // 逐条校验：老版本写进去的值、或客户手改过的值，不能变成一个 ChatApp 认不出的模式。
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === "string" && VALID.has(v)) out[k] = v as DevopsMode;
    }
    return out;
  } catch { return {}; }
}

/** 取某会话记住的模式；没记过（或记的是 off）→ `"off"`。 */
export function loadConvMode(convId: string): DevopsMode {
  if (!convId) return "off";
  return readAll()[convId] || "off";
}

/**
 * 记下某会话的模式。`off` = 删掉这一条（不留"我选择了都不开"这种条目）——
 * 否则每建一个空会话都会写一条，表很快被没意义的记录填满。
 */
export function saveConvMode(convId: string, mode: DevopsMode): void {
  if (!convId) return;
  try {
    const all = readAll();
    if (mode === "off") {
      if (!(convId in all)) return;   // 本来就没有 → 不写，省一次序列化
      delete all[convId];
    } else {
      if (all[convId] === mode) return; // 没变化 → 不写（这个函数被 effect 每次渲染都调）
      // 重新插入到末尾，让 MAX 的淘汰顺序真的是"最久没动过的先丢"。
      delete all[convId];
      all[convId] = mode;
    }
    const keys = Object.keys(all);
    if (keys.length > MAX) {
      for (const k of keys.slice(0, keys.length - MAX)) delete all[k];
    }
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* 存不下就算了：唯一后果是刷新后回到"模式没记住"的老行为 */ }
}

/** 会话被删除时清掉它的记录（否则新会话万一复用了同一个 id 会继承一个陌生的模式）。 */
export function forgetConvMode(convId: string): void {
  saveConvMode(convId, "off");
}

/**
 * 把三个布尔字段折成枚举。
 *
 * ⚠️ `devopsChat` 必须**先判**：通用会话里「深度调查（直连）」是这一轮的修饰
 * （对象仍是客户自己的 DevOps Agent，两个字段会同时为真，见 ChatApp 的
 * `toggleDevopsAgentDirect`）。按 direct 记会把整段对话的"对象"降级成一次性的开关，
 * 刷新后对话对象就丢了 —— 那正是这个模块要修的 bug 的另一种形态。
 */
export function modeOf(c: { devopsAgent?: boolean; devopsAgentDirect?: boolean; devopsChat?: boolean; starops?: boolean }): DevopsMode {
  // 🔴 `starops` **先判**，与 BFF 的一选一同序（index.mjs：STAROps 分支排在最前）。
  //    两边同序才有意义：万一某条写入路径漏了互斥、让 starops 与某个 DevOps 字段同时为真，
  //    前端记下的对象与后端实际答话的对象必须是**同一个**。反了就会出现"落款是阿里云、
  //    刷新后对象锁成 AWS DevOps Agent"这种自相矛盾的会话。
  if (c.starops) return "starops";
  if (c.devopsChat) return "chat";
  if (c.devopsAgent) return "agent";
  if (c.devopsAgentDirect) return "direct";
  return "off";
}

/** 枚举 → 四个布尔（恒定互斥，与 ChatApp 的 `setDevopsMode` 同口径）。 */
export function fieldsOf(mode: DevopsMode): { devopsAgent: boolean; devopsAgentDirect: boolean; devopsChat: boolean; starops: boolean } {
  return {
    devopsAgent: mode === "agent",
    devopsAgentDirect: mode === "direct",
    devopsChat: mode === "chat",
    starops: mode === "starops",
  };
}

/**
 * 恢复前的一道闸：这个主题**当前**还提供这个模式吗？不提供就当没记过。
 *
 * 必须有这一道，否则会出现「开着一个界面上根本没有的开关」——
 * 会话主题被改过、或某个模式后来收窄了适用主题（`topicHasDevopsChat` 就是显式列举、
 * 会变的），恢复回来的状态客户既看不到也关不掉，而它**真的**会改变下一轮走哪条链路。
 * 宁可回落到默认关：那只是少记了一次偏好，不会把请求送上一条错误的路。
 */
export function restorableMode(topic: string | undefined, mode: DevopsMode): DevopsMode {
  if (mode === "chat") return topicHasDevopsChat(topic) ? "chat" : "off";
  if (mode === "starops") return topicHasStarops(topic) ? "starops" : "off";
  if (mode === "direct") return topicHasDevopsAgent(topic) ? "direct" : "off";
  // 🔴 `"agent"`（经我们的 agent 转交那条深度调查）**一律恢复成 off**，哪怕主题还提供
  //    深度调查 —— 2026-09-13 起它在界面上**没有任何开关**（见 ModePicker 文件头 ①）。
  //    字段和 BFF 侧那条链路都还活着，所以"恢复"是能成的；恰恰因此才必须在这里挡：
  //    2026-09-13 之前落过盘的会话（以及任何写进 localStorage 的 "agent"）一旦恢复，
  //    客户会拿到一个看不见、关不掉、却真的会改变下一轮走哪条链路的模式 —— 这正是
  //    上面那段注释说的「开着一个界面上根本没有的开关」，只是这次触发它的不是主题变化
  //    而是入口下线。把入口加回来时，这一行要改回 `topicHasDevopsAgent(topic) ? mode : "off"`。
  return "off";
}
