/**
 * 会话主题的入口归一（BFF 侧）。
 *
 * 目前只做一件事：**"security" → "investigate"**（2026-09-11 起「安全」不再是聊天主题，
 * 并入「调查」；安全**看板**保留，只是不再有安全聊天）。
 *
 * 为什么 BFF 也要有一份（前端已经归一过了）：
 *
 *   1. **已经打开的旧标签页**。前端是 CloudFront 上的静态 bundle，部署完不会自己刷新。
 *      老 bundle 会继续发 `topic:"security"`，而且能通过 `ensureConversation` 在
 *      DynamoDB 里**新建**一条 `topic:"security"` 的会话头（那条记录之后永远改不了 ——
 *      写入带 `attribute_not_exists(SK)` 条件，也没有任何接口能改 topic）。
 *   2. **部署窗口**。`scripts/deploy_agent.sh` 跑在 `cdk deploy` **之前**（agent 先、
 *      BFF+前端后），这段时间新 agent 收到的还是老 BFF 转发的 "security"。
 *
 * ⚠️ 两个入口必须**同时**归一：`POST /stream` 和 `POST /warmup`。agent 侧的 LRU
 *    缓存键**包含 topic**（main.py 的 `_agent_cache.build_key`），只归一一个的话，
 *    预热建出来的 agent 挂在一个真实请求永远不会命中的 key 上 —— 那 ~10s 冷启动
 *    原价回来，而且哪儿都不报错。
 *
 * 归一之后 "security" 的那些老会话就真的变成 investigate：工具从 core 8 个变成 22 个，
 * 并注入 investigate 的 focus 段（固定 schema 成本 +约 10.4K token/轮）。这是**有意的**
 * 代价 —— 那才是这次合并的目的：安全问题以前拿的是更差的能力。
 */

/** 退役主题别名表。key = 存量里可能出现的旧值，value = 归一后的主题。
 *
 *  ⚠️ 原型必须是 null：这张表是用**客户端传来的字符串**下标查的，普通对象字面量会让
 *  `topic:"constructor"` / `"toString"` 查出 Object.prototype 上的函数（truthy!），
 *  于是 `normalizeTopic` 返回一个**函数**当主题 —— 之后 `JSON.stringify` 把它整个字段
 *  丢掉，agent 侧收到的 payload 干脆没有 topic。不是安全漏洞，但是一条纯静默的畸形路径。 */
const TOPIC_ALIASES = Object.freeze(Object.assign(Object.create(null), { security: "investigate" }));

/**
 * 归一一个 topic 字符串。
 *
 * 刻意**不做**allowlist 校验：BFF 至今对 topic 没有任何 allowlist（agent 侧全是
 * `.get(topic, "")` / `!=` 比较，未知值只是拿不到 focus），突然开始 4xx 会把老客户端
 * 打死。这里只把已知的退役别名改写掉，其余原样透传。
 */
export function normalizeTopic(t) {
  const s = (t || "general").toString();
  return TOPIC_ALIASES[s] || s;
}
