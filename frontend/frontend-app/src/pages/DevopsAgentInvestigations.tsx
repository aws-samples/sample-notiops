/**
 * DevOps Agent 调查历史页面（R20.1 - R20.4）。
 *
 * 列表 + 过滤（account_id / alias / date range / title keyword）；
 * 点击行展开详情，summary_card 默认展示、summary_raw 折叠。
 */
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Box,
  Button,
  Container,
  ExpandableSection,
  FormField,
  Header,
  Input,
  Modal,
  Pagination,
  SpaceBetween,
  Spinner,
  StatusIndicator,
  Table,
  TextContent,
} from "@cloudscape-design/components";
import {
  getDevopsAgentInvestigations,
  getDevopsAgentInvestigationDetail,
} from "../api";

interface ItemRow {
  id: number;
  task_id: string;
  account_id: string;
  account_alias: string | null;
  title: string;
  source: string | null;
  status: string;
  model_id: string | null;
  created_at: string;
}

const STATUS: Record<string, { type: "success" | "error" | "warning" | "info"; label: string }> = {
  completed: { type: "success", label: "完成" },
  failed: { type: "error", label: "失败" },
  timed_out: { type: "warning", label: "超时" },
  pending: { type: "info", label: "进行中" },
};

const SOURCE_LABEL: Record<string, string> = {
  "notiops-cost-anomaly": "成本异常",
  "notiops-health-critical": "健康告警",
  "notiops-manual": "手动触发",
};

const PAGE_SIZE = 20;

