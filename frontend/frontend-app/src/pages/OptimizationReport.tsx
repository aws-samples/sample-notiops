/**
 * 潜在优化资源报告 — 总览页面。
 * 展示各服务的汇总统计，点击可跳转到对应服务的详细报告。
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
import { getOptimizationReportList } from "../api";
import { errMsg } from "../utils/errMsg";

interface ServiceSummary {
  service: string;
  label: string;
  count: number;
  cost: number;
  href: string;
  ready: boolean;
}

export default function OptimizationReport() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [totalCount, setTotalCount] = useState(0);
  const [totalCost, setTotalCost] = useState(0);
  const [services, setServices] = useState<ServiceSummary[]>([]);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const resp = await getOptimizationReportList({ page_size: "10000" });
      const items = resp.data.items || [];
      setTotalCount(items.length);
      setTotalCost(resp.data.total_cost || 0);

      // 按 resource_type 分组统计
      const rdsItems = items.filter((i: { resource_type: string }) => i.resource_type === "rds");
      const ecItems = items.filter((i: { resource_type: string }) => i.resource_type === "elasticache");
      const rdsCost = rdsItems.reduce((s: number, i: { estimated_monthly_cost: number }) => s + (i.estimated_monthly_cost || 0), 0);
      const ecCost = ecItems.reduce((s: number, i: { estimated_monthly_cost: number }) => s + (i.estimated_monthly_cost || 0), 0);

      setServices([
        { service: "rds", label: "RDS", count: rdsItems.length, cost: rdsCost, href: "/optimization-report/rds", ready: true },
        { service: "elasticache", label: "ElastiCache", count: ecItems.length, cost: ecCost, href: "/optimization-report/elasticache", ready: true },
        { service: "ec2", label: "EC2", count: 0, cost: 0, href: "/optimization-report/ec2", ready: false },
        { service: "elb", label: "ELB", count: 0, cost: 0, href: "/optimization-report/elb", ready: false },
        { service: "ebs", label: "EBS", count: 0, cost: 0, href: "/optimization-report/ebs", ready: false },
      ]);
    } catch (e) {
      console.error("Failed to load optimization report", errMsg(e));
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
        description="路径 B — 容量审计：按服务分类查看存储/内存/计算过大的非闲置资源">
        潜在优化资源报告
      </Header>

      <Container>
        <ColumnLayout columns={2} variant="text-grid">
          <div><Box variant="awsui-key-label">总优化资源数</Box><Box variant="awsui-value-large">{totalCount}</Box></div>
          <div><Box variant="awsui-key-label">总月度成本</Box><Box variant="awsui-value-large">${totalCost.toFixed(2)}</Box></div>
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
                  <div><Box variant="awsui-key-label">月度成本</Box><Box>${item.cost.toFixed(2)}</Box></div>
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
