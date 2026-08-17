/**
 * LLM 模型目录与凭证配置（Admin「模型」板块 + 用户侧只读接口）。
 *
 * Admin（门禁同 /admin/.+ = nav:admin）：
 *   GET  /admin/llm-config              读整份配置（Key 脱敏）
 *   PUT  /admin/llm-config              写配置（校验不变量 + 原子更新 generation + 审计快照）
 *   GET  /admin/llm-config/candidates   候选模型全集（ListFoundationModels + Mantle 型号表）
 *   PUT  /admin/llm-config/bedrock-key  设置/清除 Bedrock API Key
 *   POST /admin/llm-config/test         逐模型连通性探测（只回枚举态）
 *   POST /admin/llm-config/rollback     回滚到上一 generation（数据源 = 审计快照）
 *   GET  /admin/llm-config/audit        审计列表（不含快照正文，避免响应过大）
 *   GET/PUT /admin/llm-config/backend-tasks
 *                                       后端任务模型（PHD 翻译 / DevOps 报告精简），
 *                                       真源存 alias，另投影裸 model_id 到 appconfig#*
 *
 * 用户侧（登录即可，见 authz LOGIN_ONLY）：
 *   GET  /models                        **仅启用集**；不含 provider / 凭证 / 候选全集字段
 *
 * 存储：
 *   · 配置    DynamoDB notiops-config  PK=llmcfg          SK=meta
 *   · 审计    DynamoDB notiops-config  PK=llmcfg#audit    SK=<epoch-ms>   （含变更前全量快照）
 *   · Key     Secrets Manager `notiops/bedrock-api-key`（已存在，后端 Lambda 亦在用）
 *
 * 关键设计（spec R1/R2/R4/R6）：
 *   · generation = epoch-ms，任何变更都更新；消费端(webchat runtime / IM bot)据此热生效。
 *     **由服务端读写，绝不接受客户端传入**——generation 若可被污染，会让消费端的 TTL 兜底
 *     失效并放大 DDB 读。
 *   · 控制平面（列模型）用**将来真正执行推理的那个身份**去问：credential_mode=api_key
 *     时就用 Key 列。文档说 Bedrock API Key 适用于 Amazon Bedrock **和** Bedrock Runtime
 *     两类动作（排除项只有双向流 / Agents / Data Automation），List* 属于前者。
 *     Key 背后是独立 IAM user，可以在生成时按模型收窄、也可以指向别的账号 —— 用部署角色
 *     去列就会列出 Key 调不了的模型，管理员加进目录、启用，直到用户发消息才 403。
 *     Key 确实没有 List* 权限时回退部署角色，并在响应里标 `source_identity:"iam_fallback"`
 *     说明「列表与 Key 可调范围可能不符」；静默回退等于回到了这个 bug。
 *     仍列不出来时用「手动添加 model_id」+ 连通性测试兜底。
 *     （此处原写「Key 只覆盖 runtime 推理，不支持 List*」，是错的，已作废。）
 *   · 两个 API 面物理隔离：/models 的响应体只含启用集，权限边界落在接口而非 UI。
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from "@aws-sdk/client-bedrock";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import {
  SecretsManagerClient, GetSecretValueCommand, UpdateSecretCommand, CreateSecretCommand,
} from "@aws-sdk/client-secrets-manager";

const TABLE = process.env.CONFIG_TABLE || "notiops-config";
const SECRET_ID = process.env.BEDROCK_API_KEY_SECRET || "notiops/bedrock-api-key";
const REGION = process.env.AWS_REGION || "us-east-1";

const PK = "llmcfg";
const SK = "meta";
const AUDIT_PK = "llmcfg#audit";
const AUDIT_KEEP = 200;          // 审计列表单次最多返回条数

let ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
let bedrock = new BedrockClient({ region: REGION });
/**
 * 控制面（`bedrock`：ListFoundationModels / ListInferenceProfiles）客户端参数。
 *
 * Bedrock API Key **可以**用于控制面，不是只能推理：文档明确
 * 「Amazon Bedrock API keys are limited to Amazon Bedrock **and** Amazon Bedrock
 * Runtime actions」，排除项只有 InvokeModelWithBidirectionalStream / Agents /
 * Data Automation，不含任何 List*。对应 IAM 动作 `bedrock:CallWithBearerToken`
 * 说的也是「通过 **the Amazon Bedrock endpoint** 使用 Key」。
 *
 * 为什么必须用 Key 列：候选列表若来自部署角色，而推理用的是 Key，两者可以是**完全
 * 不同的模型集合** —— Key 背后是独立 IAM user，可以被按模型收窄，甚至指向别的账号。
 * 那时管理员在候选里看到的模型，Key 根本调不了，加进目录后要到生产才暴露。
 *
 * 与 `runtimeClientConfig` 同样抽成纯函数：测试会整体替换工厂，参数拼装埋在工厂里
 * 就永远不会被执行到（这个坑在 runtime 侧已经踩过一次）。
 */
export function controlPlaneClientConfig(cred = { mode: "iam", key: "" }) {
  const base = { region: REGION };
  if (cred?.mode === "api_key" && cred?.key) {
    return { ...base, token: { token: cred.key },
             authSchemePreference: ["httpBearerAuth"] };
  }
  return base;
}
let bedrockFactory = (cred) => new BedrockClient(controlPlaneClientConfig(cred));
let sm = new SecretsManagerClient({});
/**
 * BedrockRuntimeClient 的构造参数。**单独抽成纯函数是为了可测**：测试通过
 * `__setClients({ runtimeFactory })` 整体替换工厂，所以工厂**函数体**在测试里根本不会
 * 被执行 —— 把 bearer 接线埋在工厂里等于它永远没被验证过（反向注入时把接线改坏，
 * 没有任何测试变红，正是这个原因）。参数拼装放在这里，工厂只负责 new。
 *
 * `cred.mode === "api_key"` 时改用 bearer 认证。注意 **JS SDK 不读
 * `AWS_BEARER_TOKEN_BEDROCK` 环境变量**（Python 的 botocore 会读），所以必须显式传
 * `token` 并把 `httpBearerAuth` 提到 authSchemePreference 首位 —— 默认顺序是 SigV4
 * 优先（见 defaultBedrockRuntimeHttpAuthSchemeProvider），光给 token 不会生效。
 */
export function runtimeClientConfig(region, cred = { mode: "iam", key: "" }) {
  const base = { region: region || REGION };
  if (cred?.mode === "api_key" && cred?.key) {
    return { ...base, token: { token: cred.key },
             authSchemePreference: ["httpBearerAuth"] };
  }
  return base;
}

let runtimeFactory = (region, cred) => new BedrockRuntimeClient(
  runtimeClientConfig(region, cred),
);

/**
 * 测试接缝 —— **仅供 bff/web-chat/tests 使用**，生产代码不得调用。
 * 与 Python 侧 `mod._table = lambda: fake` 同款思路：注入假客户端以避免触网，
 * 而不是引入 mock 框架（本仓库测试风格是纯断言 + 显式注入）。
 */
export function __setClients(overrides = {}) {
  if (overrides.ddb) ddb = overrides.ddb;
  if (overrides.bedrock) bedrock = overrides.bedrock;
  if (overrides.sm) sm = overrides.sm;
  if (overrides.runtimeFactory) runtimeFactory = overrides.runtimeFactory;
  if (overrides.bedrockFactory) bedrockFactory = overrides.bedrockFactory;
}

const KINDS = new Set(["bedrock_anthropic", "bedrock_converse", "bedrock_mantle_responses"]);
const SURFACES = new Set(["webchat", "im"]);
const BACKEND_TASKS = ["phd_translate", "devops_report_summarize"];
// bedrock-mantle 端点所在区域白名单；region 白名单化，避免被写进 base_url 打到任意主机。
// 名单取自 Responses API 文档的 "Supported Regions and Endpoints"，与 Python 侧
// `shared/llm_provider._MANTLE_REGIONS` 保持一致 —— 两边不一致会造成「这边存得进去、
// 那边调不出去」。
// 原先只有 us-east-2 / us-west-2，比文档窄：GPT-5.6 Terra 在 us-east-1 也供，却存不进来。
// 注意白名单管的是**端点存在性**，不是**某个模型在该区是否上架**——后者由连通性探测负责。
const MANTLE_REGIONS = new Set([
  "us-east-1", "us-east-2", "us-west-2",
  "ap-northeast-1", "ap-south-1", "ap-southeast-2", "ap-southeast-3",
  "eu-central-1", "eu-north-1", "eu-south-1", "eu-west-1", "eu-west-2",
  "sa-east-1", "us-gov-west-1",
]);
// 新增 Mantle 条目时的默认区域。**必须显式命名，不能靠 `[...MANTLE_REGIONS][0]`**：
// 名单是按区域名排的，扩容时谁排第一会变。实际发生过 —— 名单从 us-east-2/us-west-2 扩到
// 14 个区后，前端的 `regions?.[0]` 把新加 Mantle 模型的默认区从 us-east-2 静默换成了
// us-east-1，而 AgentCore runtime 的 IAM 当时只授了 us-east-2/us-west-2 →「存得进去、
// 调不出去」，且要到用户发消息才暴露。
// 与 Python 侧 `shared/llm_provider._MANTLE_REGION_DEFAULT` 一致。
const MANTLE_REGION_DEFAULT = "us-east-2";
const MODEL_ID_RE = /^[a-z0-9][a-z0-9.:_-]{0,127}$/i;
const ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// short 是 IM 侧的输入短名（`@bot model gpt_sol`），历史命名带下划线，比 canonical alias
// 多允许一个 `_`。canonical alias 不放开：它会进 URL / 缓存键 / DDB 属性名。
const SHORT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/* ───────────────── 读写底座 ───────────────── */

async function readConfig() {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK, SK } }));
  return r.Item || null;
}

// 消费端（runtime / IM bot）对 generation 的未来容忍窗口，须与 core/llm_config.py
// 的 `_GEN_MAX_SKEW_MS` 保持一致：超出这个窗口的值会被判为注入并忽略。
const GEN_MAX_SKEW_MS = 24 * 3600 * 1000;

/* ───────────────── Feature flag（spec R9.1）───────────────── */
// `LLMCFG_ENABLED=0` 旁路**消费路径**：`/models` 回空集（前端保留内置兜底清单，见
// frontend/chat-app/src/models.ts 的失败安全逻辑），`/stream` 不做服务端准入、不注入
// generation（runtime 因此只走 TTL）。
//
// 与 Python 两端的语义**故意不同**：Admin 的读写路径照常可用。事故中最需要的组合恰恰是
// 「消费端先退回兜底目录止血，同时还能改配置把它修对」；把 Admin 也关掉就只剩改 DDB 一条路。
// 所以这里不去 stub `readConfig()`（那会连并发保护的 generation 读一起废掉，
// apiPutLlmConfig 会误判成"目录不存在"），而是只在两个消费函数入口处判断。
const LLMCFG_ENABLED = !["0", "false", "False"].includes(process.env.LLMCFG_ENABLED || "1");

/* ───────────────── Metric 发射（CloudWatch EMF）───────────────── */
// 与 Python 侧 `core/llm_config.py::_emit` 同一个 namespace / 同一套语义，只是这边是
// Node。EMF 无需任何设置：把符合规范的单行 JSON 写进 CloudWatch Logs，CloudWatch 自动
// 抽取成指标，不需要 cloudwatch:PutMetricData 权限、不增加请求延迟。
// https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format.html
const METRIC_NAMESPACE = process.env.LLMCFG_METRIC_NAMESPACE || "NotiOps/LLMConfig";
const METRICS_ENABLED = !["0", "false", "False"].includes(process.env.LLMCFG_METRICS || "1");

