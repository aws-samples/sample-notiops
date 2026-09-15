import type { SourceItem, TokenUsage, InvestigationStep } from "./api/chat";
import type { TimelineStep } from "./thinking";
import { MULTICLOUD_UI } from "./featureFlags";

export type Role = "user" | "assistant";

// 待确认写操作（创建/回复/关闭 case）。
// create_case_form = **可编辑建案卡**（客户在卡里填/选服务/严重级别/语言/附加上下文，
//   预览后确认才建案）；其余是只读确认卡。
export interface ProposedAction {
  type: "create_case" | "create_case_form" | "create_case_review" | "add_communication" | "resolve_case";
  summary?: string;
  params?: Record<string, unknown>;
  // 目标 AWS 账号（agent 提议时按本轮 _acct() 写入；空=部署账号）。执行时必须原样带回
  // BFF，否则跨账号(linked account)的写操作会误落到部署账号。见 confirmAction 的 toExec。
  account_id?: string;
  // 前端本地状态：执行结果（确认后回填，用于卡片显示已执行/失败）
  done?: boolean;
  /** `duplicate:true` = BFF 回放的**同一操作既有结果**（没有重复执行；见 support.mjs 幂等段）。
   *  卡上必须明说，否则用户以为自己刚刚又开了一个案例。 */
  result?: { ok: boolean; verified?: boolean; status?: string; message?: string; caseId?: string; displayId?: string; duplicate?: boolean };
}

export interface Followup { label: string; prompt?: string; url?: string }

export interface ChatMessage {
  id: string;
  role: Role;
  text: string;
  ts: number;            // epoch ms
  model?: string;
  sources?: SourceItem[];
  actions?: ProposedAction[]; // 待确认写操作（cases 写操作的确认卡）
  followups?: Followup[];  // 快捷后续按钮（点击=发送 prompt，如调查后的 生成缓解/转人工）
  investigationSteps?: InvestigationStep[]; // 调查分析过程（走右侧「调查过程」面板，不在气泡里）
  investigationConsoleUrl?: string;         // 本次调查的 DevOps Agent 后台深链（面板顶部）
  thinkingSteps?: TimelineStep[];           // 思考/处理过程时间线（走右侧「思考过程」面板；任意长任务通用）
  usage?: TokenUsage;    // 本轮 token 用量（显示在署名行）
  // 答案来源标记。缺省=本地模型（署名 "AWS Bedrock (某模型)"）。
  //   "devops-agent" —— 由**客户自己的 DevOps Agent** 生成（「DevOps 对话」开关），署名
  //                     "AWS DevOps Agent"；前端在发起时就知道，故建消息时即置。
  //   "builtin"      —— agent 的**内置确定性回答**（如「你能做什么」），完全未调模型、
  //                     0 token，署名 "NotiOps"。前端事先不知道，由 agent 在流里发
  //                     `via` 事件告知（BFF 落库同字段，刷新后历史不被错误署名）。
  via?: string;
  // 阿里云数字员工 ID（只有 via="starops" 的回复有）：页脚里"这条是哪个数字员工答的"。
  // 一个阿里云账号可以有多个员工、纳管范围各不相同，所以这是读答案的必要坐标。
  // ⚠️ 必须来自**这一轮**（BFF 在 `via` 事件里带回、并逐条落库），不能读当前配置 ——
  //    管理员换过员工之后，历史回复要仍显示当时那一个。
  staropsEmployee?: string;
  accountId?: string;    // 本轮提问的目标 AWS 账号（多账号可切换，故按条记录，让历史回复能标明针对哪个账号）
  streaming?: boolean;   // 正在流式输出
  thinking?: boolean;    // 思考态（尚无 token）
  thinkElapsed?: number; // 思考已用秒
  progress?: string;     // 处理中的临时状态行（"正在做什么"，工具调用等）——瞬态，收到正文即清空
  reasoning?: string;    // 思考过程（模型 reasoning，累积）——可折叠灰字，默认折叠
}

