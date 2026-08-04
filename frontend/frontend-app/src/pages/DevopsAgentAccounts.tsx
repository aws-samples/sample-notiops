/**
 * DevOps Agent 账户配置页面（R8.1, R8.2）。
 *
 * 展示已上车业务账户列表；支持新增向导 + 行操作（生成模板、回填 Payload、
 * 测试连接、启用/禁用、查看业务上下文）。
 *
 * spec: devops-agent-per-account-architecture
 */
import { useEffect, useState } from "react";
import {
  Box,
  Button,
  ButtonDropdown,
  Container,
  FormField,
  Header,
  Input,
  Link,
  Modal,
  Select,
  SpaceBetween,
  Spinner,
  StatusIndicator,
  Table,
  Textarea,
  Alert,
} from "@cloudscape-design/components";
import {
  getDevopsAgentAccounts,
  createDevopsAgentAccount,
  generateOnboardingTemplate,
  saveOnboardingPayload,
  testDevopsAgentConnection,
  enableDevopsAgentAccount,
  disableDevopsAgentAccount,
  deleteDevopsAgentAccount,
} from "../api";
import DevopsAgentContextModal from "./DevopsAgentContextModal";
import OnboardingWizard from "./OnboardingWizard";

interface AccountItem {
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

const REGION_OPTIONS = [
  { label: "US East (N. Virginia) — us-east-1", value: "us-east-1" },
  { label: "US West (Oregon) — us-west-2", value: "us-west-2" },
  { label: "Asia Pacific (Sydney) — ap-southeast-2", value: "ap-southeast-2" },
  { label: "Asia Pacific (Tokyo) — ap-northeast-1", value: "ap-northeast-1" },
  { label: "Europe (Frankfurt) — eu-central-1", value: "eu-central-1" },
  { label: "Europe (Ireland) — eu-west-1", value: "eu-west-1" },
];

const STATUS_INDICATOR: Record<string, { type: "success" | "warning" | "info" | "stopped" | "error"; label: string }> = {
  active: { type: "success", label: "已启用" },
  tested: { type: "info", label: "已测试" },
  deployed: { type: "info", label: "已部署" },
  pending: { type: "warning", label: "待部署" },
  disabled: { type: "stopped", label: "已禁用" },
};

export default function DevopsAgentAccounts() {
  const [items, setItems] = useState<AccountItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [showCreate, setShowCreate] = useState(false);
  const [createAccountId, setCreateAccountId] = useState("");
  const [createAlias, setCreateAlias] = useState("");
  const [createRegion, setCreateRegion] = useState("ap-northeast-1");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const [templateModalAccount, setTemplateModalAccount] = useState<string | null>(null);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateResult, setTemplateResult] = useState<{
    presigned_url?: string;
    launch_stack_url?: string;
  } | null>(null);

  const [payloadModalAccount, setPayloadModalAccount] = useState<string | null>(null);
  const [payloadJson, setPayloadJson] = useState("");
  const [payloadSaving, setPayloadSaving] = useState(false);
  const [payloadError, setPayloadError] = useState("");

