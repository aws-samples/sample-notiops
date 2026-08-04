/**
 * 白名单管理页面。
 * 支持多选批量移除、修改有效期。
 * 添加白名单只能通过闲置资源报告页面的批量操作完成。
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
  Table,
} from "@cloudscape-design/components";
import { getWhitelist, removeWhitelist, removeWhitelistBatch, updateWhitelistExpiry } from "../api";

interface WhitelistItem {
  instance_id: string;
  account_id: string;
  resource_type: string;
  reason: string | null;
  created_at: string;
  expires_at: string | null;
}

function formatRemaining(expiresAt: string | null): string {
  if (!expiresAt) return "永久";
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "已过期";
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
  return `${days} 天`;
}

export default function Whitelist() {
  const [items, setItems] = useState<WhitelistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedItems, setSelectedItems] = useState<WhitelistItem[]>([]);

  // 修改有效期弹窗
  const [showExpiryModal, setShowExpiryModal] = useState(false);
  const [expiryTarget, setExpiryTarget] = useState<WhitelistItem | null>(null);
  const [expiryDays, setExpiryDays] = useState("30");
  const [updatingExpiry, setUpdatingExpiry] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await getWhitelist();
      setItems(res.data.items ?? res.data ?? []);
    } catch { setItems([]); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchData(); }, []);

  const handleRemove = async (item: WhitelistItem) => {
    try {
      await removeWhitelist({ instance_id: item.instance_id, account_id: item.account_id });
      setSelectedItems([]);
      fetchData();
    } catch { /* ignore */ }
  };

  const handleBatchRemove = async () => {
    if (selectedItems.length === 0) return;
    try {
      await removeWhitelistBatch(selectedItems.map((i) => ({ instance_id: i.instance_id, account_id: i.account_id })));
      setSelectedItems([]);
      fetchData();
    } catch { /* ignore */ }
  };

  const openExpiryModal = (item: WhitelistItem) => {
    setExpiryTarget(item);
    setExpiryDays("30");
    setShowExpiryModal(true);
  };

  const handleUpdateExpiry = async () => {
    if (!expiryTarget) return;
    const days = parseInt(expiryDays, 10);
    if (!Number.isInteger(days) || days <= 0) return;
    setUpdatingExpiry(true);
    try {
      await updateWhitelistExpiry({ instance_id: expiryTarget.instance_id, account_id: expiryTarget.account_id, expires_days: days });
      setShowExpiryModal(false);
      setExpiryTarget(null);
      fetchData();
    } catch { /* ignore */ }
    finally { setUpdatingExpiry(false); }
  };

  const handleSetPermanent = async () => {
    if (!expiryTarget) return;
    setUpdatingExpiry(true);
    try {
      await updateWhitelistExpiry({ instance_id: expiryTarget.instance_id, account_id: expiryTarget.account_id, expires_days: null });
      setShowExpiryModal(false);
      setExpiryTarget(null);
      fetchData();
    } catch { /* ignore */ }
    finally { setUpdatingExpiry(false); }
  };

  if (loading) return <Box textAlign="center" padding="xxxl"><Spinner size="large" /></Box>;

  return (
    <SpaceBetween size="l">
      <Header variant="h1"
        description="如需添加白名单，请在闲置资源报告页面选择实例后批量操作"
        actions={
          selectedItems.length > 0 ? (
            <Button onClick={handleBatchRemove}>批量移除 ({selectedItems.length})</Button>
          ) : undefined
        }
      >
        白名单管理
      </Header>

      <Table items={items}
        selectionType="multi"
        selectedItems={selectedItems}
        onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems)}
        trackBy={(e) => `${e.account_id}#${e.instance_id}`}
        columnDefinitions={[
          { id: "instance_id", header: "实例 ID", cell: (e) => e.instance_id },
          { id: "account_id", header: "账户 ID", cell: (e) => e.account_id },
          { id: "resource_type", header: "资源类型", cell: (e) => e.resource_type.toUpperCase() },
          { id: "reason", header: "原因", cell: (e) => e.reason ?? "-" },
          { id: "remaining", header: "剩余有效期", cell: (e) => (
            <Button variant="inline-link" onClick={() => openExpiryModal(e)}>
              {formatRemaining(e.expires_at)}
            </Button>
          )},
          { id: "created_at", header: "创建时间", cell: (e) => e.created_at },
          { id: "actions", header: "操作", cell: (e) => (
            <Button variant="link" onClick={() => handleRemove(e)}>移除</Button>
          )},
        ]}
        empty={<Box textAlign="center">暂无白名单</Box>}
      />

      <Modal visible={showExpiryModal} onDismiss={() => setShowExpiryModal(false)}
        header="修改有效期"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={handleSetPermanent} loading={updatingExpiry}>设为永久</Button>
              <Button variant="primary" loading={updatingExpiry} onClick={handleUpdateExpiry}
                disabled={!expiryDays || !/^\d+$/.test(expiryDays) || parseInt(expiryDays, 10) <= 0}>
                确认
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <FormField label="实例 ID">
            <Input value={expiryTarget?.instance_id ?? ""} disabled />
          </FormField>
          <FormField label="新的有效天数" description="从现在起计算" constraintText="请输入正整数"
            errorText={expiryDays && (!/^\d+$/.test(expiryDays) || parseInt(expiryDays, 10) <= 0) ? "请输入大于 0 的正整数" : undefined}>
            <Input value={expiryDays} onChange={({ detail }) => setExpiryDays(detail.value)} type="number" placeholder="30" />
          </FormField>
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}
