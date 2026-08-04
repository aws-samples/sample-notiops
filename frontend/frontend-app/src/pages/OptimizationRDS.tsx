/**
 * RDS 潜在优化资源报告页面。
 * 展示 RDS oversized_storage 类型的容量审计结果。
 */
import { useEffect, useState, useMemo } from "react";
import {
  Badge,
  Box,
  Button,
  ColumnLayout,
  Container,
  Header,
  Input,
  Pagination,
  Select,
  SpaceBetween,
  Spinner,
  Table,
  type SelectProps,
} from "@cloudscape-design/components";
import { getOptimizationReportList, exportOptimizationReportCSV } from "../api";
import { errMsg } from "../utils/errMsg";

interface RDSOptItem {
  id: number;
  instance_id: string;
  account_id: string;
  region: string;
  resource_type: string;
  instance_class: string;
  engine: string;
  optimization_type: string;
  estimated_monthly_cost: number;
  is_micro: boolean;
  free_storage_avg_gb: number | null;
  allocated_storage_gb: number | null;
  cpu_max: number | null;
}

const ALL: SelectProps.Option = { label: "全部", value: "" };
const PAGE_SIZE_OPTIONS = [
  { label: "50 条/页", value: "50" },
  { label: "100 条/页", value: "100" },
  { label: "200 条/页", value: "200" },
  { label: "500 条/页", value: "500" },
];
const DEFAULT_PAGE_SIZE = 50;

export default function OptimizationRDS() {
  const [allItems, setAllItems] = useState<RDSOptItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [accountId, setAccountId] = useState("");
  const [region, setRegion] = useState<SelectProps.Option>(ALL);
  const [sortDesc, setSortDesc] = useState(true);
  const [totalCost, setTotalCost] = useState(0);

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const resp = await getOptimizationReportList({ page_size: "10000", resource_type: "rds" });
      const data = resp.data;
      setAllItems(data.items || []);
      setTotalCost(data.total_cost || 0);
    } catch (e) {
      console.error("Failed to load RDS optimization report", errMsg(e));
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
      ? (b.estimated_monthly_cost || 0) - (a.estimated_monthly_cost || 0)
      : (a.estimated_monthly_cost || 0) - (b.estimated_monthly_cost || 0));
    return items;
  }, [allItems, accountId, region, sortDesc]);

  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);
  const filteredCost = filtered.reduce((s, i) => s + (i.estimated_monthly_cost || 0), 0);

  const handleExport = async () => {
    try {
      const resp = await exportOptimizationReportCSV({ resource_type: "rds" });
      const blob = new Blob([resp.data], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "rds_optimization_report.csv"; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { console.error("CSV export failed", errMsg(e)); }
  };

  const columns = [
    { id: "instance_id", header: "实例 ID", cell: (item: RDSOptItem) => item.instance_id, sortingField: "instance_id", width: 240 },
    { id: "account_id", header: "账户", cell: (item: RDSOptItem) => item.account_id, width: 130 },
    { id: "region", header: "区域", cell: (item: RDSOptItem) => item.region, width: 140 },
    { id: "instance_class", header: "规格", cell: (item: RDSOptItem) => item.instance_class, width: 150 },
    { id: "engine", header: "引擎", cell: (item: RDSOptItem) => item.engine, width: 100 },
    {
      id: "optimization_type", header: "优化类型", width: 120,
      cell: (item: RDSOptItem) => (
        <Badge color="blue">{item.optimization_type === "oversized_storage" ? "存储过大" : item.optimization_type}</Badge>
      ),
    },
    {
      id: "allocated_storage_gb", header: "分配存储 (GB)", width: 130,
      cell: (item: RDSOptItem) => item.allocated_storage_gb != null ? item.allocated_storage_gb.toFixed(1) : "-",
    },
    {
      id: "free_storage_avg_gb", header: "可用存储 (GB)", width: 130,
      cell: (item: RDSOptItem) => item.free_storage_avg_gb != null ? item.free_storage_avg_gb.toFixed(2) : "-",
    },
    {
      id: "cpu_max", header: "CPU 峰值 (%)", width: 120,
      cell: (item: RDSOptItem) => item.cpu_max != null ? item.cpu_max.toFixed(1) : "-",
    },
    {
      id: "estimated_monthly_cost", header: "月度成本 ($)", width: 120,
      cell: (item: RDSOptItem) => item.estimated_monthly_cost != null ? `$${item.estimated_monthly_cost.toFixed(2)}` : "-",
    },

  ];

  return (
    <SpaceBetween size="l">
      <Header variant="h1" actions={
        <SpaceBetween direction="horizontal" size="xs">
          <Button onClick={fetchData} iconName="refresh">刷新</Button>
          <Button onClick={handleExport} variant="primary">导出 CSV</Button>
        </SpaceBetween>
      } description="RDS 容量审计 — 识别存储过大的非闲置 RDS 实例">
        RDS 潜在优化资源
      </Header>

      <Container>
        <ColumnLayout columns={3} variant="text-grid">
          <div><Box variant="awsui-key-label">RDS 资源数</Box><Box variant="awsui-value-large">{allItems.length}</Box></div>
          <div><Box variant="awsui-key-label">总月度成本</Box><Box variant="awsui-value-large">${totalCost.toFixed(2)}</Box></div>
          <div><Box variant="awsui-key-label">筛选后成本</Box><Box variant="awsui-value-large">${filteredCost.toFixed(2)}</Box></div>
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
          empty={<Box textAlign="center" padding="xxl">暂无 RDS 优化数据</Box>}
          header={<Header counter={`(${filtered.length})`}>RDS 优化资源列表</Header>}
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
    </SpaceBetween>
  );
}
