/**
 * 全量数据大盘页面。
 *
 * 大盘卡片/图表的聚合统计来自服务端 /dashboard/summary（compute_dashboard_summary
 * 读时聚合，已对全量数据分页，不会被列表 cursor 截断）。账户/Region 筛选下推到
 * 服务端：切换筛选 → 重新请求 summary。EC2 低利用率汇总来自其独立端点。
 */
import { useEffect, useState } from "react";
import {
  Box,
  Button,
  ColumnLayout,
  Container,
  Flashbar,
  Header,
  Select,
  SpaceBetween,
  Spinner,
  type SelectProps,
} from "@cloudscape-design/components";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import { getDashboardSummary, getEc2UnderutilizedList, triggerPipeline, getPipelineStatus } from "../api";

interface DashboardSummary {
  rds: { total: number; candidates: number };
  elasticache: { total: number; candidates: number };
  idle: { total: number; total_savings: number };
  filters: { accounts: string[]; regions: string[] };
}

interface PipelineStage {
  stage: string;
  count: number;
}

const EMPTY_SUMMARY: DashboardSummary = {
  rds: { total: 0, candidates: 0 },
  elasticache: { total: 0, candidates: 0 },
  idle: { total: 0, total_savings: 0 },
  filters: { accounts: [], regions: [] },
};

const COLORS = ["#0073bb", "#ec7211", "#1d8102", "#d13212"];
const EMPTY_OPTION: SelectProps.Option = { label: "全部", value: "" };

export default function Dashboard() {
  const [summary, setSummary] = useState<DashboardSummary>(EMPTY_SUMMARY);
  const [ec2Summary, setEc2Summary] = useState({ count: 0, savings: 0 });
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [flashItems, setFlashItems] = useState<{ type: "success" | "error" | "info"; content: string; id: string }[]>([]);
  const [lastRun, setLastRun] = useState<string | null>(null);

  // 筛选条件（下推到服务端）
  const [accountId, setAccountId] = useState<SelectProps.Option>(EMPTY_OPTION);
  const [region, setRegion] = useState<SelectProps.Option>(EMPTY_OPTION);

  // 服务端聚合：随筛选变化重新请求 summary（compute_dashboard_summary 支持 account_id/region）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const params: Record<string, string> = {};
        if (accountId.value) params.account_id = accountId.value;
        if (region.value) params.region = region.value;
        const res = await getDashboardSummary(params);
        if (!cancelled) setSummary({ ...EMPTY_SUMMARY, ...res.data });
      } catch {
        if (!cancelled) setSummary(EMPTY_SUMMARY);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [accountId.value, region.value]);

  // EC2 汇总 + 采集状态：仅首次加载（EC2 端点不在 summary 内，且不随筛选变化，保持原行为）
  useEffect(() => {
    (async () => {
      try {
        const ec2Res = await getEc2UnderutilizedList({ page: "1", page_size: "10000" });
        const ec2Items = ec2Res.data.items ?? [];
        setEc2Summary({
          count: ec2Res.data.total ?? ec2Items.length,
          savings: (ec2Res.data.total_classic_savings ?? 0) + (ec2Res.data.total_costhub_savings ?? 0),
        });
      } catch {
        setEc2Summary({ count: 0, savings: 0 });
      }
      try {
        const statusRes = await getPipelineStatus();
        const d = statusRes.data;
        if (d.execution_date) {
          setLastRun(`${d.status === "completed" ? "✅" : d.status === "running" ? "🔄" : "❌"} ${d.execution_date}${d.duration_seconds ? ` (${d.duration_seconds}s)` : ""}`);
        }
      } catch { /* ignore */ }
    })();
  }, []);

  const handleTrigger = async () => {
    setTriggering(true);
    try {
      await triggerPipeline();
      setFlashItems([{ type: "success", content: "采集任务已提交，完成后数据将自动更新", id: "trigger-ok" }]);
    } catch {
      setFlashItems([{ type: "error", content: "触发失败，请稍后重试", id: "trigger-err" }]);
    } finally {
      setTriggering(false);
    }
  };

  // 筛选下拉选项来自服务端 summary.filters（过滤前的全集，切换筛选时保持稳定）
  const accountOptions: SelectProps.Options = [
    EMPTY_OPTION,
    ...summary.filters.accounts.map((a) => ({ label: a, value: a })),
  ];
  const regionOptions: SelectProps.Options = [
    EMPTY_OPTION,
    ...summary.filters.regions.map((r) => ({ label: r, value: r })),
  ];

  const candidates = summary.rds.candidates + summary.elasticache.candidates;
  const savings = summary.idle.total_savings + ec2Summary.savings;

  const pieData = [
    { name: "RDS", value: summary.rds.total },
    { name: "ElastiCache", value: summary.elasticache.total },
    { name: "EC2", value: ec2Summary.count },
  ];

  const pipelineData: PipelineStage[] = [
    { stage: "发现", count: summary.rds.total + summary.elasticache.total },
    { stage: "嫌疑人", count: candidates },
    { stage: "闲置", count: summary.idle.total },
  ];

  if (loading) {
    return (
      <Box textAlign="center" padding="xxxl">
        <Spinner size="large" />
      </Box>
    );
  }

  return (
    <SpaceBetween size="l">
      {flashItems.length > 0 && <Flashbar items={flashItems} />}
      <Header
        variant="h1"
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            {lastRun && <Box variant="small" color="text-body-secondary">{lastRun}</Box>}
            <Button onClick={handleTrigger} loading={triggering} iconName="refresh">手动采集</Button>
          </SpaceBetween>
        }
      >
        数据大盘
      </Header>

      {/* 筛选栏 */}
      <Container>
        <ColumnLayout columns={2}>
          <Select
            selectedOption={accountId}
            onChange={({ detail }) => setAccountId(detail.selectedOption)}
            options={accountOptions}
            placeholder="按账户筛选"
           expandToViewport/>
          <Select
            selectedOption={region}
            onChange={({ detail }) => setRegion(detail.selectedOption)}
            options={regionOptions}
            placeholder="按 Region 筛选"
           expandToViewport/>
        </ColumnLayout>
      </Container>

      {/* 概览卡片 */}
      <ColumnLayout columns={5} variant="text-grid">
        <StatCard title="RDS 实例" value={summary.rds.total} />
        <StatCard title="ElastiCache 实例" value={summary.elasticache.total} />
        <StatCard title="EC2 低利用率" value={ec2Summary.count} />
        <StatCard title="嫌疑人" value={candidates} />
        <StatCard title="闲置实例" value={summary.idle.total} color="#d13212" />
      </ColumnLayout>

      {/* 预估节省 */}
      <Container header={<Header variant="h2">预估月度节省</Header>}>
        <Box variant="h1" color="text-status-success">
          ${savings.toLocaleString("en-US", { minimumFractionDigits: 2 })}
        </Box>
      </Container>

      {/* 图表 */}
      <ColumnLayout columns={2}>
        <Container header={<Header variant="h2">资源类型分布</Header>}>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label>
                {pieData.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Legend />
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </Container>

        <Container header={<Header variant="h2">流水线各阶段数量</Header>}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={pipelineData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="stage" />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="count" fill="#0073bb" />
            </BarChart>
          </ResponsiveContainer>
        </Container>
      </ColumnLayout>
    </SpaceBetween>
  );
}

function StatCard({ title, value, color }: { title: string; value: number; color?: string }) {
  return (
    <Container>
      <Box variant="awsui-key-label">{title}</Box>
      <Box variant="h1" color={color as never}>
        {value}
      </Box>
    </Container>
  );
}