// 会话主题：general=通用（默认，不打 tag）；其余对应侧边栏主题入口。
// 通用对话已能完成大部分工作；主题只是带特定上下文的入口 + 会话分类标签。
//
// 🔴 **"security" 不再是聊天主题**（2026-09-11 并入 investigate）。原因是它的聊天能力是
//    investigate 的**真子集**，不是另一种能力：agent 侧 `_TOPIC_FOCUS` 里根本没有
//    "security" 这一项（system prompt 与 general 逐字节相同），工具也只挂到 core 8 个 ——
//    investigate 是 22 个，且独有 `lake_query`（CloudTrail Lake）/ `analyze_metric` /
//    `execute_cwl_insights_batch`。也就是说客户在「安全」里问安全问题，拿到的能力
//    **比在「调查」里问同一句更差**。安全看板（TopicKey 之外的 `view === "security"`）
//    保留，改由侧栏入口与调查输入框上方那行「仪表盘」pill 进入。
//    老会话里存着的 topic:"security" 由 `normalizeTopic` 读时改写（见下）。
export type TopicKey = "general" | "investigate" | "finops" | "cases" | "whats-new";

export interface TopicDef {
  key: TopicKey;
  labelKey: string;   // i18n key（复用 topic.* ）
  color: string;      // tag 颜色（CSS 变量或色值）
}

// 主题注册表（general 不在列表里，因为它不显示 tag）。图标在组件里按 key 取。
// 顺序即侧栏导航顺序，也是会话列表按主题分组的显示顺序（单一事实来源）。
export const TOPICS: TopicDef[] = [
  { key: "investigate", labelKey: "topic.investigate", color: "var(--orange2)" },
  { key: "finops",      labelKey: "topic.cost",        color: "var(--green)" },
  { key: "cases",       labelKey: "topic.cases",       color: "var(--blue)" },
  { key: "whats-new",   labelKey: "topic.whatsnew",    color: "var(--teal)" },
];

export const topicDef = (k?: string): TopicDef | undefined =>
  TOPICS.find((t) => t.key === k);

/**
 * 退役主题的读时改写（**只做一件事：security → investigate**）。
 *
 * 为什么必须有：会话头条目里的 `topic` 属性**永远不会被改写** ——
 * `store.mjs` 的 `ensureConversation` 带 `ConditionExpression: "attribute_not_exists(SK)"`，
 * 而 `touchConversation` / `renameConversation` / `PATCH /conversations/{id}` 都不碰 topic。
 * 所以 DynamoDB 里那些 `topic:"security"` 会一直存在（TTL 每轮刷新，活跃用户等于永久）。
 * 任何「下次发消息就自愈」的假设都是错的，必须在**读**的时候归一。
 *
 * 不归一会怎样（不报错、全静默）：`topicDef("security")` 返回 undefined → 顶栏主题 tag 消失；
 * 侧栏分组回落到「通用」灰 tag；chip 池回落到 general；而且它继续把 `topic:"security"` 发给
 * agent → 那边照旧只挂 8 个 core 工具。TypeScript 抓不到任何一处：
 * `ConversationSummary.topic` 是 `string`，水合处是 `as TopicKey` 硬转。
 *
 * ⚠️ 前端归一只覆盖**本次加载的这个 bundle**。已经打开的旧标签页会继续发 "security"，
 *    所以 BFF 入口（`index.mjs` 的 /stream 与 /warmup）必须有一份同样的归一，agent 侧
 *    再兜一层 —— 三层都要，理由见 bff/web-chat/topic.mjs 的注释。
 */
export function normalizeTopic(k?: string): TopicKey {
  if (k === "security") return "investigate";
  return TOPICS.some((t) => t.key === k) ? (k as TopicKey) : "general";
}