/**
 * 发一条 EMF 指标行。维度基数必须保持很低 —— alias / model_id 之类**不要**作维度
 * （按维度组合计费且会炸掉指标数），需要高基数信息就放非维度字段用 Logs Insights 查。
 * 失败静默：观测不该成为新的故障源。
 */
function emit(metric, value = 1, dimensions = {}, extra = {}) {
  if (!METRICS_ENABLED) return;
  try {
    const dims = { Surface: "bff", ...Object.fromEntries(
      Object.entries(dimensions).map(([k, v]) => [k, String(v)])) };
    console.log(JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{
          Namespace: METRIC_NAMESPACE,
          Dimensions: [Object.keys(dims).sort()],
          Metrics: [{ Name: metric, Unit: "Count" }],
        }],
      },
      ...dims, ...extra, [metric]: value,
    }));
  } catch { /* 观测不得成为故障源 */ }
}

/**
 * 下一个 generation（epoch-ms 语义，**严格单调递增**）。
 *
 * 直接用 `Date.now()` 有个真实的坑：同一毫秒内两次保存（改完目录顺手再改后端任务绑定，
 * 或前端连点两次）会得到**相同**的值。相同就等于"没变"—— 消费端按 `!=` 判断，于是
 * 那次改动在长驻 microVM / ECS 进程里根本不会生效，只能等 TTL，且 Agent 缓存键也不变。
 * 所以取 max(now, prev+1)。
 *
 * prev 若是被写坏的未来值（超出消费端容忍窗口，本来就会被忽略），直接用 now 把它拉回
 * 合法区间 —— 否则 prev+1 会让它永远卡在被拒的区间里，热生效永久失效。
 */
function nextGeneration(prev) {
  const now = Date.now();
  const p = Number(prev?.generation || 0);
  if (!Number.isFinite(p) || p <= 0 || p > now + GEN_MAX_SKEW_MS) return now;
  return Math.max(now, p + 1);
}

/** Mantle 型号：控制平面 ListFoundationModels 不返回它们，用已知表补齐候选。 */
function mantleCandidates() {
  return [
    { model_id: "openai.gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { model_id: "openai.gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { model_id: "openai.gpt-5.6-luna", label: "GPT-5.6 Luna" },
  ].map((m) => ({
    ...m,
    kind: "bedrock_mantle_responses",
    regions: [...MANTLE_REGIONS],
    // 默认区由服务端下发，别让 UI 从 `regions` 里按下标取 —— 见 MANTLE_REGION_DEFAULT。
    default_region: MANTLE_REGION_DEFAULT,
    source: "mantle_catalogue",
    provider_name: "OpenAI",
    // Mantle 端点自带区域（MANTLE_REGIONS），不是 CRIS profile，也不是本区域基座模型。
    scope: "mantle",
  }));
}

/* ───────────────── 校验 ───────────────── */

function validateEntry(m, idx) {
  const where = `models[${idx}]`;
  if (!m || typeof m !== "object") return `${where} must be an object`;
  if (!ALIAS_RE.test(String(m.alias || ""))) {
    return `${where}.alias invalid (expect [a-z0-9-], got ${JSON.stringify(m.alias)})`;
  }
  if (!MODEL_ID_RE.test(String(m.model_id || ""))) {
    return `${where}.model_id invalid (got ${JSON.stringify(m.model_id)})`;
  }
  if (!KINDS.has(m.kind)) {
    return `${where}.kind must be one of ${[...KINDS].join(" | ")} (got ${JSON.stringify(m.kind)})`;
  }
  if (m.kind === "bedrock_mantle_responses") {
    if (!MANTLE_REGIONS.has(String(m.region || ""))) {
      return `${where}.region must be one of ${[...MANTLE_REGIONS].join(" | ")} for mantle models`;
    }
  } else if (m.region) {
    return `${where}.region must be empty for non-mantle models`;
  }
  // 必须是真正的 number，不接受 "8192" 这种字符串：JS 侧 Number() 会接受，而 Python
  // 侧 `_as_int` 对 str 直接返回默认值 —— 校验通过、两端行为不一致，是最难查的那种。
  const cap = m.hard_output_limit;
  if (typeof cap !== "number" || !Number.isInteger(cap) || cap <= 0 || cap > 1_000_000) {
    return `${where}.hard_output_limit must be a positive integer (got ${JSON.stringify(m.hard_output_limit)})`;
  }
  const surfaces = Array.isArray(m.surfaces) ? m.surfaces : [];
  if (!surfaces.length || surfaces.some((s) => !SURFACES.has(s))) {
    return `${where}.surfaces must be a non-empty subset of ${[...SURFACES].join(" | ")}`;
  }
  if (m.short && !SHORT_RE.test(String(m.short))) {
    return `${where}.short invalid (got ${JSON.stringify(m.short)})`;
  }
  // aliases_legacy 此前**完全未校验**，而消费端会拿它做匹配（`resolveForStream` 与
  // Python 侧 `_find`/`is_enabled`）。后果实测过：把别人的规范 alias 写进自己的
  // aliases_legacy 就能劫持选择 —— `resolve('claude-sonnet-5')` 返回 Nova、
  // `was_substituted()` 还报 False（用户毫不知情）。格式校验在此，跨条目撞名见下方。
  const legacy = m.aliases_legacy === undefined ? [] : m.aliases_legacy;
  if (!Array.isArray(legacy)) {
    return `${where}.aliases_legacy must be an array`;
  }
  if (legacy.length > 8) {
    return `${where}.aliases_legacy has too many entries (max 8)`;
  }
  for (const a of legacy) {
    if (typeof a !== "string" || !SHORT_RE.test(a)) {
      return `${where}.aliases_legacy contains an invalid alias ${JSON.stringify(a)}`;
    }
  }
  for (const [k, v] of Object.entries(m.output_override || {})) {
    if (!SURFACES.has(k)) return `${where}.output_override has unknown surface ${k}`;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      return `${where}.output_override.${k} must be a positive integer`;
    }
    // 必须以模型自身硬上限为界。此前无上限，而消费端是
    // `max_out = override ? override : min(hard_output_limit, target)` —— override
    // 一旦存在就把钳位整个短路掉，于是 {webchat: 1e9} 能通过校验并直接进
    // BedrockModel 的 max_tokens：一个管理员可触发的成本 / DoS 旋钮。
    if (v > cap) {
      return `${where}.output_override.${k} (${v}) exceeds hard_output_limit (${cap})`;
    }
  }
  for (const [k, v] of Object.entries(m.model_id_override || {})) {
    if (!SURFACES.has(k)) return `${where}.model_id_override has unknown surface ${k}`;
    if (!MODEL_ID_RE.test(String(v))) return `${where}.model_id_override.${k} invalid`;
  }
  return null;
}

/** 服务端强校验（spec R2.6 / R2.7）。返回错误字符串或 null。导出供单测直接调用。 */
export function validateConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return "body must be an object";
  if (cfg.provider !== undefined && cfg.provider !== "bedrock") {
    return "provider must be 'bedrock' (litellm ships in a later phase)";
  }
  if (cfg.credential_mode !== undefined
      && !["iam", "api_key"].includes(cfg.credential_mode)) {
    return "credential_mode must be 'iam' or 'api_key'";
  }
  const models = cfg.models;
  if (!Array.isArray(models) || models.length === 0) return "models must be a non-empty array";

  // 撞名检测必须覆盖**全部三个命名空间**（canonical / short / aliases_legacy），
  // 因为消费端解析时三者一律接受、按数组顺序取第一个匹配。此前只查了
  // alias×alias 与 short×alias，漏掉 aliases_legacy —— 于是一个条目可以把别人的
  // 规范 alias 写进自己的 legacy 列表并静默劫持它（实测：resolve('claude-sonnet-5')
  // 返回 Nova，且 was_substituted() 报 False）。
  // 同一条目内重名无害（都指向同一个模型），所以只查**跨条目**冲突。
  const owner = new Map();      // name → 首个声明它的 canonical alias
  const canonicals = new Set(); // 单独查 canonical 自身重复：两条重复项的 canonical
                                // 相同，跨命名空间那道检查（prev !== canonical）会放过
  for (let i = 0; i < models.length; i++) {
    const err = validateEntry(models[i], i);
    if (err) return err;
    const canonical = String(models[i].alias);
    if (canonicals.has(canonical)) return `duplicate alias ${canonical}`;
    canonicals.add(canonical);
    const names = new Set([canonical]);
    if (models[i].short) names.add(String(models[i].short));
    for (const a of models[i].aliases_legacy || []) names.add(String(a));
    for (const n of names) {
      const prev = owner.get(n);
      if (prev !== undefined && prev !== canonical) {
        return `alias ${n} is claimed by both ${prev} and ${canonical} `
          + "(canonical / short / aliases_legacy share one namespace)";
      }
      owner.set(n, canonical);
    }
  }

  const enabled = models.filter((m) => m.enabled === true);
  if (enabled.length === 0) return "at least one model must be enabled";

  const def = String(cfg.default_model || "");
  const defEntry = models.find((m) => String(m.alias) === def);
  if (!defEntry) return `default_model ${def || "(empty)"} is not in the catalogue`;
  if (defEntry.enabled !== true) return `default_model ${def} must be enabled`;
  // 这里曾经有 `if (defEntry.verified === false) return "... is unverified; test it first"`。
  // 已删除，连同 `verified` 这个持久化字段本身 —— 它是**一个快照冒充事实**：它断言的是
  // (模型 × 区域 × 凭证 × 时间) 这个组合成立，而其中任何一维变了它就失效，我们却只能感知
  // 换 Key 这一维（那还是硬编码补上的）。实际后果两次：种子把它写死 true，于是东京调不通的
  // `amazon.nova-pro-v1:0` 一路走到生产；被收窄的 Key 排除掉的模型也照样能设成默认。
  // 取而代之的是**保存时现场探测默认模型**（见 apiPutLlmConfig 的 probeDefaultModel）——
  // 决策那一刻的事实，不可能过期。

  // 每个端至少要有一个可用模型，否则该端会没有任何模型可选
  for (const surface of SURFACES) {
    if (!enabled.some((m) => (m.surfaces || []).includes(surface))) {
      return `no enabled model available for surface '${surface}'`;
    }
  }

  // 序列化体积上限：DDB 会接受一个仍在 400KB 以内、但序列化后超出审计快照预算的目录，
  // 于是快照被省略、这一代变成**不可回滚**。在入口拦掉比在事故里发现好。
  const size = JSON.stringify({ ...cfg, PK: undefined, SK: undefined }).length;
  if (size > SNAPSHOT_BUDGET) {
    return `configuration is too large to snapshot for rollback `
      + `(${size} bytes > ${SNAPSHOT_BUDGET}); reduce the number of models or shorten labels`;
  }

  for (const task of Object.keys(cfg.backend_tasks || {})) {
    if (!BACKEND_TASKS.includes(task)) return `unknown backend task ${task}`;
    const v = cfg.backend_tasks[task];
    if (v === null || v === "" || v === undefined) continue;
    const e = models.find((m) => String(m.alias) === String(v));
    if (!e || e.enabled !== true) return `backend_tasks.${task} must be an enabled alias`;
    // 「已启用」是唯一条件。这里曾经额外拒绝 Mantle（Responses API）模型，理由写的是
    // 「后端任务一律走 Converse」—— 那是**我们自己的**实现缺口，不是模型的限制：
    // Bedrock 上有一批模型只在 bedrock-mantle 端点上架（实测
    // `Converse(openai.gpt-5.6-terra)` → `ValidationException: The provided model
    // identifier is invalid`，而 `Converse(openai.gpt-oss-120b-1:0)` 是 200 —— 所以
    // 是「哪个端点上架」的问题，不是「OpenAI 家族不支持 Converse」）。对话侧早就能用
    // 它们，两端能力不一致，管理员看到的就是「加进来了但后端下拉是灰的」，实测被问
    // 「为什么不让我选 gpt」。`shared/llm_provider.py` 已补 Mantle Responses 分支。
    //
    // 不在这里再查 region：Mantle 模型的 region 已由**上面的逐模型校验**保证落在
    // MANTLE_REGIONS 内（见 validateModel）。在这里重查是不可达分支 —— 反向注入验证时
    // 把它改成恒真也没有任何测试变红，正是因为它永远不会被执行到。
  }
  return null;
}

