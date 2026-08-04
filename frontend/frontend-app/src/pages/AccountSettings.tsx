/**
 * 目标账户管理页面。
 * 目标账户列表、添加/编辑/删除操作，支持配置 Role ARN、Region 列表和启用/禁用。
 */
import { useEffect, useState } from "react";
import {
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
  Toggle,
} from "@cloudscape-design/components";
import {
  getTargetAccounts,
  addTargetAccount,
  updateTargetAccount,
  deleteTargetAccount,
} from "../api";

interface AccountItem {
  account_id: string;
  role_arn: string;
  regions: string[];
  enabled: boolean;
  description: string | null;
}

const EMPTY_FORM = {
  account_id: "",
  role_arn: "",
  regions: "",
  enabled: true,
  description: "",
};

export default function AccountSettings() {
  const [items, setItems] = useState<AccountItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await getTargetAccounts();
      setItems(res.data.items ?? res.data ?? []);
    } catch { setItems([]); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchData(); }, []);

  const openCreate = () => {
    setEditId(null);
    setForm(EMPTY_FORM);
    setErrorMsg("");
    setShowModal(true);
  };

  const openEdit = (item: AccountItem) => {
    setEditId(item.account_id);
    setErrorMsg("");
    setForm({
      account_id: item.account_id,
      role_arn: item.role_arn,
      regions: (item.regions ?? []).join(", "),
      enabled: item.enabled,
      description: item.description ?? "",
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    setErrorMsg("");
    // 新增时检查重复账号
    if (editId == null && items.some((i) => i.account_id === form.account_id.trim())) {
      setErrorMsg(`账户 ${form.account_id.trim()} 已存在，请勿重复添加`);
      return;
    }

    // Region 验证：自动替换中文逗号、顿号，校验格式
    const regionPattern = /^[a-z]{2}(-[a-z]+-\d+)$/;
    const normalized = form.regions.replace(/[，、]/g, ",");
    const regionList = normalized.split(",").map((r) => r.trim()).filter(Boolean);
    if (regionList.length === 0) {
      setErrorMsg("请至少输入一个 Region");
      return;
    }
    const invalid = regionList.filter((r) => !regionPattern.test(r));
    if (invalid.length > 0) {
      setErrorMsg(`Region 格式不正确: ${invalid.join(", ")}，正确格式如 ap-northeast-1`);
      return;
    }

    setSaving(true);
    const data = {
      account_id: form.account_id,
      role_arn: form.role_arn,
      regions: regionList,
      enabled: form.enabled,
      description: form.description || null,
    };
    try {
      if (editId != null) await updateTargetAccount(editId, data);
      else await addTargetAccount(data);
      setShowModal(false);
      fetchData();
    } catch { /* ignore */ }
    finally { setSaving(false); }
  };

  const handleDelete = async (accountId: string) => {
    try { await deleteTargetAccount(accountId); fetchData(); }
    catch { /* ignore */ }
  };

  const set = (key: string, val: string | boolean) => setForm((f) => ({ ...f, [key]: val }));

  if (loading) return <Box textAlign="center" padding="xxxl"><Spinner size="large" /></Box>;

  return (
    <SpaceBetween size="l">
      <Header variant="h1" actions={<Button variant="primary" onClick={openCreate}>添加目标账户</Button>}>
        目标账户管理
      </Header>

      <Table items={items}
        columnDefinitions={[
          { id: "account_id", header: "账户 ID", cell: (e) => e.account_id },
          { id: "role_arn", header: "Role ARN", cell: (e) => e.role_arn },
          { id: "regions", header: "Region 列表", cell: (e) => (e.regions ?? []).join(", ") },
          { id: "enabled", header: "状态", cell: (e) => (
            <StatusIndicator type={e.enabled ? "success" : "stopped"}>
              {e.enabled ? "启用" : "禁用"}
            </StatusIndicator>
          )},
          { id: "description", header: "描述", cell: (e) => e.description ?? "-" },
          { id: "actions", header: "操作", cell: (e) => (
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => openEdit(e)}>编辑</Button>
              <Button variant="link" onClick={() => handleDelete(e.account_id)}>删除</Button>
            </SpaceBetween>
          )},
        ]}
        empty={<Box textAlign="center">暂无目标账户</Box>}
      />

      <Modal visible={showModal} onDismiss={() => setShowModal(false)}
        header={editId != null ? "编辑目标账户" : "添加目标账户"}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setShowModal(false)}>取消</Button>
              <Button variant="primary" loading={saving} disabled={!form.account_id || !form.role_arn} onClick={handleSave}>保存</Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          {errorMsg && (
            <Box color="text-status-error">{errorMsg}</Box>
          )}
          <FormField label="账户 ID">
            <Input value={form.account_id} onChange={({ detail }) => set("account_id", detail.value)} disabled={editId != null} />
          </FormField>
          <FormField label="Role ARN">
            <Input value={form.role_arn} onChange={({ detail }) => set("role_arn", detail.value)} placeholder="arn:aws:iam::123456789012:role/notiops-idle-detection-role" />
          </FormField>
          <FormField label="Region 列表" description="逗号分隔，例如: ap-northeast-1, us-east-1">
            <Input value={form.regions} onChange={({ detail }) => set("regions", detail.value)} />
          </FormField>
          <FormField label="启用">
            <Toggle checked={form.enabled} onChange={({ detail }) => set("enabled", detail.checked)} />
          </FormField>
          <FormField label="描述">
            <Input value={form.description} onChange={({ detail }) => set("description", detail.value)} />
          </FormField>
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}
