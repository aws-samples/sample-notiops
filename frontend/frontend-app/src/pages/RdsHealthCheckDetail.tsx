/**
 * RDS AI 巡检报告详情页。
 * 使用 react-markdown 渲染 Bedrock 生成的 Markdown 格式报告内容。
 */
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Box,
  Button,
  ColumnLayout,
  Container,
  Header,
  SpaceBetween,
  Spinner,
  StatusIndicator,
} from "@cloudscape-design/components";
import { getRdsHealthCheckDetail } from "../api";

interface ReportDetail {
  id?: string;
  report_date: string;
  report_type: string;
  account_id: string | null;
  region: string | null;
  total_instances: number | null;
  critical_count: number | null;
  warning_count: number | null;
  attention_count: number | null;
  report_content: string | null;
  model_id: string | null;
  status: string;
  error_message: string | null;
  created_at: string | null;
}

export default function RdsHealthCheckDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [report, setReport] = useState<ReportDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    getRdsHealthCheckDetail(id)
      .then((resp) => setReport(resp.data.record ?? resp.data))
      .catch((e) => setError(e?.response?.data?.error ?? "加载失败"))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <Box textAlign="center" padding="xxxl">
        <Spinner size="large" />
      </Box>
    );
  }

  if (error || !report) {
    return (
      <Container>
        <Box textAlign="center" padding="xxl" color="text-status-error">
          {error || "报告不存在"}
          <Box margin={{ top: "m" }}>
            <Button onClick={() => navigate("/rds-health-check")}>
              返回报告列表
            </Button>
          </Box>
        </Box>
      </Container>
    );
  }

  const statusIndicator = () => {
    switch (report.status) {
      case "completed":
        return <StatusIndicator type="success">已完成</StatusIndicator>;
      case "generating":
        return <StatusIndicator type="in-progress">生成中</StatusIndicator>;
      case "failed":
        return <StatusIndicator type="error">失败</StatusIndicator>;
      default:
        return <span>{report.status}</span>;
    }
  };

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <Button
            onClick={() => navigate("/rds-health-check")}
            iconName="arrow-left"
          >
            返回报告列表
          </Button>
        }
        description={`${report.report_date} · ${report.report_type === "summary" ? "汇总报告" : "按账户报告"}`}
      >
        巡检报告详情
      </Header>

      {/* 报告元数据 */}
      <Container header={<Header variant="h2">报告信息</Header>}>
        <ColumnLayout columns={5} variant="text-grid">
          <div>
            <Box variant="awsui-key-label">报告日期</Box>
            <div>{report.report_date}</div>
          </div>
          <div>
            <Box variant="awsui-key-label">报告类型</Box>
            <div>
              {report.report_type === "summary" ? "汇总" : "按账户"}
              {report.account_id ? ` (${report.account_id})` : ""}
            </div>
          </div>
          <div>
            <Box variant="awsui-key-label">账户 ID</Box>
            <div>{report.account_id ?? "-"}</div>
          </div>
          <div>
            <Box variant="awsui-key-label">状态</Box>
            <div>{statusIndicator()}</div>
          </div>
          <div>
            <Box variant="awsui-key-label">模型 ID</Box>
            <div>{report.model_id ?? "-"}</div>
          </div>
        </ColumnLayout>
      </Container>

      {/* 汇总卡片 */}
      <Container>
        <ColumnLayout columns={4} variant="text-grid">
          <div>
            <Box variant="awsui-key-label">总实例数</Box>
            <Box variant="awsui-value-large">
              {report.total_instances ?? 0}
            </Box>
          </div>
          <div>
            <Box variant="awsui-key-label">Critical</Box>
            <Box variant="awsui-value-large" color="text-status-error">
              {report.critical_count ?? 0}
            </Box>
          </div>
          <div>
            <Box variant="awsui-key-label">Warning</Box>
            <Box variant="awsui-value-large" color="text-status-warning">
              {report.warning_count ?? 0}
            </Box>
          </div>
          <div>
            <Box variant="awsui-key-label">Attention</Box>
            <Box variant="awsui-value-large" color="text-status-info">
              {report.attention_count ?? 0}
            </Box>
          </div>
        </ColumnLayout>
      </Container>

      {/* 报告内容 */}
      <Container header={<Header variant="h2">报告内容</Header>}>
        {report.status === "generating" ? (
          <Box textAlign="center" padding="xxl">
            <SpaceBetween direction="vertical" size="s" alignItems="center">
              <Spinner size="large" />
              <Box>报告生成中...</Box>
            </SpaceBetween>
          </Box>
        ) : report.status === "failed" ? (
          <Box textAlign="center" padding="xxl" color="text-status-error">
            报告生成失败
            {report.error_message && (
              <Box margin={{ top: "s" }} color="text-body-secondary">
                {report.error_message.replace(/arn:aws[^\s,)"]*/g, "arn:***")}
              </Box>
            )}
          </Box>
        ) : report.report_content ? (
          <div className="markdown-report-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{report.report_content}</ReactMarkdown>
          </div>
        ) : (
          <Box textAlign="center" padding="xxl" color="text-body-secondary">
            暂无报告内容
          </Box>
        )}
      </Container>
    </SpaceBetween>
  );
}
