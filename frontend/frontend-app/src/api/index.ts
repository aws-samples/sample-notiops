/**
 * API 调用封装。
 */
import client from "./client";

// Dashboard
export const getDashboardSummary = (params?: Record<string, string>) =>
  client.get("/dashboard/summary", { params });
export const getDashboardPipeline = () =>
  client.get("/dashboard/pipeline");

// Waste Report
export const getWasteReportList = (params?: Record<string, string>) =>
  client.get("/waste-report", { params });
export const getWasteReportDetail = (accountId: string, instanceId: string) =>
  client.get(`/waste-report/${accountId}/${instanceId}`);
export const exportWasteReportCSV = (params?: Record<string, string>) =>
  client.get("/waste-report/export", { params, responseType: "blob" });

// Whitelist
export const getWhitelist = () => client.get("/whitelist");
export const addWhitelist = (data: {
  instance_id: string;
  account_id?: string;
  resource_type: string;
  reason?: string;
  expires_days?: number;
}) => client.post("/whitelist", data);
export const addWhitelistBatch = (data: {
  items: { instance_id: string; account_id: string; resource_type: string }[];
  reason: string;
  expires_days?: number;
}) => client.post("/whitelist", data);
export const removeWhitelist = (data: { instance_id: string; account_id: string }) =>
  client.delete("/whitelist", { data });
export const removeWhitelistBatch = (items: { instance_id: string; account_id: string }[]) =>
  client.delete("/whitelist/batch", { data: { items } });
export const updateWhitelistExpiry = (data: { instance_id: string; account_id: string; expires_days: number | null }) =>
  client.patch("/whitelist", data);

// Threshold Config
export const getThresholdConfigs = () => client.get("/threshold-config");
export const createThresholdConfig = (data: Record<string, unknown>) =>
  client.post("/threshold-config", data);
export const updateThresholdConfig = (
  resourceType: string,
  data: Record<string, unknown>,
) => client.put(`/threshold-config/${resourceType}`, data);
export const deleteThresholdConfig = (resourceType: string) =>
  client.delete(`/threshold-config/${resourceType}`);

// Optimization Report
export const getOptimizationReportList = (params?: Record<string, string>) =>
  client.get("/optimization-report", { params });
export const getOptimizationReportDetail = (id: number) =>
  client.get(`/optimization-report/${id}`);
export const exportOptimizationReportCSV = (params?: Record<string, string>) =>
  client.get("/optimization-report/export", { params, responseType: "blob" });

// Target Accounts
export const getTargetAccounts = () => client.get("/target-accounts");
export const addTargetAccount = (data: Record<string, unknown>) =>
  client.post("/target-accounts", data);
export const updateTargetAccount = (
  accountId: string,
  data: Record<string, unknown>,
) => client.put(`/target-accounts/${accountId}`, data);
export const deleteTargetAccount = (accountId: string) =>
  client.delete(`/target-accounts/${accountId}`);

// Org 一键账号接入（Organizations + StackSets）
export const getOrgAccounts = () => client.get("/org-onboard/accounts");
export const orgOnboardAccount = (data: { account_id: string; regions: string[] }) =>
  client.post("/org-onboard", data);
export const getOrgOnboardStatus = (operationId: string, accountId: string) =>
  client.get(`/org-onboard/status/${operationId}`, { params: { account_id: accountId } });

// EC2 Underutilized
export const getEc2UnderutilizedList = (params?: Record<string, string>) =>
  client.get("/ec2-underutilized", { params });
export const getEc2UnderutilizedDetail = (accountId: string, instanceId: string) =>
  client.get(`/ec2-underutilized/${accountId}/${instanceId}`);
export const exportEc2UnderutilizedCSV = (params?: Record<string, string>) =>
  client.get("/ec2-underutilized/export", { params, responseType: "blob" });


// RDS Health Check
export const getRdsHealthCheckList = (params?: Record<string, string>) =>
  client.get("/rds-health-check", { params });
export const getRdsHealthCheckDetail = (reportId: string) =>
  client.get(`/rds-health-check/${reportId}`);
export const getRdsHealthCheckLatest = () =>
  client.get("/rds-health-check/latest");
export const triggerRdsHealthCheck = () =>
  client.post("/rds-health-check/trigger");
export const deleteRdsHealthCheckBatch = (items: { date: string; type?: string; account?: string }[]) =>
  client.delete("/rds-health-check/batch", { data: { items } });
export const getRdsHealthCheckConfig = () =>
  client.get("/rds-health-check/config");
export const updateRdsHealthCheckConfig = (data: Record<string, unknown>) =>
  client.put("/rds-health-check/config", data);
export const getRdsHealthCheckModels = () =>
  client.get("/rds-health-check/models");

// Health Check Whitelist
export const getHealthCheckWhitelist = (params?: Record<string, string>) =>
  client.get("/health-check-whitelist", { params });
export const getHealthCheckWhitelistInstances = (params?: Record<string, string>) =>
  client.get("/health-check-whitelist/instances", { params });
export const addHealthCheckWhitelist = (data: {
  instance_id?: string;
  account_id?: string;
  resource_type: string;
  reason?: string;
  expires_days?: number;
}) => client.post("/health-check-whitelist", data);
export const addHealthCheckWhitelistBatch = (data: {
  items: { instance_id: string; account_id: string }[];
  resource_type: string;
  reason?: string;
  expires_days?: number;
}) => client.post("/health-check-whitelist/batch", data);
export const deleteHealthCheckWhitelist = (data: { instance_id: string; account_id: string; resource_type: string }) =>
  client.delete("/health-check-whitelist", { data });
