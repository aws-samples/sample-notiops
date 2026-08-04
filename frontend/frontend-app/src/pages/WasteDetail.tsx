/**
 * 闲置实例详情页面。
 * 完整监控数据、判定过程可视化、连续低阈值天数、添加白名单按钮。
 */
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Box,
  Button,
  ColumnLayout,
  Container,
  FormField,
  Header,
  Input,
  KeyValuePairs,
  Modal,
  SpaceBetween,
  Spinner,
  StatusIndicator,
  Alert,
} from "@cloudscape-design/components";
import { getWasteReportDetail, addWhitelist, getWhitelist } from "../api";

interface Detail {
  id: number;
  instance_id: string;
  account_id: string;
  region: string;
  resource_type: string;
  instance_class: string;
  engine: string;
  report_date: string;
  is_idle: boolean;
  exclusion_reason: string | null;
  idle_score: number | null;
  value_score: number | null;
  estimated_monthly_savings: number | null;
  consecutive_low_days: number;
  cpu_utilization: number | null;
  connections: number | null;
  free_storage_or_memory: number | null;
  peak_cpu_7d: number | null;
  read_iops: number | null;
  write_iops: number | null;
  evictions: number | null;
  allocated_storage_gb: number | null;
  cache_hits: number | null;
  cache_misses: number | null;
}

