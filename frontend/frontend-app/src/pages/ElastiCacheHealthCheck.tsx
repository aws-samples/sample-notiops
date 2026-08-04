/**
 * ElastiCache AI 智能巡检报告页面。
 * 展示 AI 驱动的 ElastiCache 健康巡检报告列表，支持一键生成和轮询。
 */
import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Box,
  Button,
  ColumnLayout,
  Container,
  Header,
  Input,
  Modal,
  Pagination,
  RadioGroup,
  Select,
  SpaceBetween,
  Spinner,
  StatusIndicator,
  Table,
  Toggle,
  type SelectProps,
} from "@cloudscape-design/components";
import { getElastiCacheHealthCheckList, triggerElastiCacheHealthCheck, deleteElastiCacheHealthCheckBatch, triggerPipeline, getPipelineStatus } from "../api";
import { errMsg } from "../utils/errMsg";

interface HealthCheckItem {
  id?: string;
  report_date: string;
  report_type: string;
  account_id: string | null;
  region: string | null;
  total_instances: number | null;
  critical_count: number | null;
  warning_count: number | null;
  attention_count: number | null;
  status: string;
}

interface Summary {
  total_instances: number;
  critical_count: number;
  warning_count: number;
  attention_count: number;
}

const PAGE_SIZE_OPTIONS: SelectProps.Option[] = [
  { label: "50 条/页", value: "50" },
  { label: "100 条/页", value: "100" },
  { label: "200 条/页", value: "200" },
  { label: "500 条/页", value: "500" },
];
const DEFAULT_PAGE_SIZE = 50;
const POLL_INTERVAL = 5000;
const PIPELINE_POLL_INTERVAL = 5000;
const PIPELINE_TIMEOUT = 300000; // 300s