// 通用会话的 tag 定义：不在 TOPICS（不作侧栏导航入口），但需要一个与其它主题**设计一致**
// 的标签（中性灰 + 对话气泡图标），用于置顶组等需要显式标注主题的场合。
export const GENERAL_TAG: TopicDef = { key: "general", labelKey: "topic.general", color: "var(--muted)" };

// 取任意会话的 tag 定义：主题会话取对应 TopicDef；general/未设主题回落到 GENERAL_TAG。
// 与 topicDef 的区别：topicDef 只认导航主题（general 返回 undefined，用于「是否是导航主题」判断）；
// tagDef 永远返回一个可渲染的 tag（用于会话标签展示，保证通用会话也有一致的 tag）。
export const tagDef = (k?: string): TopicDef =>
  TOPICS.find((t) => t.key === k) ?? GENERAL_TAG;

// ── 侧栏的「对话对象」tag（这段会话最后一轮是**谁**答的）─────────────────────
// 为什么侧栏需要它：主题分组的组标题只说"这是通用/故障调查会话"，说不了"这段是 NotiOps
// 答的、还是客户自己的 DevOps Agent / 阿里云数字员工答的"。而通用会话恰恰全都堆在一个
// 「通用」组里 —— 翻回一段旧会话时，除了点开看，没有任何线索。
//
// 唯一的事实来源是服务端 `listConversations()` 回的 `obj`（store.mjs 写在会话头上）。
// **不许**用本地那份 convMode 记忆代替：那是 per-浏览器 的，换台机器就成了空 —— 而
// 「猜错」比「不标」糟得多（把一段阿里云会话标成 NotiOps 是跨云假信息）。
//
// 颜色/图标与顶栏那三枚对象 tag 同源（ChatApp.tsx 的 topbar-topic）：
// starops=--link、devops=--ok、notiops=--orange。两处必须一致，否则同一段会话在侧栏
// 和顶栏是两个颜色，客户会以为是两个东西。
// 标签文字用**短名**（NotiOps / DevOps / STAROps），全称放 title —— 侧栏那一行宽度就那么点，
// "AWS DevOps Agent" 会把会话标题挤没。
export interface ObjTagDef { key: string; labelKey: string; hintKey: string; color: string }

const OBJ_TAGS: readonly ObjTagDef[] = [
  { key: "starops", labelKey: "conv.obj.starops", hintKey: "obj.tag.starops.hint", color: "var(--link)" },
  { key: "devops", labelKey: "conv.obj.devops", hintKey: "obj.tag.devops.hint", color: "var(--ok)" },
  { key: "notiops", labelKey: "conv.obj.notiops", hintKey: "obj.tag.notiops.hint", color: "var(--orange)" },
];

/** 服务端 `obj` → tag 定义。**未知/空一律返回 undefined**（老会话没有这个属性）：
 *  调用方据此回落到主题 tag，而不是把它当成 notiops —— 默认值猜错就是标错。 */
export const objTagDef = (obj?: string): ObjTagDef | undefined =>
  OBJ_TAGS.find((o) => o.key === obj);

// ── 「深度调查」（DevOps Agent）的主题适用范围 ────────────────────────────────
// **口径：默认提供，按例外排除**（不是按主题白名单开启）。深度调查是一条与主题解耦的
// 通用能力，以后新增主题应**自动继承**它 —— 所以这里列的是**不提供**它的主题。
// 排除理由：general 通用会话不给入口；cases 是 Support Case 生命周期管理、不是环境排障；
// whats-new 读 AWS 资讯、与用户环境无关。
// ⚠️ 必须与后端 `main.py` 的 `_DEVOPS_TOPICS_EXCLUDED` **保持一致**：只改一边会造成
// 「开关亮着但后端没挂工具」的静默失效。此前该判断在前后端共有三份硬编码字符串。
const DEVOPS_TOPICS_EXCLUDED: ReadonlySet<string> = new Set(["general", "cases", "whats-new"]);

