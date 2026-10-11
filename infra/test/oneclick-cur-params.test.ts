/**
 * 一键模板里 CUR / 成本 MCP 那几个参数的判据 —— 2026-10-10 发版前审查查出来的几处，全部读**合成出来的模板**。
 *
 *   · 跨账号（CurRoleArn）暂不支持：查询会跑在 CUR 账号、却带着只存在于本账号的 workgroup 名 ⇒ 每次都失败。
 *     模板必须在开栈时就拒掉，而不是部署出一个每次都失败的数据源。
 *   · workgroup 名是合成期的字面量（NotiOps-cost-mcp）⇒ 同账号同区两个栈撞名。要跟着 AWS::StackName 走。
 *   · ProvisionCur 不在「CUR 数据源」那一组里，控制台上以原始参数名孤零零地出现。
 *   · ArtifactBaseUrl 的描述写着「八个产物」、漏了 cur-provisioner.zip —— 照着做镜像的客户选 ProvisionCur=yes
 *     时 stager 404。这里直接拿 scripts/artifacts.py 的清单对，清单变了描述就必须跟着变。
 */
import * as fs from "fs";
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { NotiOpsWebChatStandaloneStack } from "../lib/notiops-webchat-standalone-stack";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const app = new cdk.App();
const stack = new NotiOpsWebChatStandaloneStack(app, "NotiOps", {
  synthesizer: new cdk.DefaultStackSynthesizer({ generateBootstrapVersionRule: false }),
});
const T: Json = Template.fromStack(stack).toJSON();
const R: Record<string, Json> = T.Resources;

describe("one-click CUR / cost MCP parameters", () => {
  it("refuses a CurRoleArn (cross-account CUR is not supported yet) at stack creation", () => {
    const rule = T.Rules?.CostMcpCrossAccountNotSupported;
    expect(rule).toBeDefined();
    expect(rule.RuleCondition).toBeUndefined(); // 无条件：填了就拒
    expect(rule.Assertions).toEqual([expect.objectContaining({
      Assert: { "Fn::Equals": [{ Ref: "CurRoleArn" }, ""] },
    })]);
  });

  it("CurTable requires CurBucketName -- CurRoleArn no longer satisfies it", () => {
    const a = T.Rules.CostMcpNeedsCurAccess.Assertions[0].Assert;
    expect(JSON.stringify(a)).toContain('"Ref":"CurBucketName"');
    expect(JSON.stringify(a)).not.toContain("CurRoleArn");
  });

  it("the cost MCP workgroup name follows the stack name, not the synth-time name", () => {
    const wgs = Object.values(R).filter((r: Json) => r.Type === "AWS::Athena::WorkGroup");
    expect(wgs).toHaveLength(1);
    const name = JSON.stringify((wgs[0] as Json).Properties.Name);
    expect(name).toContain('"Ref":"AWS::StackName"');
    expect(name).not.toContain("NotiOps-cost-mcp");
  });

  it("ProvisionCur sits in the CUR data-source group and has a label", () => {
    const iface = T.Metadata["AWS::CloudFormation::Interface"];
    const group = iface.ParameterGroups.find((g: Json) => g.Parameters.includes("CurTable"));
    expect(group.Parameters).toContain("ProvisionCur");
    expect(iface.ParameterLabels.ProvisionCur?.default).toBeTruthy();
  });

  it("the ArtifactBaseUrl description names every release artifact in scripts/artifacts.py", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "artifacts.py"), "utf8");
    const allBlock = src.slice(src.indexOf("ALL: tuple"), src.indexOf(")", src.indexOf("ALL: tuple")));
    const zips = [...allBlock.matchAll(/"([a-z0-9-]+\.zip)"/g)].map((m) => m[1]);
    expect(zips.length).toBeGreaterThanOrEqual(9);
    const desc: string = T.Parameters.ArtifactBaseUrl.Description;
    const missing = zips.filter((z) => !desc.includes(z));
    expect(missing).toEqual([]);
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
    expect(desc).toContain(`There are ${words[zips.length]} release files`);
  });

  it("every CfnParameter description stays ASCII (postprocess_template.py would reject it)", () => {
    const bad = Object.entries(T.Parameters as Record<string, Json>)
      .filter(([, p]) => /[^\x00-\x7F]/.test(String(p.Description ?? "")))
      .map(([k]) => k);
    expect(bad).toEqual([]);
  });
});
