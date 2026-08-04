/**
 * ElastiCache 潜在优化资源报告页面。
 * 展示 ElastiCache oversized_memory 类型的容量审计结果，含网络带宽超限指标。
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

interface ECOptItem {
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
  engine_cpu_max: number | null;
  memory_util_pct: number | null;
  swap_max_gb: number | null;
  nw_bw_in_exceeded: number | null;
  nw_bw_out_exceeded: number | null;
}

const ALL: SelectProps.Option = { label: "全部", value: "" };
const PAGE_SIZE_OPTIONS = [
  { label: "50 条/页", value: "50" },
  { label: "100 条/页", value: "100" },
  { label: "200 条/页", value: "200" },
  { label: "500 条/页", value: "500" },
];
const DEFAULT_PAGE_SIZE = 50;

export default function OptimizationElastiCache() {
  const [allItems, setAllItems] = useState<ECOptItem[]>([]);
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
      const resp = await getOptimizationReportList({ page_size: "10000", resource_type: "elasticache" });
      const data = resp.data;
      setAllItems(data.items || []);
      setTotalCost(data.total_cost || 0);
    } catch (e) {
      console.error("Failed to load ElastiCache optimization report", errMsg(e));
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
      const resp = await exportOptimizationReportCSV({ resource_type: "elasticache" });
      const blob = new Blob([resp.data], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "elasticache_optimization_report.csv"; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { console.error("CSV export failed", errMsg(e)); }
  };

  const columns = [
    { id: "instance_id", header: "实例 ID", cell: (item: ECOptItem) => item.instance_id, width: 240 },
    { id: "account_id", header: "账户", cell: (item: ECOptItem) => item.account_id, width: 130 },
    { id: "region", header: "区域", cell: (item: ECOptItem) => item.region, width: 140 },
    { id: "instance_class", header: "规格", cell: (item: ECOptItem) => item.instance_class, width: 150 },
    { id: "engine", header: "引擎", cell: (item: ECOptItem) => item.engine, width: 100 },
    {
      id: "optimization_type", header: "优化类型", width: 120,
      cell: (item: ECOptItem) => (
        <Badge color="green">{item.optimization_type === "oversized_memory" ? "内存过大" : item.optimization_type}</Badge>
      ),
    },
    {
      id: "memory_util_pct", header: "内存使用率 (%)", width: 130,
      cell: (item: ECOptItem) => item.memory_util_pct != null ? item.memory_util_pct.toFixed(1) : "-",
    },
    {
      id: "engine_cpu_max", header: "Engine CPU 峰值 (%)", width: 150,
      cell: (item: ECOptItem) => item.engine_cpu_max != null ? item.engine_cpu_max.toFixed(1) : "-",
    },
    {
      id: "swap_max_gb", header: "Swap (GB)", width: 110,
      cell: (item: ECOptItem) => item.swap_max_gb != null ? item.swap_max_gb.toFixed(4) : "-",
    },
    {
      id: "nw_bw_in_exceeded", header: "入站带宽超限", width: 120,
      cell: (item: ECOptItem) => item.nw_bw_in_exceeded != null ? item.nw_bw_in_exceeded.toFixed(0) : "-",
    },
    {
      id: "nw_bw_out_exceeded", header: "出站带宽超限", width: 120,
      cell: (item: ECOptItem) => item.nw_bw_out_exceeded != null ? item.nw_bw_out_exceeded.toFixed(0) : "-",
    },
    {
      id: "estimated_monthly_cost", header: "月度成本 ($)", width: 120,
      cell: (item: ECOptItem) => item.estimated_monthly_cost != null ? `$${item.estimated_monthly_cost.toFixed(2)}` : "-",
    },

  ];

  return (
    <SpaceBetween size="l">
      <Header variant="h1" actions={
        <SpaceBetween direction="horizontal" size="xs">
          <Button onClick={fetchData} iconName="refresh">刷新</Button>
          <Button onClick={handleExport} variant="primary">导出 CSV</Button>
        </SpaceBetween>
      } description="ElastiCache 容量审计 — 识别内存过大的非闲置 ElastiCache 节点">
        ElastiCache 潜在优化资源
      </Header>

      <Container>
        <ColumnLayout columns={3} variant="text-grid">
          <div><Box variant="awsui-key-label">ElastiCache 资源数</Box><Box variant="awsui-value-large">{allItems.length}</Box></div>
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
          empty={<Box textAlign="center" padding="xxl">暂无 ElastiCache 优化数据</Box>}
          header={<Header counter={`(${filtered.length})`}>ElastiCache 优化资源列表</Header>}
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
