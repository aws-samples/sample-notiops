/**
 * 账户接入 (Organizations) — 一键接入页面。
 *
 * 前提：org 模式部署（./setup.sh --multi-account 且组织管理账号/委派管理员）。
 * 流程：列出组织内 ACTIVE 账号 → 选账号 + 采集 Region → 一键接入
 *   （后端经 CloudFormation StackSets 向该账号下发只读角色 + 事件转发，
 *    完成后自动登记进「目标账户」并启用）。
 * 非 org 模式部署时后端返回 400，本页展示引导信息。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  FormField,
  Header,
  Input,
  Modal,
  SpaceBetween,
  Spinner,
  StatusIndicator,
  Table,
} from "@cloudscape-design/components";
import {
  getOrgAccounts,
  getOrgOnboardStatus,
  orgOnboardAccount,
} from "../api";

interface OrgAccountItem {
  account_id: string;
  name: string;
  email: string;
  onboarded: boolean;
  enabled: boolean;
  org_onboard_status: string;
  regions: string[];
}

const POLL_INTERVAL_MS = 5000;

export default function OrgOnboarding() {
  const [items, setItems] = useState<OrgAccountItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [orgModeDisabled, setOrgModeDisabled] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  // 接入弹窗
  const [target, setTarget] = useState<OrgAccountItem | null>(null);
  const [regionsInput, setRegionsInput] = useState("us-east-1");
  const [submitting, setSubmitting] = useState(false);

  // operation_id -> account_id 轮询表
  const pollingRef = useRef<Map<string, string>>(new Map());

  const load = useCallback(async () => {
    setErrorMsg("");
    try {
      const resp = await getOrgAccounts();
      setItems(resp.data.items ?? []);
      setOrgModeDisabled(false);
    } catch (e: unknown) {
      const err = e as { response?: { status?: number; data?: { message?: string } } };
      if (err.response?.status === 400) {
        setOrgModeDisabled(true);
      } else {
        setErrorMsg(err.response?.data?.message ?? "加载失败，请稍后重试");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 轮询进行中的 StackSet operation
  useEffect(() => {
    const timer = setInterval(async () => {
      const entries = [...pollingRef.current.entries()];
      if (entries.length === 0) return;
      for (const [operationId, accountId] of entries) {
        try {
          const resp = await getOrgOnboardStatus(operationId, accountId);
          const status = resp.data.status as string;
          if (status !== "RUNNING" && status !== "QUEUED") {
            pollingRef.current.delete(operationId);
            void load();
          }
        } catch {
          pollingRef.current.delete(operationId);
        }
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const submitOnboard = async () => {
    if (!target) return;
    const regions = regionsInput
      .split(/[,;\s]+/)
      .map((r) => r.trim())
      .filter(Boolean);
    if (regions.length === 0) {
      setErrorMsg("请至少填写一个采集 Region");
      return;
    }
    setSubmitting(true);
    setErrorMsg("");
    try {
      const resp = await orgOnboardAccount({
        account_id: target.account_id,
        regions,
      });
      pollingRef.current.set(resp.data.operation_id, target.account_id);
      setTarget(null);
      void load();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string } } };
      setErrorMsg(err.response?.data?.message ?? "接入请求失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

  const statusCell = (item: OrgAccountItem) => {
    if (item.org_onboard_status === "PROVISIONING") {
      return <StatusIndicator type="in-progress">接入中（StackSet 下发）</StatusIndicator>;
    }
    if (item.org_onboard_status === "FAILED") {
      return <StatusIndicator type="error">接入失败</StatusIndicator>;
    }
    if (item.onboarded && item.enabled) {
      return <StatusIndicator type="success">已接入</StatusIndicator>;
    }
    if (item.onboarded) {
      return <StatusIndicator type="stopped">已登记（未启用）</StatusIndicator>;
    }
    return <StatusIndicator type="pending">未接入</StatusIndicator>;
  };

  if (orgModeDisabled) {
    return (
      <SpaceBetween size="l">
        <Header variant="h1">账户接入 (Organizations)</Header>
        <Alert type="info" header="当前部署未启用 Organizations 多账号模式">
          <Box variant="p">
            一键接入需要在<strong>组织管理账号</strong>（或 StackSets 委派管理员账号）以多账号模式部署：
          </Box>
          <Box variant="code">./setup.sh --multi-account</Box>
          <Box variant="p">
            非组织场景下，请在目标账号手动部署{" "}
            <Box variant="code" display="inline">infra/member-account-onboarding.yaml</Box>{" "}
            后，到「设置 → 目标账户」手动登记 Role ARN。
          </Box>
        </Alert>
      </SpaceBetween>
    );
  }

  return (
    <SpaceBetween size="l">
      {errorMsg && (
        <Alert type="error" dismissible onDismiss={() => setErrorMsg("")}>
          {errorMsg}
        </Alert>
      )}

      <Table
        header={
          <Header
            variant="h1"
            description="组织内账号一键接入：自动下发只读采集角色 + DevOps/PHD 事件转发（CloudFormation StackSets），完成后自动登记并启用。"
            counter={`(${items.length})`}
            actions={
              <Button iconName="refresh" onClick={() => void load()} disabled={loading}>
                刷新
              </Button>
            }
          >
            账户接入 (Organizations)
          </Header>
        }
        columnDefinitions={[
          { id: "account_id", header: "账号 ID", cell: (i) => i.account_id },
          { id: "name", header: "账号名称", cell: (i) => i.name || "-" },
          { id: "email", header: "Email", cell: (i) => i.email || "-" },
          { id: "status", header: "接入状态", cell: statusCell },
          {
            id: "regions",
            header: "采集 Region",
            cell: (i) =>
              i.regions?.length ? (
                <SpaceBetween direction="horizontal" size="xs">
                  {i.regions.map((r) => (
                    <Badge key={r} color="blue">{r}</Badge>
                  ))}
                </SpaceBetween>
              ) : (
                "-"
              ),
          },
          {
            id: "actions",
            header: "操作",
            cell: (i) =>
              i.org_onboard_status === "PROVISIONING" ? (
                <Spinner />
              ) : (
                <Button
                  variant={i.onboarded ? "normal" : "primary"}
                  disabled={i.onboarded && i.enabled}
                  onClick={() => {
                    setTarget(i);
                    setRegionsInput(i.regions?.join(",") || "us-east-1");
                  }}
                >
                  {i.org_onboard_status === "FAILED" ? "重试接入" : "一键接入"}
                </Button>
              ),
          },
        ]}
        items={items}
        loading={loading}
        loadingText="加载组织账号列表..."
        empty={<Box textAlign="center">组织内没有 ACTIVE 账号</Box>}
      />

      <Modal
        visible={target !== null}
        onDismiss={() => setTarget(null)}
        header={`一键接入账号 ${target?.account_id ?? ""}`}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setTarget(null)}>
                取消
              </Button>
              <Button variant="primary" loading={submitting} onClick={() => void submitOnboard()}>
                确认接入
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Alert type="info">
            将通过 CloudFormation StackSets 在目标账号创建：只读采集角色
            （notiops-idle-detection-role）、DevOps Agent 调查事件转发、PHD 事件转发。
            过程约 1-2 分钟，完成后自动启用采集。
          </Alert>
          <FormField
            label="采集 Region 列表"
            description="逗号分隔，如: us-east-1,ap-southeast-1"
          >
            <Input
              value={regionsInput}
              onChange={(e) => setRegionsInput(e.detail.value)}
              placeholder="us-east-1,ap-southeast-1"
            />
          </FormField>
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}
