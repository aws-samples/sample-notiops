/**
 * Web 登录两步验证（TOTP）的三档在两条部署路径上**落到同一组用户池属性**（2026-10-29）。
 *
 *   · 方式 B（setup.sh → NotiOpsBackendStack）：`-c mfaMode=` 字面量，CDK L2 直接给值；
 *   · 方式 A（一键模板）：参数 `MfaMode` 是 token，只能 L1 + Fn::If（见 minimal-base-core.ts）。
 *
 * 两种写法各自对、合在一起错的方式很多（档位名映射写反、OFF 时还带着 EnabledMfas —— Cognito 会拒、
 * 一键那边把 REQUIRED 原样塞进 MfaConfiguration —— Cognito 只认 ON），而且**只有真开栈才报错**。
 * 所以这里把一键模板的 Fn::If 按三个参数值各解一遍，逐档和方式 B 的合成结果比。
 */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { NotiOpsBackendStack } from "../lib/notiops-backend-stack";
import { NotiOpsWebChatStandaloneStack } from "../lib/notiops-webchat-standalone-stack";
import { parseMfaMode, MFA_MODES, DEFAULT_MFA_MODE } from "../lib/constructs/web-mfa";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const userPoolOf = (t: Json) => {
  const ids = Object.keys(t.Resources).filter((k) => t.Resources[k].Type === "AWS::Cognito::UserPool");
  expect(ids).toHaveLength(1);
  return t.Resources[ids[0]].Properties;
};

/** 方式 B：按上下文合成后端栈，取用户池的两项。
 *  关掉资产暂存：这里只看用户池属性，不需要把每个 Lambda 的代码目录拷进 cdk.out —— 一次后端栈合成要拷
 *  上万个文件，这个文件合成五次，/tmp（tmpfs）的 inode 会被吃光（2026-10-29 本机实测 ENOSPC）。 */
function backendPool(mfaMode?: string): { MfaConfiguration: Json; EnabledMfas: Json } {
  const context: Record<string, unknown> = { "aws:cdk:disable-asset-staging": true };
  if (mfaMode !== undefined) context.mfaMode = mfaMode;
  const app = new cdk.App({ context });
  const stack = new NotiOpsBackendStack(app, "MfaTestBackend", { env: { account: "111122223333", region: "us-east-1" } });
  const p = userPoolOf(Template.fromStack(stack).toJSON());
  return { MfaConfiguration: p.MfaConfiguration, EnabledMfas: p.EnabledMfas };
}

const oneClick: Json = (() => {
  const app = new cdk.App();
  const stack = new NotiOpsWebChatStandaloneStack(app, "MfaTestOneClick", {
    synthesizer: new cdk.DefaultStackSynthesizer({ generateBootstrapVersionRule: false }),
  });
  return Template.fromStack(stack).toJSON();
})();

/** 按参数值解一键模板里的 Ref / Fn::If / Fn::Equals（只覆盖这里用到的形状），NoValue → undefined。 */
function resolve(v: Json, params: Record<string, string>): Json {
  if (Array.isArray(v)) return v.map((x) => resolve(x, params)).filter((x) => x !== undefined);
  if (v && typeof v === "object") {
    if (typeof v.Ref === "string") {
      if (v.Ref === "AWS::NoValue") return undefined;
      if (v.Ref in params) return params[v.Ref];
      throw new Error(`unresolved Ref ${v.Ref}`);
    }
    if (Array.isArray(v["Fn::If"])) {
      const [cond, a, b] = v["Fn::If"];
      return resolve(cond in conditions(params) && conditions(params)[cond] ? a : b, params);
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, params)]));
  }
  return v;
}
function conditions(params: Record<string, string>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [id, c] of Object.entries<Json>(oneClick.Conditions || {})) {
    const eq = c["Fn::Equals"];
    if (Array.isArray(eq) && eq[0]?.Ref === "MfaMode") out[id] = params.MfaMode === eq[1];
  }
  return out;
}

