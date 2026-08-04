/**
 * EC2 低利用率资源详情页。
 * 展示单条 EC2 低利用率记录的完整信息。
 */
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Badge,
  Box,
  Button,
  ColumnLayout,
  Container,
  Header,
  KeyValuePairs,
  SpaceBetween,
  Spinner,
} from "@cloudscape-design/components";
import { getEc2UnderutilizedDetail } from "../api";

interface Ec2Record {
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
  costhub_last_refresh: string | null;
  status: string | null;
  monitoring_date: string | null;
}

const fmt = (v: number | null | undefined, digits = 2) =>
  v != null ? v.toFixed(digits) : "-";

export default function Ec2UnderutilizedDetail() {
  const { accountId, instanceId } = useParams<{ accountId: string; instanceId: string }>();
  const navigate = useNavigate();
  const [record, setRecord] = useState<Ec2Record | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!accountId || !instanceId) return;
    setLoading(true);
    getEc2UnderutilizedDetail(accountId, instanceId)
      .then((resp) => setRecord(resp.data.record ?? resp.data))
      .catch((e) => setError(e?.response?.data?.error ?? "加载失败"))
      .finally(() => setLoading(false));
  }, [accountId, instanceId]);

  if (loading) {
    return <Box textAlign="center" padding="xxxl"><Spinner size="large" /></Box>;
  }

  if (error || !record) {
    return (
      <Container>
        <Box textAlign="center" padding="xxl" color="text-status-error">
          {error || "记录不存在"}
          <Box margin={{ top: "m" }}><Button onClick={() => navigate(-1)}>返回</Button></Box>
        </Box>
      </Container>
    );
  }

  const isRightsizing = !!record.recommended_action && /rightsize/i.test(record.recommended_action);

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={<Button onClick={() => navigate(-1)} iconName="arrow-left">返回列表</Button>}
        description={`${record.account_id} / ${record.region}`}
      >
        {record.instance_id}
      </Header>

      <Container header={<Header variant="h2">基本信息</Header>}>
        <ColumnLayout columns={3} variant="text-grid">
          <KeyValuePairs items={[
            { label: "Instance ID", value: record.instance_id },
            { label: "Instance Name", value: record.instance_name ?? "-" },
            { label: "Instance Type", value: record.instance_type ?? "-" },
          ]} />
          <KeyValuePairs items={[
            { label: "Account ID", value: record.account_id },
            { label: "Region", value: record.region },
            { label: "状态", value: record.status ?? "-" },
          ]} />
          <KeyValuePairs items={[
            { label: "监控日期", value: record.monitoring_date ?? "-" },
            { label: "低利用率天数", value: (
              record.low_utilization_days != null
                ? <Badge color={record.low_utilization_days >= 14 ? "red" : "grey"}>{String(record.low_utilization_days)}</Badge>
                : "-"
            )},
          ]} />
        </ColumnLayout>
      </Container>

      <Container header={<Header variant="h2">利用率指标</Header>}>
        <ColumnLayout columns={2} variant="text-grid">
          <KeyValuePairs items={[
            { label: "CPU 14天平均利用率 (%)", value: fmt(record.cpu_14d_avg) },
            { label: "网络 I/O 14天平均值", value: fmt(record.network_io_14d_avg) },
          ]} />
          <KeyValuePairs items={[
            { label: "低利用率天数", value: record.low_utilization_days != null ? String(record.low_utilization_days) : "-" },
          ]} />
        </ColumnLayout>
      </Container>

      <Container header={<Header variant="h2">优化建议</Header>}>
        <ColumnLayout columns={1}>
          <KeyValuePairs items={[
            { label: "推荐动作", value: record.recommended_action ?? "-" },
            { label: "当前资源配置", value: record.current_resource_summary ?? "-" },
            ...(isRightsizing ? [{ label: "推荐资源配置", value: record.recommended_resource_summary ?? "-" }] : []),
          ]} />
        </ColumnLayout>
      </Container>

      <Container header={<Header variant="h2">费用估算</Header>}>
        <ColumnLayout columns={2} variant="text-grid">
          <KeyValuePairs items={[
            { label: "经典版预估月度节省", value: record.classic_estimated_savings != null ? `$${fmt(record.classic_estimated_savings)}` : "-" },
            { label: "新版预估月度节省", value: record.costhub_estimated_savings != null ? `$${fmt(record.costhub_estimated_savings)}` : "-" },
          ]} />
          <KeyValuePairs items={[
            { label: "新版预估月度成本", value: record.costhub_estimated_monthly_cost != null ? `$${fmt(record.costhub_estimated_monthly_cost)}` : "-" },
            { label: "Cost Optimization Hub 最后刷新", value: record.costhub_last_refresh ?? "-" },
          ]} />
        </ColumnLayout>
      </Container>
    </SpaceBetween>
  );
}
