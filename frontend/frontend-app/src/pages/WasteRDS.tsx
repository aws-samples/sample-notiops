/**
 * RDS 闲置资源报告页面。
 * 展示 RDS 特有的闲置指标列。
 */
import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Badge,
  Box,
  Button,
  Checkbox,
  ColumnLayout,
  Container,
  FormField,
  Header,
  Input,
  Modal,
  Pagination,
  Select,
  SpaceBetween,
  Spinner,
  Table,
  Textarea,
  type SelectProps,
} from "@cloudscape-design/components";
import { getWasteReportList, exportWasteReportCSV, addWhitelistBatch } from "../api";
import { errMsg } from "../utils/errMsg";

interface RDSWasteItem {
  id: number;
  instance_id: string;
  account_id: string;
  region: string;
  resource_type: string;
  instance_class: string;
  engine: string;
  idle_score: number;
  value_score: number;
  consecutive_low_days: number;
  estimated_monthly_savings: number;
  cpu_utilization: number | null;
  connections: number | null;
  free_storage_or_memory: number | null;
  peak_cpu_7d: number | null;
  read_iops: number | null;
  write_iops: number | null;
  allocated_storage_gb: number | null;
}

const ALL: SelectProps.Option = { label: "全部", value: "" };
const PAGE_SIZE_OPTIONS = [
  { label: "50 条/页", value: "50" },
  { label: "100 条/页", value: "100" },
  { label: "200 条/页", value: "200" },
  { label: "500 条/页", value: "500" },
];
const DEFAULT_PAGE_SIZE = 50;

