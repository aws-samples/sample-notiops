/**
 * 两步验证（验证器 App）客户端：GET /me/mfa —— 用户池是哪一档、自己绑了没有（见 bff/web-chat/mfa.mjs）。
 * 绑定 / 关闭本身不经 BFF，在 TwoFactorDialog 里经 Amplify 直连 Cognito。
 */
import { signedClient } from "./chat";

export type MfaMode = "OFF" | "OPTIONAL" | "REQUIRED";
export interface MyMfa {
  /** null = 服务端暂时读不到（菜单里就不显示入口）。 */
  mode: MfaMode | null;
  enrolled: boolean | null;
  /** 「管理」页是否要求先绑定（mode 不是 OFF 时为 true）。 */
  adminRequiresMfa: boolean | null;
}

/** BFF 拒绝管理请求、理由是「先开两步验证」时，api/admin.ts 广播这个事件，ChatApp 收到就弹出设置框。 */
export const MFA_REQUIRED_EVENT = "notiops:mfa-required";

export async function getMyMfa(): Promise<MyMfa | null> {
  const s = await signedClient();
  if (!s) return null;
  try {
    const r = await s.aws.fetch(`${s.base}/me/mfa`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return null;
    const j = (await r.json()) as Partial<MyMfa>;
    const mode = j.mode === "OFF" || j.mode === "OPTIONAL" || j.mode === "REQUIRED" ? j.mode : null;
    return {
      mode,
      enrolled: typeof j.enrolled === "boolean" ? j.enrolled : null,
      adminRequiresMfa: typeof j.adminRequiresMfa === "boolean" ? j.adminRequiresMfa : null,
    };
  } catch {
    return null;
  }
}
