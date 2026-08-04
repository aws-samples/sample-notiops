/**
 * DevOps Agent 上车向导 — 纯函数工具集
 *
 * 包含 Payload 校验、状态机初始步骤计算、Steps 数组补全等逻辑。
 * 与 React 组件解耦，便于单元测试和 PBT 验证。
 */

// ---------------------------------------------------------------------------
// Payload 校验
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  jsonError?: string;
  missingFields?: string[];
}

const REQUIRED_FIELDS = [
  "agentSpaceId",
  "agentSpaceArn",
  "triggerRoleArn",
] as const;

/**
 * 校验 OnboardingPayload JSON 字符串。
 *
 * 三分支行为：
 * 1. JSON.parse 失败 → valid=false, jsonError 非空
 * 2. JSON 合法但缺少/空值必需字段 → valid=false, missingFields 列出缺失字段
 * 3. 三个必需字段均存在且非空 → valid=true
 *
 * 额外字段不影响校验结果。
 */
export function validatePayload(input: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (e) {
    return {
      valid: false,
      jsonError: e instanceof Error ? e.message : String(e),
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      valid: false,
      jsonError: "JSON 必须是一个对象",
    };
  }

  const obj = parsed as Record<string, unknown>;
  const missing: string[] = [];

  for (const field of REQUIRED_FIELDS) {
    const value = obj[field];
    if (value === undefined || value === null || value === "") {
      missing.push(field);
    } else if (typeof value === "string" && value.trim() === "") {
      missing.push(field);
    }
  }

  if (missing.length > 0) {
    return { valid: false, missingFields: missing };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// 状态机初始步骤计算
// ---------------------------------------------------------------------------

interface AccountForStep {
  onboarding_status: string;
  template_generated_at?: string | null;
}

/**
 * 根据账户状态计算 Wizard 初始步骤索引（0-based）。
 *
 * - pending → 0 (生成模板)
 * - deployed → 2 (测试连接)
 * - tested → 3 (启用)
 * - 其他 → 0 (兜底)
 */
export function getInitialStep(account: AccountForStep): number {
  switch (account.onboarding_status) {
    case "pending":
      return 0;
    case "deployed":
      return 2;
    case "tested":
      return 3;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Steps 数组补全
// ---------------------------------------------------------------------------

export interface StepResult {
  step: number;
  name: string;
  passed: boolean | null; // null = 未执行
  error?: string;
}

export const ALL_STEP_NAMES = [
  "AssumeRole",
  "GetAgentSpace",
  "PutEvents",
] as const;

/**
 * 将后端返回的 0-3 步 steps 数组补全为始终 3 步。
 *
 * - 已有步骤保持原样（passed 和 error 不变）
 * - 缺失步骤 passed=null（表示"未执行"）
 * - 输出按 step 编号 1、2、3 排序
 */
export function normalizeSteps(steps: StepResult[]): StepResult[] {
  const byStep = new Map<number, StepResult>();
  for (const s of steps) {
    byStep.set(s.step, s);
  }

  return ALL_STEP_NAMES.map((name, idx) => {
    const stepNum = idx + 1;
    const existing = byStep.get(stepNum);
    if (existing) {
      return existing;
    }
    return { step: stepNum, name, passed: null };
  });
}