export default function DevopsAgentInvestigations() {
  const [items, setItems] = useState<ItemRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const [filterAccount, setFilterAccount] = useState("");
  const [filterAlias, setFilterAlias] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [filterTitle, setFilterTitle] = useState("");

  const [detailVisible, setDetailVisible] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<any>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {
        limit: String(PAGE_SIZE),
        offset: String((page - 1) * PAGE_SIZE),
      };
      if (filterAccount.trim()) params.account_id = filterAccount.trim();
      if (filterAlias.trim()) params.account_alias = filterAlias.trim();
      if (filterDateFrom) params.date_from = filterDateFrom;
      if (filterDateTo) params.date_to = filterDateTo;
      if (filterTitle.trim()) params.title_keyword = filterTitle.trim();

      const res = await getDevopsAgentInvestigations(params);
      setItems(res.data?.items ?? []);
      setTotal(res.data?.total ?? 0);
    } catch {
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const handleApplyFilter = () => {
    setPage(1);
    fetchData();
  };

  const handleClearFilter = () => {
    setFilterAccount("");
    setFilterAlias("");
    setFilterDateFrom("");
    setFilterDateTo("");
    setFilterTitle("");
    setPage(1);
    setTimeout(fetchData, 0);
  };

  const openDetail = async (taskId: string) => {
    setDetailVisible(true);
    setDetailLoading(true);
    try {
      const res = await getDevopsAgentInvestigationDetail(taskId);
      setDetail(res.data);
    } catch (e: any) {
      setDetail({ error: e?.response?.data?.message ?? String(e) });
    } finally {
      setDetailLoading(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Container header={<Header variant="h1" description={`共 ${total} 条`}>DevOps Agent 调查历史</Header>}>
      <SpaceBetween size="m">
        {/* 过滤条件 */}
        <Box padding="m" variant="div">
          <SpaceBetween size="xs" direction="horizontal">
            <FormField label="Account ID">
              <Input value={filterAccount} onChange={(e) => setFilterAccount(e.detail.value)} placeholder="12 位数字" />
            </FormField>
            <FormField label="账户别名">
              <Input value={filterAlias} onChange={(e) => setFilterAlias(e.detail.value)} placeholder="模糊匹配" />
            </FormField>
            <FormField label="起始日期">
              <Input value={filterDateFrom} onChange={(e) => setFilterDateFrom(e.detail.value)} placeholder="YYYY-MM-DD" />
            </FormField>
            <FormField label="结束日期">
              <Input value={filterDateTo} onChange={(e) => setFilterDateTo(e.detail.value)} placeholder="YYYY-MM-DD" />
            </FormField>
            <FormField label="标题关键字">
              <Input value={filterTitle} onChange={(e) => setFilterTitle(e.detail.value)} placeholder="模糊匹配" />
            </FormField>
            <FormField label=" ">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="primary" onClick={handleApplyFilter}>查询</Button>
                <Button onClick={handleClearFilter}>清空</Button>
              </SpaceBetween>
            </FormField>
          </SpaceBetween>
        </Box>

        {loading ? <Spinner /> : (
          <>
            <Table
              columnDefinitions={[
                { id: "account", header: "账户", cell: (i) => i.account_alias || i.account_id },
                { id: "title", header: "标题", cell: (i) => <Button variant="inline-link" onClick={() => openDetail(i.task_id)}>{i.title}</Button> },
                { id: "source", header: "来源", cell: (i) => SOURCE_LABEL[i.source || ""] || i.source || "-" },
                { id: "status", header: "状态", cell: (i) => {
                  const s = STATUS[i.status] ?? { type: "info" as const, label: i.status };
                  return <StatusIndicator type={s.type}>{s.label}</StatusIndicator>;
                }},
                { id: "task_id", header: "Task ID", cell: (i) => <code>{i.task_id}</code> },
                { id: "created_at", header: "创建时间", cell: (i) => i.created_at?.slice(0, 19).replace("T", " ") || "-" },
              ]}
              items={items}
              trackBy="task_id"
              empty={<Box textAlign="center">暂无调查记录</Box>}
            />

            <Box float="right">
              <Pagination
                currentPageIndex={page}
                pagesCount={totalPages}
                onChange={(e) => setPage(e.detail.currentPageIndex)}
              />
            </Box>
          </>
        )}
      </SpaceBetween>

      {/* 详情 Modal */}
      <Modal
        visible={detailVisible}
        onDismiss={() => { setDetailVisible(false); setDetail(null); }}
        header="调查详情"
        size="large"
        footer={<Box float="right"><Button onClick={() => { setDetailVisible(false); setDetail(null); }}>关闭</Button></Box>}
      >
        {detailLoading ? <Spinner /> : detail ? (
          detail.error ? <Box color="text-status-error">{detail.error}</Box> : (
            <SpaceBetween size="m">
              <Box>
                <strong>{detail.title}</strong>
                <TextContent>
                  <p>
                    {(detail.account_alias || detail.account_id)} · {SOURCE_LABEL[detail.source] || detail.source} · task_id <code>{detail.task_id}</code>
                  </p>
                </TextContent>
              </Box>

              <Box>
                <Header variant="h3">精简卡片（Summary Card）</Header>
                <Box padding="s" variant="div">
                  {detail.summary_card ? (
                    <div className="markdown-report-content">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.summary_card}</ReactMarkdown>
                    </div>
                  ) : (
                    <Box color="text-status-inactive">(无)</Box>
                  )}
                </Box>
              </Box>

              <ExpandableSection headerText="完整报告 Full Report">
                <Box padding="s" variant="div">
                  {detail.report_content ? (
                    <div className="markdown-report-content" style={{ maxHeight: "500px", overflow: "auto" }}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.report_content}</ReactMarkdown>
                    </div>
                  ) : (
                    <Box color="text-status-inactive">(无)</Box>
                  )}
                </Box>
              </ExpandableSection>

              <Box>
                <TextContent>
                  <small>
                    model_id: <code>{detail.model_id || "-"}</code> · 创建时间 {detail.created_at?.slice(0, 19).replace("T", " ")}
                  </small>
                </TextContent>
              </Box>
            </SpaceBetween>
          )
        ) : null}
      </Modal>
    </Container>
  );
}
