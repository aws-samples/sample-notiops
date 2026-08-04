/**
 * 阈值配置管理页面。
 * 按资源类型 × 检测路径（闲置检测 / 容量优化）分组展示和编辑阈值。
 */
import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Container,
  FormField,
  Header,
  Input,
  Modal,
  SpaceBetween,
  Spinner,
  Tabs,
} from "@cloudscape-design/components";
import {
  getThresholdConfigs,
  updateThresholdConfig,
} from "../api";

interface ThresholdItem {
  resource_type: string;
  thresholds: Record<string, number>;
  description: string | null;
}

interface FieldDef {
  key: string;
  label: string;
  suffix?: string;
}

interface FieldGroup {
  groupLabel: string;
  fields: FieldDef[];
}

/** 每种资源类型的阈值字段定义，按路径分组 */
const THRESHOLD_GROUPS: Record<string, FieldGroup[]> = {
  rds: [
    {
      groupLabel: "闲置检测阈值（路径 A）",
      fields: [
        { key: "candidate_cpu", label: "候选 CPU 阈值", suffix: "%" },
        { key: "candidate_connections", label: "候选连接数阈值" },
        { key: "peak_cpu_veto", label: "峰值 CPU 否决阈值", suffix: "%" },
        { key: "iops", label: "IOPS 阈值" },
        { key: "write_iops", label: "写入 IOPS 阈值" },
      ],
    },
    {
      groupLabel: "容量优化阈值（路径 B）",
      fields: [
        { key: "free_storage_pct", label: "存储空闲率阈值" },
        { key: "cpu_max_veto", label: "CPU 最大值否决阈值", suffix: "%" },
      ],
    },
  ],
  elasticache: [
    {
      groupLabel: "闲置检测阈值（路径 A）",
      fields: [
        { key: "candidate_cpu", label: "候选 CPU 阈值", suffix: "%" },
        { key: "candidate_connections", label: "候选连接数阈值" },
        { key: "peak_cpu_veto", label: "峰值 CPU 否决阈值", suffix: "%" },
        { key: "evictions", label: "驱逐数阈值" },
        { key: "requests_sum", label: "请求总量阈值" },
        { key: "conn_max", label: "最大连接数阈值" },
      ],
    },
    {
      groupLabel: "容量优化阈值（路径 B）",
      fields: [
        { key: "swap_max_gb", label: "Swap 最大值阈值", suffix: "GB" },
        { key: "memory_util_max", label: "内存利用率上限", suffix: "%" },
      ],
    },
  ],
};

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  rds: "RDS",
  elasticache: "ElastiCache",
};

export default function ThresholdSettings() {
  const [items, setItems] = useState<ThresholdItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editItem, setEditItem] = useState<ThresholdItem | null>(null);
  const [editGroup, setEditGroup] = useState<FieldGroup | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await getThresholdConfigs();
      const raw = res.data.items ?? res.data ?? [];
      const parsed = raw.map((r: ThresholdItem) => ({
        ...r,
        thresholds: typeof r.thresholds === "string" ? JSON.parse(r.thresholds) : r.thresholds,
      }));
      setItems(parsed);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const openEdit = (item: ThresholdItem, group: FieldGroup) => {
    setEditItem(item);
    setEditGroup(group);
    const formData: Record<string, string> = {};
    for (const f of group.fields) {
      formData[f.key] = String(item.thresholds[f.key] ?? "");
    }
    formData.description = item.description ?? "";
    setForm(formData);
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!editItem || !editGroup) return;
    setSaving(true);
    // 合并：保留原有阈值，只更新当前编辑组的字段
    const thresholds: Record<string, number> = { ...editItem.thresholds };
    for (const f of editGroup.fields) {
      thresholds[f.key] = parseFloat(form[f.key] || "0");
    }
    try {
      await updateThresholdConfig(editItem.resource_type, {
        thresholds,
        description: form.description || editItem.description || null,
      });
      setShowModal(false);
      fetchData();
    } catch { /* ignore */ }
    finally { setSaving(false); }
  };

  const set = (key: string, val: string) => setForm((f) => ({ ...f, [key]: val }));

  if (loading) return <Box textAlign="center" padding="xxxl"><Spinner size="large" /></Box>;

  // 构建 Tabs：每个资源类型一个 Tab
  const tabs = items.map((item) => {
    const groups = THRESHOLD_GROUPS[item.resource_type] ?? [];
    const label = RESOURCE_TYPE_LABELS[item.resource_type] ?? item.resource_type.toUpperCase();
    return {
      id: item.resource_type,
      label,
      content: (
        <SpaceBetween size="l">
          {groups.map((group) => (
            <Container
              key={group.groupLabel}
              header={
                <Header variant="h3" actions={<Button onClick={() => openEdit(item, group)}>编辑</Button>}>
                  {group.groupLabel}
                </Header>
              }
            >
              <SpaceBetween size="s">
                {group.fields.map((f) => (
                  <Box key={f.key}>
                    {f.label}: <b>{item.thresholds[f.key] ?? "-"}{f.suffix ?? ""}</b>
                  </Box>
                ))}
              </SpaceBetween>
            </Container>
          ))}
          {item.description && (
            <Box color="text-body-secondary">描述: {item.description}</Box>
          )}
        </SpaceBetween>
      ),
    };
  });

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description="按资源类型和检测路径分组管理阈值参数">
        阈值配置
      </Header>

      {items.length === 0 ? (
        <Box textAlign="center" color="text-body-secondary">暂无阈值配置</Box>
      ) : (
        <Tabs tabs={tabs} />
      )}

      {/* 编辑弹窗 */}
      <Modal
        visible={showModal}
        onDismiss={() => setShowModal(false)}
        header={`编辑 ${editItem ? (RESOURCE_TYPE_LABELS[editItem.resource_type] ?? editItem.resource_type) : ""} — ${editGroup?.groupLabel ?? ""}`}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setShowModal(false)}>取消</Button>
              <Button variant="primary" loading={saving} onClick={handleSave}>保存</Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          {editGroup && editGroup.fields.map((f) => (
            <FormField key={f.key} label={`${f.label}${f.suffix ? ` (${f.suffix})` : ""}`}>
              <Input
                type="number"
                value={form[f.key] ?? ""}
                onChange={({ detail }) => set(f.key, detail.value)}
              />
            </FormField>
          ))}
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}