  const [testResult, setTestResult] = useState<{ accountId: string; result: any } | null>(null);
  const [contextAccount, setContextAccount] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [wizardAccount, setWizardAccount] = useState<AccountItem | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await getDevopsAgentAccounts();
      setItems(res.data.items ?? []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const handleCreate = async () => {
    setCreateError("");
    if (!/^[0-9]{12}$/.test(createAccountId)) {
      setCreateError("account_id 必须是 12 位数字");
      return;
    }
    if (!createAlias.trim()) {
      setCreateError("account_alias 必填");
      return;
    }
    setCreating(true);
    try {
      await createDevopsAgentAccount({
        account_id: createAccountId,
        account_alias: createAlias,
        region: createRegion,
      });
      setShowCreate(false);
      setCreateAccountId("");
      setCreateAlias("");
      await fetchData();
    } catch (e: any) {
      setCreateError(e?.response?.data?.message ?? String(e));
    } finally {
      setCreating(false);
    }
  };

  const handleGenerateTemplate = async (accountId: string) => {
    setTemplateModalAccount(accountId);
    setTemplateResult(null);
    setTemplateLoading(true);
    try {
      const res = await generateOnboardingTemplate(accountId);
      setTemplateResult(res.data);
      await fetchData();
    } catch (e: any) {
      setTemplateResult({ presigned_url: "", launch_stack_url: "" });
      alert(`生成模板失败: ${e?.response?.data?.message ?? e}`);
    } finally {
      setTemplateLoading(false);
    }
  };

  const handleSavePayload = async () => {
    if (!payloadModalAccount) return;
    setPayloadError("");
    setPayloadSaving(true);
    try {
      await saveOnboardingPayload(payloadModalAccount, payloadJson);
      setPayloadModalAccount(null);
      setPayloadJson("");
      await fetchData();
    } catch (e: any) {
      setPayloadError(e?.response?.data?.message ?? String(e));
    } finally {
      setPayloadSaving(false);
    }
  };

  const handleTestConnection = async (accountId: string) => {
    setActionBusy(accountId + ":test");
    try {
      const res = await testDevopsAgentConnection(accountId);
      setTestResult({ accountId, result: res.data });
      await fetchData();
    } catch (e: any) {
      setTestResult({ accountId, result: { passed: false, error: e?.response?.data?.message ?? String(e) } });
    } finally {
      setActionBusy(null);
    }
  };

  const handleToggleEnabled = async (item: AccountItem) => {
    setActionBusy(item.account_id + ":toggle");
    try {
      if (item.enabled) {
        await disableDevopsAgentAccount(item.account_id);
      } else {
        await enableDevopsAgentAccount(item.account_id);
      }
      await fetchData();
    } catch (e: any) {
      alert(`操作失败: ${e?.response?.data?.message ?? e}`);
    } finally {
      setActionBusy(null);
    }
  };

  const handleDeleteAccount = async (accountId: string) => {
    if (!confirm(`确认删除账户 ${accountId}？此操作不可撤销。`)) return;
    setActionBusy(accountId + ":delete");
    try {
      await deleteDevopsAgentAccount(accountId);
      await fetchData();
    } catch (e: any) {
      alert(`删除失败: ${e?.response?.data?.message ?? e}`);
    } finally {
      setActionBusy(null);
    }
  };

  return (
    <Container header={<Header variant="h1" actions={<Button onClick={() => setShowCreate(true)} variant="primary">新增业务账户</Button>}>DevOps Agent 账户配置</Header>}>
      {loading ? <Spinner /> : (
        <Table
          columnDefinitions={[
            { id: "account_id", header: "账户 ID", cell: (i) => i.account_id },
            { id: "account_alias", header: "别名", cell: (i) => i.account_alias || "-" },
            { id: "region", header: "Region", cell: (i) => i.region },
            { id: "status", header: "状态", cell: (i) => {
              const s = STATUS_INDICATOR[i.onboarding_status] ?? { type: "info" as const, label: i.onboarding_status };
              return <StatusIndicator type={s.type}>{s.label}</StatusIndicator>;
            }},
            { id: "agent_space_id", header: "Agent Space ID", cell: (i) => i.agent_space_id
              ? <span title={i.agent_space_id} style={{ fontSize: "13px" }}>{i.agent_space_id.slice(0, 12)}…</span>
              : "-"
            },
            { id: "actions", header: "操作", cell: (i) => {
              const showWizard = !["active", "disabled"].includes(i.onboarding_status);
              const showIndividualOps = ["active", "disabled"].includes(i.onboarding_status);
              const items = [
                ...(showWizard ? [{ id: "wizard", text: "上车向导" }] : []),
                ...(showIndividualOps ? [
                  { id: "template", text: "生成模板" },
                  { id: "payload", text: "回填 Payload" },
                  { id: "test", text: "测试连接", disabled: actionBusy === i.account_id + ":test" },
                ] : []),
                {
                  id: "toggle",
                  text: i.enabled ? "禁用" : "启用",
                  disabled: (actionBusy === i.account_id + ":toggle") || (!i.enabled && i.onboarding_status !== "tested"),
                },
                { id: "context", text: "业务上下文" },
                {
                  id: "delete",
                  text: "删除",
                  disabled: i.onboarding_status === "active",
                },
              ];
              return (
              <ButtonDropdown
                items={items}
                onItemClick={({ detail }) => {
                  switch (detail.id) {
                    case "wizard": setWizardAccount(i); break;
                    case "template": handleGenerateTemplate(i.account_id); break;
                    case "payload": setPayloadModalAccount(i.account_id); break;
                    case "test": handleTestConnection(i.account_id); break;
                    case "toggle": handleToggleEnabled(i); break;
                    case "context": setContextAccount(i.account_id); break;
                    case "delete": handleDeleteAccount(i.account_id); break;
                  }
                }}
                loading={actionBusy?.startsWith(i.account_id + ":") ?? false}
                expandToViewport
              >
                操作
              </ButtonDropdown>
              );
            }},
          ]}
          items={items}
          trackBy="account_id"
          empty={<Box textAlign="center" color="inherit">暂无已配置账户</Box>}
        />
      )}

      {/* 新增向导 */}
      <Modal
        visible={showCreate}
        onDismiss={() => setShowCreate(false)}
        header="新增业务账户"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setShowCreate(false)}>取消</Button>
              <Button variant="primary" onClick={handleCreate} loading={creating}>创建</Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          {createError && <Alert type="error">{createError}</Alert>}
          <FormField label="AWS 账户 ID" description="12 位数字">
            <Input value={createAccountId} onChange={(e) => setCreateAccountId(e.detail.value)} />
          </FormField>
          <FormField label="账户别名" description="业务易读名字，如 '游戏1'，用于 IM 推送前缀">
            <Input value={createAlias} onChange={(e) => setCreateAlias(e.detail.value)} />
          </FormField>
          <FormField label="Agent Space Region" description="DevOps Agent 支持的 6 个 Region 之一，默认 System Region">
            <Select
              selectedOption={REGION_OPTIONS.find((o) => o.value === createRegion) ?? REGION_OPTIONS[3]}
              onChange={(e) => setCreateRegion(e.detail.selectedOption.value ?? "ap-northeast-1")}
              options={REGION_OPTIONS}
             expandToViewport/>
          </FormField>
          <Alert type="info" header="跨 Region 提醒">
            若所选 Region 与系统账户 Region 不同，调查摘要副本会写入系统账户 Region 的 RDS。请确认业务方同意此跨 Region 数据副本。
          </Alert>
        </SpaceBetween>
      </Modal>

      {/* 模板生成结果 */}
      <Modal
        visible={templateModalAccount !== null}
        onDismiss={() => setTemplateModalAccount(null)}
        header={`上车模板 — ${templateModalAccount}`}
        footer={<Box float="right"><Button onClick={() => setTemplateModalAccount(null)}>关闭</Button></Box>}
      >
        {templateLoading ? <Spinner /> : templateResult ? (
          <SpaceBetween size="m">
            <Alert type="success">模板已生成并上传 S3（1 小时内有效）</Alert>
            <FormField label="Launch Stack URL（推荐：发给客户点击一键部署）">
              <Link href={templateResult.launch_stack_url || "#"} external>打开 CloudFormation Console</Link>
            </FormField>
            <FormField label="Presigned URL（CFN 模板文件下载）">
              <Link href={templateResult.presigned_url || "#"} external>下载模板文件</Link>
            </FormField>
            <Alert type="info">客户部署完成后，复制 OnboardingPayload JSON 点"回填 Payload"按钮提交</Alert>
          </SpaceBetween>
        ) : null}
      </Modal>

      {/* 回填 Payload */}
      <Modal
        visible={payloadModalAccount !== null}
        onDismiss={() => setPayloadModalAccount(null)}
        header={`回填 OnboardingPayload — ${payloadModalAccount}`}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setPayloadModalAccount(null)}>取消</Button>
              <Button variant="primary" onClick={handleSavePayload} loading={payloadSaving}>保存</Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          {payloadError && <Alert type="error">{payloadError}</Alert>}
          <FormField
            label="OnboardingPayload JSON"
            description='客户部署完 CFN 后从 Outputs 复制，包含 agentSpaceId / agentSpaceArn / triggerRoleArn'
          >
            <Textarea rows={8} value={payloadJson} onChange={(e) => setPayloadJson(e.detail.value)} />
          </FormField>
        </SpaceBetween>
      </Modal>