/* ───────────────── Admin: 读 ───────────────── */

/**
 * 读 Key 明文 + 元数据。**只在本模块内部使用**，绝不出现在任何响应体里（spec R5.5）。
 * 连通性探测需要明文（要用它去签请求），所以从 keyStatus 里抽出来共用一份读取逻辑，
 * 避免两处各自解析 Secret 格式而漂移。
 */
async function readKeySecret() {
  try {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
    const raw = r.SecretString || "";
    let key = raw;
    try {
      const parsed = JSON.parse(raw);
      key = parsed.bedrock_api_key || parsed.api_key || "";
    } catch { /* 非 JSON：整串即 key */ }
    key = String(key || "").trim();
    return { key, created: r.CreatedDate || null, error: "" };
  } catch (e) {
    if (e?.name === "ResourceNotFoundException") return { key: "", created: null, error: "" };
    return { key: "", created: null, error: e?.name || "read_failed" };
  }
}

/** 超过这个天数未轮换就在管理页提示（spec R5.6）。 */
const KEY_ROTATION_DAYS = 90;

/**
 * Key 状态：只回是否已配置 + 后 4 位 + 谁在何时设的 + 是否该轮换，**绝不回明文**（R5.5）。
 *
 * `set_at` 取 `GetSecretValue` 的 `CreatedDate` —— 那是**当前版本**的创建时间，也就是
 * 「这个 Key 是什么时候被写进来的」。注意别换成 `DescribeSecret` 的 `CreatedDate`，
 * 那是 Secret 本身的创建时间（这套里是 2026-07-10），会把轮换时间报早一个月。
 *
 * `set_by` 存在 DDB llmcfg 上而不是 Secret 里：Secret 的每次写入都会新建一个版本，把操作人
 * 塞进 payload 等于让审计信息参与"密文"的比较与轮换；而 llmcfg 本来就要在 Key 变更时被
 * 写一次（bump generation），顺路记下零额外成本。`item` 可由调用方传入，避免多一次 DDB 读。
 */
async function keyStatus(item) {
  const { key, created, error } = await readKeySecret();
  if (error) return { configured: false, error };
  if (!key) return { configured: false };
  const cfg = item !== undefined ? item : await readConfig();
  const setAt = created ? new Date(created) : null;
  const ageDays = setAt ? Math.floor((Date.now() - setAt.getTime()) / 86400000) : null;
  return {
    configured: true,
    last_4: key.slice(-4),
    length: key.length,
    set_at: setAt ? setAt.toISOString() : "",
    set_by: String(cfg?.bedrock_key_set_by || ""),
    age_days: ageDays,
    // 计算放服务端：前端各自算容易和这里漂移，而这是一条安全提示。
    rotation_due: ageDays !== null && ageDays >= KEY_ROTATION_DAYS,
    rotation_days: KEY_ROTATION_DAYS,
  };
}

/**
 * 探测该用哪种凭证 —— 必须与**运行时实际会用的那种**一致，否则「已验证」是假绿。
 *
 * 之前探测一律用 BFF 自己的任务角色。于是 credential_mode=api_key 时，「已验证」证明的
 * 是「BFF 角色能调这个模型」，而真正发推理请求的是 Admin 配的那个 Key —— 两件事。
 * 实测就是这个落差：Key 背后的 IAM user 只挂了 AmazonBedrockLimitedAccess，如果换成
 * 一个按模型收窄过的 Key，探测全绿而生产全 403，管理员没有任何前置信号。
 */
async function probeCredential(modeOverride) {
  // `modeOverride`：**正在保存的那份** credential_mode。保存时必须传它，不能读持久值 ——
  // 那次保存改变的就是凭证维度，用旧值探测两个方向都错：
  //   iam → api_key：用部署角色验证一次「切换到 Key」，是假绿（这个函数存在的意义就是
  //                  消灭这种假绿）
  //   api_key → iam：用一个已被收窄/吊销的 Key 去验证「退回 IAM」，403 硬拦 ——
  //                  而这恰好是管理员从坏 Key 逃生的唯一出口，等于把门锁死
  // 不传时（独立的连通性测试按钮、候选枚举）读持久值才是对的：那些操作不改变凭证维度。
  const mode = modeOverride !== undefined && modeOverride !== null && modeOverride !== ""
    ? String(modeOverride)
    : String((await readConfig())?.credential_mode || "iam");
  if (mode !== "api_key") return { mode: "iam", key: "" };
  const { key } = await readKeySecret();
  // 选了 api_key 但 Secret 是空的 → 运行时也会回退 IAM，探测跟着回退才诚实。
  return key ? { mode: "api_key", key } : { mode: "iam", key: "" };
}

export async function apiGetLlmConfig() {
  const item = await readConfig();
  const cfg = item || {};
  return {
    provider: cfg.provider || "bedrock",
    credential_mode: cfg.credential_mode || "iam",
    default_model: cfg.default_model || "",
    generation: Number(cfg.generation || 0),
    models: Array.isArray(cfg.models) ? cfg.models : [],
    backend_tasks: cfg.backend_tasks || {},
    bedrock_api_key: await keyStatus(item),
    seeded: Boolean(item),
    updated_at: cfg.updated_at || "",
    updated_by: cfg.updated_by || "",
  };
}

/** 用户侧：**仅启用集**，且按 surface 过滤。不含 provider / 凭证 / 候选全集。 */
/**
 * 用户侧可选模型（仅启用集）。
 *
 * `source` 是给前端做**行为分流**用的，不能省。此前只回 `models: []`，而空数组同时对应
 * 四种完全不同的状况，客户端无法区分，只能一律退回打包内置清单 —— 于是：
 *   · 管理员把 webchat 启用集清空（该报错让他去修）与 DDB 读失败（该降级放行）同款处理；
 *   · 灰度回滚（`LLMCFG_ENABLED=0`，语义就是"回到 feature 之前"）也长得一样；
 *   · 而"目录正常但还没拉到"被当成"目录就是这 8 个"，用户在加载窗口里能选中已停用的模型。
 *
 * 取值：
 *   `ddb`        目录读到了（models 可能为空 = 管理员确实没为该端启用模型 → 前端应报错）
 *   `unseeded`   表里没有 llmcfg 项（全新部署 / seed 失败）→ 前端用内置清单，可发消息
 *   `disabled`   本端 feature flag 关闭（回滚拉杆）→ 同上
 *   `read_error` DDB 读失败 → 同上，并提示降级
 */
export async function apiGetModels(surface = "webchat") {
  if (!LLMCFG_ENABLED) {
    emit("FallbackBuiltin", 1, { reason: "disabled" });
    return { models: [], default_model: "", generation: 0, source: "disabled" };
  }
  let item;
  try {
    item = await readConfig();
  } catch (e) {
    // 此前没有 try/catch：DDB 抖动 → 这条路由 500 → 前端静默退回内置清单，
    // 于是这个 500 从来没人看见（BFF 只记 5xx 的异常栈，而前端把失败吞了）。
    console.warn(`[llm-config] /models read failed: ${e?.name || e}`);
    emit("FallbackBuiltin", 1, { reason: "read_error" });
    return { models: [], default_model: "", generation: 0, source: "read_error" };
  }
  if (!item) {
    emit("FallbackBuiltin", 1, { reason: "not_seeded" });
    return { models: [], default_model: "", generation: 0, source: "unseeded" };
  }
  const cfg = item;
  const want = SURFACES.has(surface) ? surface : "webchat";
  const models = (Array.isArray(cfg.models) ? cfg.models : [])
    .filter((m) => m && m.enabled === true && (m.surfaces || []).includes(want))
    .map((m) => ({
      id: String(m.alias),
      name: String(m.label || m.alias),
      short: m.short || undefined,
      desc_key: m.desc_key || undefined,
      // 曾经是 `m.kind !== "bedrock_mantle_responses"`，依据是「Mantle 不受 Bedrock
      // API Key 影响」（spec R5.7）。那个前提不成立：Mantle 端点本来就接受 Bedrock
      // API Key 作为 `Authorization: Bearer`（文档里 OpenAI SDK 的标准用法，对应
      // IAM 动作 bedrock-mantle:CallWithBearerToken），只是我们三条 Mantle 代码路径
      // 都没把 Key 传进去 —— 实测表现为 Claude 那几轮 CloudTrail caller 是 Key 的
      // IAM user，GPT 那轮是部署角色。三条路径已补齐，故所有模型一律受 Key 影响。
      uses_api_key: true,
    }));
  const def = String(cfg.default_model || "");
  return {
    models,
    default_model: models.some((m) => m.id === def) ? def : (models[0]?.id || ""),
    generation: Number(cfg.generation || 0),
    source: "ddb",
  };
}

/* ───────────────── Admin: 候选全集 ───────────────── */

/** model_id 前缀 → 路由范围。`global.*`/`apac.*`/`jp.*` 这类是 inference profile
 *  （跨区域路由），无前缀的是本区域 foundation model。Admin 选之前必须能看见这个区别：
 *  它决定推理请求会落到哪些区域（数据驻留），也是「同一个模型三种 ID」困惑的根源。 */
function routingScope(id) {
  const m = /^(global|us|eu|apac|jp|us-gov)\./.exec(String(id || ""));
  return m ? m[1] : "regional";
}

/** 从 model_id 推断厂商名（ListInferenceProfiles 不返回 providerName）。 */
function providerFromId(id) {
  const base = String(id || "").replace(/^(global|us|eu|apac|jp|us-gov)\./, "");
  const vendor = base.split(".")[0] || "";
  const NAMES = {
    anthropic: "Anthropic", amazon: "Amazon", openai: "OpenAI", meta: "Meta",
    mistral: "Mistral AI", deepseek: "DeepSeek", cohere: "Cohere", ai21: "AI21 Labs",
    qwen: "Qwen", zai: "Z.ai", moonshotai: "Moonshot AI", moonshot: "Moonshot AI",
    google: "Google", nvidia: "NVIDIA", minimax: "MiniMax", writer: "Writer",
    stability: "Stability AI", luma: "Luma AI", twelvelabs: "TwelveLabs",
  };
  return NAMES[vendor] || (vendor ? vendor[0].toUpperCase() + vendor.slice(1) : "");
}

/** 纯 embedding / rerank / 图像 / 视频厂商与型号 —— 这些 profile 不能用于对话。
 *  按"排除已知的非对话项"而不是"只收白名单厂商"：新厂商上线时默认可见（列出来最多是多一个
 *  选项，管理员点测试就知道），而漏掉一个对话模型是我们刚踩过的坑。 */
