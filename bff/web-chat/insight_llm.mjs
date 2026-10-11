/**
 * Dashboard 洞察（FinOps deep-dive / tag-cost、Support 6 个月汇总）的模型调用。
 *
 * 这三处的活是「把给定的几十行数据整理成一段 JSON」—— 不需要推理，推理型模型在这上面
 * 先白想 2–3.5k token。2026-10-10 us-east-1，按 deep-dive 真实形状的 40 行提示词实测：
 *   · Kimi K3 / Grok 4.6 / Grok 4.7 / GLM 5.3 在 maxTokens=1000 时**全部**停在推理里、
 *     一个 JSON 字都没有（stopReason=max_tokens）。这是 2026-09-01 换成 Grok 4.6 之后这几处
 *     洞察一直是空的**两个原因之一**；另一个是读错了块，见 `converseText`。
 *   · 预算放到 4000：Kimi 能出但要 38s / 139s（输出 ~3.4k，离上限很近），GLM 5.3 照样用光，
 *     Grok 4.6 19s。Support 那处**不缓存**，每次打开都要等这么久。
 *   · DeepSeek V3.2（非推理）：~300 token、约 4s、JSON 完整。
 * 所以首选 DeepSeek V3.2。但它是**裸 id**、没有跨区 profile —— eu-west-1 / eu-central-1 /
 * ap-southeast-1 都没有它（同日 list-foundation-models 实测）。调不通、或者没拿到文本时，
 * 退回产品默认模型（`global.` profile，哪个区都能调），并给足推理的预算。
 *
 * ⚠️ 最后一项必须是目录的 `default_model`：tests/dashboard_insight_requests.test.mjs 拿
 * `config/llm-model-catalog.json` 核它，换默认模型时会在那里红。
 *
 * **不要传 temperature / topP**：Kimi K3 直接拒（ValidationException），Sonnet 5 也拒过
 * （「`temperature` is deprecated for this model」）。这几处的异常会被调用方兜成 aiError，
 * 界面上只是「洞察是空的」，没有任何报错 —— 2026-08-26 就这样整体失效过一次。确定性靠
 * 提示词里的 STRICT JSON 约束，不靠采样参数。
 */
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

export const INSIGHT_MODELS = Object.freeze([
  Object.freeze({ modelId: "deepseek.v3.2", maxTokens: 1000 }),
  Object.freeze({ modelId: "global.moonshotai.kimi-k3", maxTokens: 8000 }),
]);

/**
 * Converse 响应里的**答案文本**。
 *
 * 别用 `content[0].text`：推理型模型把 `reasoningContent` 块放在前面。实测（同上）：
 * Kimi K3 / Grok 4.6 / Grok 4.7 都是 `[reasoningContent, text]`，GLM 5.3 反过来是
 * `[text, reasoningContent]`。取 `content[0]` 拿到的是 `undefined`，后面的 `JSON.parse("")`
 * 抛错，被兜成 aiError。所有文本块按顺序拼起来 —— Converse 没有承诺答案只占一个块。
 */
export function converseText(resp) {
  const blocks = resp?.output?.message?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => typeof b?.text === "string")
    .map((b) => b.text)
    .join("");
}

let _client = null;
function _defaultClient() {
  _client ||= new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });
  return _client;
}

/**
 * 依次试 `models`，返回第一个拿到非空文本的。全都不行 → 抛最后那个错误（调用方的 catch
 * 照旧兜成 aiError）。
 *
 * 不区分错误类型就往下试：这里只有一次性的生成，换个模型重来没有副作用；而「这个区没有
 * 这个模型」在不同的区报出来的类型并不一样（ValidationException / AccessDenied /
 * ResourceNotFound 都见过）。
 */
export async function invokeInsight(prompt, { client = _defaultClient(), models = INSIGHT_MODELS } = {}) {
  let lastErr = null;
  for (const { modelId, maxTokens } of models) {
    try {
      const resp = await client.send(new ConverseCommand({
        modelId,
        messages: [{ role: "user", content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens },
      }));
      const txt = converseText(resp);
      if (txt.trim()) return txt;
      lastErr = Object.assign(new Error(`no answer text (stopReason=${resp?.stopReason || "unknown"})`),
                              { name: "EmptyAnswer" });
    } catch (e) {
      lastErr = e;
    }
    // 只记模型 id + 错误类型名：e.message 会带调用方 role ARN / 账号 id（见 safe_err.mjs）。
    console.warn(`insight: ${modelId} gave no answer (${lastErr?.name || "Error"})`);
  }
  throw lastErr || new Error("no insight model configured");
}