      {/* 测试连接结果 */}
      <Modal
        visible={testResult !== null}
        onDismiss={() => setTestResult(null)}
        header={`测试连接 — ${testResult?.accountId}`}
        footer={<Box float="right"><Button onClick={() => setTestResult(null)}>关闭</Button></Box>}
      >
        {testResult && (
          <SpaceBetween size="m">
            <Alert type={testResult.result?.passed ? "success" : "error"}>
              {testResult.result?.passed ? "全部 3 步通过 ✅" : "测试失败，见下方步骤详情"}
            </Alert>
            {(testResult.result?.steps || []).map((s: any) => (
              <Box key={s.step}>
                <StatusIndicator type={s.passed ? "success" : "error"}>
                  Step {s.step}: {s.name}
                </StatusIndicator>
                {s.error && <Box padding={{ left: "l" }} color="text-status-error">{s.error}</Box>}
              </Box>
            ))}
          </SpaceBetween>
        )}
      </Modal>

      {/* 业务上下文 Modal */}
      {contextAccount && (
        <DevopsAgentContextModal
          accountId={contextAccount}
          onDismiss={() => setContextAccount(null)}
        />
      )}

      {/* 上车向导 */}
      {wizardAccount && (
        <OnboardingWizard
          account={wizardAccount}
          visible={wizardAccount !== null}
          onDismiss={() => setWizardAccount(null)}
          onComplete={() => {
            setWizardAccount(null);
            fetchData();
          }}
        />
      )}
    </Container>
  );
}