const NON_CHAT_VENDORS = new Set(["stability", "twelvelabs", "luma"]);
const NON_CHAT_HINT = /(^|[.\-])(embed|embedding|rerank|image|video|canvas|reel|voice)([.\-]|$)/;

function isChatCapableProfile(profileId, underlyingId, textModelIds) {
  // 底层基座模型在本区被列为文本模型 → 直接通过（最强证据）
  if (underlyingId && textModelIds.has(underlyingId)) return true;
  const base = String(profileId).replace(/^(global|us|eu|apac|jp|us-gov)\./, "");
  const vendor = base.split(".")[0] || "";
  if (NON_CHAT_VENDORS.has(vendor)) return false;
  // 型号名里带 embed/rerank/image… 的一律排除（如 `global.cohere.embed-v4:0`）
  if (NON_CHAT_HINT.test(base) || (underlyingId && NON_CHAT_HINT.test(underlyingId))) return false;
  return true;
}

/** Key 没有列模型权限时的判据。只有这两种才回退 —— 限流 / 服务端错误不该被
 *  误判成「Key 不行」然后悄悄换身份，那会把一次偶发失败变成一份来源错误的列表。 */
function isAuthFailure(e) {
  const n = e?.name || "";
  return n === "AccessDeniedException" || n === "UnrecognizedClientException"
    || n === "ExpiredTokenException" || e?.$metadata?.httpStatusCode === 401
    || e?.$metadata?.httpStatusCode === 403;
}

export async function apiGetCandidates() {
  const out = [];
  const seen = new Set();
  // 候选枚举必须用**将来真正执行推理的那个身份**去问，否则列出来的模型 Key 可能调不了。
  // 三种来源如实回给客户端（`source_identity`），UI 据此标注：
  //   api_key      用 Key 列的 —— 与推理身份一致，可信
  //   iam          凭证方式就是 IAM，本来就一致
  //   iam_fallback Key 没有列模型权限，退回部署角色 —— **列表与 Key 可调范围可能不符**
  const cred = await probeCredential();
  let sourceIdentity = cred.mode;
  let client = bedrockFactory(cred);
  // 文本基座模型的 id 集合 —— 用来过滤 inference profile：profile 自身不声明模态，
  // 但它的 `models[].modelArn` 指向基座模型，落在这个集合里才是文本对话模型。
  // 不这样过滤就会把 embedding / 图像 profile 也列进候选。
  const textModelIds = new Set();

  // ⚠️ **不要**加 `byInferenceType: "ON_DEMAND"`。新一代模型（Claude Sonnet 5 /
  // Opus 5 / Sonnet 4.6 …）的 `inferenceTypesSupported` 只有 `INFERENCE_PROFILE`
  // —— 它们不支持按需直调，必须经 inference profile。加了那个过滤器，AWS 会把这些
  // 模型整个从结果里剔除，候选里 Claude 只剩 3 Haiku，管理员的结论是"新模型没有"
  // （实测：东京 64 条 → 44 条，Claude 5 全部消失）。
  // 这里改为只按文本模态取全量，再用 responseStreamingSupported 过滤对话可用性。
  const listFoundation = (c) => c.send(new ListFoundationModelsCommand({
    byOutputModality: "TEXT",
  }));

  let r;
  try {
    r = await listFoundation(client);
  } catch (e) {
    // 鉴权类失败**且**当前用的是 Key → Key 没有列模型的权限，换部署角色重试一次。
    // 只认鉴权类：限流 / 服务端错误照原样落到下面的降级分支，否则一次偶发失败会被
    // 标注成 `iam_fallback`，把人引去查权限。
    if (cred.mode === "api_key" && isAuthFailure(e)) {
      console.log("[llm-config] the API key cannot list models "
                  + `(${e?.name || "auth error"}); falling back to the deployment role`);
      client = bedrockFactory({ mode: "iam", key: "" });
      sourceIdentity = "iam_fallback";
      try {
        r = await listFoundation(client);
      } catch (e2) {
        return {
          models: mantleCandidates(),
          source_identity: sourceIdentity,
          warning: `ListFoundationModels failed (${e2?.name || "error"}); manual entry still available`,
        };
      }
    } else {
      // 列不出来不阻断：Admin 仍可用「手动添加 model_id」+ 连通性测试
      return {
        models: mantleCandidates(),
        source_identity: sourceIdentity,
        warning: `ListFoundationModels failed (${e?.name || "error"}); manual entry still available`,
      };
    }
  }

  {
    for (const m of r.modelSummaries || []) {
      const id = m.modelId || "";
      if (!id || seen.has(id)) continue;
      // 只要支持流式 + 文本输出的模型（对话必需）
      if (m.responseStreamingSupported === false) continue;
      // 只经 profile 调用的基座模型**本身**不可直调：仍收进 textModelIds 供下面的
      // profile 过滤识别，但不作为候选列出 —— 否则管理员会选中一个直调必失败的 ID。
      const types = m.inferenceTypesSupported || [];
      const onDemand = types.length === 0 || types.includes("ON_DEMAND");
      textModelIds.add(id);
      if (!onDemand) continue;
      seen.add(id);
      out.push({
        model_id: id,
        label: m.modelName || id,
        provider_name: m.providerName || "",
        // Anthropic 走 InvokeModel + Anthropic body；其余走 Converse
        kind: /anthropic/i.test(id) ? "bedrock_anthropic" : "bedrock_converse",
        source: "list_foundation_models",
        scope: "regional",
      });
    }
  }

  // ── inference profiles（跨区域路由）──
  // ListFoundationModels **不返回** profile，而本系统的目录默认就用 `global.*`
  // （2026-07 决策：Claude 系走 Global CRIS）。缺了这一步，Admin 在候选里只能看到
  // `anthropic.claude-sonnet-5`，与目录里实际生效的 `global.anthropic.claude-sonnet-5`
  // 对不上号，会以为"新模型没上"。
  // 失败**不阻断**：这是候选的增量来源，列不出来仍有基座模型 + 手填入口。
  let profileWarning = "";
  try {
    let token;
    do {
      const p = await client.send(new ListInferenceProfilesCommand({
        // 只要 AWS 预置的跨区域 profile。用户自建（APPLICATION）profile 的 id 不带地理
        // 前缀，会落进"其他"厂商分组、scope 被误判成 regional、kind 也猜不准。
        typeEquals: "SYSTEM_DEFINED",
        maxResults: 100, nextToken: token,
      }));
      for (const s of p.inferenceProfileSummaries || []) {
        const id = s.inferenceProfileId || "";
        if (!id || seen.has(id)) continue;
        if (s.status && s.status !== "ACTIVE") continue;
        // 过滤非文本 profile（embedding / rerank / 图像），但**不能**靠"底层基座模型是否
        // 出现在本区 ListFoundationModels(TEXT) 里"来判断 —— 实测：东京的
        // `apac.anthropic.claude-3-5-sonnet-*` 底层基座在本区**根本不被列出**（这些模型在
        // 东京只能经 APAC CRIS 访问），按那个条件会把 3 个真实可用的 Claude profile 丢掉，
        // us-east-1 丢 5 个，且无任何提示 —— 与"找不到模型"是同一类症状。
        // 改为按**厂商段**判断：厂商是已知的对话类厂商即收，命中纯 embedding/图像厂商则排除。
        // 这样不依赖本区基座列表，同时仍能挡掉 cohere.embed / stability / twelvelabs。
        const under = ((s.models || [])[0]?.modelArn || "").split("/").pop() || "";
        if (!isChatCapableProfile(id, under, textModelIds)) continue;
        seen.add(id);
        out.push({
          model_id: id,
          label: s.inferenceProfileName || id,
          provider_name: providerFromId(id),
          kind: /anthropic/i.test(id) ? "bedrock_anthropic" : "bedrock_converse",
          source: "list_inference_profiles",
          scope: routingScope(id),
          routes_to: under || null,
        });
      }
      token = p.nextToken;
    } while (token);
  } catch (e) {
    profileWarning = `ListInferenceProfiles failed (${e?.name || "error"}); `
      + `cross-region profiles such as global.* are not listed`;
  }

  // Mantle 型号也过 seen：函数其余部分都维持 model_id 唯一，这里不过滤的话返回数组就没有
  // 这个保证，而前端用 model_id 做 React key 并用 find 反查选中项。
  for (const m of mantleCandidates()) {
    if (seen.has(m.model_id)) continue;
    seen.add(m.model_id);
    out.push(m);
  }
  const models = out;
  return profileWarning
    ? { models, source_identity: sourceIdentity, warning: profileWarning }
    : { models, source_identity: sourceIdentity };
}

/* ───────────────── Admin: 写 ───────────────── */

// 审计快照预算。DDB 单 item 上限 400KB，留出其余字段与属性名的余量。
const SNAPSHOT_BUDGET = 380000;
// 同毫秒内的审计序号。见 auditSortKey() 说明。
let _auditSeq = 0;

/**
 * 审计行的 SK。
 *
 * 原实现是 `String(Date.now()).padStart(16, "0")` —— 同一毫秒内的两条审计会得到
 * **相同**的 SK 而互相覆盖，丢掉其中一条（连同它的回滚快照）。这正是 `nextGeneration()`
 * 特意解决的那个 bug 类，审计这边当时漏了。
 *
 * 补一个进程内序号 + 随机后缀：序号解决同容器并发，随机后缀降低跨 Lambda 容器同毫秒
 * 相撞的概率。零填充宽度固定，所以字典序仍等于时间序（`ScanIndexForward: false`
 * 依赖这一点），且旧格式的短 SK 会排在同毫秒新格式之前，读取兼容。
 */