export default function WasteDetail() {
  const { accountId, instanceId } = useParams<{ accountId: string; instanceId: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [whitelisting, setWhitelisting] = useState(false);
  const [whitelisted, setWhitelisted] = useState(false);
  const [showWhitelistModal, setShowWhitelistModal] = useState(false);
  const [whitelistReason, setWhitelistReason] = useState("");
  const [whitelistDays, setWhitelistDays] = useState("30");

  useEffect(() => {
    if (!accountId || !instanceId) return;
    setLoading(true);
    Promise.all([
      getWasteReportDetail(accountId, instanceId),
      getWhitelist().catch(() => ({ data: [] })),
    ])
      .then(([detailRes, wlRes]) => {
        const report = detailRes.data.report ?? detailRes.data;
        setDetail(report);
        const wlItems = wlRes.data.items ?? wlRes.data ?? [];
        const inWl = wlItems.some(
          (w: { instance_id: string }) => w.instance_id === report?.instance_id
        );
        setWhitelisted(inWl);
      })
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [accountId, instanceId]);

  const handleWhitelist = async () => {
    if (!detail) return;
    const days = parseInt(whitelistDays, 10);
    if (!Number.isInteger(days) || days <= 0) return;
    setWhitelisting(true);
    try {
      await addWhitelist({
        instance_id: detail.instance_id,
        account_id: detail.account_id,
        resource_type: detail.resource_type,
        reason: whitelistReason || "从详情页手动添加白名单",
        expires_days: days,
      });
      setWhitelisted(true);
      setShowWhitelistModal(false);
      setWhitelistReason("");
      setWhitelistDays("30");
    } catch { /* ignore */ }
    finally { setWhitelisting(false); }
  };

  if (loading) return <Box textAlign="center" padding="xxxl"><Spinner size="large" /></Box>;
  if (!detail) return <Alert type="error">未找到该实例</Alert>;
  const isEC = (detail.resource_type ?? "") === "elasticache";

  const fmt = (v: number | null | undefined, digits = 2) =>
    v != null ? v.toFixed(digits) : "N/A";

  const fmtBytes = (v: number | null | undefined): string => {
    if (v == null) return "N/A";
    if (v >= 1024 ** 4) return `${(v / 1024 ** 4).toFixed(2)} TB`;
    if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`;
    if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(2)} MB`;
    if (v >= 1024) return `${(v / 1024).toFixed(2)} KB`;
    return `${v.toFixed(0)} B`;
  };

  return (
    <SpaceBetween size="l">
      <Header variant="h1"
        actions={
          <SpaceBetween direction="horizontal" size="s">
            <Button onClick={() => navigate(-1)}>返回</Button>
            <Button variant="primary" loading={whitelisting} disabled={whitelisted} onClick={() => setShowWhitelistModal(true)}>
              {whitelisted ? "已加入白名单" : "加入白名单"}
            </Button>
          </SpaceBetween>
        }
      >
        {detail.instance_id}
      </Header>

      {/* 基本信息 */}
      <Container header={<Header variant="h2">基本信息</Header>}>
        <ColumnLayout columns={3} variant="text-grid">
          <KeyValuePairs items={[
            { label: "账户 ID", value: detail.account_id },
            { label: "Region", value: detail.region },
            { label: "资源类型", value: (detail.resource_type ?? "").toUpperCase() },
          ]} />
          <KeyValuePairs items={[
            { label: "实例规格", value: detail.instance_class },
            { label: "引擎", value: detail.engine },
            { label: "报告日期", value: detail.report_date },
          ]} />
          <KeyValuePairs items={[
            { label: "连续低阈值天数", value: String(detail.consecutive_low_days) },
            { label: "预估月度节省", value: `$${fmt(detail.estimated_monthly_savings)}` },
          ]} />
        </ColumnLayout>
      </Container>

      {/* 判定结果 */}
      <Container header={<Header variant="h2">判定结果</Header>}>
        <ColumnLayout columns={4} variant="text-grid">
          <div>
            <Box variant="awsui-key-label">状态</Box>
            <StatusIndicator type={detail.is_idle ? "warning" : "success"}>
              {detail.is_idle ? "闲置" : "正常"}
            </StatusIndicator>
          </div>
          <div>
            <Box variant="awsui-key-label">排除原因</Box>
            <Box>{detail.exclusion_reason ?? "无"}</Box>
          </div>
          <div>
            <Box variant="awsui-key-label">闲置评分</Box>
            <Box variant="h2">{fmt(detail.idle_score, 1)}</Box>
          </div>
          <div>
            <Box variant="awsui-key-label">价值评分</Box>
            <Box variant="h2">{fmt(detail.value_score, 1)}</Box>
          </div>
        </ColumnLayout>
      </Container>

      {/* 监控指标 */}
      <ColumnLayout columns={2}>
        <Container header={<Header variant="h2">基础指标</Header>}>
          <KeyValuePairs items={[
            { label: isEC ? "Engine CPU 利用率" : "CPU 利用率", value: `${fmt(detail.cpu_utilization)}%` },
            { label: "连接数", value: String(detail.connections ?? "N/A") },
            { label: (detail.resource_type ?? "") === "rds" ? "可用存储空间" : "内存使用率",
              value: (detail.resource_type ?? "") === "rds" ? fmtBytes(detail.free_storage_or_memory) : `${fmt(detail.free_storage_or_memory)}%` },
          ]} />
        </Container>
        <Container header={<Header variant="h2">深度指标</Header>}>
          <KeyValuePairs items={[
            { label: isEC ? "7 天 Engine CPU 峰值" : "7 天 CPU 峰值", value: `${fmt(detail.peak_cpu_7d)}%` },
            ...((detail.resource_type ?? "") === "rds"
              ? [
                  { label: "Read IOPS", value: fmt(detail.read_iops) },
                  { label: "Write IOPS", value: fmt(detail.write_iops) },
                  { label: "分配存储 (GB)", value: fmt(detail.allocated_storage_gb, 1) },
                ]
              : [
                  { label: "Evictions", value: String(detail.evictions ?? "N/A") },
                  { label: "Cache Hits", value: detail.cache_hits?.toLocaleString() ?? "N/A" },
                  { label: "Cache Misses", value: detail.cache_misses?.toLocaleString() ?? "N/A" },
                ]),
          ]} />
        </Container>
      </ColumnLayout>

      <Modal visible={showWhitelistModal} onDismiss={() => setShowWhitelistModal(false)}
        header="加入白名单"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setShowWhitelistModal(false)}>取消</Button>
              <Button variant="primary" loading={whitelisting} onClick={handleWhitelist}
                disabled={!whitelistDays || !/^\d+$/.test(whitelistDays) || parseInt(whitelistDays, 10) <= 0}>确认</Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <FormField label="实例 ID"><Input value={detail.instance_id} disabled /></FormField>
          <FormField label="原因" description="请填写将此实例加入白名单的原因，方便日后查阅">
            <Input value={whitelistReason} onChange={({ detail }) => setWhitelistReason(detail.value)} placeholder="例如：测试环境实例，无需优化" />
          </FormField>
          <FormField label="有效天数" description="白名单过期后将自动恢复检测" constraintText="请输入正整数"
            errorText={whitelistDays && (!/^\d+$/.test(whitelistDays) || parseInt(whitelistDays, 10) <= 0) ? "请输入大于 0 的正整数" : undefined}>
            <Input value={whitelistDays} onChange={({ detail }) => setWhitelistDays(detail.value)} type="number" placeholder="30" />
          </FormField>
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}
