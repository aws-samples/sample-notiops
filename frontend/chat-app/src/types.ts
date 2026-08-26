import type { SourceItem, TokenUsage, InvestigationStep } from "./api/chat";

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
  result?: { ok: boolean; verified?: boolean; status?: string; message?: string; caseId?: string; displayId?: string };
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
  usage?: TokenUsage;    // 本轮 token 用量（显示在署名行）
  accountId?: string;    // 本轮提问的目标 AWS 账号（多账号可切换，故按条记录，让历史回复能标明针对哪个账号）
  streaming?: boolean;   // 正在流式输出
  thinking?: boolean;    // 思考态（尚无 token）
  thinkElapsed?: number; // 思考已用秒
  progress?: string;     // 处理中的临时状态行（"正在做什么"，工具调用等）——瞬态，收到正文即清空
  reasoning?: string;    // 思考过程（模型 reasoning，累积）——可折叠灰字，默认折叠
}

// 会话主题：general=通用（默认，不打 tag）；其余对应侧边栏主题入口。
// 通用对话已能完成大部分工作；主题只是带特定上下文的入口 + 会话分类标签。
export type TopicKey = "general" | "investigate" | "finops" | "cases" | "security" | "whats-new";

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
  { key: "security",    labelKey: "topic.security",    color: "#8b5cf6" },
  { key: "cases",       labelKey: "topic.cases",       color: "var(--blue)" },
  { key: "whats-new",   labelKey: "topic.whatsnew",    color: "var(--teal)" },
];

export const topicDef = (k?: string): TopicDef | undefined =>
  TOPICS.find((t) => t.key === k);

// 通用会话的 tag 定义：不在 TOPICS（不作侧栏导航入口），但需要一个与其它主题**设计一致**
// 的标签（中性灰 + 对话气泡图标），用于置顶组等需要显式标注主题的场合。
export const GENERAL_TAG: TopicDef = { key: "general", labelKey: "topic.general", color: "var(--muted)" };

// 取任意会话的 tag 定义：主题会话取对应 TopicDef；general/未设主题回落到 GENERAL_TAG。
// 与 topicDef 的区别：topicDef 只认导航主题（general 返回 undefined，用于「是否是导航主题」判断）；
// tagDef 永远返回一个可渲染的 tag（用于会话标签展示，保证通用会话也有一致的 tag）。
export const tagDef = (k?: string): TopicDef =>
  TOPICS.find((t) => t.key === k) ?? GENERAL_TAG;

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

export interface Conversation {
  id: string;
  title: string;
  icon?: string;
  topic?: TopicKey;      // 会话所属主题（默认 general/未设 = 通用）
  model?: string;        // 本会话选用的模型（缺省走 defaultModelId()，兜底 DEFAULT_MODEL）
  accountId?: string;    // 本会话目标 AWS 账号（默认空=部署账号）
  webSearch?: boolean;   // 本会话是否开启联网搜索（默认关；每会话独立）
  finopsAgent?: boolean; // 本会话是否启用 FinOps Agent 深度模式（默认关；仅 FinOps 主题；每会话独立）
  devopsAgent?: boolean; // 本会话是否启用 DevOps Agent 深度调查（默认关；仅故障调查主题；每会话独立）
  // 本会话是否启用「深度调查（直连）」：BFF 直连 DevOps Agent API、**0 token**（默认关）。
  // 与 devopsAgent **互斥**（同时开会同时走两条路），互斥逻辑在 ChatApp 的 toggle 里。
  devopsAgentDirect?: boolean;
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
// 按显示名首字母升序排列（A→Z）。
export const MODELS: ModelOption[] = [
  { id: "amazon-nova-pro", name: "Amazon Nova Pro", descKey: "model.desc.nova" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", descKey: "model.desc.haiku" },
  { id: "claude-opus-5", name: "Claude Opus 5", descKey: "model.desc.opus" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", descKey: "model.desc.claude" },
  { id: "deepseek-v3-2", name: "DeepSeek V3.2", descKey: "model.desc.deepseek" },
  { id: "zai-glm-5", name: "GLM 5", descKey: "model.desc.glm" },
  { id: "gpt-5-6-luna", name: "GPT-5.6 Luna", descKey: "model.desc.gptLuna" },
  { id: "gpt-5-6-sol", name: "GPT-5.6 Sol", descKey: "model.desc.gptSol" },
  { id: "gpt-5-6", name: "GPT-5.6 Terra", descKey: "model.desc.gpt" },
  { id: "xai-grok-4-6", name: "Grok 4.6", descKey: "model.desc.grok" },
];