function auditSortKey(now) {
  _auditSeq = (_auditSeq + 1) % 10000;
  const seq = String(_auditSeq).padStart(4, "0");
  const rand = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${String(now).padStart(16, "0")}-${seq}-${rand}`;
}

async function writeAudit(prevItem, nextCfg, actor) {
  const now = Date.now();
  // 快照过大时**不截断**：截断 JSON 得到的是非法 JSON，回滚要到真正需要它的时候
  // 才会以 "audit snapshot is corrupt" 暴露 —— 即事故现场。改为显式记录省略原因，
  // 让「这条无法回滚」在写入时就是已知事实。validateConfig 也会在入口拦掉超预算配置，
  // 所以这条只兜存量的超大 item。
  const snapshot = prevItem ? JSON.stringify(prevItem) : "";
  const tooBig = snapshot.length > SNAPSHOT_BUDGET;
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        PK: AUDIT_PK,
        SK: auditSortKey(now),
        at: new Date(now).toISOString(),
        actor_sub: actor?.sub || "",
        actor_name: actor?.username || "",
        source_ip: actor?.ip || "",
        user_agent: (actor?.ua || "").slice(0, 200),
        generation_before: Number(prevItem?.generation || 0),
        generation_after: Number(nextCfg.generation || 0),
        // 全量快照（变更前）—— 支撑一键回滚与「还原某时刻配置」演练
        snapshot_before: tooBig ? "" : snapshot,
        ...(tooBig ? { snapshot_omitted: true, snapshot_bytes: snapshot.length } : {}),
      },
    }));
  } catch (e) {
    // 审计写失败不回滚业务写：宁可少一条审计，也不让 Admin 卡住
    console.error(`[llm-config] audit write failed: ${e?.name || e}`);
  }
}

/* ───────────────── 后端任务模型：投影到既有 appconfig#* 键 ───────────────── */

/**
 * backend_tasks 的**真源**是 llmcfg.backend_tasks（存 alias）。
 * 但后端 Lambda 各自已经在读自己的 `appconfig#<ns>` / SK=bedrock_model_id（存裸 model_id），
 * 且都带「DDB → env → 硬编码」三级静默降级。所以这里把 alias 解析成 model_id **投影**过去：
 *   · DevOps 报告精简那半边后端零改（shared/summarizer_config.py 已在读这个键）
 *   · Lambda 侧不必再养第三份 alias→model_id 解析逻辑
 *   · llmcfg 损坏也不会让 PHD 停推（Lambda 仍有自己的降级链）
 * 代价：appconfig#* 成为派生值，老巡检 UI 直接改会被下次保存覆盖 —— 那个 UI 正在下线。
 */
const TASK_PROJECTION = {
  phd_translate: "appconfig#phd",
  devops_report_summarize: "appconfig#devops_agent",
};
const PROJECTION_SK = "bedrock_model_id";
/**
 * `kind` / `region` 也必须投影，不只是 model_id。
 *
 * 原因：Bedrock 上有一批模型**只在 `bedrock-mantle` 端点提供**，调 Converse 会报
 * `ValidationException: The provided model identifier is invalid`（实测
 * `openai.gpt-5.6-terra`）。后端任务要能用这些模型，就得知道该走哪条协议、打哪个区
 * —— 而这两项只存在于模型目录里，裸 model_id 带不出来。少了它们，后端只能一律
 * Converse，于是「对话里能用的模型，后端任务绑不了」。
 *
 * 拆成独立 SK 而不是把三者塞进一行 JSON：`bedrock_model_id` 这行是**早已在线**的契约
 * （shared/summarizer_config.py、老巡检 UI 都在读它的 `config_value`），改成 JSON 会
 * 让存量读取方拿到一个它不认识的字符串。新增行则是纯加法，老读取方不受影响。
 */
const PROJECTION_SK_KIND = "bedrock_model_kind";
const PROJECTION_SK_REGION = "bedrock_model_region";

/**
 * 把 cfg.backend_tasks 投影成 appconfig#* 行。返回失败的任务名数组。
 * **不抛异常**：llmcfg 本体已经写成功，投影失败只是后端暂时还用旧模型 —— 属可降级，
 * 由调用方把警告透给 UI，而不是回滚一次成功的保存（回滚会让 admin 更困惑）。
 */
async function projectBackendTasks(cfg, actor = {}) {
  const failed = [];
  const models = Array.isArray(cfg.models) ? cfg.models : [];
  const tasks = cfg.backend_tasks || {};
  const now = new Date().toISOString();
  for (const task of BACKEND_TASKS) {
    const pk = TASK_PROJECTION[task];
    if (!pk) continue;
    const alias = String(tasks[task] || "");
    const entry = alias ? models.find((m) => String(m.alias) === alias) : null;
    const bound = Boolean(entry && entry.enabled === true);
    const modelId = bound ? String(entry.model_id) : "";
    // 这两项决定后端走 Converse 还是 Mantle Responses、以及打哪个区。
    const modelKind = bound ? String(entry.kind || "") : "";
    const modelRegion = bound ? String(entry.region || "") : "";

    if (!modelId) {
      // 未绑定 / 绑定项已消失。**不能无条件写空串**：`appconfig#devops_agent` 是一条
      // 早已在线的行，老巡检 UI（frontend-app 的 AI 设置页）还在直接写它。第一次
      // Admin 保存若把它清空，DevOps 报告精简会静默退回 env / 硬编码默认，而管理员
      // 只是保存了一次模型目录、完全不知道动了那个功能。
      // 只清空**我们自己投影过**的行（带 projected_from 标记），手填值原样保留。
      let ours = false;
      try {
        const r = await ddb.send(new GetCommand({
          TableName: TABLE, Key: { PK: pk, SK: PROJECTION_SK },
        }));
        if (!r.Item) continue;                       // 本来就没有，无需写
        ours = Boolean(r.Item.projected_from);
        if (!String(r.Item.config_value || "")) continue;  // 已经是空的
      } catch (e) {
        console.error(`[llm-config] projection precheck failed for ${task}: ${e?.name || e}`);
        failed.push(task);
        continue;
      }
      if (!ours) {
        console.log(`[llm-config] leaving hand-set ${pk}/${PROJECTION_SK} alone `
                    + `(${task} is unbound and that row was not projected by us)`);
        continue;
      }
    }

    // 三行一起写。**顺序要紧**：先写 kind / region，最后写 model_id。
    // model_id 是后端读取的触发点（`bedrock_model_id` 非空才认为「Admin 配过」），
    // 若它先落地而 kind 还没到，中间那一瞬后端会拿新 model_id 配旧协议 —— 对
    // Mantle-only 的模型就是一次 ValidationException。
    //
    // 但**写序单独不够**。这里原先写着「消费侧对『kind 与 model_id 不配』采取忽略 kind
    // 的保守处理」—— 那个处理从来没被实现过，而消费侧的读序（先 model_id、后 kind）
    // 恰好把写序的保护抵消掉了：
    //     t0 读 model_id → 旧值   t1..t3 写 kind/region/model_id（新）   t4 读 kind → 新值
    // 得到「旧 model_id + 新 kind」，同一类错配从另一侧进来。
    //
    // 所以路由行额外带上 `for_model_id`，让配对可被**校验**而不是靠约定。因为 model_id
    // 是最后写的，「kind 行声称自己属于我手上这个 model_id」就足以证明两者同代。
    // 消费侧见 shared/phd_config.phd_model_route 与 shared/summarizer_config._model_route。
    //
    // 没用 TransactWriteItems 做原子写：实测 `dynamodb:TransactWriteItems` 是**独立的**
    // IAM 动作（只授 PutItem 时模拟结果为 implicitDeny），要给 BFF 与两个消费 Lambda
    // 各加授权；而配对校验零 IAM 变更就能覆盖瞬时撕裂。三次 put 中途失败导致的**持久**
    // 撕裂仍会被下面的 catch 记入 `failed`，管理员会看到「save again to re-sync」。
    const rows = [
      [PROJECTION_SK_KIND, modelKind],
      [PROJECTION_SK_REGION, modelRegion],
      [PROJECTION_SK, modelId],
    ];
    try {
      for (const [sk, value] of rows) {
        await ddb.send(new PutCommand({
          TableName: TABLE,
          Item: {
            PK: pk, SK: sk,
            config_value: value,
            updated_at: now,
            updated_by: actor?.username || actor?.sub || "",
            // 留痕：这行是派生值，别让后来人以为它是手填的。也是上面「是否可以清空」
            // 的判据 —— 没有这个标记就说明是人手填的，我们不动。
            projected_from: `llmcfg.backend_tasks.${task}`,
            // 配对标记：这一行属于哪个 model_id。消费侧据此判断 kind/region 与自己
            // 手上的 model_id 是否同代（见上方说明）。model_id 行自带这个信息，
            // 但一并写上，读起来不必分情况。解绑时 modelId 为 ""，与空的 model_id 行配对。
            for_model_id: modelId,
          },
        }));
      }
    } catch (e) {
      console.error(`[llm-config] backend task projection failed for ${task}: ${e?.name || e}`);
      failed.push(task);
    }
  }
  return failed;
}

/** Admin：读后端任务绑定（alias）+ 各自投影出去的 model_id 现值，便于核对是否同步。 */
export async function apiGetBackendTasks() {
  const cfg = (await readConfig()) || {};
  const models = Array.isArray(cfg.models) ? cfg.models : [];
  const tasks = cfg.backend_tasks || {};
  const out = [];
  for (const task of BACKEND_TASKS) {
    const alias = String(tasks[task] || "");
    const entry = alias ? models.find((m) => String(m.alias) === alias) : null;
    let projected = "";
    let projected_at = "";
    let projected_by_us = false;
    let readOk = true;
    try {
      const r = await ddb.send(new GetCommand({
        TableName: TABLE, Key: { PK: TASK_PROJECTION[task], SK: PROJECTION_SK },
      }));
      projected = String(r.Item?.config_value || "");
      projected_at = String(r.Item?.updated_at || "");
      projected_by_us = Boolean(r.Item?.projected_from);
    } catch (e) {
      console.error(`[llm-config] read projection for ${task} failed: ${e?.name || e}`);
      readOk = false;
    }
    const wanted = entry ? String(entry.model_id) : "";
    // 三态而非布尔。旧的 `in_sync: wanted === projected` 在**什么都没配**时是
    // `"" === ""` → true，于是一个从未配置过的系统显示为「已同步」；投影读失败时
    // 也同样报 true（projected 保持 ""）。两种都是假绿，而这是唯一的漂移信号。
    let status;
    if (!readOk) status = "unknown";                    // 读失败，不知道那行是什么
    else if (!wanted && !projected) status = "unbound"; // 未绑定，后端走自己的兜底
    else if (wanted === projected) status = "in_sync";
    else status = "drift";                              // 上次投影失败 / 被人手改过
    out.push({
      task,
      alias,
      model_id: wanted,
      projected_model_id: projected,
      projected_at,
      // 该行是我们投影的还是人手填的 —— 决定「取消绑定」时是否可以清空它
      projected_by_us,
      status,
      // 保留布尔字段供旧调用方使用，但只在真正同步时为 true
      in_sync: status === "in_sync",
    });
  }
  return { tasks: out, generation: Number(cfg.generation || 0) };
}

/**
 * Admin：只改后端任务绑定。整份 PUT 也会带 backend_tasks，但那要求 admin 提交完整目录；
 * UI 上「后端任务模型」是独立分区，给它一条窄接口，避免为改一个下拉框而重传全量目录
 * （全量重传还会撞上 generation 并发校验）。
 */
export async function apiPutBackendTasks(body, actor = {}) {
  if (!body || typeof body !== "object") return { error: "body must be an object", status: 400 };
  const prev = await readConfig();
  if (!prev) return { error: "model catalogue is not seeded yet", status: 409 };

  const next = { ...(prev.backend_tasks || {}) };
  let touched = false;
  for (const task of BACKEND_TASKS) {
    if (!(task in body)) continue;
    const v = body[task];
    if (v === null || v === "" || v === undefined) { next[task] = ""; touched = true; continue; }
    if (typeof v !== "string") return { error: `${task} must be a string alias`, status: 400 };
    next[task] = v;
    touched = true;
  }
  for (const k of Object.keys(body)) {
    if (!BACKEND_TASKS.includes(k)) return { error: `unknown backend task ${k}`, status: 400 };
  }
  if (!touched) return { error: `at least one of ${BACKEND_TASKS.join(", ")} is required`, status: 400 };

  // 复用整份校验：alias 必须 ∈ 启用集且非 Mantle。目录本体原样带入，只换 backend_tasks。
  const candidate = { ...prev, backend_tasks: next };
  const err = validateConfig(candidate);
  if (err) return { error: err, status: 400 };

  const generation = nextGeneration(prev);
  // 归一同保存路径：本接口只改 backend_tasks，但它**重写整份目录**并推进 generation，
  // 所以旧字段会跟着往前传。窄接口也是写入侧。
  const item = { ...candidate, PK, SK, generation,
                 models: normaliseModels(candidate.models),
                 updated_at: new Date(generation).toISOString(),
                 updated_by: actor?.username || actor?.sub || "" };
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE, Item: item,
      ConditionExpression: "generation = :g",
      ExpressionAttributeValues: { ":g": Number(prev.generation || 0) },
    }));
  } catch (e) {
    if (e?.name === "ConditionalCheckFailedException") {
      return { error: "configuration changed by someone else; reload and retry", status: 409 };
    }
    throw e;
  }

  const failedProjection = await projectBackendTasks(item, actor);
  await writeAudit(prev, item, { ...actor, note: "backend_tasks" });
  return {
    message: "backend task models updated",
    generation,
    ...(failedProjection.length
      ? { warning: `saved, but syncing to the backend config failed for: ${failedProjection.join(", ")} — retry to re-sync` }
      : {}),
  };
}

