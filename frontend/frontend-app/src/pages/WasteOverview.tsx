/**
 * 闲置资源报告 — 总览页面。
 * 按服务分类展示汇总统计，点击可跳转到对应服务的详细报告。
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Box,
  Button,
  Cards,
  ColumnLayout,
  Container,
  Header,
  SpaceBetween,
  Spinner,
  StatusIndicator,
} from "@cloudscape-design/components";
import { getWasteReportList, getEc2UnderutilizedList } from "../api";
import { errMsg } from "../utils/errMsg";

interface ServiceSummary {
  service: string;
  label: string;
  count: number;
  savings: number;
  href: string;
  ready: boolean;
}

export default function WasteOverview() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [totalCount, setTotalCount] = useState(0);
  const [totalSavings, setTotalSavings] = useState(0);
  const [services, setServices] = useState<ServiceSummary[]>([]);

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const resp = await getWasteReportList({ page: "1", page_size: "10000" });
      const items = resp.data.items ?? resp.data ?? [];
      setTotalCount(items.length);
      setTotalSavings(resp.data.total_savings || 0);

      const rdsItems = items.filter((i: { resource_type: string }) => i.resource_type === "rds");
      const ecItems = items.filter((i: { resource_type: string }) => i.resource_type === "elasticache");
      const rdsSavings = rdsItems.reduce((s: number, i: { estimated_monthly_savings: number }) => s + (i.estimated_monthly_savings || 0), 0);
      const ecSavings = ecItems.reduce((s: number, i: { estimated_monthly_savings: number }) => s + (i.estimated_monthly_savings || 0), 0);

      // 拉取 EC2 低利用率数据
      let ec2Count = 0;
      let ec2Savings = 0;
      try {
        const ec2Resp = await getEc2UnderutilizedList({ page: "1", page_size: "10000" });
        const ec2Items = ec2Resp.data.items ?? [];
        ec2Count = ec2Resp.data.total ?? ec2Items.length;
        ec2Savings = (ec2Resp.data.total_classic_savings ?? 0) + (ec2Resp.data.total_costhub_savings ?? 0);
      } catch {
        // EC2 API 失败不影响其他服务展示
      }

      setTotalCount(items.length + ec2Count);
      setTotalSavings((resp.data.total_savings || 0) + ec2Savings);

      setServices([
        { service: "rds", label: "RDS", count: rdsItems.length, savings: rdsSavings, href: "/waste-report/rds", ready: true },
        { service: "elasticache", label: "ElastiCache", count: ecItems.length, savings: ecSavings, href: "/waste-report/elasticache", ready: true },
        { service: "ec2", label: "EC2", count: ec2Count, savings: ec2Savings, href: "/waste-report/ec2", ready: true },
        { service: "elb", label: "ELB", count: 0, savings: 0, href: "/waste-report/elb", ready: false },
        { service: "ebs", label: "EBS", count: 0, savings: 0, href: "/waste-report/ebs", ready: false },
      ]);
    } catch (e) {
      console.error("Failed to load waste report", errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <Box textAlign="center" padding="xxl"><Spinner size="large" /></Box>;
  }

  return (
    <SpaceBetween size="l">
      <Header variant="h1" actions={<Button onClick={fetchData} iconName="refresh">刷新</Button>}
        description="路径 A — 闲置检测：按服务分类查看闲置资源">
        闲置资源报告
      </Header>

      <Container>
        <ColumnLayout columns={2} variant="text-grid">
          <div><Box variant="awsui-key-label">总闲置资源数</Box><Box variant="awsui-value-large">{totalCount}</Box></div>
          <div><Box variant="awsui-key-label">预估总月度节省</Box><Box variant="awsui-value-large">${totalSavings.toFixed(2)}</Box></div>
        </ColumnLayout>
      </Container>

      <Cards
        items={services}
        cardDefinition={{
          header: (item) => (
            <SpaceBetween direction="horizontal" size="xs" alignItems="center">
              <Box variant="h3">{item.label}</Box>
              {!item.ready && <StatusIndicator type="info">即将推出</StatusIndicator>}
            </SpaceBetween>
          ),
          sections: [
            {
              id: "stats",
              content: (item) => (
                <ColumnLayout columns={2} variant="text-grid">
                  <div><Box variant="awsui-key-label">资源数</Box><Box>{item.count}</Box></div>
                  <div><Box variant="awsui-key-label">预估月度节省</Box><Box>${item.savings.toFixed(2)}</Box></div>
                </ColumnLayout>
              ),
            },
            {
              id: "action",
              content: (item) => (
                <Button variant={item.ready ? "primary" : "normal"} disabled={!item.ready && item.count === 0}
                  onClick={() => navigate(item.href)}>
                  {item.ready ? "查看详情" : "敬请期待"}
                </Button>
              ),
            },
          ],
        }}
        header={<Header>服务分类</Header>}
      />
    </SpaceBetween>
  );
}
