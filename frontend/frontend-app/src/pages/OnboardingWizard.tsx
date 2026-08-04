/**
 * DevOps Agent 上车向导 — Cloudscape Wizard + Modal
 *
 * 4 步引导式上车流程：生成模板 → 回填 Payload → 测试连接 → 启用
 * 根据账户 onboarding_status 自动跳转到正确步骤。
 *
 * spec: devops-agent-onboarding-wizard
 */
import { useEffect, useState, useCallback } from "react";
import {
  Alert,
  Box,
  Button,
  CopyToClipboard,
  FormField,
  KeyValuePairs,
  Link,
  Modal,
  SpaceBetween,
  Spinner,
  StatusIndicator,
  Textarea,
  Wizard,
} from "@cloudscape-design/components";
import {
  generateOnboardingTemplate,
  saveOnboardingPayload,
  testDevopsAgentConnection,
  enableDevopsAgentAccount,
} from "../api";
import {
  validatePayload,
  getInitialStep,
  normalizeSteps,
  type StepResult,
} from "../utils/onboardingUtils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AccountItem {
  account_id: string;
  account_alias: string | null;
  agent_space_id: string | null;
  agent_space_arn: string | null;
  trigger_role_arn: string | null;
  region: string;
  onboarding_status: string;
  enabled: boolean;
  last_test_at: string | null;
  last_test_result: string | null;
  last_test_error: string | null;
  related_business_accounts: string[] | null;
  template_generated_at: string | null;
}

interface OnboardingWizardProps {
  account: AccountItem;
  visible: boolean;
  onDismiss: () => void;
  onComplete: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function OnboardingWizard({
  account,
  visible,
  onDismiss,
  onComplete,
}: OnboardingWizardProps) {
  // --- Step index ---
  const [activeStepIndex, setActiveStepIndex] = useState(() =>
    getInitialStep(account)
  );

  // --- Step 1: 生成模板 ---
  const [templateResult, setTemplateResult] = useState<{
    launch_stack_url?: string;
    presigned_url?: string;
  } | null>(null);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateError, setTemplateError] = useState("");

  // --- Step 2: 回填 Payload ---
  const [payloadInput, setPayloadInput] = useState("");
  const [payloadError, setPayloadError] = useState("");
  const [payloadSaving, setPayloadSaving] = useState(false);

  // --- Step 3: 测试连接 ---
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<{
    passed: boolean;
    steps: StepResult[];
  } | null>(null);
  const [testError, setTestError] = useState("");

  // --- Step 4: 启用 ---
  const [enableLoading, setEnableLoading] = useState(false);
  const [enableError, setEnableError] = useState("");

  // --- 预填已有数据 ---
  useEffect(() => {
    if (visible && account) {
      // 预填 Payload（如果已有数据）
      if (account.agent_space_id && account.agent_space_arn && account.trigger_role_arn) {
        const existing = JSON.stringify(
          {
            agentSpaceId: account.agent_space_id,
            agentSpaceArn: account.agent_space_arn,
            triggerRoleArn: account.trigger_role_arn,
          },
          null,
          2
        );
        setPayloadInput(existing);
      }
    }
  }, [visible, account]);

  // --- Step 3 自动触发测试 ---
  const runTest = useCallback(async () => {
    setTestLoading(true);
    setTestError("");
    setTestResult(null);
    try {
      const res = await testDevopsAgentConnection(account.account_id);
      const data = res.data;
      setTestResult({
        passed: data.passed,
        steps: normalizeSteps(data.steps ?? []),
      });
    } catch (e: any) {
      setTestError(e.userMessage || e?.response?.data?.message || String(e));
    } finally {
      setTestLoading(false);
    }
  }, [account.account_id]);

  useEffect(() => {
    if (activeStepIndex === 2 && visible) {
      runTest();
    }
  }, [activeStepIndex, visible, runTest]);

  // --- Handlers ---

  const handleGenerateTemplate = async () => {
    setTemplateLoading(true);
    setTemplateError("");
    setTemplateResult(null);
    try {
      const res = await generateOnboardingTemplate(account.account_id);
      setTemplateResult(res.data);
    } catch (e: any) {
      setTemplateError(e.userMessage || e?.response?.data?.message || String(e));
    } finally {
      setTemplateLoading(false);
    }
  };