describe("parseMfaMode", () => {
  it("default is OPTIONAL", () => {
    expect(DEFAULT_MFA_MODE).toBe("OPTIONAL");
    expect(parseMfaMode(undefined)).toBe("OPTIONAL");
    expect(parseMfaMode("")).toBe("OPTIONAL");
  });
  it("accepts the three values case-insensitively", () => {
    for (const m of MFA_MODES) {
      expect(parseMfaMode(m)).toBe(m);
      expect(parseMfaMode(m.toLowerCase())).toBe(m);
    }
  });
  it("rejects anything else instead of silently picking a mode", () => {
    expect(() => parseMfaMode("ON")).toThrow(/mfaMode must be one of/);
    expect(() => parseMfaMode("REQUIRE")).toThrow(/mfaMode must be one of/);
  });
});

describe("one-click template: MfaMode parameter", () => {
  const p = oneClick.Parameters.MfaMode;
  it("exists with the three values and defaults to OPTIONAL", () => {
    expect(p.Type).toBe("String");
    expect(p.AllowedValues).toEqual(["OFF", "OPTIONAL", "REQUIRED"]);
    expect(p.Default).toBe("OPTIONAL");
  });
  it("is in the Security parameter group and has a label", () => {
    const iface = oneClick.Metadata["AWS::CloudFormation::Interface"];
    const group = iface.ParameterGroups.find((g: Json) => /^Security/.test(g.Label.default));
    expect(group.Parameters).toContain("MfaMode");
    expect(iface.ParameterLabels.MfaMode.default).toMatch(/Two-step verification/);
  });
  it("description is ASCII (customer-facing text)", () => {
    expect(/^[\x20-\x7e]+$/.test(p.Description)).toBe(true);
  });
});

describe("both deployment paths give the user pool the same MFA settings", () => {
  for (const mode of MFA_MODES) {
    it(`${mode}`, () => {
      const viaB = backendPool(mode);
      const viaA = resolve({ MfaConfiguration: userPoolOf(oneClick).MfaConfiguration, EnabledMfas: userPoolOf(oneClick).EnabledMfas },
        { MfaMode: mode });
      expect(viaA).toEqual(viaB);
      // 钉死具体值：两边一起写错也要红
      expect(viaB.MfaConfiguration).toBe({ OFF: "OFF", OPTIONAL: "OPTIONAL", REQUIRED: "ON" }[mode]);
      expect(viaB.EnabledMfas).toEqual(mode === "OFF" ? undefined : ["SOFTWARE_TOKEN_MFA"]);
    });
  }
  it("setup.sh path without -c mfaMode gets the default (OPTIONAL)", () => {
    expect(backendPool(undefined)).toEqual({ MfaConfiguration: "OPTIONAL", EnabledMfas: ["SOFTWARE_TOKEN_MFA"] });
  });
  it("setup.sh path with an invalid -c mfaMode fails the synth", () => {
    expect(() => backendPool("YES")).toThrow(/mfaMode must be one of/);
  });
});

describe("the BFF can read and reset MFA (both paths share web-chat-core)", () => {
  const NEED = ["cognito-idp:GetUserPoolMfaConfig", "cognito-idp:AdminGetUser",
                "cognito-idp:AdminDeleteSoftwareToken", "cognito-idp:AdminUserGlobalSignOut"];
  it("one-click BFF role has the four actions on the user pool", () => {
    const actions = new Set<string>();
    for (const r of Object.values<Json>(oneClick.Resources)) {
      if (r.Type !== "AWS::IAM::Policy" && r.Type !== "AWS::IAM::ManagedPolicy") continue;
      const roles = JSON.stringify(r.Properties.Roles || []);
      if (!roles.includes("WebChatBff")) continue;
      for (const st of [].concat(r.Properties.PolicyDocument.Statement)) {
        const s: Json = st;
        if (JSON.stringify(s.Resource).includes("userpool/")) for (const a of [].concat(s.Action)) actions.add(a);
      }
    }
    for (const a of NEED) expect(actions.has(a)).toBe(true);
    // 重置只删验证器；「强制」档下只关偏好的老做法不管用，BFF 也就不该再有这个动作
    expect(actions.has("cognito-idp:AdminSetUserMFAPreference")).toBe(false);
  });
});