/**
 * 模型条目的字段白名单 —— 写入 DDB 前按它归一，白名单外的键一律丢弃。
 *
 * 直接动因是 `verified`：那个字段已从种子、内置兜底、校验、UI 全部删除，但**已部署环境的
 * DDB item 里还留着**。Admin 页把 item 读出来、原样提交回来，而写入侧是 `models: body.models`
 * 直通，于是它会一代一代 round-trip 下去 —— 代码读起来像"字段已删除"，线上数据却一直带着它。
 * 更糟的是它会进审计快照，回滚时被还原。
 *
 * 用白名单而不是 `delete m.verified`：删单个字段只解决今天这一个，白名单让 schema 成为
 * 唯一事实来源，以后任何被废弃的字段都会自动停止蔓延。校验（validateEntry）负责"值对不对"，
 * 这里负责"有哪些键"，两者互补。
 *
 * ⚠️ 增加合法字段时必须同步这里，否则新字段会被静默丢掉 —— **这不是假设，第一版就漏了
 * `model_id_override`**（见下方注释）。所以本清单被 `export`，且 `VALIDATED_ENTRY_FIELDS`
 * 记下校验器实际认识的键：测试断言两者一致，而不是再手抄一份清单。手抄的清单会连同遗漏
 * 一起被抄过去，那正是漏掉 `model_id_override` 时测试仍然全绿的原因。
 */
export const MODEL_ENTRY_FIELDS = [
  "alias", "short", "aliases_legacy", "model_id", "label", "desc_key",
  "kind", "region", "hard_output_limit", "output_override",
  // 按端覆盖 model_id。**漏掉它曾造成静默数据丢失**：这个清单第一版没写它，而
  // `validateEntry` 校验它、`apiGetLlmConfig` 原样返回、Admin 页原样提交回来、
  // `core/llm_config.py` 的 `_resolve_entry` 用它决定该端真正调哪个 model_id。
  // 于是管理员在模型页点一下任何勾选框，这个字段就被抹掉，运行时静默退回基础
  // model_id —— 而它存在的意义正是「某一端要用不同的 inference profile」，
  // 抹掉等于**静默改变该端的地理路由与数据驻留**，且无日志、无指标、无审计痕迹。
  "model_id_override",
  "supports_prompt_cache", "surfaces", "enabled",
];

/**
 * `validateEntry` 实际认识的模型条目字段 —— 即「schema 承认它存在」的那一份清单。
 *
 * 单独列出来只为一个目的：让测试能断言 `MODEL_ENTRY_FIELDS` 与它**逐一相等**。
 * 校验器读键的方式是散在函数体里的属性访问（`m.alias`、`m.model_id_override` …），
 * 没法可靠地反射出来，所以这里显式记一份，并由测试盯住两者不许分叉。
 *
 * ⚠️ 改 `validateEntry` 认识的字段时，这里和 `MODEL_ENTRY_FIELDS` 都要改，测试会拦。
 */
export const VALIDATED_ENTRY_FIELDS = [
  "alias", "short", "aliases_legacy", "model_id", "label", "desc_key",
  "kind", "region", "hard_output_limit", "output_override", "model_id_override",
  "supports_prompt_cache", "surfaces", "enabled",
];

/** 按白名单归一模型条目。缺失的键不补默认值 —— 校验已经保证必填项都在。 */
function normaliseModels(models) {
  return (models || []).map((m) => {
    const out = {};
    for (const k of MODEL_ENTRY_FIELDS) {
      if (m[k] !== undefined) out[k] = m[k];
    }
    return out;
  });
}

export async function apiPutLlmConfig(body, actor = {}) {
  const err = validateConfig(body);
  if (err) return { error: err, status: 400 };

  // 现场探测默认模型，取代已删除的持久化 `verified`。在写入**之前**做：让不可用的默认
  // 模型根本进不了 DDB，而不是先落地再靠一个会过期的标记去追。
  const probe = await probeDefaultModel(body);
  if (!probe.ok) return { error: probe.error, status: 400 };

  const prev = await readConfig();
  const generation = nextGeneration(prev); // epoch-ms 语义，服务端生成且严格单调
  const item = {
    PK, SK,
    provider: body.provider || "bedrock",
    credential_mode: body.credential_mode || prev?.credential_mode || "iam",
    default_model: String(body.default_model),
    models: normaliseModels(body.models),
    backend_tasks: body.backend_tasks || prev?.backend_tasks || {},
    generation,
    updated_at: new Date(generation).toISOString(),
    updated_by: actor?.username || actor?.sub || "",
  };

  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: item,
      // 并发保护：期望 generation 与读到的一致；不一致说明有人先改了（返 409 让 Admin 重载）
      ...(prev
        ? {
          ConditionExpression: "generation = :g",
          ExpressionAttributeValues: { ":g": Number(prev.generation || 0) },
        }
        : { ConditionExpression: "attribute_not_exists(PK)" }),
    }));
  } catch (e) {
    if (e?.name === "ConditionalCheckFailedException") {
      return { error: "configuration changed by someone else; reload and retry", status: 409 };
    }
    throw e;
  }

  // 目录本体变了也要重投影：alias 没变但它指向的 model_id 可能被改（重映射 / 换代），
  // 或者被绑定的模型被禁用了 —— 只在 backend-tasks 那条窄接口里投影会漏掉这些情形。
  const failedProjection = await projectBackendTasks(item, actor);

  await writeAudit(prev, item, actor);
  // 两类 warning 都要能透出去：投影失败（后端暂时用旧模型）与默认模型未能验证
  // （Bedrock 限流/超时，不是模型不行）。合并成一条，别让后者被前者盖掉。
  const warnings = [
    failedProjection.length
      ? `syncing to the backend config failed for: ${failedProjection.join(", ")} — retry to re-sync`
      : "",
    probe.warning || "",
  ].filter(Boolean);
  return {
    message: "LLM config updated",
    generation,
    ...(warnings.length ? { warning: `saved, but ${warnings.join("; ")}` } : {}),
  };
}

/* ───────────────── Admin: Bedrock API Key ───────────────── */

export async function apiPutBedrockKey(body, actor = {}) {
  if (!body || typeof body !== "object") return { error: "body must be an object", status: 400 };
  const clear = body.clear === true;
  const key = String(body.api_key || "").trim();
  if (!clear && !key) return { error: "api_key is required (or pass clear:true)", status: 400 };
  if (!clear && (key.length < 8 || key.length > 4096)) {
    return { error: "api_key length looks wrong", status: 400 };
  }

  const payload = JSON.stringify(clear ? {} : { bedrock_api_key: key });
  try {
    await sm.send(new UpdateSecretCommand({ SecretId: SECRET_ID, SecretString: payload }));
  } catch (e) {
    if (e?.name === "ResourceNotFoundException") {
      await sm.send(new CreateSecretCommand({ Name: SECRET_ID, SecretString: payload }));
    } else throw e;
  }

  // Key 变更必须更新 generation：消费端据此重建模型客户端（env 快照在构造时读取）
  const prev = await readConfig();
  if (prev) {
    const generation = nextGeneration(prev);
    // 这里曾经把所有 `verified` 置 false（换凭证 → 旧的验证结论失效）。`verified` 这个
    // 持久化字段已整体删除，所以这段也没了 —— 换 Key 后的正确性由**下一次保存时的现场
    // 探测**保证（probeDefaultModel 用的就是新 Key），不再依赖任何需要手动失效的标记。
    try {
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: { ...prev, generation,
                // 归一同保存路径。本接口不碰模型目录，但它把 `prev` 整份写回并推进
                // generation，所以旧字段照样往前传一代。
                models: normaliseModels(prev.models),
                updated_at: new Date(generation).toISOString(),
                updated_by: actor?.username || actor?.sub || "",
                // 谁设/清了 Key（spec R5.6 的 `set_by`）。清空时一并清掉，否则「未配置」
                // 状态下还挂着上一个人的名字，看起来像 Key 还在。
                bedrock_key_set_by: clear ? "" : (actor?.username || actor?.sub || "") },
        // 这是一次「读快照 → 只改 generation → 写回」，没有条件保护时会把并发保存的
        // 目录整份静默回退，**而且回退那次写还会 bump generation** —— 于是所有消费端
        // 把旧目录当成最新配置热刷进去。加条件保护。
        ConditionExpression: "generation = :g",
        ExpressionAttributeValues: { ":g": Number(prev.generation || 0) },
      }));
      await writeAudit(prev, { generation }, { ...actor, note: clear ? "key_cleared" : "key_set" });
    } catch (e) {
      if (e?.name === "ConditionalCheckFailedException") {
        // 有人并发保存了目录 → generation 已经前进，本次 bump 的目的（让消费端重建
        // 模型客户端）已由那次保存达成。不是错误，也不需要重试。
        console.log("[llm-config] generation already advanced by a concurrent save; "
                    + "skipping the bump after the key change");
      } else {
        console.error(`[llm-config] generation bump after key change failed: ${e?.name || e}`);
      }
    }
  }
  // 绝不回显明文
  return { message: clear ? "Bedrock API key cleared" : "Bedrock API key updated",
           bedrock_api_key: await keyStatus() };
}

/* ───────────────── Admin: 连通性测试 ───────────────── */

/**
 * 逐模型最小探测。**只回枚举态**（ok / unauthorized / forbidden / not_found /
 * throttled / timeout / error），不透传上游原文——上游报错可能带凭证片段（spec R5.5）。
 */
/** Mantle（GPT 系）连通性探测 —— 真发一次最小推理请求。
 *
 * 这里曾经直接返回 `skipped`，理由写的是「凭证与端点均与 runtime 不同，BFF 探测不了」。
 * 那个判断是错的：Mantle 的鉴权就是**普通 SigV4**（签名服务名 `bedrock-mantle`，见
 * openai SDK 的 _bedrock_auth.py），BFF 用自己的任务角色签名即可调通。
 * 错误的后果很实际：GPT 系模型永远显示「跳过」，管理员没有任何办法在上线前确认它能用 ——
 * 只能让用户到生产里试错。
 *
 * 凭证：跟随 `cred` —— api_key 模式发 `Authorization: Bearer <key>`，否则 SigV4
 * （签名服务名 `bedrock-mantle`）。**这与 runtime 现在的行为一致**，所以 ok 的含义是
 * 「运行时真正会用的那套凭证能调通这个模型」。
 *
 * 此处原本写着「Key 对 Mantle 无效，Mantle 始终走 IAM（spec R5.7）」—— 那是错的，已作废。
 * 文档明确 Bedrock API Key 就是 Mantle 给 OpenAI SDK 的推荐认证方式（对应 IAM 动作
 * `bedrock-mantle:CallWithBearerToken`）。当时真正的原因是我们没接这条线，表现是
 * CloudTrail 里 Claude 那几轮的 caller 是 Key 背后的 IAM user、GPT 那轮却是部署角色 ——
 * 同一个「凭证方式」开关按模型给出两种语义。
 *
 * 与 Converse 探测的差别：Responses API 的参数名是 max_output_tokens（不是 maxTokens）。
 */