export const deleteHealthCheckWhitelistBatch = (items: { instance_id: string; account_id: string; resource_type: string }[]) =>
  client.delete("/health-check-whitelist/batch", { data: { items } });
export const updateHealthCheckWhitelistExpiry = (data: { instance_id: string; account_id: string; resource_type: string; expires_days: number | null }) =>
  client.patch("/health-check-whitelist", data);

// Pipeline
export const triggerPipeline = () =>
  client.post("/pipeline/trigger");
export const getPipelineStatus = () =>
  client.get("/pipeline/status");

// ElastiCache Health Check
export const getElastiCacheHealthCheckList = (params?: Record<string, string>) =>
  client.get("/elasticache-health-check", { params });
export const getElastiCacheHealthCheckDetail = (reportId: string) =>
  client.get(`/elasticache-health-check/${reportId}`);
export const triggerElastiCacheHealthCheck = () =>
  client.post("/elasticache-health-check/trigger");
export const deleteElastiCacheHealthCheckBatch = (items: { date: string; type?: string; account?: string }[]) =>
  client.delete("/elasticache-health-check/batch", { data: { items } });
export const getElastiCacheHealthCheckConfig = () =>
  client.get("/elasticache-health-check/config");
export const updateElastiCacheHealthCheckConfig = (data: Record<string, unknown>) =>
  client.put("/elasticache-health-check/config", data);
export const getElastiCacheHealthCheckModels = () =>
  client.get("/elasticache-health-check/models");

// Notification Config
export const getNotificationConfig = () =>
  client.get("/notification-config");
export const updateNotificationConfig = (data: Record<string, unknown>) =>
  client.put("/notification-config", data);
export const testNotificationSend = (data: { platform: string; chat_id: string }) =>
  client.post("/notification-config/test", data);

// DevOps Agent 多账户（spec: devops-agent-per-account-architecture）
export const getDevopsAgentAccounts = () =>
  client.get("/devops-agent/accounts");
export const getDevopsAgentAccount = (accountId: string) =>
  client.get(`/devops-agent/accounts/${accountId}`);
export const createDevopsAgentAccount = (data: {
  account_id: string;
  account_alias: string;
  region: string;
  related_business_accounts?: string[];
}) => client.post("/devops-agent/accounts", data);
export const generateOnboardingTemplate = (accountId: string) =>
  client.post(`/devops-agent/accounts/${accountId}/generate-template`);
export const saveOnboardingPayload = (accountId: string, payload: string) =>
  client.post(`/devops-agent/accounts/${accountId}/onboarding-payload`, { payload });
export const testDevopsAgentConnection = (accountId: string) =>
  client.post(`/devops-agent/accounts/${accountId}/test-connection`);
export const enableDevopsAgentAccount = (accountId: string) =>
  client.post(`/devops-agent/accounts/${accountId}/enable`);
export const disableDevopsAgentAccount = (accountId: string) =>
  client.post(`/devops-agent/accounts/${accountId}/disable`);
export const deleteDevopsAgentAccount = (accountId: string) =>
  client.delete(`/devops-agent/accounts/${accountId}`);
export const updateDevopsAgentContext = (accountId: string, data: {
  terms?: string; preferences?: string; known_issues?: string; contacts?: string;
}) => client.put(`/devops-agent/accounts/${accountId}/context`, data);
export const getDevopsAgentInvestigations = (params?: Record<string, string>) =>
  client.get("/devops-agent/investigations", { params });
export const getDevopsAgentInvestigationDetail = (taskId: string) =>
  client.get(`/devops-agent/investigations/${taskId}`);
export const getDevopsAgentConfig = () =>
  client.get("/devops-agent/config");
export const updateDevopsAgentConfig = (data: {
  bedrock_model_id?: string; agent_prompt?: string;
}) => client.put("/devops-agent/config", data);

// Agent Config (飞书 AI 助手模型 — spec: agent-model-config-integration)
export const getAgentConfig = () => client.get("/agent-config");
export const getAgentConfigModels = () => client.get("/agent-config/models");
export const putAgentConfig = (data: { model_id: string }) =>
  client.put("/agent-config", data);

// ─── System Config: LLM Provider 切换 ────────────────────────────────
// Bedrock 与 LiteLLM Proxy 共存,运行时切换。
export interface LlmProviderConfig {
  provider: "bedrock" | "litellm";
  provider_source: "ssm" | "default";
  litellm: {
    base_url: string;
    default_model: string;
    api_key_masked: string;
  };
  parameter_name: string;
  litellm_secret_id: string;
}

export const getLlmProvider = () =>
  client.get<LlmProviderConfig>("/system-config/llm-provider");

export const putLlmProvider = (data: { provider: "bedrock" | "litellm" }) =>
  client.put("/system-config/llm-provider", data);

export const putLiteLlmConfig = (data: {
  base_url?: string;
  api_key?: string;
  default_model?: string;
}) => client.put("/system-config/litellm-config", data);

export const testLiteLlm = (data?: {
  base_url?: string;
  api_key?: string;
  model?: string;
}) => client.post("/system-config/litellm-test", data ?? {});

export interface LiteLlmModel {
  id: string;
  provider: "bedrock" | "anthropic" | "groq" | "openai" | "other";
}
export interface LiteLlmModelsResponse {
  models: LiteLlmModel[];
  default_model: string;
  base_url: string;
  reason?: string;
}
export const getLiteLlmModels = () =>
  client.get<LiteLlmModelsResponse>("/system-config/litellm-models");

