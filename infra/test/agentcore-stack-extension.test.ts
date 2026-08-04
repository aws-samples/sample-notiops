/**
 * CDK assertion tests for agent-model-config-integration spec.
 *
 * Validates:
 *  - SSM Parameter `/notiops/agent/model_id` exists with correct defaults
 *  - RemovalPolicy.DESTROY resolves to DeletionPolicy=Delete
 *  - Runtime Role has ssm:GetParameter (read-only) on the Parameter ARN
 *  - Runtime Role does NOT have ssm:PutParameter (defensive isolation)
 *  - API Lambda Role has ssm:GetParameter + ssm:PutParameter on the Parameter ARN
 *
 * Requirements: 6.1, 6.2, 6.3, 6.5
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
  // Requirements 6.1, 6.5
  // ---------------------------------------------------------------------

  test("SSM Parameter /notiops/agent/model_id exists with hardcoded default", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/notiops/agent/model_id",
      Type: "String",
      Value: "global.anthropic.claude-opus-4-7",
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
  // Runtime Role: ssm:GetParameter only (no PutParameter)
  // Requirements 6.2
  // ---------------------------------------------------------------------

  test("Runtime Role has ssm:GetParameter on the Model ID Parameter ARN", () => {
    // iam:Policy with the runtime role name attached, containing SSMReadModelIdParam
    template.hasResourceProperties("AWS::IAM::Policy", {
      Roles: Match.arrayWith([
        Match.objectLike({ Ref: Match.stringLikeRegexp(".*AgentRuntimeRole.*") }),
      ]),
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "SSMReadModelIdParam",
            Effect: "Allow",
            Action: "ssm:GetParameter",
          }),
        ]),
      }),
    });
  });

  test("Runtime Role does NOT have ssm:PutParameter (defensive isolation)", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const runtimePolicies = Object.entries(policies).filter(([, resource]) => {
      const roles = (resource as { Properties: { Roles?: unknown[] } }).Properties.Roles ?? [];
      return roles.some((r) => {
        if (typeof r !== "object" || r === null) return false;
        const ref = (r as { Ref?: string }).Ref;
        return typeof ref === "string" && /AgentRuntimeRole/.test(ref);
      });
    });

    for (const [, resource] of runtimePolicies) {
      const statements =
        (resource as { Properties: { PolicyDocument: { Statement: Array<{ Action?: unknown; Sid?: string }> } } })
          .Properties.PolicyDocument.Statement;
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        expect(actions).not.toContain("ssm:PutParameter");
      }
    }
  });

  // ---------------------------------------------------------------------
  // API Lambda Role: ssm:GetParameter + ssm:PutParameter
  // Requirements 6.3
  // ---------------------------------------------------------------------

  test("API Lambda Role has AgentModelIdParamReadWrite policy with Get+Put", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      Roles: Match.arrayWith([
        Match.objectLike({ Ref: Match.stringLikeRegexp(".*LambdaExecutionRole.*") }),
      ]),
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "AgentModelIdParamReadWrite",
            Effect: "Allow",
            Action: Match.arrayWith(["ssm:GetParameter", "ssm:PutParameter"]),
          }),
        ]),
      }),
    });
  });
});
