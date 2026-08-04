/**
 * 当前用户可见能力子树客户端（GET /me/capabilities）。
 * 服务端按 Effective_Permissions 过滤 registry；前端据此决定渲染哪些 tab/subtab。
 */
import { signedClient } from "./chat";

export interface CapabilityNode {
  key: string;
  level: "tab" | "subtab" | "dashboard" | "action";
  parent: string | null;
  viewState?: string | null;
  title_zh?: string;
  title_en?: string;
}

/** 拉取当前用户可见能力节点数组。失败 → 空（前端保守隐藏受控入口）。 */
export async function getMyCapabilities(): Promise<CapabilityNode[]> {
  const s = await signedClient();
  if (!s) return [];
  try {
    const r = await s.aws.fetch(`${s.base}/me/capabilities`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j.capabilities) ? j.capabilities : [];
  } catch {
    return [];
  }
}

/** 由可见节点构造一个 Set<key> + can() 判定器，供组件按 key 门禁。 */
export function makeCan(nodes: CapabilityNode[]): (key: string) => boolean {
  const set = new Set(nodes.map((n) => n.key));
  return (key: string) => set.has(key);
}