export default function ElastiCacheHealthCheck() {
  const navigate = useNavigate();
  const [allItems, setAllItems] = useState<HealthCheckItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [summary, setSummary] = useState<Summary>({
    total_instances: 0,
    critical_count: 0,
    warning_count: 0,
    attention_count: 0,
  });

  const [reportDate, setReportDate] = useState("");
  const [debouncedReportDate, setDebouncedReportDate] = useState("");
  const [showLatestOnly, setShowLatestOnly] = useState(true);

  const [triggering, setTriggering] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [selectedItems, setSelectedItems] = useState<HealthCheckItem[]>([]);
  const [deleting, setDeleting] = useState(false);

  const [showTriggerModal, setShowTriggerModal] = useState(false);
  const [triggerMode, setTriggerMode] = useState<string>("report-only");
  const [pipelinePolling, setPipelinePolling] = useState(false);
  const pipelinePollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [triggerStep, setTriggerStep] = useState<string>("idle");
  const [triggerError, setTriggerError] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedReportDate(reportDate);
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [reportDate]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {
        page: "1",
        page_size: "10000",
        show_all: "true",
      };
      const resp = await getElastiCacheHealthCheckList(params);
      const data = resp.data;
      setAllItems((data.items ?? []) as HealthCheckItem[]);
      setSummary({
        total_instances: data.summary?.total_instances ?? 0,
        critical_count: data.summary?.critical_count ?? 0,
        warning_count: data.summary?.warning_count ?? 0,
        attention_count: data.summary?.attention_count ?? 0,
      });
    } catch (e) {
      console.error("Failed to load ElastiCache health check reports", errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const filteredItems = useMemo(() => {
    let result = allItems;
    if (debouncedReportDate.trim()) {
      result = result.filter((item) => item.report_date === debouncedReportDate.trim());
    } else if (showLatestOnly && result.length > 0) {
      const latestDate = result.reduce(
        (max, item) => (item.report_date > max ? item.report_date : max),
        result[0].report_date,
      );
      result = result.filter((item) => item.report_date === latestDate);
    }
    return result;
  }, [allItems, debouncedReportDate, showLatestOnly]);

  const total = filteredItems.length;
  const pagesCount = Math.max(1, Math.ceil(total / pageSize));
  const pagedItems = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredItems.slice(start, start + pageSize);
  }, [filteredItems, page, pageSize]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      if (pipelinePollingRef.current) {
        clearInterval(pipelinePollingRef.current);
        pipelinePollingRef.current = null;
      }
    };
  }, []);

  const startPolling = useCallback(() => {
    if (pollingRef.current) return;
    pollingRef.current = setInterval(async () => {
      try {
        const params: Record<string, string> = {
          page: "1",
          page_size: "10000",
          show_all: "true",
        };
        const resp = await getElastiCacheHealthCheckList(params);
        const data = resp.data;
        const reportItems = (data.items ?? []) as HealthCheckItem[];
        const hasGenerating = reportItems.some((item) => item.status === "generating");

        setAllItems(reportItems);
        setSummary({
          total_instances: data.summary?.total_instances ?? 0,
          critical_count: data.summary?.critical_count ?? 0,
          warning_count: data.summary?.warning_count ?? 0,
          attention_count: data.summary?.attention_count ?? 0,
        });

        if (!hasGenerating) {
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }
          setTriggering(false);
        }
      } catch (e) {
        console.error("Polling failed", errMsg(e));
      }
    }, POLL_INTERVAL);
  }, []);

  useEffect(() => {
    if (!loading && allItems.some((item) => item.status === "generating") && !pollingRef.current) {
      setTriggering(true);
      startPolling();
    }
  }, [loading, allItems, startPolling]);

  const handleTrigger = async () => {
    setTriggerError("");
    setTriggering(true);

    try {
      if (triggerMode === "collect-and-report") {
        setTriggerStep("collecting");
        await triggerPipeline();
        setPipelinePolling(true);

        const startTime = Date.now();
        await new Promise<void>((resolve, reject) => {
          pipelinePollingRef.current = setInterval(async () => {
            try {
              if (Date.now() - startTime > PIPELINE_TIMEOUT) {
                if (pipelinePollingRef.current) {
                  clearInterval(pipelinePollingRef.current);
                  pipelinePollingRef.current = null;
                }
                setPipelinePolling(false);
                reject(new Error("数据采集超时（已等待 5 分钟）"));
                return;
              }
              const resp = await getPipelineStatus();
              const status = resp.data?.status;
              if (status === "completed" || status === "failed") {
                if (pipelinePollingRef.current) {
                  clearInterval(pipelinePollingRef.current);
                  pipelinePollingRef.current = null;
                }
                setPipelinePolling(false);
                if (status === "failed") {
                  reject(new Error("数据采集失败，请检查流水线状态"));
                } else {
                  resolve();
                }
              }
            } catch (e) {
              console.error("Pipeline polling failed", errMsg(e));
            }
          }, PIPELINE_POLL_INTERVAL);
        });
      }

      setTriggerStep("generating");
      await triggerElastiCacheHealthCheck();
      await fetchData();
      startPolling();
      setTriggerStep("done");
    } catch (e) {
      console.error("Failed to trigger health check", errMsg(e));
      setTriggerStep("error");
      setTriggerError(e instanceof Error ? e.message : "操作失败");
      setTriggering(false);
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedItems.length === 0) return;
    setDeleting(true);
    try {
      await deleteElastiCacheHealthCheckBatch(selectedItems.map((i) => ({ date: i.report_date, type: i.report_type, account: i.account_id ?? undefined })));
      setSelectedItems([]);
      await fetchData();
    } catch (e) {
      console.error("Failed to delete reports", errMsg(e));
    } finally {
      setDeleting(false);
    }
  };

  const columns = useMemo(
    () => [
      {
        id: "report_date",
        header: "报告日期",
        cell: (item: HealthCheckItem) => item.report_date,
        width: 120,
      },
      {
        id: "report_type",
        header: "报告类型",
        cell: (item: HealthCheckItem) =>
          item.report_type === "summary" ? "汇总" : "按账户",
        width: 100,
      },
      {
        id: "account_id",
        header: "账户 ID",
        cell: (item: HealthCheckItem) => item.account_id ?? "-",
        width: 140,
      },
      {
        id: "total_instances",
        header: "实例总数",
        cell: (item: HealthCheckItem) =>
          item.total_instances != null ? String(item.total_instances) : "-",
        width: 100,
      },
      {
        id: "critical_count",
        header: "Critical",
        cell: (item: HealthCheckItem) =>
          item.critical_count != null ? (
            <Box color="text-status-error">{item.critical_count}</Box>
          ) : (
            "-"
          ),
        width: 90,
      },
      {
        id: "warning_count",
        header: "Warning",
        cell: (item: HealthCheckItem) =>
          item.warning_count != null ? (
            <Box color="text-status-warning">{item.warning_count}</Box>
          ) : (
            "-"
          ),
        width: 90,
      },
      {
        id: "attention_count",
        header: "Attention",
        cell: (item: HealthCheckItem) =>
          item.attention_count != null ? (
            <Box color="text-status-info">{item.attention_count}</Box>
          ) : (
            "-"
          ),
        width: 90,
      },
      {
        id: "status",
        header: "状态",
        cell: (item: HealthCheckItem) => {
          if (item.status === "generating") {
            return (
              <SpaceBetween direction="horizontal" size="xs">
                <Spinner size="normal" />
                <span>生成中</span>
              </SpaceBetween>
            );
          }
          if (item.status === "completed") {
            return <StatusIndicator type="success">已完成</StatusIndicator>;
          }
          if (item.status === "failed") {
            return <StatusIndicator type="error">失败</StatusIndicator>;
          }
          if (item.status === "skipped") {
            return <StatusIndicator type="info">已跳过</StatusIndicator>;
          }
          return item.status ?? "-";
        },
        width: 120,
      },
    ],
    []
  );

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            {selectedItems.length > 0 && (
              <Button
                onClick={handleDeleteSelected}
                loading={deleting}
              >
                删除所选 ({selectedItems.length})
              </Button>
            )}
            <Button
              onClick={() => {
                setTriggerMode("report-only");
                setTriggerStep("idle");
                setTriggerError("");
                setShowTriggerModal(true);
              }}
              loading={triggering}
              variant="primary"
            >
              生成最新报告
            </Button>
            <Button onClick={() => navigate("/settings/ai-config")}>
              设置
            </Button>
          </SpaceBetween>
        }
        description="AI 驱动的 ElastiCache 健康巡检报告"
      >
        ElastiCache AI 智能巡检
      </Header>

      {/* 汇总卡片 */}
      <Container>
        <ColumnLayout columns={4} variant="text-grid">
          <div>
            <Box variant="awsui-key-label">总实例数</Box>
            <Box variant="awsui-value-large">{summary.total_instances}</Box>
          </div>
          <div>
            <Box variant="awsui-key-label">严重问题</Box>
            <Box variant="awsui-value-large" color="text-status-error">
              {summary.critical_count}
            </Box>
          </div>
          <div>
            <Box variant="awsui-key-label">警告</Box>
            <Box variant="awsui-value-large" color="text-status-warning">
              {summary.warning_count}
            </Box>
          </div>
          <div>
            <Box variant="awsui-key-label">关注</Box>
            <Box variant="awsui-value-large" color="text-status-info">
              {summary.attention_count}
            </Box>
          </div>
        </ColumnLayout>
      </Container>

      {/* 筛选栏 */}
      <Container>
        <SpaceBetween direction="horizontal" size="l">
          <Toggle
            checked={showLatestOnly}
            onChange={({ detail }) => {
              setShowLatestOnly(detail.checked);
              setPage(1);
            }}
          >
            显示最新
          </Toggle>
          <Input
            value={reportDate}
            onChange={({ detail }) => setReportDate(detail.value)}
            placeholder="报告日期 (YYYY-MM-DD)"
          />
        </SpaceBetween>
      </Container>

      {/* 报告列表 */}
      {loading ? (
        <Box textAlign="center" padding="xxl">
          <Spinner size="large" />
        </Box>
      ) : (
        <Table
          items={pagedItems}
          columnDefinitions={columns}
          variant="full-page"
          stickyHeader
          trackBy={(item) => item.id ?? `${item.report_date}_${item.report_type}_${item.account_id ?? ""}`}
          selectionType="multi"
          selectedItems={selectedItems}
          onSelectionChange={({ detail }) =>
            setSelectedItems(detail.selectedItems as HealthCheckItem[])
          }
          onRowClick={({ detail }) =>
            navigate(`/elasticache-health-check/${detail.item.id ?? detail.item.report_date}`)
          }
          empty={
            <Box textAlign="center" padding="xxl">
              暂无 AI 巡检报告
            </Box>
          }
          header={
            <Header counter={`(${total})`}>AI 巡检报告列表</Header>
          }
          pagination={
            <SpaceBetween direction="horizontal" size="xs">
              <Select
                selectedOption={
                  PAGE_SIZE_OPTIONS.find(
                    (o) => o.value === String(pageSize)
                  ) ?? PAGE_SIZE_OPTIONS[0]
                }
                onChange={({ detail }) => {
                  setPageSize(Number(detail.selectedOption.value));
                  setPage(1);
                }}
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

      {/* 生成报告弹窗 */}
      <Modal
        visible={showTriggerModal}
        onDismiss={() => {
          setShowTriggerModal(false);
        }}
        header="生成巡检报告"
        footer={
          triggerStep === "idle" ? (
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setShowTriggerModal(false)}>
                  取消
                </Button>
                <Button variant="primary" onClick={handleTrigger}>
                  确认
                </Button>
              </SpaceBetween>
            </Box>
          ) : (
            <Box float="right">
              <Button
                variant={triggerStep === "done" || triggerStep === "error" ? "primary" : "link"}
                onClick={() => setShowTriggerModal(false)}
              >
                {triggerStep === "done" || triggerStep === "error" ? "关闭" : "后台运行"}
              </Button>
            </Box>
          )
        }
      >
        {triggerStep === "idle" ? (
          <SpaceBetween size="m">
            <RadioGroup
              value={triggerMode}
              onChange={({ detail }) => setTriggerMode(detail.value)}
              items={[
                {
                  value: "report-only",
                  label: "仅生成报告",
                  description: "基于上次采集的数据生成巡检报告，不拉取最新监控指标",
                },
                {
                  value: "collect-and-report",
                  label: "拉取新数据并生成报告",
                  description: "先触发数据采集流水线获取最新监控指标，完成后自动生成巡检报告（预计需要数分钟）",
                },
              ]}
            />
          </SpaceBetween>
        ) : (
          <SpaceBetween size="s">
            {triggerMode === "collect-and-report" && (
              <StatusIndicator
                type={
                  triggerStep === "collecting" ? "in-progress"
                    : triggerStep === "error" && pipelinePolling ? "error"
                    : "success"
                }
              >
                {triggerStep === "collecting" ? "正在采集最新监控数据..." : "数据采集完成"}
              </StatusIndicator>
            )}
            <StatusIndicator
              type={
                triggerStep === "generating" ? "in-progress"
                  : triggerStep === "done" ? "success"
                  : triggerStep === "error" ? (triggerMode === "collect-and-report" && !pipelinePolling ? "error" : "pending")
                  : "pending"
              }
            >
              {triggerStep === "generating" ? "正在生成巡检报告..."
                : triggerStep === "done" ? "报告生成已提交，列表将自动刷新"
                : "生成报告"}
            </StatusIndicator>
            {triggerStep === "error" && (
              <Box color="text-status-error" variant="p">{triggerError}</Box>
            )}
            {(triggerStep === "collecting" || triggerStep === "generating") && (
              <Box color="text-body-secondary" variant="small">
                可以点击"后台运行"关闭此窗口，任务会继续执行
              </Box>
            )}
          </SpaceBetween>
        )}
      </Modal>
    </SpaceBetween>
  );
}