export const topicHasDevopsAgent = (k?: string): boolean =>
  !DEVOPS_TOPICS_EXCLUDED.has(k || "general");

/**
 * 哪些主题在工具条上提供「DevOps 对话」这个**平铺开关**。
 *
 * 口径与上面那条相反 —— 这里是**显式列举**，不跟随 `topicHasDevopsAgent` 的
 * 「默认提供、按例外排除」：那份排除表管的是"给我们的 agent 挂 DevOps 工具"，
 * 与这条**根本不经我们 agent** 的直连路径无关。
 * 通用会话（general）刻意不在其中：那里改由新对话主页的「对话对象」两张卡来选
 * （ChatObjectPicker），选完发第一句即锁定 —— 一个能力两个入口会让"这段对话谁在答"
 * 变得不可预期（开关是每轮修饰，对象是整段会话的事实）。
 *
 * 从 Composer 里那个局部 `CHAT_TOPICS` 提上来的：会话模式要**跨刷新**恢复，
 * ChatApp 侧也要判"这个主题到底有没有这个开关"，两处各写一份必然漂。
 */
const DEVOPS_CHAT_TOPICS: ReadonlySet<string> = new Set(["investigate"]);

export const topicHasDevopsChat = (k?: string): boolean =>
  DEVOPS_CHAT_TOPICS.has(k || "general");

/**
 * 哪些主题可以把「对话对象」选成 **STAROps**（客户自己的阿里云数字员工）。
 *
 * 口径与上面 `DEVOPS_CHAT_TOPICS` 一样是**显式列举**，而且**只有通用会话**。两条理由：
 *  1. 入口只有一个 —— 新对话主页的「对话对象」选择器（ChatObjectPicker）。STAROps
 *     **刻意不做**工具条上的平铺开关：其余主题（FinOps / 故障调查 / 案例 / 巡检 / 安全）
 *     整套语境、工具和左侧看板都是 **AWS**，在里面摆一个指向阿里云的开关，客户勾上以后
 *     看到的答案与这一页的数据来自两朵不同的云 —— 界面上却完全看不出来。
 *  2. STAROps 也**不需要**单独的「深度调查」开关：让数字员工自己发起巡检/排查就是一句
 *     自然语言的事（这正是 STAROps 控制台的行为）。多一个开关只会造出一个我们保证不了的语义。
 *
 * ⚠️ 必须真的包含 `general`，否则 `restorableMode` 会把记住的模式**静默丢掉**
 *    —— 而 general 恰恰是唯一能选 STAROps 的地方（`devopsChat` 今天就踩在这个坑里：
 *    它的表里没有 general，所以通用会话里选的「DevOps 对话」跨刷新只能靠历史 `via` 回锁）。
 */
const STAROPS_TOPICS: ReadonlySet<string> = new Set(["general"]);

/**
 * ⚠️ 2026-09-15 产品决策：多云先**不对外**，所以这里在 `MULTICLOUD_UI` 关着的时候
 * 一律回 `false` —— 表本身（上面那个 `STAROPS_TOPICS`）原样留着，把
 * `featureFlags.ts` 里的 `MULTICLOUD_UI` 翻成 `true` 就整套回来。
 *
 * 为什么闸门放在这个函数里，而不是只在选择器那边不渲染：这个函数还被
 * `convMode.restorableMode` 用来判"这个主题到底有没有这个模式"。只藏 UI 的话，
 * 之前选过 STAROps 的会话刷新后会**恢复成一个界面上根本看不见的对象** —— 用户在
 * 通用会话里问一句 AWS，答案来自阿里云，而界面上没有任何地方显示它切走了。
 * 那正是 `convMode.ts` 文件头点名的那种坑。
 *
 * 只影响「还能不能**新选** STAROps」。已经存在的 STAROps 会话在侧栏仍然正确显示
 * 成 STAROps（`CONV_OBJECTS` 那格是只读展示，有意不跟着藏）。
 */
