/**
 * CDK assertion tests for agent-model-config-integration spec.
 *
 * Validates:
 *  - SSM Parameter `/notiops/agent/model_id` exists as a writable String param
 *  - RemovalPolicy.DESTROY resolves to DeletionPolicy=Delete
 *  - 只有 API Lambda 角色能**写** model_id 参数（其它角色一律不得 PutParameter）
 *
 * ⚠️ 本文件在 2026-08-22 修过一次腐坏 —— 此前它从未被任何 CI job 跑过
 * （CI 里当时没有 infra 的 job），于是烂在了两个地方：
 *   ① 断言 SSM 默认值等于一个**写死的型号**（`global.anthropic.claude-opus-4-7`），
 *      目录默认模型一换就红。改为只断言"是 global.* CRIS 形态"，不钉具体型号。
 *   ② 断言 `AgentRuntimeRole` + Sid `SSMReadModelIdParam` —— 这两个标识符
 *      **全仓只存在于这个测试文件里**，NotiOpsBackendStack 从来没有这样的角色。
 *      所以那条 hasResourceProperties 恒红；更糟的是配套那条"不得有
 *      ssm:PutParameter"因为筛不到任何策略而**空转通过**（false green）。
 *      现改为按"谁能写 model_id 参数"正面枚举，并强制至少命中一条，
 *      空转即失败。
 */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { NotiOpsBackendStack } from "../lib/notiops-backend-stack";

describe("agent-model-config-integration — CDK assertions", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new NotiOpsBackendStack(app, "TestNotiOpsBackendStack", {
      env: { account: "123456789012", region: "ap-northeast-1" },
    });
    template = Template.fromStack(stack);
  });

  // ---------------------------------------------------------------------
  // SSM Parameter existence + defaults + RemovalPolicy.DESTROY
  // ---------------------------------------------------------------------

  test("SSM Parameter /notiops/agent/model_id exists with a global.* CRIS default", () => {
    // 不钉具体型号：目录默认模型会随版本更新（见 config/llm_catalog）。
    // 要守的是"有默认值且是 Global CRIS 形态"，不是"默认值是某一款"。
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/notiops/agent/model_id",
      Type: "String",
      Value: Match.stringLikeRegexp("^global\\..+"),
    });
  });

  test("SSM Parameter has DeletionPolicy=Delete (RemovalPolicy.DESTROY)", () => {
    template.hasResource("AWS::SSM::Parameter", {
      Properties: Match.objectLike({ Name: "/notiops/agent/model_id" }),
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
    });
  });

  // ---------------------------------------------------------------------
  // 写权限边界：只有 API Lambda 角色能改 model_id
  // ---------------------------------------------------------------------

  test("只有 API Lambda 角色对 model_id 参数有 ssm:PutParameter", () => {
    // 先拿到 model_id 参数的逻辑 ID —— 策略里是 { Ref: <logicalId> } 引用它。
    const params = template.findResources("AWS::SSM::Parameter", {
      Properties: Match.objectLike({ Name: "/notiops/agent/model_id" }),
    });
    const paramLogicalIds = Object.keys(params);
    expect(paramLogicalIds).toHaveLength(1);
    const paramRef = paramLogicalIds[0];

    const writers: string[] = [];
    for (const [, resource] of Object.entries(template.findResources("AWS::IAM::Policy"))) {
      const props = (resource as {
        Properties: {
          Roles?: Array<{ Ref?: string }>;
          PolicyDocument: { Statement: Array<{ Action?: unknown; Resource?: unknown }> };
        };
      }).Properties;
      for (const stmt of props.PolicyDocument.Statement) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        if (!actions.includes("ssm:PutParameter")) continue;
        // 该语句的 Resource 是否指向 model_id 这个参数（Fn::Join 里带 { Ref: paramRef }）
        if (!JSON.stringify(stmt.Resource ?? "").includes(`"Ref":"${paramRef}"`)) continue;
        for (const role of props.Roles ?? []) {
          if (role.Ref) writers.push(role.Ref);
        }
      }
    }

    // 空转即失败 —— 这是上一版 false green 的根因。
    expect(writers.length).toBeGreaterThan(0);
    for (const roleRef of writers) {
      expect(roleRef).toMatch(/LambdaExecutionRole/);
    }
  });
});
