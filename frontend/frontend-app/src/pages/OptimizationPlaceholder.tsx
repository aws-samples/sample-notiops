/**
 * 占位页面 — 尚未实现的服务优化报告。
 */
import { Box, Container, Header, SpaceBetween, StatusIndicator } from "@cloudscape-design/components";

interface Props {
  serviceName: string;
}

export default function OptimizationPlaceholder({ serviceName }: Props) {
  return (
    <SpaceBetween size="l">
      <Header variant="h1">{serviceName} 潜在优化资源</Header>
      <Container>
        <Box textAlign="center" padding="xxl">
          <SpaceBetween size="m" alignItems="center">
            <StatusIndicator type="info">即将推出</StatusIndicator>
            <Box variant="p" color="text-body-secondary">
              {serviceName} 容量审计功能正在开发中，敬请期待。
            </Box>
          </SpaceBetween>
        </Box>
      </Container>
    </SpaceBetween>
  );
}