/**
 * 判定 Mantle 的 400 是「我们的请求体不对」还是「这个模型不行」。
 *
 * 起因与 Converse 侧 temperature 那次同类：400 原先一律映射成 `invalid_model`，而
 * `invalid_model` 在 HARD_FAIL_PROBE_RESULTS 里 —— 于是我们自己的请求体被拒会**硬拦保存**，
 * 管理员看到的是"模型 ID 无效"，去查模型，而真凶在探测代码里。
 *
 * 实测（us-east-2，2026-08，本部署账号）三种形状。**注意最外层的 `error`
 * 包裹** —— 下面读的是 `json().error.param`，与实测一致；这段注释早先把 `error` 外层
 * 省掉了，看起来像扁平结构，照它「改对」代码反而会改坏（一次交叉 review 正是据此
 * 报了个不存在的 bug）：
 *   参数不被该模型接受 → 400 {"error":{"code":"unsupported_parameter",
 *                                     "param":"temperature","type":"invalid_request_error"}}
 *   参数值越界        → 400 {"error":{"code":"integer_below_min_value",
 *                                     "param":"max_output_tokens",
 *                                     "message":"Expected a value >= 16, but got 1"}}
 *   模型真不存在      → **404** {"error":{"code":"not_found_error","param":null}}
 * 也就是说：模型缺失走 404，可实测的 400 全部出在请求体上。所以 400 的默认归属是
 * `probe_error`（放行 + warning），只有明确点到 `model` 参数时才算模型的问题。
 *
 * 只用 body 做**分类**，绝不把上游文案带进返回值（spec R5.5）。body 读不出来时同样按
 * probe_error 处理 —— 宁可放行加一条 warning，也不要凭猜硬拦一次合法保存。
 */
async function _classifyMantle400(response) {
  let param = "";
  let code = "";
  try {
    const err = (await response.json())?.error || {};
    param = String(err.param || "");
    code = String(err.code || "");
  } catch {
    return "probe_error";                 // 读不出结构 → 不硬拦
  }
  // `model` 是唯一由目录决定的参数；其余（input / max_output_tokens / store / …）都是
  // 探测自己填的，被拒就是我们的问题。
  // `not_found_error` 是实测到的「模型不存在」code（走 404，不走这里），一并认下 ——
  // 早先这里写的是 `model_not_found`，那个 code 在实测里根本不存在，是凭空猜的分支。
  if (param === "model" || code === "not_found_error") return "invalid_model";
  return "probe_error";
}

async function probeMantle(modelId, region, cred = { mode: "iam", key: "" }) {
  const started = Date.now();
  try {
    const hostname = `bedrock-mantle.${region}.api.aws`;
    const path = "/openai/v1/responses";
    // 最小请求：一个 token 的输入 + 极小输出上限，只为换一个 HTTP 状态码。
    // `store: false` —— 探测不该在客户账号里留 30 天的留存记录（默认是 true）。
    // 16 是实测出的 `max_output_tokens` 下限（传 1 → 400 integer_below_min_value,
    // "Expected a value >= 16"），所以这里正好卡在边界上。若某个模型的下限更高，
    // 400 会被 _classifyMantle400 判成 probe_error（放行 + warning），
    // 而不是像以前那样报"模型 ID 无效"把合法保存硬拦下来。
    const payload = JSON.stringify({
      model: modelId, input: "ping", max_output_tokens: 16, store: false,
    });

    let headers;
    if (cred.mode === "api_key" && cred.key) {
      // Mantle 直接吃 Bedrock API Key 的 bearer（文档里 OpenAI SDK 的标准用法）。
      // 用 Key 探测才和运行时一致 —— 运行时现在也用 Key 走这条路。
      headers = { host: hostname, "content-type": "application/json",
                  authorization: `Bearer ${cred.key}` };
    } else {
      const { SignatureV4 } = await import("@smithy/signature-v4");
      const { Sha256 } = await import("@aws-crypto/sha256-js");
      const { defaultProvider } = await import("@aws-sdk/credential-provider-node");
      const signer = new SignatureV4({
        service: "bedrock-mantle", region, sha256: Sha256, credentials: defaultProvider(),
      });
      const signed = await signer.sign({
        method: "POST", protocol: "https:", hostname, path,
        headers: { host: hostname, "content-type": "application/json" },
        body: payload,
      });
      headers = signed.headers;
    }

    const ctl = AbortSignal.timeout(10_000);   // spec R2.4：单模型探测 ≤10s
    const r = await fetch(`https://${hostname}${path}`, {
      method: "POST", headers, body: payload, signal: ctl,
    });
    const latency_ms = Date.now() - started;
    if (r.ok) return { model_id: modelId, result: "ok", latency_ms };
    // 400 要看清是谁的错，见 _classifyMantle400。其余状态码直接映射。
    // 只回枚举态，**不透传上游错误原文**（spec R5.5：可能含账号/凭证细节）。
    if (r.status === 400) {
      return { model_id: modelId, result: await _classifyMantle400(r), latency_ms };
    }
    const byStatus = {
      401: "unauthorized", 403: "forbidden",
      404: "not_found", 408: "timeout", 429: "throttled",
    };
    return { model_id: modelId, result: byStatus[r.status] || "error", latency_ms };
  } catch (e) {
    const name = e?.name || "";
    return {
      model_id: modelId,
      result: name === "TimeoutError" || name === "AbortError" ? "timeout" : "error",
      latency_ms: Date.now() - started,
    };
  }
}

export async function apiTestLlmModel(body) {
  const modelId = String(body?.model_id || "").trim();
  const kind = String(body?.kind || "bedrock_converse");
  const region = String(body?.region || "").trim();
  if (!MODEL_ID_RE.test(modelId)) return { error: "invalid model_id", status: 400 };

  // 用**运行时会用的那种凭证**探测。回给客户端 `credential`，让 UI 能说清这一次验的是
  // 什么 —— 「用 Key 验过」和「用部署角色验过」是两个不同的保证。
  const cred = await probeCredential();

  if (kind === "bedrock_mantle_responses") {
    if (!MANTLE_REGIONS.has(region)) return { error: "invalid region for mantle model", status: 400 };
    return { ...(await probeMantle(modelId, region, cred)), credential: cred.mode };
  }

  return { ...(await probeConverse(modelId, region, cred)), credential: cred.mode };
}

/**
 * 保存前现场探测默认模型。取代已删除的持久化 `verified` 字段。
 *
 * 为什么改成保存时探：`verified` 断言的是 (模型 × 区域 × 凭证 × 时间) 这个组合成立，
 * 任何一维变了它就失效，而我们只能感知换 Key 那一维。于是它两次给出错误答案 —— 种子
 * 写死 true 让东京调不通的模型进了生产；被收窄的 Key 排除掉的模型照样能设成默认。
 * 现场探测的结论属于**决策那一刻**，不存在过期问题。
 *
 * 只对**确定性判定**硬拦。`throttled` / `timeout` / `error` 说明的是「这次没问对上」，
 * 不是「这个模型不行」—— 拿它们拦保存等于 Bedrock 抖一下管理员就被锁在门外，而目录本身
 * 可能只是改了个输出上限。放行并回一条 warning。
 */
const HARD_FAIL_PROBE_RESULTS = new Set([
  "invalid_model",    // 模型 id 在这个区/端点上不存在
  "not_found",
  "forbidden",        // 当前凭证没权限调它（被收窄的 Key 正是这一种）
  "unauthorized",
  "needs_profile",    // 本区不支持按需直调，要改用 global./apac. 前缀
]);

async function probeDefaultModel(cfg) {
  const def = String(cfg.default_model || "");
  const entry = (cfg.models || []).find((m) => String(m.alias) === def);
  if (!entry) return { ok: true };                     // validateConfig 已经拦过
  // 用**这份 cfg 里**的 credential_mode，不是 DDB 里的旧值 —— 见 probeCredential 的说明。
  const cred = await probeCredential(cfg.credential_mode);
  const region = String(entry.region || "");
  let r;
  try {
    r = entry.kind === "bedrock_mantle_responses"
      ? await probeMantle(String(entry.model_id), _mantleRegionOrDefault(region), cred)
      : await probeConverse(String(entry.model_id), region, cred);
  } catch (e) {
    // 探测本身炸了（网络 / SDK）——不能因此拦住一次合法保存。
    console.error(`[llm-config] default-model probe threw: ${e?.name || e}`);
    return { ok: true, warning: `could not verify default_model ${def} (probe error)` };
  }
  if (r.result === "ok") return { ok: true, credential: cred.mode };
  if (HARD_FAIL_PROBE_RESULTS.has(r.result)) {
    return { ok: false,
             error: `default_model ${def} failed a live check (${r.result}` +
                    `${cred.mode === "api_key" ? ", using the configured API key" : ""}); `
                    + "fix the model id/region or pick another default" };
  }
  // 文案保持中性、不含「saved」/「rolled back」—— 调用方（保存 / 回滚）各自加前缀。
  // 写死 "saved, but" 曾让回滚拼出「rolled back, but saved, but …」。
  return { ok: true,
           warning: `default_model ${def} could not be verified right now `
                    + `(${r.result}) — re-run the connectivity test later` };
}

/** Mantle 的 region 必须在白名单内才拼得出 hostname；越界时退默认区（与 Python 侧一致）。 */
function _mantleRegionOrDefault(region) {
  return MANTLE_REGIONS.has(region) ? region : MANTLE_REGION_DEFAULT;
}

/** Converse 探测。抽出来给保存时的默认模型检查复用，避免两处各写一遍状态码映射。 */
async function probeConverse(modelId, region, cred) {
  const client = runtimeFactory(region, cred);
  const started = Date.now();
  try {
    await client.send(new ConverseCommand({
      modelId,
      messages: [{ role: "user", content: [{ text: "ping" }] }],
      // **不要传 temperature**。新一代 Claude（Sonnet 5 / Opus 5，adaptive thinking 常驻）
      // 已弃用该参数，传了直接 ValidationException：
      //   "The model returned the following errors: `temperature` is deprecated for this model"
      // 而下面把 ValidationException 映射成 `invalid_model` —— 于是探测对**每一个**新一代
      // Claude 都报"模型无效"，管理员因此无法把它设为默认模型（实测 global.anthropic.
      // claude-sonnet-5：带 temperature 报错，去掉后正常返回）。
      // 探测只为换一个状态码，采样参数一概不传，交给模型默认值。
      inferenceConfig: { maxTokens: 8 },
    }));
    return { model_id: modelId, result: "ok", latency_ms: Date.now() - started };
  } catch (e) {
    const name = e?.name || "";
    const map = {
      AccessDeniedException: "forbidden",
      UnrecognizedClientException: "unauthorized",
      ValidationException: "invalid_model",
      ResourceNotFoundException: "not_found",
      ThrottlingException: "throttled",
      ModelNotReadyException: "not_ready",
      TimeoutError: "timeout",
    };
    let result = map[name] || "error";
    // ValidationException 同时覆盖两件完全不同的事：「这个 model_id 不对」与「我这次请求的
    // 参数这个模型不接受」。一律报成 `invalid_model` 会把探测自身的问题归咎到模型上 ——
    // 实测就踩过：探测传了 `temperature`，而新一代 Claude 已弃用它，于是每个 Sonnet 5 /
    // Opus 5 都显示"模型无效"。参数问题是**我们的** bug，得报成 probe_error 让人去查探测，
    // 而不是让管理员以为模型不可用。仍然只回枚举态，不透传上游原文（spec R5.5）。
    const msg = String(e?.message || "");
    if (name === "ValidationException" && /\bdeprecated\b|inferenceConfig|temperature|topP|topK/i
        .test(msg)) {
      result = "probe_error";
    } else if (name === "ValidationException" && /on-demand throughput isn.t supported|inference profile/i
        .test(msg)) {
      // 「这个模型在本区不支持按需直调，请改用 inference profile」。这**不是**"模型不存在"，
      // 而是"你填的 id 形态不对，换成 apac./global. 前缀的那个"。区分开才给得出下一步 ——
      // 实测东京的 `amazon.nova-pro-v1:0` 就是这种（种子目录里正是裸 id，因此在东京不可用，
      // 而种子把 verified 写死成 true，从没被测出来）。
      result = "needs_profile";
    }
    return { model_id: modelId, result, latency_ms: Date.now() - started };
  }
}

