/**
 * EC2 低利用率报告页面。
 * 展示 Trusted Advisor 经典版和 Cost Optimization Hub 合并后的 EC2 低利用率数据。
 */
import { useEffect, useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
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
import { getEc2UnderutilizedList, exportEc2UnderutilizedCSV } from "../api";
import { errMsg } from "../utils/errMsg";

interface Ec2Item {
  id: number;
  instance_id: string;
  account_id: string;
  region: string;
  instance_name: string | null;
  instance_type: string | null;
  cpu_14d_avg: number | null;
  network_io_14d_avg: number | null;
  low_utilization_days: number | null;
  classic_estimated_savings: number | null;
  recommended_action: string | null;
  current_resource_summary: string | null;
  recommended_resource_summary: string | null;
  costhub_estimated_monthly_cost: number | null;
  costhub_estimated_savings: number | null;
}

const ALL: SelectProps.Option = { label: "全部", value: "" };
const PAGE_SIZE_OPTIONS = [
  { label: "50 条/页", value: "50" },
  { label: "100 条/页", value: "100" },
  { label: "200 条/页", value: "200" },
  { label: "500 条/页", value: "500" },
];
const DEFAULT_PAGE_SIZE = 50;

export default function Ec2Underutilized() {
  const navigate = useNavigate();
  const [allItems, setAllItems] = useState<Ec2Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [totalClassicSavings, setTotalClassicSavings] = useState(0);
  const [totalCosthubSavings, setTotalCosthubSavings] = useState(0);

  // 筛选状态
  const [accountId, setAccountId] = useState("");
  const [debouncedAccountId, setDebouncedAccountId] = useState("");
  const [region, setRegion] = useState<SelectProps.Option>(ALL);
  const [instanceType, setInstanceType] = useState<SelectProps.Option>(ALL);

  // 排序状态
  const [sortBy, setSortBy] = useState("costhub_estimated_savings");
  const [sortDesc, setSortDesc] = useState(true);

  // 防抖 Account ID 输入
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedAccountId(accountId);
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [accountId]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await getEc2UnderutilizedList({ page: "1", page_size: "10000" });
      const data = resp.data;
      setAllItems((data.items ?? []) as Ec2Item[]);
      setTotalClassicSavings(data.total_classic_savings ?? 0);
      setTotalCosthubSavings(data.total_costhub_savings ?? 0);
    } catch (e) {
      console.error("Failed to load EC2 underutilized report", errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 初始加载
  useEffect(() => { fetchData(); }, [fetchData]);

  // 从数据中提取唯一的 region 和 instance_type 用于下拉选项
  const regionOptions = useMemo(() => {
    const regions = [...new Set(allItems.map((i) => i.region).filter(Boolean))].sort();
    return [ALL, ...regions.map((r) => ({ label: r, value: r }))];
  }, [allItems]);

  const instanceTypeOptions = useMemo(() => {
    const types = [...new Set(allItems.map((i) => i.instance_type).filter(Boolean) as string[])].sort();
    return [ALL, ...types.map((t) => ({ label: t, value: t }))];
  }, [allItems]);

  // 客户端筛选
  const filteredItems = useMemo(() => {
    return allItems.filter((item) => {
      if (debouncedAccountId.trim() && !item.account_id.includes(debouncedAccountId.trim())) return false;
      if (region.value && item.region !== region.value) return false;
      if (instanceType.value && item.instance_type !== instanceType.value) return false;
      return true;
    });
  }, [allItems, debouncedAccountId, region, instanceType]);

  // 客户端排序
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

  // 客户端分页
  const pagedItems = useMemo(() => {
    const start = (page - 1) * pageSize;
    return sortedItems.slice(start, start + pageSize);
  }, [sortedItems, page, pageSize]);

  const handleExport = async () => {
    try {
      const params: Record<string, string> = {};
      if (debouncedAccountId.trim()) params.account_id = debouncedAccountId.trim();
      if (region.value) params.region = region.value;
      if (instanceType.value) params.instance_type = instanceType.value;

      const resp = await exportEc2UnderutilizedCSV(params);
      const blob = new Blob([resp.data], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "ec2_underutilized.csv"; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { console.error("CSV export failed", errMsg(e)); }
  };

  const handleSortChange = (fieldId: string) => {
    if (sortBy === fieldId) {
      setSortDesc((prev) => !prev);
    } else {
      setSortBy(fieldId);
      setSortDesc(true);
    }
    setPage(1);
  };

  const pagesCount = Math.max(1, Math.ceil(filteredItems.length / pageSize));

  const columns = useMemo(() => [
    { id: "instance_id", header: "Instance ID", cell: (item: Ec2Item) => item.instance_id, sortingField: "instance_id", width: 200 },
    { id: "account_id", header: "Account ID", cell: (item: Ec2Item) => item.account_id, sortingField: "account_id", width: 140 },
    { id: "region", header: "Region", cell: (item: Ec2Item) => item.region, sortingField: "region", width: 150 },
    { id: "instance_name", header: "Instance Name", cell: (item: Ec2Item) => item.instance_name ?? "-", width: 180 },
    { id: "instance_type", header: "Instance Type", cell: (item: Ec2Item) => item.instance_type ?? "-", sortingField: "instance_type", width: 140 },
    {
      id: "low_utilization_days", header: "低利用率天数", width: 130,
      sortingField: "low_utilization_days",
      cell: (item: Ec2Item) => item.low_utilization_days != null ? String(item.low_utilization_days) : "-",
    },
    {
      id: "classic_estimated_savings", header: "经典版预估节省 ($)", width: 160,
      sortingField: "classic_estimated_savings",
      cell: (item: Ec2Item) => item.classic_estimated_savings != null ? item.classic_estimated_savings.toFixed(2) : "-",
    },
    {
      id: "costhub_estimated_savings", header: "新版预估节省 ($)", width: 160,
      sortingField: "costhub_estimated_savings",
      cell: (item: Ec2Item) => item.costhub_estimated_savings != null ? item.costhub_estimated_savings.toFixed(2) : "-",
    },
  ], []);

  return (
    <SpaceBetween size="l">
      <Header variant="h1" actions={
        <SpaceBetween direction="horizontal" size="xs">
          <Button onClick={fetchData} iconName="refresh">刷新</Button>
          <Button onClick={handleExport} variant="primary">导出 CSV</Button>
        </SpaceBetween>
      } description="EC2 低利用率检测 — Trusted Advisor 经典版 + Cost Optimization Hub 合并报告">
        EC2 低利用率资源
      </Header>

      <Container>
        <ColumnLayout columns={3} variant="text-grid">
          <div><Box variant="awsui-key-label">低利用率实例总数</Box><Box variant="awsui-value-large">{filteredItems.length}</Box></div>
          <div><Box variant="awsui-key-label">经典版预估总节省</Box><Box variant="awsui-value-large">${totalClassicSavings.toFixed(2)}</Box></div>
          <div><Box variant="awsui-key-label">新版预估总节省</Box><Box variant="awsui-value-large">${totalCosthubSavings.toFixed(2)}</Box></div>
        </ColumnLayout>
      </Container>

      <Container>
        <ColumnLayout columns={3}>
          <Input value={accountId} onChange={({ detail }) => setAccountId(detail.value)} placeholder="Account ID" />
          <Select selectedOption={region} onChange={({ detail }) => { setRegion(detail.selectedOption); setPage(1); }} options={regionOptions} placeholder="Region"  expandToViewport/>
          <Select selectedOption={instanceType} onChange={({ detail }) => { setInstanceType(detail.selectedOption); setPage(1); }} options={instanceTypeOptions} placeholder="Instance Type"  expandToViewport/>
        </ColumnLayout>
      </Container>

      {loading ? (
        <Box textAlign="center" padding="xxl"><Spinner size="large" /></Box>
      ) : (
        <Table
          items={pagedItems}
          columnDefinitions={columns}
          variant="full-page"
          stickyHeader
          trackBy="instance_id"
          onRowClick={({ detail }) => navigate(`/ec2-underutilized/${detail.item.account_id}/${detail.item.instance_id}`)}
          sortingColumn={columns.find((c) => c.sortingField === sortBy)}
          sortingDescending={sortDesc}
          onSortingChange={({ detail }) => {
            if (detail.sortingColumn?.sortingField) {
              handleSortChange(detail.sortingColumn.sortingField);
            }
          }}
          empty={<Box textAlign="center" padding="xxl">暂无 EC2 低利用率资源</Box>}
          header={<Header counter={`(${filteredItems.length})`}>EC2 低利用率资源列表</Header>}
          pagination={
            <SpaceBetween direction="horizontal" size="xs">
              <Select
                selectedOption={PAGE_SIZE_OPTIONS.find((o) => o.value === String(pageSize)) ?? PAGE_SIZE_OPTIONS[0]}
                onChange={({ detail }) => { setPageSize(Number(detail.selectedOption.value)); setPage(1); }}
                options={PAGE_SIZE_OPTIONS}
               expandToViewport/>
              <Pagination
                currentPageIndex={page}
                pagesCount={pagesCount}
                onChange={({ detail }) => setPage(detail.currentPageIndex)}
              />
            </SpaceBetween>
          }
        />
      )}
    </SpaceBetween>
  );
}