export const topicHasStarops = (k?: string): boolean =>
  MULTICLOUD_UI && STAROPS_TOPICS.has(k || "general");

/**
 * 从「事件通知」类卡片的「深入调查」发起会话时，新会话要带的两个深度调查开关。
 *
 * 为什么需要：这类卡片发出去的正文是后端 `core/push_event.py` 的 `dispatch_query`，
 * 那个字段的注释写的就是 "text to send to DevOps Agent for follow-up investigation" ——
 * 按钮从一开始就是深度调查的入口。但前端只起了一个「故障调查」主题的会话、两个开关都没开
 * （ChatApp 的注释甚至写着"默认开 DevOps Agent"，与代码不符），于是用户点完「深入调查」，
 * Composer 里「深度调查（直连）」是没勾的，那一轮走的其实是普通问答。
 * 把这个决定收成纯函数，才能在测试里钉住，不再靠每个调用点手工同步（漂了一次了）。
 *
 * 口径：
 *   · 只开**直连**那个（BFF 直连 DevOps Agent API、0 token），并显式关掉计费那个 ——
 *     两者互斥，同时开会同时走两条路。
 *   · 主题不提供深度调查（general / cases / whats-new）→ 两个都关：开了也没有开关可显示，
 *     用户既看不到也关不掉。
 *   · **不**在这里做能力探测。账号没接入 DevOps Agent 时直连路径自己会回一句
 *     「无法定位该账号的 Agent Space，请确认已接入」并以 0 token 收尾
 *     （devops_investigate.mjs），Composer 随后也会把开关置灰写明原因。
 *     先探测再发意味着点击后多等一个往返、以及"点了没反应"，而代价只是一句真实报错——
 *     这与仓库既有取舍一致（"宁可让用户点进去看到真实报错"）。
 */
export function deepDiveTogglesFor(topic?: string): { devopsAgent: boolean; devopsAgentDirect: boolean } {
  return { devopsAgent: false, devopsAgentDirect: topicHasDevopsAgent(topic) };
}

export interface Conversation {
  id: string;
  title: string;
  icon?: string;
  topic?: TopicKey;      // 会话所属主题（默认 general/未设 = 通用）
  // 最后一轮的「对话对象」（"notiops" | "devops" | "starops"）。**只读展示字段**，
  // 事实来源是服务端 `listConversations()`；本地新建的会话恒为 undefined（没答过就没有对象）。
  // 与下面那四个互斥开关是两回事：开关是"下一轮走哪条路"，obj 是"上一轮谁答的"。
  // 别拿开关反推它 —— 客户在会话里换过对象、或换台机器打开，两者就不一致了。
  obj?: string;
  model?: string;        // 本会话选用的模型（缺省走 defaultModelId()，兜底 DEFAULT_MODEL）
  accountId?: string;    // 本会话目标 AWS 账号（默认空=部署账号）
  webSearch?: boolean;   // 本会话是否开启联网搜索（默认关；每会话独立）
  finopsAgent?: boolean; // 本会话是否启用 FinOps Agent 深度模式（默认关；仅 FinOps 主题；每会话独立）
  devopsAgent?: boolean; // 本会话是否启用 DevOps Agent 深度调查（默认关；仅故障调查主题；每会话独立）
  // 本会话是否启用「深度调查（直连）」：BFF 直连 DevOps Agent API、**0 token**（默认关）。
  // 与 devopsAgent **互斥**（同时开会同时走两条路），互斥逻辑在 ChatApp 的 toggle 里。
  devopsAgentDirect?: boolean;
  // 本会话是否启用「DevOps 对话」：BFF 直连 DevOps Agent 控制面 CreateChat/SendMessage，
  // 由**客户自己的 DevOps Agent** 回答（NotiOps 侧 **0 token**，默认关）。
  // 与上面两个开关**三方互斥**（同时开会同时走多条路），互斥逻辑在 ChatApp 的 setDevopsMode 里。
  devopsChat?: boolean;
  // 本会话的「对话对象」是否为 **STAROps**：BFF 直连**阿里云** STAROps 数字员工
  // （CreateChat + SSE），由客户自己的数字员工回答 —— 计他自己的阿里云 AI 额度，
  // NotiOps 侧同样 **0 token**、不经 Bedrock（默认关）。
  // 与上面三个 DevOps 开关**四方互斥**，且 STAROps **优先**（互斥在 ChatApp 的
  // setDevopsMode 与 BFF 的一选一里各自落实）。互斥不是洁癖：一个指向阿里云的问题被
  // AWS DevOps Agent 悄悄接走，等于把问题原文发到了**另一朵云**，而界面上看不出来。
  starops?: boolean;
  // 后端只回了最近 N 条历史、更早的没读（GET /conversations/{id} 的 truncated）。
  // 只在**从后端水合**时置位；本地新建会话恒为 undefined。
  historyTruncated?: boolean;
  // 服务端那一次读用的条数上限（只在 historyTruncated 为真时有意义）。
  historyLimit?: number;
  messages: ChatMessage[];
  updatedAt: number;
  pinned?: boolean;
}