/* ───────────────── Admin: 审计 / 回滚 ───────────────── */

export async function apiListLlmAudit() {
  const r = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": AUDIT_PK },
    ScanIndexForward: false,
    Limit: AUDIT_KEEP,
    // 列表不带 snapshot_before（可能很大）；回滚时按 SK 单条取
    ProjectionExpression: "SK, at, actor_sub, actor_name, generation_before, generation_after",
  }));
  return { entries: r.Items || [] };
}

export async function apiRollbackLlmConfig(body, actor = {}) {
  const sk = String(body?.sk || "").trim();
  if (!sk) return { error: "sk (audit entry key) is required", status: 400 };
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: AUDIT_PK, SK: sk } }));
  const entry = r.Item;
  if (!entry) return { error: "audit entry not found", status: 404 };
  if (!entry.snapshot_before) return { error: "audit entry has no snapshot to restore", status: 400 };

  let snapshot;
  try {
    snapshot = JSON.parse(entry.snapshot_before);
  } catch {
    return { error: "audit snapshot is corrupt", status: 500 };
  }
  const err = validateConfig(snapshot);
  if (err) return { error: `snapshot fails current validation: ${err}`, status: 400 };

  // 回滚也必须现场探测默认模型 —— 与保存同一套判定，同一个 HARD_FAIL 集合。
  //
  // 为什么不以「它当年通过过门禁」为由放行：那正是被删掉的 `verified` 字段的根本缺陷。
  // 快照断言的是 (模型 × 区域 × 凭证 × 时间) 这个组合**在当时**成立；此后 Key 可能被
  // 按模型收窄、模型可能下架、区域授权可能变。放行等于把那个缺陷原样请回来，只是换了
  // 一条路径 —— 保存拦得住的状态，回滚却能绕过去。
  //
  // 硬拦不会把管理员困住：同一页上可以换一条审计记录回滚，或直接存一份修正过的配置。
  // 而放行的代价更大 —— `default_model` 是 resolve() 的兜底级，坏掉的话所有没有显式
  // 选过模型的用户都受影响，且回滚会报告"成功"。
  // 瞬时故障（throttled / timeout / error）仍然只是 warning，不拦：Bedrock 抖一下不该
  // 把管理员锁在恢复路径外面。
  const probe = await probeDefaultModel(snapshot);
  if (!probe.ok) {
    return { error: `${probe.error} — roll back to a different entry instead, `
                    + "or save a corrected configuration", status: 400 };
  }

  const prev = await readConfig();
  const generation = nextGeneration(prev);
  // 归一同保存路径。回滚是**最需要**它的那条：快照来自旧代，里面必然带着当时的字段
  // （`verified` 就是这么被一代代还原回来的）。只在 apiPutLlmConfig 归一等于「清理永远
  // 追不上还原」—— 白名单是写入侧的不变式，就得在每个写入侧都成立。
  const item = { ...snapshot, PK, SK, generation,
                 models: normaliseModels(snapshot.models),
                 updated_at: new Date(generation).toISOString(),
                 updated_by: actor?.username || actor?.sub || "" };
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE, Item: item,
      // 回滚此前是本模块唯一的无条件写：与并发保存竞争时静默胜出，把对方的改动
      // 连带丢掉。与其它写路径统一，冲突时让 Admin 重载后再决定。
      ...(prev
        ? {
          ConditionExpression: "generation = :g",
          ExpressionAttributeValues: { ":g": Number(prev.generation || 0) },
        }
        : { ConditionExpression: "attribute_not_exists(PK)" }),
    }));
  } catch (e) {
    if (e?.name === "ConditionalCheckFailedException") {
      return { error: "configuration changed by someone else; reload and retry", status: 409 };
    }
    throw e;
  }
  // 回滚也要重投影：否则后端任务会停在被回滚掉的那个模型上（真源回去了、派生值没回去）。
  const failedProjection = await projectBackendTasks(item, actor);
  await writeAudit(prev, item, { ...actor, note: `rollback_to:${sk}` });
  // 两类 warning 合并，别让探测那条被投影那条盖掉（保存路径同样处理）。
  const warnings = [
    failedProjection.length
      ? `syncing to the backend config failed for: ${failedProjection.join(", ")} — save again to re-sync`
      : "",
    probe.warning || "",
  ].filter(Boolean);
  return {
    message: "rolled back",
    generation,
    ...(warnings.length ? { warning: `rolled back, but ${warnings.join("; ")}` } : {}),
  };
}

/* ───────────────── Admin: 只读诊断（spec R9.4 / task 9.2）───────────────── */

/**
 * 「现在到底是什么状态」的单一入口。
 *
 * BFF 能权威回答的只有一半：DDB 里的真值（哪一代、谁改的、启用了几个模型）。另一半 ——
 * **每个长驻实例当前正在服务哪一代** —— BFF 不可能知道：webchat runtime 是 AgentCore
 * microVM、IM bot 是 ECS 任务，各自持有独立的 TTL 缓存，且都没有对外的管理接口。
 * 所以这里把两半都给出来：真值 + 一条能查出各端实际状态的 Logs Insights 语句。
 *
 * 「混合态」（几个实例分别停在不同代上）是这套设计的正常中间态而非异常 —— 长驻进程 +
 * TTL 必然产生它。能诊断它比消除它重要。
 */
export async function apiGetLlmStatus() {
  let item = null;
  let readError = "";
  try {
    item = await readConfig();
  } catch (e) {
    readError = e?.name || "read_failed";
  }
  const models = Array.isArray(item?.models) ? item.models : [];
  const enabled = models.filter((m) => m && m.enabled === true);
  return {
    // ── BFF 自身 ──
    bff: {
      enabled_flag: LLMCFG_ENABLED,
      // 关闭态下 BFF 不注入 generation、不做准入 —— 这解释了为什么各端可能"不跟随"
      note: LLMCFG_ENABLED
        ? "consumer paths active"
        : "LLMCFG_ENABLED=0 — /models returns an empty set and /stream neither admits "
          + "nor injects generation; consumers stay on their builtin catalogue",
    },
    // ── DDB 真值 ──
    catalogue: {
      seeded: Boolean(item),
      read_error: readError || undefined,
      generation: Number(item?.generation || 0),
      provider: item?.provider || "",
      credential_mode: item?.credential_mode || "",
      default_model: item?.default_model || "",
      models_total: models.length,
      models_enabled: enabled.length,
      enabled_by_surface: {
        webchat: enabled.filter((m) => (m.surfaces || []).includes("webchat")).length,
        im: enabled.filter((m) => (m.surfaces || []).includes("im")).length,
      },
      updated_at: item?.updated_at || "",
      updated_by: item?.updated_by || "",
      bedrock_api_key: await keyStatus(item),
    },
    // ── 如何看到**各端实际**在服务哪一代 ──
    // 日志组名由 CDK 生成、不稳定，所以给的是筛选语句与找日志组的线索，不写死名字。
    per_surface_diagnosis: {
      how: "Each long-lived surface logs a single-line `llmcfg_status` JSON whenever its "
        + "effective config changes (first load / generation change / source flip). Run the "
        + "query below over the log groups of all three units to see who is on which "
        + "generation right now.",
      logs_insights_query:
        "fields @timestamp, @log, @message"
        + " | filter @message like /llmcfg_status/"
        + " | sort @timestamp desc"
        + " | limit 100",
      where_to_look: [
        "BFF Lambda: /aws/lambda/notiops-web-chat-bff",
        "webchat runtime: /aws/bedrock-agentcore/runtimes/* (AgentCore)",
        "IM bot: the ECS task log groups — streams are prefixed feishu-bot / slack-bot / dingtalk-bot",
        "PHD Lambda: /aws/lambda/notiops-phd-forwarder (logs which of DDB / env / hardcoded won)",
      ],
      metrics_namespace: METRIC_NAMESPACE,
      metrics_hint:
        "FallbackBuiltin (dimension reason=not_seeded|read_error|malformed|disabled) tells you "
        + "a surface is NOT on the DDB catalogue. On a fresh deploy that is the default state, "
        + "so a non-zero value is expected until the catalogue is seeded.",
    },
  };
}

/* ───────────────── 供 stream 链路复用 ───────────────── */

/**
 * 取当前 generation + 启用集校验后的 alias。
 * stream 路由用它给 payload 注入**服务端** generation，并把不在启用集内的 alias
 * 换成默认模型（spec R3.5：不信任客户端传值）。
 */
export async function resolveForStream(requestedAlias, surface = "webchat") {
  if (!LLMCFG_ENABLED) {
    // 原样透传客户端 alias，generation 0（agentcore.mjs 会把该字段整个省掉 →
    // runtime 只走 TTL）。runtime 侧若也关了开关，则两端都在兜底目录上，行为一致。
    return { alias: requestedAlias || "", generation: 0, substituted: false };
  }
  const cfg = (await readConfig()) || {};
  const generation = Number(cfg.generation || 0);
  const want = SURFACES.has(surface) ? surface : "webchat";
  const models = (Array.isArray(cfg.models) ? cfg.models : [])
    .filter((m) => m && m.enabled === true && (m.surfaces || []).includes(want));
  if (!models.length) {
    // 目录未 seed / 全禁用：透传客户端值，由 runtime 侧内置兜底处理
    return { alias: requestedAlias || "", generation, substituted: false };
  }
  const asked = String(requestedAlias || "").trim().toLowerCase();
  const hit = models.find((m) => asked === String(m.alias).toLowerCase()
    || asked === String(m.short || "").toLowerCase()
    || (m.aliases_legacy || []).some((a) => String(a).toLowerCase() === asked));
  if (hit) return { alias: String(hit.alias), generation, substituted: false };

  const def = String(cfg.default_model || "");
  const fallback = models.find((m) => String(m.alias) === def) || models[0];
  // 空 alias 不算「被替换」（用户没指定，走默认是正常行为）
  const substituted = Boolean(asked);
  if (substituted) {
    // 这条指标回答的是「有多少用户还在点已经下架的模型」——admin 缩减启用集后，
    // 存量会话偏好会持续撞上来，量能说明是否需要主动通知。alias 不作维度（高基数），
    // 放非维度字段供 Logs Insights 查具体是哪个。
    emit("ModelSubstituted", 1, {}, { requested: asked, effective: String(fallback.alias) });
  }
  return { alias: String(fallback.alias), generation, substituted };
}
