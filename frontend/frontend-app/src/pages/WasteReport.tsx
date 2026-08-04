/**
 * 闲置资源报告页面。
 * 支持多选实例批量加入白名单，带原因输入对话框。
 */
import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
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

interface WasteItem {
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
  allocated_storage_gb: number | null;
  cache_hits: number | null;
  cache_misses: number | null;
}

const ALL: SelectProps.Option = { label: "全部", value: "" };
const PAGE_SIZE_OPTIONS = [
  { label: "50 条/页", value: "50" },
  { label: "100 条/页", value: "100" },
  { label: "200 条/页", value: "200" },
  { label: "500 条/页", value: "500" },
];
const DEFAULT_PAGE_SIZE = 50;

export default function WasteReport() {
  const navigate = useNavigate();
  const [allItems, setAllItems] = useState<WasteItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [resourceType, setResourceType] = useState<SelectProps.Option>(ALL);
  const [accountId, setAccountId] = useState("");
  const [region, setRegion] = useState<SelectProps.Option>(ALL);
  const [sortBy, setSortBy] = useState("value_score");
  const [sortDesc, setSortDesc] = useState(true);

  // 多选
  const [selectedItems, setSelectedItems] = useState<WasteItem[]>([]);

  // 白名单对话框
  const [showWhitelistModal, setShowWhitelistModal] = useState(false);
  const [whitelistReason, setWhitelistReason] = useState("");
  const [whitelistDays, setWhitelistDays] = useState("30");
  const [whitelistPermanent, setWhitelistPermanent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const loadData = () => {
    setLoading(true);
    getWasteReportList({ page: "1", page_size: "10000" })
      .then((res) => setAllItems(res.data.items ?? res.data ?? []))
      .catch(() => setAllItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadData(); }, []);

  const regionOptions = useMemo(() => {
    const regions = [...new Set(allItems.map((i) => i.region).filter(Boolean))].sort();
    return [ALL, ...regions.map((r) => ({ label: r, value: r }))];
  }, [allItems]);

  const filteredItems = useMemo(() => {
    return allItems.filter((item) => {
      if (resourceType.value && item.resource_type !== resourceType.value) return false;
      if (accountId && !item.account_id.includes(accountId)) return false;
      if (region.value && item.region !== region.value) return false;
      return true;
    });
  }, [allItems, resourceType, accountId, region]);

  const sortedItems = useMemo(() => {
    return [...filteredItems].sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[sortBy];
      const bv = (b as unknown as Record<string, unknown>)[sortBy];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string") return sortDesc ? (bv as string).localeCompare(av) : av.localeCompare(bv as string);
      return sortDesc ? (bv as number) - (av as number) : (av as number) - (bv as number);
    });
  }, [filteredItems, sortBy, sortDesc]);

  const pagedItems = useMemo(() => {
    const start = (page - 1) * pageSize;
    return sortedItems.slice(start, start + pageSize);
  }, [sortedItems, page]);

  const totalSavings = useMemo(
    () => filteredItems.reduce((sum, i) => sum + (i.estimated_monthly_savings ?? 0), 0),
    [filteredItems],
  );

  const handleSort = (field: string) => {
    if (sortBy === field) setSortDesc((d) => !d);
    else { setSortBy(field); setSortDesc(true); }
    setPage(1);
  };

  const handleExport = async () => {
    try {
      const res = await exportWasteReportCSV({ page: "1", page_size: "10000" });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = "waste_report.csv";
      a.click();
      window.URL.revokeObjectURL(url);
    } catch { /* ignore */ }
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
      loadData();
    } catch { /* ignore */ }
    finally { setSubmitting(false); }
  };

  return (
    <SpaceBetween size="l">
      <Header variant="h1" actions={
        <SpaceBetween direction="horizontal" size="xs">
          {selectedItems.length > 0 && (
            <Button variant="normal" onClick={() => setShowWhitelistModal(true)}>
              加入白名单 ({selectedItems.length})
            </Button>
          )}
          <Button iconName="download" onClick={handleExport}>导出 CSV</Button>
        </SpaceBetween>
      }>
        闲置资源报告
      </Header>

      <Container header={<Header variant="h3">筛选条件</Header>}>
        <ColumnLayout columns={3}>
          <Select selectedOption={resourceType} onChange={({ detail }) => { setResourceType(detail.selectedOption); setPage(1); }}
            options={[ALL, { label: "RDS", value: "rds" }, { label: "ElastiCache", value: "elasticache" }]} placeholder="资源类型"  expandToViewport/>
          <Input value={accountId} onChange={({ detail }) => { setAccountId(detail.value); setPage(1); }} placeholder="账户 ID" />
          <Select selectedOption={region} onChange={({ detail }) => { setRegion(detail.selectedOption); setPage(1); }}
            options={regionOptions} placeholder="Region"  expandToViewport/>
        </ColumnLayout>
      </Container>

      <ColumnLayout columns={2} variant="text-grid">
        <Container><Box variant="awsui-key-label">闲置资源总数</Box><Box variant="h2">{filteredItems.length}</Box></Container>
        <Container><Box variant="awsui-key-label">预估总节省</Box><Box variant="h2" color="text-status-success">${totalSavings.toLocaleString("en-US", { minimumFractionDigits: 2 })}</Box></Container>
      </ColumnLayout>

      {loading ? (
        <Box textAlign="center" padding="xxxl"><Spinner size="large" /></Box>
      ) : (
        <>
          <Table items={pagedItems}
            selectionType="multi"
            selectedItems={selectedItems}
            onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems)}
            trackBy={(item) => `${item.account_id}#${item.instance_id}`}
            onRowClick={({ detail }) => {
              if ((detail as unknown as Record<string, unknown>).target !== "selection") {
                navigate(`/waste-report/${detail.item.account_id}/${detail.item.instance_id}`);
              }
            }}
            sortingColumn={{ sortingField: sortBy }}
            sortingDescending={sortDesc}
            onSortingChange={({ detail }) => handleSort(detail.sortingColumn.sortingField!)}
            columnDefinitions={[
              { id: "instance_id", header: "实例 ID", cell: (e) => e.instance_id, sortingField: "instance_id" },
              { id: "account_id", header: "账户 ID", cell: (e) => e.account_id, sortingField: "account_id" },
              { id: "region", header: "Region", cell: (e) => e.region, sortingField: "region" },
              { id: "resource_type", header: "类型", cell: (e) => (e.resource_type ?? "").toUpperCase(), sortingField: "resource_type" },
              { id: "instance_class", header: "规格", cell: (e) => e.instance_class, sortingField: "instance_class" },
              { id: "engine", header: "引擎", cell: (e) => e.engine },
              { id: "idle_score", header: "闲置评分", cell: (e) => e.idle_score?.toFixed(1), sortingField: "idle_score" },
              { id: "value_score", header: "价值评分", cell: (e) => e.value_score?.toFixed(1), sortingField: "value_score" },
              { id: "consecutive_low_days", header: "连续低阈值天数", cell: (e) => e.consecutive_low_days, sortingField: "consecutive_low_days" },
              { id: "savings", header: "预估月度节省", cell: (e) => `$${e.estimated_monthly_savings?.toFixed(2)}`, sortingField: "estimated_monthly_savings" },
              { id: "allocated_storage_gb", header: "分配存储 (GB)", cell: (e) => e.allocated_storage_gb?.toFixed(1) ?? "-", sortingField: "allocated_storage_gb" },
              { id: "cache_hits", header: "Cache Hits", cell: (e) => e.cache_hits?.toLocaleString() ?? "-", sortingField: "cache_hits" },
              { id: "cache_misses", header: "Cache Misses", cell: (e) => e.cache_misses?.toLocaleString() ?? "-", sortingField: "cache_misses" },
            ]}
            empty={<Box textAlign="center">暂无闲置资源</Box>}
          />
          <SpaceBetween direction="horizontal" size="xs">
            <Select
              selectedOption={PAGE_SIZE_OPTIONS.find((o) => o.value === String(pageSize)) ?? PAGE_SIZE_OPTIONS[0]}
              onChange={({ detail }) => { setPageSize(Number(detail.selectedOption.value)); setPage(1); }}
              options={PAGE_SIZE_OPTIONS}
             expandToViewport/>
            <Pagination currentPageIndex={page} pagesCount={Math.max(1, Math.ceil(filteredItems.length / pageSize))}
              onChange={({ detail }) => setPage(detail.currentPageIndex)} />
          </SpaceBetween>
        </>
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
          <Box>
            即将把以下 <strong>{selectedItems.length}</strong> 个实例加入白名单，加入后将不再出现在闲置报告中：
          </Box>
          <Box>
            {selectedItems.map((item) => (
              <div key={item.id} style={{ padding: "2px 0", fontSize: "13px" }}>
                • {item.instance_id} ({item.resource_type.toUpperCase()}, {item.region})
              </div>
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