  const handleSavePayload = async (): Promise<boolean> => {
    setPayloadError("");
    setPayloadSaving(true);
    try {
      await saveOnboardingPayload(account.account_id, payloadInput);
      return true;
    } catch (e: any) {
      setPayloadError(e.userMessage || e?.response?.data?.message || String(e));
      return false;
    } finally {
      setPayloadSaving(false);
    }
  };

  const handleEnable = async () => {
    setEnableLoading(true);
    setEnableError("");
    try {
      await enableDevopsAgentAccount(account.account_id);
      onComplete();
    } catch (e: any) {
      setEnableError(e.userMessage || e?.response?.data?.message || String(e));
    } finally {
      setEnableLoading(false);
    }
  };

  // --- Payload 实时校验 ---
  const payloadValidation = payloadInput.trim()
    ? validatePayload(payloadInput)
    : null;

  const payloadFieldError = payloadValidation
    ? payloadValidation.jsonError
      ? `JSON 格式不合法: ${payloadValidation.jsonError}`
      : payloadValidation.missingFields?.length
        ? `缺少必需字段: ${payloadValidation.missingFields.join(", ")}`
        : ""
    : "";

  // --- Navigation ---

  const handleNavigate = async (requestedStepIndex: number) => {
    // Step 2 → Step 3: 先保存 Payload
    if (activeStepIndex === 1 && requestedStepIndex === 2) {
      if (!payloadValidation?.valid) return;
      const saved = await handleSavePayload();
      if (!saved) return;
    }
    // Step 3 → Step 4: 仅当测试通过时允许
    if (activeStepIndex === 2 && requestedStepIndex === 3) {
      if (!testResult || !testResult.passed) return;
    }
    // Step 1 → Step 2: Payload 校验（如果有输入）
    if (activeStepIndex === 1 && requestedStepIndex > 1) {
      if (payloadInput.trim() && !payloadValidation?.valid) return;
    }
    setActiveStepIndex(requestedStepIndex);
  };

  const handleSubmit = () => {
    handleEnable();
  };

  // --- Render helpers ---

  const renderStep1 = () => (
    <SpaceBetween size="m">
      {templateError && (
        <Alert type="error" dismissible onDismiss={() => setTemplateError("")}>
          {templateError}
        </Alert>
      )}

      {account.template_generated_at && !templateResult && (
        <Alert type="info">
          模板已于 {account.template_generated_at.slice(0, 19).replace("T", " ")} 生成（Presigned URL 可能已过期）
        </Alert>
      )}

      {!templateResult && (
        <Button
          onClick={handleGenerateTemplate}
          loading={templateLoading}
          variant="primary"
        >
          {account.template_generated_at ? "重新生成模板" : "生成模板"}
        </Button>
      )}

      {templateResult && (
        <SpaceBetween size="m">
          <Alert type="success">模板已生成并上传 S3（1 小时内有效）</Alert>

          <FormField label="Launch Stack URL（推荐：发给客户点击一键部署）">
            <SpaceBetween size="xs" direction="horizontal">
              <Link href={templateResult.launch_stack_url || "#"} external>
                打开 CloudFormation Console
              </Link>
              <CopyToClipboard
                copyButtonAriaLabel="复制 Launch Stack URL"
                copySuccessText="已复制"
                copyErrorText="复制失败"
                textToCopy={templateResult.launch_stack_url || ""}
                variant="inline"
              />
            </SpaceBetween>
          </FormField>

          <FormField label="Presigned URL（CFN 模板文件下载）">
            <SpaceBetween size="xs" direction="horizontal">
              <Link href={templateResult.presigned_url || "#"} external>
                下载模板文件
              </Link>
              <CopyToClipboard
                copyButtonAriaLabel="复制 Presigned URL"
                copySuccessText="已复制"
                copyErrorText="复制失败"
                textToCopy={templateResult.presigned_url || ""}
                variant="inline"
              />
            </SpaceBetween>
          </FormField>

          <Alert type="info">
            将 Launch Stack URL 发给业务方，等待业务方完成 CFN 部署后，复制 OnboardingPayload JSON 进入下一步。
          </Alert>
        </SpaceBetween>
      )}
    </SpaceBetween>
  );

