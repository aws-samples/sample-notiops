/**
 * 这套部署装没装 IM（待办 #8）。
 *
 * 用途只有一个：网关排第一时，保存模型配置会**加探 IM 那条 Bedrock 链路**（IM 的 `/agent notiops`
 * 之外，IM 机器人自己调模型只走 Bedrock，见 llm_config.mjs::probeBeforeWrite）。纯网页部署根本没有
 * IM —— 这一探只会把「本账号压根没开 Bedrock」的客户挡在网关门外（保存永远被 IM 那条拦下），
 * 而那正是最需要网关的客户。
 *
 * 判据与「集成 IM」抽屉找 webhook 地址同一套（feishu_config.mjs 等）：IM 入口 HTTP API 按名字
 * `${IM_INGRESS_API_NAME_PREFIX}<平台>` 建（方式 B `notiops-im-ingress-`、方式 A `<栈名>-im-ingress-`），
 * 一个都没有 = 没装 IM。BFF 角色本来就有这个只读的 `apigateway:GET`（/apis）。
 *
 * 返回 `true` / `false` / `null`（查不清：没有前缀 env、GetApis 失败）。**调用方把 null 当「装了」**
 * —— 查不清时照旧探，安全方向与改动前一致。
 */
import { ApiGatewayV2Client, GetApisCommand } from "@aws-sdk/client-apigatewayv2";

export const IM_PLATFORMS = ["feishu", "slack", "dingtalk"];

let agw = new ApiGatewayV2Client({});

/** 测试接缝 —— 仅供 bff/web-chat/tests 使用。 */
export function __setImIngressClient(client) { agw = client; }

export async function imIngressDeployed() {
  const prefix = process.env.IM_INGRESS_API_NAME_PREFIX || "";
  if (!prefix) return null;
  const wanted = new Set(IM_PLATFORMS.map((p) => `${prefix}${p}`));
  try {
    let next;
    do {
      const r = await agw.send(new GetApisCommand({ MaxResults: "100", NextToken: next }));
      if ((r.Items || []).some((a) => wanted.has(a?.Name))) return true;
      next = r.NextToken;
    } while (next);
    return false;
  } catch (e) {
    // 只记异常类型名（docs/LOGGING_STANDARD.md）。
    console.warn(`[llm-config] could not tell whether IM is deployed: ${e?.name || "Error"}`);
    return null;
  }
}