// 新对话默认模型的**兜底**值。真值由 GET /models 下发（管理员在「管理 → 模型」里定），
// 见 models.ts 的 defaultModelId()。这里保留是为了首帧渲染和接口读不到时不至于没模型可用。
export const DEFAULT_MODEL = "xai-grok-4-6";

export interface ModelOption {
  id: string;
  name: string;
  descKey: string;       // i18n key
  flagKey?: string;      // 如 "实验"
}

// 内置**兜底**目录：GET /models 读不到（未登录首帧 / 接口异常 / 目录未 seed）时用它。
// 正常情况下界面展示的是管理员勾选的启用集，别在这里加模型来"上线"一个模型 ——
// 真源是 config/llm-model-catalog.json + DynamoDB llmcfg。
//
// 顺序**必须与种子里 webchat 启用集的顺序一致**（不再按首字母排）：下拉框直接按数组顺序
// 渲染，而服务端 `/models` 是原样保留种子/DDB 的数组顺序的 —— 这里自己排一遍的话，
// 降级前后列表会重排，看起来像"模型换了一批"。默认模型放第一位（2026-09-03 用户要求：
// Grok 置顶、GLM 次之，其余相对顺序不动）。
export const MODELS: ModelOption[] = [
  { id: "xai-grok-4-6", name: "Grok 4.6", descKey: "model.desc.grok" },
  { id: "zai-glm-5", name: "GLM 5", descKey: "model.desc.glm" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", descKey: "model.desc.claude" },
  { id: "claude-opus-5", name: "Claude Opus 5", descKey: "model.desc.opus" },
  { id: "amazon-nova-pro", name: "Amazon Nova Pro", descKey: "model.desc.nova" },
  { id: "deepseek-v3-2", name: "DeepSeek V3.2", descKey: "model.desc.deepseek" },
  { id: "gpt-5-6", name: "GPT-5.6 Terra", descKey: "model.desc.gpt" },
  { id: "gpt-5-6-sol", name: "GPT-5.6 Sol", descKey: "model.desc.gptSol" },
];

// 已从 Web 列表下架、但**历史消息里还留着**的模型。只用于把落款上的 id 还原成显示名
// （见 models.ts 的 `modelDisplayName`）—— 不进任何可选清单。
// 下架一个模型时把它从 MODELS 挪到这里，别直接删：删了之后翻回去看老对话，落款会从
// 「Claude Haiku 4.5」变成裸 alias `claude-haiku-4-5`。
export const RETIRED_MODELS: ModelOption[] = [
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", descKey: "model.desc.haiku" },
  { id: "gpt-5-6-luna", name: "GPT-5.6 Luna", descKey: "model.desc.gptLuna" },
];