  const renderStep2 = () => (
    <SpaceBetween size="m">
      {payloadError && (
        <Alert type="error" dismissible onDismiss={() => setPayloadError("")}>
          {payloadError}
        </Alert>
      )}

      <FormField
        label="OnboardingPayload JSON"
        description="客户部署完 CFN 后从 Outputs 复制，包含 agentSpaceId / agentSpaceArn / triggerRoleArn"
        errorText={payloadFieldError}
      >
        <Textarea
          rows={10}
          value={payloadInput}
          onChange={(e) => setPayloadInput(e.detail.value)}
          placeholder='{"agentSpaceId": "...", "agentSpaceArn": "arn:aws:aidevops:...", "triggerRoleArn": "arn:aws:iam::..."}'
        />
      </FormField>

      {payloadSaving && <Spinner />}
    </SpaceBetween>
  );

  const renderStep3 = () => (
    <SpaceBetween size="m">
      {testError && (
        <Alert type="error" dismissible onDismiss={() => setTestError("")}>
          {testError}
        </Alert>
      )}

      {testLoading && (
        <Box textAlign="center" padding="l">
          <Spinner size="large" />
          <Box padding={{ top: "s" }}>正在执行 3 步连接验证...</Box>
        </Box>
      )}

      {testResult && (
        <SpaceBetween size="m">
          <Alert type={testResult.passed ? "success" : "error"}>
            {testResult.passed
              ? "全部 3 步通过 ✅"
              : "测试失败，请检查下方步骤详情"}
          </Alert>

          {testResult.steps.map((s) => (
            <Box key={s.step}>
              <StatusIndicator
                type={
                  s.passed === true
                    ? "success"
                    : s.passed === false
                      ? "error"
                      : "stopped"
                }
              >
                Step {s.step}: {s.name}
                {s.passed === null && " (未执行)"}
              </StatusIndicator>
              {s.error && (
                <Box padding={{ left: "l" }} color="text-status-error">
                  {s.error}
                </Box>
              )}
            </Box>
          ))}

          {!testResult.passed && (
            <Button onClick={runTest} loading={testLoading}>
              重新测试
            </Button>
          )}
        </SpaceBetween>
      )}
    </SpaceBetween>
  );

  const renderStep4 = () => (
    <SpaceBetween size="m">
      {enableError && (
        <Alert type="error" dismissible onDismiss={() => setEnableError("")}>
          {enableError}
        </Alert>
      )}

      <KeyValuePairs
        columns={2}
        items={[
          { label: "账户 ID", value: account.account_id },
          { label: "别名", value: account.account_alias || "-" },
          { label: "Region", value: account.region },
          { label: "Agent Space ID", value: account.agent_space_id || "-" },
        ]}
      />

      {enableLoading && <Spinner />}
    </SpaceBetween>
  );

  // --- Wizard steps ---

  const steps = [
    {
      title: "生成模板",
      description: "生成 CFN 模板并获取 Launch Stack URL",
      content: renderStep1(),
    },
    {
      title: "回填 Payload",
      description: "粘贴 OnboardingPayload JSON",
      content: renderStep2(),
      isOptional: false,
    },
    {
      title: "测试连接",
      description: "验证 Agent Space 连接与事件转发",
      content: renderStep3(),
    },
    {
      title: "启用",
      description: "确认并启用账户",
      content: renderStep4(),
    },
  ];

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      size="large"
      header={`上车向导 — ${account.account_alias || account.account_id}`}
    >
      <Wizard
        i18nStrings={{
          stepNumberLabel: (n) => `步骤 ${n}`,
          collapsedStepsLabel: (n, total) => `步骤 ${n}/${total}`,
          cancelButton: "取消",
          previousButton: "上一步",
          nextButton: "下一步",
          submitButton: "启用",
          optional: "可选",
        }}
        activeStepIndex={activeStepIndex}
        onNavigate={({ detail }) => handleNavigate(detail.requestedStepIndex)}
        onCancel={onDismiss}
        onSubmit={handleSubmit}
        isLoadingNextStep={
          (activeStepIndex === 1 && payloadSaving) || enableLoading
        }
        steps={steps}
        allowSkipTo={false}
      />
    </Modal>
  );
}
