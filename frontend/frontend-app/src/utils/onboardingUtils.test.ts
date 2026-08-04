/**
 * PBT 测试：DevOps Agent 上车向导纯函数
 *
 * 使用 fast-check 对 validatePayload / normalizeSteps / getInitialStep 进行
 * Property-Based Testing，验证正确性属性。
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  validatePayload,
  normalizeSteps,
  getInitialStep,
  ALL_STEP_NAMES,
  type StepResult,
} from "./onboardingUtils";

// =========================================================================
// Feature: devops-agent-onboarding-wizard, Property 2: Payload 校验函数正确性
// =========================================================================
describe("Property 2: validatePayload correctness", () => {
  it("非法 JSON 字符串 → valid=false, jsonError 非空", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => {
          try {
            JSON.parse(s);
            return false;
          } catch {
            return true;
          }
        }),
        (input) => {
          const result = validatePayload(input);
          expect(result.valid).toBe(false);
          expect(result.jsonError).toBeDefined();
          expect(typeof result.jsonError).toBe("string");
          expect(result.jsonError!.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("合法 JSON 但缺少必需字段 → valid=false, missingFields 包含缺失字段", () => {
    // 生成包含 0-2 个必需字段的对象（至少缺一个）
    const requiredFields = ["agentSpaceId", "agentSpaceArn", "triggerRoleArn"];

    fc.assert(
      fc.property(
        fc.record({
          includeFields: fc.subarray(requiredFields, {
            minLength: 0,
            maxLength: 2,
          }),
          extraFields: fc.dictionary(
            fc.string().filter((s) => !requiredFields.includes(s)),
            fc.string()
          ),
        }),
        ({ includeFields, extraFields }) => {
          const obj: Record<string, string> = { ...extraFields };
          for (const f of includeFields) {
            obj[f] = "some-non-empty-value";
          }
          const input = JSON.stringify(obj);
          const result = validatePayload(input);

          const missing = requiredFields.filter(
            (f) => !includeFields.includes(f)
          );
          expect(result.valid).toBe(false);
          expect(result.missingFields).toBeDefined();
          for (const m of missing) {
            expect(result.missingFields).toContain(m);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("空字符串值视为缺失字段", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "agentSpaceId",
          "agentSpaceArn",
          "triggerRoleArn"
        ),
        (emptyField) => {
          const obj: Record<string, string> = {
            agentSpaceId: "space-123",
            agentSpaceArn: "arn:aws:aidevops:us-east-1:123:space/abc",
            triggerRoleArn: "arn:aws:iam::123:role/trigger",
          };
          obj[emptyField] = "";
          const result = validatePayload(JSON.stringify(obj));
          expect(result.valid).toBe(false);
          expect(result.missingFields).toContain(emptyField);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("三个必需字段均存在且非空 → valid=true（额外字段不影响）", () => {
    fc.assert(
      fc.property(
        fc.record({
          agentSpaceId: fc.string({ minLength: 1 }),
          agentSpaceArn: fc.string({ minLength: 1 }),
          triggerRoleArn: fc.string({ minLength: 1 }),
        }),
        fc.dictionary(
          fc.string().filter(
            (s) =>
              !["agentSpaceId", "agentSpaceArn", "triggerRoleArn"].includes(s)
          ),
          fc.jsonValue()
        ),
        (required, extra) => {
          // 确保必需字段非空白
          if (
            required.agentSpaceId.trim() === "" ||
            required.agentSpaceArn.trim() === "" ||
            required.triggerRoleArn.trim() === ""
          ) {
            return; // 跳过空白字符串（由空字符串测试覆盖）
          }
          const obj = { ...extra, ...required };
          const result = validatePayload(JSON.stringify(obj));
          expect(result.valid).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// =========================================================================
// Feature: devops-agent-onboarding-wizard, Property 3: Steps 数组补全
// =========================================================================
describe("Property 3: normalizeSteps completeness", () => {
  const stepArbitrary: fc.Arbitrary<StepResult> = fc.record({
    step: fc.constantFrom(1, 2, 3),
    name: fc.constantFrom(...ALL_STEP_NAMES),
    passed: fc.constantFrom(true, false, null),
    error: fc.option(fc.string(), { nil: undefined }),
  });

  it("输出始终为 3 步", () => {
    fc.assert(
      fc.property(
        fc.array(stepArbitrary, { minLength: 0, maxLength: 3 }),
        (steps) => {
          const result = normalizeSteps(steps);
          expect(result).toHaveLength(3);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("输出按 step 编号 1、2、3 排序", () => {
    fc.assert(
      fc.property(
        fc.array(stepArbitrary, { minLength: 0, maxLength: 3 }),
        (steps) => {
          const result = normalizeSteps(steps);
          expect(result[0].step).toBe(1);
          expect(result[1].step).toBe(2);
          expect(result[2].step).toBe(3);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("已有步骤保持原样", () => {
    fc.assert(
      fc.property(
        fc.array(stepArbitrary, { minLength: 0, maxLength: 3 }),
        (steps) => {
          // 去重：同一 step 编号只保留最后一个
          const deduped = new Map<number, StepResult>();
          for (const s of steps) {
            deduped.set(s.step, s);
          }

          const result = normalizeSteps(steps);
          for (const [stepNum, original] of deduped) {
            const normalized = result.find((r) => r.step === stepNum);
            expect(normalized).toBeDefined();
            expect(normalized!.passed).toBe(original.passed);
            expect(normalized!.error).toBe(original.error);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("缺失步骤 passed===null", () => {
    fc.assert(
      fc.property(
        fc.array(stepArbitrary, { minLength: 0, maxLength: 3 }),
        (steps) => {
          const presentSteps = new Set(steps.map((s) => s.step));
          const result = normalizeSteps(steps);
          for (const r of result) {
            if (!presentSteps.has(r.step)) {
              expect(r.passed).toBeNull();
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// =========================================================================
// Feature: devops-agent-onboarding-wizard, Property 4: 状态机初始步骤计算
// =========================================================================
describe("Property 4: getInitialStep state machine", () => {
  it("pending → 0, deployed → 2, tested → 3, 其他 → 0", () => {
    fc.assert(
      fc.property(
        fc.record({
          onboarding_status: fc.constantFrom(
            "pending",
            "deployed",
            "tested",
            "active",
            "disabled"
          ),
          template_generated_at: fc.option(
            fc.constant("2024-06-15T10:30:00Z"),
            { nil: null }
          ),
        }),
        (account) => {
          const step = getInitialStep(account);
          switch (account.onboarding_status) {
            case "pending":
              expect(step).toBe(0);
              break;
            case "deployed":
              expect(step).toBe(2);
              break;
            case "tested":
              expect(step).toBe(3);
              break;
            default:
              expect(step).toBe(0);
              break;
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("未知 status 兜底返回 0", () => {
    fc.assert(
      fc.property(
        fc.string().filter(
          (s) =>
            !["pending", "deployed", "tested", "active", "disabled"].includes(s)
        ),
        (randomStatus) => {
          const step = getInitialStep({
            onboarding_status: randomStatus,
            template_generated_at: null,
          });
          expect(step).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});