export default function WasteRDS() {
  const navigate = useNavigate();
  const [allItems, setAllItems] = useState<RDSWasteItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [accountId, setAccountId] = useState("");
  const [region, setRegion] = useState<SelectProps.Option>(ALL);
  const [sortDesc, setSortDesc] = useState(true);
  const [selectedItems, setSelectedItems] = useState<RDSWasteItem[]>([]);
  const [showWhitelistModal, setShowWhitelistModal] = useState(false);
  const [whitelistReason, setWhitelistReason] = useState("");
  const [whitelistDays, setWhitelistDays] = useState("30");
  const [whitelistPermanent, setWhitelistPermanent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const resp = await getWasteReportList({ page: "1", page_size: "10000", resource_type: "rds" });
      const items = (resp.data.items ?? resp.data ?? []) as RDSWasteItem[];
      setAllItems(items);
    } catch (e) {
      console.error("Failed to load RDS waste report", errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  const regionOptions = useMemo(() => {
    const regions = [...new Set(allItems.map((i) => i.region))].sort();
    return [ALL, ...regions.map((r) => ({ label: r, value: r }))];
  }, [allItems]);

  const filtered = useMemo(() => {
    let items = [...allItems];
    if (accountId.trim()) items = items.filter((i) => i.account_id.includes(accountId.trim()));
    if (region.value) items = items.filter((i) => i.region === region.value);
    items.sort((a, b) => sortDesc
      ? (b.value_score || 0) - (a.value_score || 0)
      : (a.value_score || 0) - (b.value_score || 0));
    return items;
  }, [allItems, accountId, region, sortDesc]);

  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);
  const totalSavings = filtered.reduce((s, i) => s + (i.estimated_monthly_savings || 0), 0);

  const handleExport = async () => {
    try {
      const resp = await exportWasteReportCSV({ page: "1", page_size: "10000", resource_type: "rds" });
      const blob = new Blob([resp.data], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "rds_waste_report.csv"; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { console.error("CSV export failed", errMsg(e)); }
  };

  const handleBatchWhitelist = async () => {
    if (selectedItems.length === 0) return;
    if (!whitelistPermanent) {
      const days = parseInt(whitelistDays, 10);
      if (!Number.isInteger(days) || days <= 0) return;
    }
    setSubmitting(true);
    try {
      await addWhitelistBatch({
        items: selectedItems.map((item) => ({
          instance_id: item.instance_id,
          account_id: item.account_id,
          resource_type: item.resource_type,
        })),
        reason: whitelistReason,
        ...(whitelistPermanent ? {} : { expires_days: parseInt(whitelistDays, 10) }),
      });
      setShowWhitelistModal(false);
      setWhitelistReason("");
      setWhitelistDays("30");
      setWhitelistPermanent(false);
      setSelectedItems([]);
      fetchData();
    } catch { /* ignore */ }
    finally { setSubmitting(false); }
  };

  const columns = [
    { id: "instance_id", header: "实例 ID", cell: (item: RDSWasteItem) => item.instance_id, sortingField: "instance_id", width: 240 },
    { id: "account_id", header: "账户", cell: (item: RDSWasteItem) => item.account_id, width: 130 },
    { id: "region", header: "区域", cell: (item: RDSWasteItem) => item.region, width: 140 },
    { id: "instance_class", header: "规格", cell: (item: RDSWasteItem) => item.instance_class, width: 150 },
    { id: "engine", header: "引擎", cell: (item: RDSWasteItem) => item.engine, width: 100 },
    {
      id: "idle_score", header: "闲置评分", width: 100,
      cell: (item: RDSWasteItem) => <Badge color="red">{item.idle_score?.toFixed(1)}</Badge>,
    },
    {
      id: "value_score", header: "价值评分", width: 100,
      cell: (item: RDSWasteItem) => item.value_score?.toFixed(1) ?? "-",
    },
    {
      id: "consecutive_low_days", header: "连续低阈值天数", width: 130,
      cell: (item: RDSWasteItem) => item.consecutive_low_days,
    },
    {
      id: "cpu_utilization", header: "CPU 利用率 (%)", width: 120,
      cell: (item: RDSWasteItem) => item.cpu_utilization != null ? item.cpu_utilization.toFixed(2) : "-",
    },
    {
      id: "connections", header: "连接数", width: 90,
      cell: (item: RDSWasteItem) => item.connections ?? "-",
    },
    {
      id: "allocated_storage_gb", header: "分配存储 (GB)", width: 120,
      cell: (item: RDSWasteItem) => item.allocated_storage_gb != null ? item.allocated_storage_gb.toFixed(1) : "-",
    },
    {
      id: "read_iops", header: "Read IOPS", width: 100,
      cell: (item: RDSWasteItem) => item.read_iops != null ? item.read_iops.toFixed(1) : "-",
    },
    {
      id: "write_iops", header: "Write IOPS", width: 100,
      cell: (item: RDSWasteItem) => item.write_iops != null ? item.write_iops.toFixed(1) : "-",
    },
    {
      id: "estimated_monthly_savings", header: "预估月度节省 ($)", width: 130,
      cell: (item: RDSWasteItem) => item.estimated_monthly_savings != null ? `${item.estimated_monthly_savings.toFixed(2)}` : "-",
    },
  ];

  return (
    <SpaceBetween size="l">
      <Header variant="h1" actions={
        <SpaceBetween direction="horizontal" size="xs">
          {selectedItems.length > 0 && (
            <Button variant="normal" onClick={() => setShowWhitelistModal(true)}>
              加入白名单 ({selectedItems.length})
            </Button>
          )}
          <Button onClick={fetchData} iconName="refresh">刷新</Button>
          <Button onClick={handleExport} variant="primary">导出 CSV</Button>
        </SpaceBetween>
      } description="RDS 闲置检测 — 识别低利用率的 RDS 实例">
        RDS 闲置资源
      </Header>

      <Container>
        <ColumnLayout columns={3} variant="text-grid">
          <div><Box variant="awsui-key-label">RDS 闲置资源数</Box><Box variant="awsui-value-large">{filtered.length}</Box></div>
          <div><Box variant="awsui-key-label">预估总月度节省</Box><Box variant="awsui-value-large">${totalSavings.toFixed(2)}</Box></div>
          <div><Box variant="awsui-key-label">总数据量</Box><Box variant="awsui-value-large">{allItems.length}</Box></div>
        </ColumnLayout>
      </Container>

      <Container>
        <ColumnLayout columns={3}>
          <Input value={accountId} onChange={({ detail }) => { setAccountId(detail.value); setPage(1); }} placeholder="账户 ID" />
          <Select selectedOption={region} onChange={({ detail }) => { setRegion(detail.selectedOption); setPage(1); }} options={regionOptions} placeholder="区域"  expandToViewport/>
          <Select selectedOption={{ label: sortDesc ? "降序" : "升序", value: sortDesc ? "desc" : "asc" }}
            onChange={({ detail }) => setSortDesc(detail.selectedOption.value === "desc")}
            options={[{ label: "降序", value: "desc" }, { label: "升序", value: "asc" }]} placeholder="排序方向"  expandToViewport/>
        </ColumnLayout>
      </Container>

      {loading ? (
        <Box textAlign="center" padding="xxl"><Spinner size="large" /></Box>
      ) : (
        <Table items={paged} columnDefinitions={columns} variant="full-page" stickyHeader
          selectionType="multi"
          selectedItems={selectedItems}
          onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems)}
          trackBy={(item) => `${item.account_id}#${item.instance_id}`}
          onRowClick={({ detail }) => navigate(`/waste-report/detail/${detail.item.account_id}/${detail.item.instance_id}`)}
          empty={<Box textAlign="center" padding="xxl">暂无 RDS 闲置资源</Box>}
          header={<Header counter={`(${filtered.length})`}>RDS 闲置资源列表</Header>}
          pagination={
            <SpaceBetween direction="horizontal" size="xs">
              <Select
                selectedOption={PAGE_SIZE_OPTIONS.find((o) => o.value === String(pageSize)) ?? PAGE_SIZE_OPTIONS[0]}
                onChange={({ detail }) => { setPageSize(Number(detail.selectedOption.value)); setPage(1); }}
                options={PAGE_SIZE_OPTIONS}
               expandToViewport/>
              <Pagination currentPageIndex={page} pagesCount={Math.max(1, Math.ceil(filtered.length / pageSize))}
                onChange={({ detail }) => setPage(detail.currentPageIndex)} />
            </SpaceBetween>
          }
        />
      )}

      <Modal visible={showWhitelistModal} onDismiss={() => setShowWhitelistModal(false)}
        header="批量加入白名单"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setShowWhitelistModal(false)}>取消</Button>
              <Button variant="primary" loading={submitting} onClick={handleBatchWhitelist}>确认</Button>
            </SpaceBetween>
          </Box>
        }>
        <SpaceBetween size="m">
          <Box>即将把以下 <strong>{selectedItems.length}</strong> 个 RDS 实例加入白名单：</Box>
          <Box>
            {selectedItems.map((item) => (
              <div key={item.id} style={{ padding: "2px 0", fontSize: "13px" }}>• {item.instance_id} ({item.region})</div>
            ))}
          </Box>
          <Textarea value={whitelistReason} onChange={({ detail }) => setWhitelistReason(detail.value)}
            placeholder="请输入加入白名单的原因（可选）" rows={3} />
          <Checkbox checked={whitelistPermanent} onChange={({ detail }) => setWhitelistPermanent(detail.checked)}>
            永久白名单
          </Checkbox>
          {!whitelistPermanent && (
            <FormField label="有效天数" description="白名单过期后将自动恢复检测" constraintText="请输入正整数"
              errorText={whitelistDays && (!/^\d+$/.test(whitelistDays) || parseInt(whitelistDays, 10) <= 0) ? "请输入大于 0 的正整数" : undefined}>
              <Input value={whitelistDays} onChange={({ detail }) => setWhitelistDays(detail.value)} type="number" placeholder="30" />
            </FormField>
          )}
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}
