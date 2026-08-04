/**
 * AI 配置页面 — 统一管理所有 AI 相关配置。
 *
 * Tab 1: AI 认证（LLM Provider 切换 + Bedrock API Key + LiteLLM 配置）
 * Tab 2: RDS 巡检（模型选择 + Agent Prompt）
 * Tab 3: ElastiCache 巡检（模型选择 + Agent Prompt）
 * Tab 4: DevOps Agent（模型选择 + Agent Prompt）
 * Tab 5: 巡检白名单
 */
import { useEffect, useState, useCallback, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Box,
  Button,
  Container,
  Flashbar,
  FormField,
  Header,
  Input,
  Modal,
  RadioGroup,
  Select,
  SpaceBetween,
  Table,
  Tabs,
  Textarea,
  Alert,
  StatusIndicator,
  type SelectProps,
  type FlashbarProps,
} from "@cloudscape-design/components";
import {
  getRdsHealthCheckConfig,
  updateRdsHealthCheckConfig,
  getRdsHealthCheckModels,
  getElastiCacheHealthCheckConfig,
  updateElastiCacheHealthCheckConfig,
  getDevopsAgentConfig,
  updateDevopsAgentConfig,
  getHealthCheckWhitelist,
  getHealthCheckWhitelistInstances,
  addHealthCheckWhitelist,
  addHealthCheckWhitelistBatch,
  deleteHealthCheckWhitelist,
  deleteHealthCheckWhitelistBatch,
  updateHealthCheckWhitelistExpiry,
  getAgentConfig,
  getAgentConfigModels,
  putAgentConfig,
  getLlmProvider,
  putLlmProvider,
  putLiteLlmConfig,
  testLiteLlm,
  getLiteLlmModels,
  type LiteLlmModel,
} from "../api";
import { errMsg } from "../utils/errMsg";

// ─── 常量 ───────────────────────────────────────────────
const CUSTOM_MODEL_VALUE = "__custom__";
const FLASH_DISMISS_MS = 3000;

// ─── 类型 ───────────────────────────────────────────────
interface ModelOption {
  model_id: string;
  model_name: string;
}

interface WhitelistItem {
  instance_id: string;
  account_id: string | null;
  resource_type: string;
  reason: string | null;
  created_at: string | null;
  expires_at: string | null;
}

type ResourceTypeFilter = "rds" | "elasticache" | "all";

const RESOURCE_TYPE_OPTIONS: SelectProps.Options = [
  { label: "RDS", value: "rds" },
  { label: "ElastiCache", value: "elasticache" },
  { label: "全部", value: "all" },
];

// ─── 辅助 ────────────────────────────────────────────────

function formatRemaining(expiresAt: string | null): string {
  if (!expiresAt) return "永久";
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "已过期";
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
  return `${days} 天`;
}

// ─── 辅助 Hook ──────────────────────────────────────────

function useFlash() {
  const [items, setItems] = useState<FlashbarProps.MessageDefinition[]>([]);

  const show = useCallback(
    (type: FlashbarProps.Type, content: string) => {
      const id = String(Date.now());
      const msg: FlashbarProps.MessageDefinition = {
        type,
        content,
        id,
        dismissible: true,
        onDismiss: () =>
          setItems((prev) => prev.filter((m) => m.id !== id)),
      };
      setItems((prev) => [...prev, msg]);
      setTimeout(
        () => setItems((prev) => prev.filter((m) => m.id !== id)),
        FLASH_DISMISS_MS,
      );
    },
    [],
  );

  return { items, show };
}

// ─── 主组件 ─────────────────────────────────────────────
export default function AiSettings() {
  const flash = useFlash();
  const [providerVersion, setProviderVersion] = useState(0);

  const handleProviderChanged = useCallback(() => {
    setProviderVersion((v) => v + 1);
  }, []);

  return (
    <SpaceBetween size="l">
      <Header variant="h1">AI 配置</Header>

      <Flashbar items={flash.items} />

      <Tabs
        tabs={[
          {
            label: "AI 认证",
            id: "ai-auth",
            content: <AiAuthTab flash={flash} onProviderChanged={handleProviderChanged} />,
          },
          {
            label: "RDS 巡检",
            id: "rds",
            content: <ServiceConfigTab flash={flash} serviceType="rds" providerVersion={providerVersion} />,
          },
          {
            label: "ElastiCache 巡检",
            id: "elasticache",
            content: <ServiceConfigTab flash={flash} serviceType="elasticache" providerVersion={providerVersion} />,
          },
          {
            label: "DevOps Agent",
            id: "devops-agent",
            content: <DevOpsAgentTab flash={flash} providerVersion={providerVersion} />,
          },
          {
            label: "IM Bot 模型",
            id: "agent-model",
            content: <AgentModelTab flash={flash} providerVersion={providerVersion} />,
          },
          {
            label: "巡检白名单",
            id: "whitelist",
            content: <WhitelistTab flash={flash} />,
          },
        ]}
      />
    </SpaceBetween>
  );
}

// ─── Tab Props ──────────────────────────────────────────
interface TabProps {
  flash: ReturnType<typeof useFlash>;
  providerVersion?: number;
}

interface AiAuthTabProps extends TabProps {
  onProviderChanged?: () => void;
}

// ─── Tab 1: Bedrock 认证 ────────────────────────────────
function BedrockAuthTab({ flash }: TabProps) {
  const [apiKey, setApiKey] = useState("");
  const [apiKeyMasked, setApiKeyMasked] = useState("");
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getRdsHealthCheckConfig()
      .then((resp) => {
        if (cancelled) return;
        setApiKeyMasked(resp.data.bedrock_api_key_masked ?? "");
        setApiKeyConfigured(resp.data.bedrock_api_key_configured ?? false);
      })
      .catch((e) => {
        console.error("Failed to load API key config", errMsg(e));
        flash.show("error", "加载 API Key 配置失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    if (!apiKey.trim()) {
      flash.show("error", "请输入 API Key");
      return;
    }
    setSaving(true);
    try {
      await updateRdsHealthCheckConfig({ bedrock_api_key: apiKey.trim() });
      flash.show("success", "API Key 已保存");
      setApiKeyConfigured(true);
      setApiKeyMasked("****" + apiKey.slice(-4));
      setApiKey("");
    } catch (e) {
      console.error("Failed to save API key", errMsg(e));
      flash.show("error", "保存 API Key 失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Container header={<Header variant="h2">Bedrock 认证</Header>}>
      <SpaceBetween size="l">
        <Alert type="info">
          此 API Key 全局共享，影响所有 AI 功能（巡检、DevOps Agent、PHD 翻译等）。
          API Key 为空时将使用当前账号 IAM 凭证调用 Bedrock。
        </Alert>

        <FormField
          label="Bedrock API Key"
          description={
            apiKeyConfigured
              ? `当前已配置: ${apiKeyMasked}`
              : loading
                ? "加载中..."
                : "未配置"
          }
        >
          <Input
            type="password"
            value={apiKey}
            onChange={({ detail }) => setApiKey(detail.value)}
            placeholder={apiKeyConfigured ? "留空则保留现值" : "输入 Bedrock API Key"}
          />
        </FormField>

        <Button variant="primary" onClick={handleSave} loading={saving} disabled={loading}>
          保存
        </Button>
      </SpaceBetween>
    </Container>
  );
}

// ─── Tab 1 (new): AI 认证 ── Bedrock + LiteLLM 共存 ──────
function AiAuthTab({ flash, onProviderChanged }: AiAuthTabProps) {
  // Provider 状态
  const [provider, setProvider] = useState<"bedrock" | "litellm">("bedrock");
  const [pendingProvider, setPendingProvider] = useState<"bedrock" | "litellm" | null>(null);
  const [providerSource, setProviderSource] = useState<"ssm" | "default">("default");
  const [providerSwitching, setProviderSwitching] = useState(false);
  const [showSwitchModal, setShowSwitchModal] = useState(false);

  // LiteLLM 配置
  const [litellmBaseUrl, setLitellmBaseUrl] = useState("");
  const [litellmApiKey, setLitellmApiKey] = useState(""); // 新输入,显示 *
  const [litellmApiKeyMasked, setLitellmApiKeyMasked] = useState(""); // 服务器返回的 mask
  const [litellmDefaultModel, setLitellmDefaultModel] = useState("");
  const [litellmModels, setLitellmModels] = useState<LiteLlmModel[]>([]);
  const [litellmModelsLoading, setLitellmModelsLoading] = useState(false);
  const [litellmModelsReason, setLitellmModelsReason] = useState<string | null>(null);
  const [litellmSaving, setLitellmSaving] = useState(false);
  const [litellmTesting, setLitellmTesting] = useState(false);
  const [litellmTestResult, setLitellmTestResult] = useState<null | {
    ok: boolean;
    reason?: string;
    content?: string;
    latency_ms?: number;
    model?: string;
  }>(null);

  const [loading, setLoading] = useState(true);

  // 稳定引用,避免 flash state 变化导致 reload/useEffect 循环触发
  const flashShow = flash.show;

  // 加载当前 provider + LiteLLM 配置
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await getLlmProvider();
      const d = resp.data;
      setProvider(d.provider);
      setPendingProvider(null);
      setProviderSource(d.provider_source);
      setLitellmBaseUrl(d.litellm.base_url ?? "");
      setLitellmApiKeyMasked(d.litellm.api_key_masked ?? "");
      setLitellmDefaultModel(d.litellm.default_model ?? "");
    } catch (e) {
      console.error("Failed to load LLM provider config", errMsg(e));
      flashShow("error", "加载 AI 认证配置失败");
    } finally {
      setLoading(false);
    }
  }, [flashShow]);

  // 单独 fetch 模型列表(LiteLLM Proxy 调用,可能慢一点 / 失败)
  const loadModels = useCallback(async () => {
    setLitellmModelsLoading(true);
    setLitellmModelsReason(null);
    try {
      const resp = await getLiteLlmModels();
      setLitellmModels(resp.data.models ?? []);
      if (resp.data.reason) setLitellmModelsReason(resp.data.reason);
    } catch (e) {
      console.error("Failed to fetch LiteLLM model list", errMsg(e));
      setLitellmModelsReason(
        (e as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? "加载模型列表失败",
      );
    } finally {
      setLitellmModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
    loadModels();
  }, [reload, loadModels]);

  // 切换确认 — 通过 Modal
  const handleConfirmSwitch = async () => {
    if (!pendingProvider || pendingProvider === provider || providerSwitching) return;
    setProviderSwitching(true);
    try {
      await putLlmProvider({ provider: pendingProvider });
      flash.show(
        "success",
        `LLM Provider 已切换到 ${pendingProvider === "litellm" ? "LiteLLM Proxy" : "Bedrock 直连"}。请到各 Tab 检查并更新模型配置。`,
      );
      await reload();
      onProviderChanged?.();
    } catch (e: unknown) {
      const msg =
        (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "切换失败";
      flash.show("error", msg);
    } finally {
      setProviderSwitching(false);
      setShowSwitchModal(false);
    }
  };

  const handleSaveLitellm = async () => {
    if (litellmSaving) return;
    if (!litellmBaseUrl.trim() && !litellmApiKey.trim() && !litellmDefaultModel.trim()) {
      flash.show("error", "至少填写一个字段才能保存");
      return;
    }
    setLitellmSaving(true);
    try {
      await putLiteLlmConfig({
        base_url: litellmBaseUrl.trim() || undefined,
        api_key: litellmApiKey.trim() || undefined,
        default_model: litellmDefaultModel.trim() || undefined,
      });
      flash.show("success", "LiteLLM 配置已保存");
      setLitellmApiKey("");
      await reload();
      await loadModels(); // base_url 可能改了 → 模型列表跟着刷
    } catch (e: unknown) {
      const msg =
        (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "保存失败";
      flash.show("error", msg);
    } finally {
      setLitellmSaving(false);
    }
  };

  const handleTestLitellm = async () => {
    setLitellmTesting(true);
    setLitellmTestResult(null);
    try {
      // 用表单当前值 + 下拉选中的模型测试（base_url 必填；api_key 这次没重输则
      // 省略 → 后端回退已存 key；model 用选中的拨号测试模型）。
      const resp = await testLiteLlm({
        base_url: litellmBaseUrl.trim() || undefined,
        api_key: litellmApiKey.trim() || undefined,
        model: litellmDefaultModel.trim() || undefined,
      });
      setLitellmTestResult(resp.data);
      if (resp.data.ok) {
        flash.show(
          "success",
          `LiteLLM 拨号成功(${resp.data.latency_ms}ms，模型 ${resp.data.model})`,
        );
      } else {
        flash.show("error", `LiteLLM 拨号失败：${resp.data.reason ?? "未知"}`);
      }
    } catch (e: unknown) {
      const msg =
        (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "拨号失败";
      flash.show("error", msg);
      setLitellmTestResult({ ok: false, reason: msg });
    } finally {
      setLitellmTesting(false);
    }
  };

  return (
    <SpaceBetween size="l">
      {/* ─── Provider 切换 ─── */}
      <Container header={<Header variant="h2">LLM Provider 切换</Header>}>
        <SpaceBetween size="m">
          <Alert type="info">
            选择 <b>Bedrock</b> 直连 AWS Bedrock（默认，需要本账户有 Bedrock 模型访问权限）；
            选择 <b>LiteLLM</b> 走兼容 OpenAI 协议的代理（需要先在下方填好 LiteLLM 配置）。
            切换后请到各 Tab 检查并更新模型配置。IM 机器人最多 5 分钟内生效。
          </Alert>

          <FormField
            label="当前 Provider"
            description={
              loading
                ? "加载中..."
                : providerSource === "ssm"
                  ? "已切换（写在 SSM Parameter）"
                  : "未切换 — 使用默认值 bedrock"
            }
          >
            {loading ? (
              <StatusIndicator type="loading">加载当前配置…</StatusIndicator>
            ) : (
              <RadioGroup
                value={pendingProvider ?? provider}
                onChange={({ detail }) =>
                  setPendingProvider(detail.value as "bedrock" | "litellm")
                }
                items={[
                  { value: "bedrock", label: "Bedrock（直连 AWS）", disabled: providerSwitching },
                  { value: "litellm", label: "LiteLLM Proxy（OpenAI 兼容）", disabled: providerSwitching },
                ]}
              />
            )}
          </FormField>

          <Button
            variant="primary"
            disabled={!pendingProvider || pendingProvider === provider || providerSwitching || loading}
            loading={providerSwitching}
            onClick={() => setShowSwitchModal(true)}
          >
            切换 Provider
          </Button>
        </SpaceBetween>
      </Container>

      {/* ─── Provider 切换确认 Modal ─── */}
      <Modal
        visible={showSwitchModal}
        onDismiss={() => setShowSwitchModal(false)}
        header="确认切换 LLM Provider"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setShowSwitchModal(false)}>取消</Button>
              <Button
                variant="primary"
                loading={providerSwitching}
                onClick={handleConfirmSwitch}
              >
                确认切换
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Box>
            {`确认切换到 ${pendingProvider === "litellm" ? "LiteLLM Proxy" : "Bedrock 直连"}？`}
          </Box>
          <Alert type="warning">
            切换后请到 RDS 巡检、ElastiCache 巡检、DevOps Agent、AgentCore Runtime 各 Tab 检查并更新模型配置。
            IM 机器人最多 5 分钟内生效。
          </Alert>
        </SpaceBetween>
      </Modal>

      {/* ─── Bedrock 认证(原内容) ─── */}
      <BedrockAuthTab flash={flash} />

      {/* ─── LiteLLM 配置 ─── */}
      <Container
        header={
          <Header
            variant="h2"
            description="走 OpenAI Chat Completions 协议的代理 — 适用于本账户没 Bedrock 直连或公司有统一网关的场景"
          >
            LiteLLM 认证
          </Header>
        }
      >
        <SpaceBetween size="l">
          <FormField
            label="Base URL"
            description="例如 https://litellm.example.com (不要包含 /v1 路径，系统会自动追加)"
          >
            <Input
              value={litellmBaseUrl}
              onChange={({ detail }) => setLitellmBaseUrl(detail.value)}
              placeholder="https://litellm.example.com"
              disabled={loading}
            />
          </FormField>

          <FormField
            label="API Key"
            description={
              litellmApiKeyMasked
                ? `当前已配置: ${litellmApiKeyMasked}（留空则保留现值）`
                : "Bearer Token，例如 sk-xxx"
            }
          >
            <Input
              type="password"
              value={litellmApiKey}
              onChange={({ detail }) => setLitellmApiKey(detail.value)}
              placeholder={
                litellmApiKeyMasked ? "留空则保留现值" : "sk-..."
              }
              disabled={loading}
            />
          </FormField>

          <FormField
            label="拨号测试模型"
            description={
              litellmModelsReason
                ? `仅用于下方"拨号测试"验证 Proxy 连通性,不影响各 Tab 的实际模型选择。⚠ ${litellmModelsReason}`
                : `仅用于下方"拨号测试"验证 Proxy 连通性,不影响各 Tab 的实际模型选择`
            }
          >
            {litellmModels.length > 0 ? (
              <SpaceBetween size="xs" direction="horizontal">
                <Select
                  selectedOption={
                    litellmDefaultModel
                      ? {
                          label: litellmDefaultModel,
                          value: litellmDefaultModel,
                          description:
                            litellmModels.find((m) => m.id === litellmDefaultModel)?.provider ?? "",
                        }
                      : null
                  }
                  onChange={({ detail }) =>
                    setLitellmDefaultModel(detail.selectedOption?.value ?? "")
                  }
                  options={[
                    { label: "── Bedrock ──", value: "__group_bedrock__", disabled: true },
                    ...litellmModels
                      .filter((m) => m.provider === "bedrock")
                      .map((m) => ({ label: m.id, value: m.id, description: "bedrock" })),
                    { label: "── Anthropic（直连）──", value: "__group_anthropic__", disabled: true },
                    ...litellmModels
                      .filter((m) => m.provider === "anthropic")
                      .map((m) => ({ label: m.id, value: m.id, description: "anthropic" })),
                    { label: "── Groq ──", value: "__group_groq__", disabled: true },
                    ...litellmModels
                      .filter((m) => m.provider === "groq")
                      .map((m) => ({ label: m.id, value: m.id, description: "groq" })),
                    { label: "── OpenAI / 其他 ──", value: "__group_other__", disabled: true },
                    ...litellmModels
                      .filter(
                        (m) => m.provider === "openai" || m.provider === "other",
                      )
                      .map((m) => ({
                        label: m.id,
                        value: m.id,
                        description: m.provider,
                      })),
                  ]}
                  filteringType="auto"
                  placeholder="选择默认模型（支持搜索）"
                  empty="没有可用模型"
                  expandToViewport
                  disabled={loading || litellmModelsLoading}
                />
                <Button
                  iconName="refresh"
                  onClick={loadModels}
                  loading={litellmModelsLoading}
                  variant="icon"
                  ariaLabel="刷新模型列表"
                />
              </SpaceBetween>
            ) : (
              <SpaceBetween size="xs" direction="horizontal">
                <Input
                  value={litellmDefaultModel}
                  onChange={({ detail }) => setLitellmDefaultModel(detail.value)}
                  placeholder="bedrock/global.anthropic.claude-opus-4-7"
                  disabled={loading}
                />
                <Button
                  iconName="refresh"
                  onClick={loadModels}
                  loading={litellmModelsLoading}
                  variant="icon"
                  ariaLabel="重试拉取模型列表"
                />
              </SpaceBetween>
            )}
          </FormField>

          <Alert type="info">
            <b>操作顺序</b>：
            <ol style={{ margin: "4px 0 0", paddingLeft: "20px" }}>
              <li>填写 <b>Base URL</b>（填代理根地址，不要带 <code>/v1</code> 或其他路径，系统会自动追加）+ <b>API Key</b></li>
              <li>点 <b>保存</b>（模型列表「刷新」读取的是已保存配置，需先保存一次）</li>
              <li>点模型框右侧 <b>刷新</b> 加载模型列表</li>
              <li>从列表选择 <b>拨号测试模型</b></li>
              <li>点 <b>拨号测试</b> 验证 Proxy 连通性</li>
            </ol>
            说明：<b>拨号测试</b>使用你当前填写 / 选择的值（改了 Base URL、API Key 或模型可直接测，无需先保存）；<b>刷新模型列表</b>读取已保存配置（改了 Base URL / Key 需重新保存再刷新）。<br />
            为什么刷新要先保存：刷新走 GET 请求，若直接用表单值会把 API Key 暴露在 URL 里并写进访问日志，出于安全考虑刷新只读已保存的配置。
          </Alert>

          <SpaceBetween size="xs" direction="horizontal">
            <Button
              variant="primary"
              onClick={handleSaveLitellm}
              loading={litellmSaving}
              disabled={loading}
            >
              保存
            </Button>
            <Button
              onClick={handleTestLitellm}
              loading={litellmTesting}
              disabled={loading || !litellmBaseUrl}
            >
              拨号测试
            </Button>
          </SpaceBetween>

          {litellmTestResult && (
            <Alert type={litellmTestResult.ok ? "success" : "error"}>
              {litellmTestResult.ok ? (
                <>
                  <StatusIndicator type="success">连通</StatusIndicator>{" "}
                  模型 <b>{litellmTestResult.model}</b>，延迟{" "}
                  {litellmTestResult.latency_ms}ms，返回：{" "}
                  <code>{litellmTestResult.content}</code>
                </>
              ) : (
                <>
                  <StatusIndicator type="error">失败</StatusIndicator>{" "}
                  {litellmTestResult.reason}
                </>
              )}
            </Alert>
          )}
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}

// ─── Tab 2 & 3: RDS / ElastiCache 巡检 ─────────────────
interface ServiceConfigTabProps extends TabProps {
  serviceType: "rds" | "elasticache";
  providerVersion?: number;
}

const SERVICE_API_MAP = {
  rds: { getConfig: getRdsHealthCheckConfig, updateConfig: updateRdsHealthCheckConfig },
  elasticache: { getConfig: getElastiCacheHealthCheckConfig, updateConfig: updateElastiCacheHealthCheckConfig },
};

const SERVICE_LABELS = {
  rds: "RDS",
  elasticache: "ElastiCache",
};

function ServiceConfigTab({ flash, serviceType, providerVersion }: ServiceConfigTabProps) {
  const { getConfig, updateConfig } = SERVICE_API_MAP[serviceType];
  const label = SERVICE_LABELS[serviceType];

  // 模型状态
  const [models, setModels] = useState<ModelOption[]>([]);
  const [llmProvider, setLlmProvider] = useState<"bedrock" | "litellm" | null>(null);
  const [litellmReason, setLitellmReason] = useState<string | null>(null);
  const [selectedValue, setSelectedValue] = useState<string>("");
  const [customModelId, setCustomModelId] = useState("");
  const [originalModelId, setOriginalModelId] = useState("");
  const [modelLoading, setModelLoading] = useState(true);
  const [modelSaving, setModelSaving] = useState(false);

  // Prompt 状态
  const [promptText, setPromptText] = useState("");
  const [promptLoading, setPromptLoading] = useState(true);
  const [promptSaving, setPromptSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const results = await Promise.allSettled([
        getConfig(),
        getRdsHealthCheckModels(),
      ]);
      if (cancelled) return;

      const [configResult, modelsResult] = results;

      // 处理模型列表
      let modelList: ModelOption[] = [];
      if (modelsResult.status === "fulfilled") {
        modelList = modelsResult.value.data.models ?? [];
        setModels(modelList);
        // 后端新加的 metadata,用于在 UI 上做"当前看的是哪个 provider 的模型列表"提示
        const data = modelsResult.value.data as {
          llm_provider?: "bedrock" | "litellm";
          litellm_reason?: string;
        };
        if (data.llm_provider) setLlmProvider(data.llm_provider);
        if (data.litellm_reason) setLitellmReason(data.litellm_reason);
      } else {
        console.error("Failed to load models", errMsg(modelsResult.reason));
        flash.show("error", "加载模型列表失败");
      }

      // 处理配置
      if (configResult.status === "fulfilled") {
        const modelId: string = configResult.value.data.bedrock_model_id ?? "";
        setOriginalModelId(modelId);
        const found = modelList.some((m) => m.model_id === modelId);
        if (found) {
          setSelectedValue(modelId);
        } else if (modelId) {
          setSelectedValue(CUSTOM_MODEL_VALUE);
          setCustomModelId(modelId);
        }
        setPromptText(configResult.value.data.agent_prompt ?? "");
      } else {
        console.error(`Failed to load ${label} config`, errMsg(configResult.reason));
        flash.show("error", `加载 ${label} 配置失败`);
      }

      if (!cancelled) {
        setModelLoading(false);
        setPromptLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [getConfig, providerVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const options: SelectProps.Options = [
    ...models.map((m) => ({
      label: m.model_name,
      value: m.model_id,
    })),
    { label: "自定义模型 ID", value: CUSTOM_MODEL_VALUE },
  ];

  const effectiveModelId =
    selectedValue === CUSTOM_MODEL_VALUE ? customModelId.trim() : selectedValue;

  const handleModelSave = async () => {
    if (!effectiveModelId) {
      flash.show("error", `请选择或输入 ${label} 模型 ID`);
      return;
    }
    if (effectiveModelId === originalModelId) {
      flash.show("info", "模型未变更");
      return;
    }
    setModelSaving(true);
    try {
      await updateConfig({ bedrock_model_id: effectiveModelId });
      setOriginalModelId(effectiveModelId);
      flash.show("success", `${label} 模型已保存`);
    } catch (e) {
      console.error(`Failed to save ${label} model`, errMsg(e));
      flash.show("error", `保存 ${label} 模型失败`);
    } finally {
      setModelSaving(false);
    }
  };

  const handlePromptSave = async () => {
    setPromptSaving(true);
    try {
      await updateConfig({ agent_prompt: promptText });
      flash.show("success", `${label} Agent Prompt 已保存`);
    } catch (e) {
      console.error(`Failed to save ${label} prompt`, errMsg(e));
      flash.show("error", `保存 ${label} Agent Prompt 失败`);
    } finally {
      setPromptSaving(false);
    }
  };

  return (
    <SpaceBetween size="l">
      {/* Provider 提示 — 让操作员知道"当前看的是哪边的模型列表" */}
      {llmProvider === "litellm" && (
        <Alert type="info">
          当前 LLM Provider 是 <b>LiteLLM</b>:模型列表来自 LiteLLM Proxy
          <code>/v1/models</code>(共 {models.length} 个 chat 模型,已过滤
          dev fixture 与非对话模型)。Provider 切换在 <b>AI 认证</b> Tab。
          {litellmReason && (
            <>
              <br />
              <Box variant="span" color="text-status-warning">
                ⚠ {litellmReason}
              </Box>
            </>
          )}
        </Alert>
      )}

      {/* 模型选择 */}
      <Container
        header={
          <Header
            variant="h2"
            actions={
              <Button variant="primary" onClick={handleModelSave} loading={modelSaving} disabled={modelLoading}>
                保存模型
              </Button>
            }
          >
            {label} 模型选择
          </Header>
        }
      >
        <SpaceBetween size="m">
          <FormField
            label={
              modelLoading
                ? "选择模型"
                : llmProvider === "litellm"
                  ? "选择 LiteLLM 模型"
                  : "选择 Bedrock 模型"
            }
            description={
              modelLoading
                ? ""
                : llmProvider === "litellm"
                  ? "选项来自 LiteLLM Proxy。bedrock/* 走代理后端转发到 Bedrock,其他前缀(anthropic/groq/openai)需要 Proxy 端配好对应 key。"
                  : "模型名称前缀表示数据处理区域,影响请求路由和数据驻留位置。"
            }
          >
            <Select
              selectedOption={
                options.find((o) => o.value === selectedValue) ?? null
              }
              onChange={({ detail }) => {
                setSelectedValue(detail.selectedOption.value ?? "");
                if (detail.selectedOption.value !== CUSTOM_MODEL_VALUE) {
                  setCustomModelId("");
                }
              }}
              options={options}
              placeholder={llmProvider === "litellm" ? "选择 LiteLLM 模型(支持搜索)" : "请选择模型"}
              loadingText="加载中..."
              statusType={modelLoading ? "loading" : "finished"}
              filteringType="auto"
             expandToViewport/>
          </FormField>

          {selectedValue === CUSTOM_MODEL_VALUE && (
            <FormField
              label="自定义模型 ID"
              description="输入跨区域推理配置文件 ID 或其他自定义模型 ID"
            >
              <Input
                value={customModelId}
                onChange={({ detail }) => setCustomModelId(detail.value)}
                placeholder="例如: us.anthropic.claude-sonnet-4-20250514-v1:0"
              />
            </FormField>
          )}

          {!modelLoading && llmProvider !== "litellm" && (
            <Box variant="div" padding={{ top: "xxs" }}>
              <Box variant="small" color="text-body-secondary">
                <SpaceBetween size="xxs">
                  <div><Box variant="span" fontWeight="bold">JP</Box> — 请求仅在日本区域处理，数据不出日本</div>
                  <div><Box variant="span" fontWeight="bold">APAC</Box> — 请求在亚太区域处理（Tokyo、Singapore、Sydney 等）</div>
                  <div><Box variant="span" fontWeight="bold">Global</Box> — 请求可路由到全球任意可用区域，延迟最低但数据可能跨区域</div>
                </SpaceBetween>
              </Box>
            </Box>
          )}
        </SpaceBetween>
      </Container>

      {/* Agent Prompt */}
      <Container
        header={
          <Header
            variant="h2"
            actions={
              <Button variant="primary" onClick={handlePromptSave} loading={promptSaving}>
                保存 Prompt
              </Button>
            }
          >
            {label} Agent Prompt
          </Header>
        }
      >
        <Box variant="small" color="text-body-secondary">
          当前字符数: {promptText.length}
        </Box>
      </Container>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px", minHeight: "600px" }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <Box variant="small" fontWeight="bold" padding={{ bottom: "xs" }}>编辑</Box>
          <Textarea
            value={promptText}
            onChange={({ detail }) => setPromptText(detail.value)}
            rows={30}
            placeholder={promptLoading ? "加载中..." : "输入 Agent Prompt 内容"}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <Box variant="small" fontWeight="bold" padding={{ bottom: "xs" }}>预览</Box>
          <div
            style={{
              flex: 1,
              overflow: "auto",
              border: "1px solid #d5dbdb",
              borderRadius: "8px",
              padding: "16px",
              backgroundColor: "#fafafa",
              fontSize: "14px",
              lineHeight: "1.6",
            }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{promptText}</ReactMarkdown>
          </div>
        </div>
      </div>
    </SpaceBetween>
  );
}

// ─── Tab 4: DevOps Agent ────────────────────────────────
function DevOpsAgentTab({ flash, providerVersion }: TabProps) {
  const [loading, setLoading] = useState(true);
  const [modelSaving, setModelSaving] = useState(false);
  const [promptSaving, setPromptSaving] = useState(false);

  const [bedrockModelId, setBedrockModelId] = useState("");
  const [originalModelId, setOriginalModelId] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [modelOptions, setModelOptions] = useState<{ label: string; value: string }[]>([]);
  const [llmProvider, setLlmProvider] = useState<"bedrock" | "litellm" | null>(null);
  const [litellmReason, setLitellmReason] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cfgRes, modelsRes] = await Promise.all([
          getDevopsAgentConfig(),
          getRdsHealthCheckModels().catch(() => ({ data: { items: [] } })),
        ]);
        if (cancelled) return;

        const items = cfgRes.data?.items || [];
        const modelItem = items.find((i: any) => i.config_key === "bedrock_model_id");
        const promptItem = items.find((i: any) => i.config_key === "agent_prompt");
        const modelId = modelItem?.config_value || "";
        setBedrockModelId(modelId);
        setOriginalModelId(modelId);
        setAgentPrompt(promptItem?.config_value || "");

        const models = modelsRes.data?.items || modelsRes.data?.models || [];
        const opts = models.map((m: any) => ({
          label: m.model_name || m.name || m.id || m.model_id,
          value: m.model_id || m.id,
        }));
        setModelOptions(opts);
        // 后端 provider-aware metadata
        const md = modelsRes.data as {
          llm_provider?: "bedrock" | "litellm";
          litellm_reason?: string;
        };
        if (md?.llm_provider) setLlmProvider(md.llm_provider);
        if (md?.litellm_reason) setLitellmReason(md.litellm_reason);
      } catch (e: any) {
        console.error("Failed to load DevOps Agent config", errMsg(e));
        flash.show("error", "加载 DevOps Agent 配置失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [providerVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleModelSave = async () => {
    if (!bedrockModelId.trim()) {
      flash.show("error", "请选择或输入模型 ID");
      return;
    }
    if (bedrockModelId === originalModelId) {
      flash.show("info", "模型未变更");
      return;
    }
    setModelSaving(true);
    try {
      await updateDevopsAgentConfig({ bedrock_model_id: bedrockModelId });
      setOriginalModelId(bedrockModelId);
      flash.show("success", "DevOps Agent 模型已保存");
    } catch (e: any) {
      console.error("Failed to save DevOps Agent model", errMsg(e));
      flash.show("error", "保存 DevOps Agent 模型失败");
    } finally {
      setModelSaving(false);
    }
  };

  const handlePromptSave = async () => {
    setPromptSaving(true);
    try {
      await updateDevopsAgentConfig({ agent_prompt: agentPrompt });
      flash.show("success", "DevOps Agent Prompt 已保存");
    } catch (e: any) {
      console.error("Failed to save DevOps Agent prompt", errMsg(e));
      flash.show("error", "保存 DevOps Agent Prompt 失败");
    } finally {
      setPromptSaving(false);
    }
  };

  return (
    <SpaceBetween size="l">
      <Alert type="info" header="配置用途">
        此处配置用于 Callback Lambda 精简调查报告（长报告 → 短卡片）和 Lambda4 Health_Report_Parser 解析巡检报告。
        留空则使用环境变量 DEVOPS_AGENT_SUMMARIZER_MODEL_ID，再次降级使用硬编码默认{" "}
        <code>global.anthropic.claude-opus-4-6-v1</code>。
      </Alert>

      {llmProvider === "litellm" && (
        <Alert type="info">
          当前 LLM Provider 是 <b>LiteLLM</b>:可选模型来自 LiteLLM Proxy
          <code>/v1/models</code>(共 {modelOptions.length} 个)。Provider
          切换在 <b>AI 认证</b> Tab。
          {litellmReason && (
            <>
              <br />
              <Box variant="span" color="text-status-warning">
                ⚠ {litellmReason}
              </Box>
            </>
          )}
        </Alert>
      )}

      {/* 模型选择 */}
      <Container
        header={
          <Header
            variant="h2"
            actions={
              <Button variant="primary" onClick={handleModelSave} loading={modelSaving} disabled={loading}>
                保存模型
              </Button>
            }
          >
            DevOps Agent 模型选择
          </Header>
        }
      >
        <FormField
          label={
            loading
              ? "模型 ID"
              : llmProvider === "litellm"
                ? "LiteLLM 模型 ID"
                : "Bedrock 模型 ID"
          }
          description={
            loading
              ? ""
              : llmProvider === "litellm"
                ? "选项来自 LiteLLM Proxy"
                : "选择当前账户可用的 Bedrock 模型"
          }
        >
          {modelOptions.length > 0 ? (
            <Select
              selectedOption={
                modelOptions.find((o) => o.value === bedrockModelId) ??
                (bedrockModelId ? { label: bedrockModelId, value: bedrockModelId } : null)
              }
              onChange={(e) => setBedrockModelId(e.detail.selectedOption.value ?? "")}
              options={modelOptions}
              placeholder={loading ? "加载中..." : llmProvider === "litellm" ? "选择 LiteLLM 模型(支持搜索)" : "选择模型 ID"}
              loadingText="加载中..."
              statusType={loading ? "loading" : "finished"}
              filteringType="auto"
             expandToViewport/>
          ) : (
            <Input
              value={bedrockModelId}
              onChange={(e) => setBedrockModelId(e.detail.value)}
              placeholder={loading ? "" : llmProvider === "litellm" ? "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0" : "global.anthropic.claude-opus-4-6-v1"}
            />
          )}
        </FormField>
      </Container>

      {/* Agent Prompt */}
      <Container
        header={
          <Header
            variant="h2"
            actions={
              <Button variant="primary" onClick={handlePromptSave} loading={promptSaving} disabled={loading}>
                保存 Prompt
              </Button>
            }
          >
            DevOps Agent Prompt
          </Header>
        }
      >
        <FormField
          label="Agent Prompt（可选）"
          description="自定义精简报告的 system prompt。留空则使用硬编码默认（三段式：Symptoms / Root Cause / Findings）"
        >
          <Textarea rows={12} value={agentPrompt} onChange={(e) => setAgentPrompt(e.detail.value)} />
        </FormField>
      </Container>
    </SpaceBetween>
  );
}


// ─── Tab 5: AgentCore Runtime 模型 ────────────────────
// Spec: agent-model-config-integration
interface AgentModelInfo {
  model_id: string;
  source: "ssm" | "default";
}

function AgentModelTab({ flash, providerVersion }: TabProps) {
  const [currentModelId, setCurrentModelId] = useState("");
  const [currentSource, setCurrentSource] = useState<"ssm" | "default">("default");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedValue, setSelectedValue] = useState("");
  const [customInput, setCustomInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [globalProvider, setGlobalProvider] = useState<"bedrock" | "litellm" | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const results = await Promise.allSettled([
        getAgentConfig(),
        getAgentConfigModels(),
        getLlmProvider().catch(() => null),
      ]);
      if (cancelled) return;
      const [configRes, modelsRes, providerRes] = results;

      if (providerRes.status === "fulfilled" && providerRes.value) {
        setGlobalProvider((providerRes.value as { data: { provider: "bedrock" | "litellm" } }).data.provider);
      }

      if (modelsRes.status === "fulfilled") {
        const modelsData = modelsRes.value.data as {
          models?: ModelOption[];
          llm_provider?: "bedrock" | "litellm";
        };
        setModels(modelsData.models ?? []);
        if (modelsData.llm_provider) setGlobalProvider(modelsData.llm_provider);
      } else {
        console.error("Failed to load agent models", errMsg(modelsRes.reason));
        flash.show(
          "error",
          "加载模型列表失败，可在\"自定义...\"选项中手动输入模型 ID",
        );
      }

      if (configRes.status === "fulfilled") {
        const data = configRes.value.data as AgentModelInfo;
        setCurrentModelId(data.model_id ?? "");
        setCurrentSource(data.source ?? "default");
      } else {
        console.error("Failed to load agent config", errMsg(configRes.reason));
        flash.show("error", "加载 AgentCore Runtime 配置失败");
      }

      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [providerVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const options: SelectProps.Options = [
    ...models.map((m) => ({ label: m.model_name, value: m.model_id })),
    { label: "自定义...", value: CUSTOM_MODEL_VALUE },
  ];

  const selectedOption =
    options.find((o): o is SelectProps.Option => "value" in o && o.value === selectedValue) ?? null;

  const effectiveSelectedId =
    selectedValue === CUSTOM_MODEL_VALUE
      ? customInput.trim()
      : selectedValue;

  const canSave =
    !loading &&
    !saving &&
    !!effectiveSelectedId &&
    effectiveSelectedId !== currentModelId;

  const lookupName = (modelId: string): string => {
    const m = models.find((x) => x.model_id === modelId);
    return m ? m.model_name : "";
  };

  const formatModel = (modelId: string): string => {
    const name = lookupName(modelId);
    return name ? `${name} (${modelId})` : modelId;
  };

  const handleSave = () => {
    if (!canSave) return;
    setConfirmOpen(true);
  };

  const handleConfirm = async () => {
    setSaving(true);
    try {
      const resp = await putAgentConfig({ model_id: effectiveSelectedId });
      const saved = resp.data?.model_id ?? effectiveSelectedId;
      setCurrentModelId(saved);
      setCurrentSource("ssm");
      setConfirmOpen(false);
      flash.show("success", "AgentCore Runtime 模型已保存（配置最多 5 分钟生效）");
    } catch (e) {
      console.error("Failed to save agent model", errMsg(e));
      flash.show("error", "保存 AgentCore Runtime 模型失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SpaceBetween size="l">
      <Alert type="info" header="用途">
        配置 IM 机器人（飞书/Slack）意图分类与巡检报告生成使用的 Bedrock 模型。切换后各运行单元通过 TTL 缓存自动读取新配置，最多 5 分钟生效。
      </Alert>

      {globalProvider === "litellm" && (
        <Alert type="info" header="当前全局 Provider: LiteLLM">
          模型列表来自 LiteLLM Proxy。系统会自动处理模型 ID 格式转换，保存时自动转换为 Bedrock 原生格式。
          切换 Provider 后 IM 机器人最多 5 分钟内生效。
        </Alert>
      )}

      <Container header={<Header variant="h2">当前模型</Header>}>
        <SpaceBetween size="m">
          <FormField label="当前使用">
            <Box variant="code">{currentModelId || "（加载中...）"}</Box>
          </FormField>
          {currentSource === "default" && (
            <Box variant="small" color="text-status-warning">
              （默认值，尚未手动配置）
            </Box>
          )}
        </SpaceBetween>
      </Container>

      <Container
        header={
          <Header
            variant="h2"
            actions={
              <Button
                variant="primary"
                onClick={handleSave}
                disabled={!canSave}
                loading={saving}
                data-testid="agent-model-save-btn"
              >
                保存
              </Button>
            }
          >
            切换模型
          </Header>
        }
      >
        <SpaceBetween size="m">
          <FormField
            label={loading ? "切换到" : globalProvider === "litellm" ? "选择 LiteLLM 模型" : "切换到"}
            description={
              loading ? "" :
              globalProvider === "litellm"
                ? "选择模型（系统自动处理格式转换，无需手动加前缀）"
                : "选择预置模型或自定义输入模型 ID"
            }
          >
            <Select
              selectedOption={selectedOption}
              onChange={({ detail }) => {
                const v = detail.selectedOption.value ?? "";
                setSelectedValue(v);
                if (v !== CUSTOM_MODEL_VALUE) {
                  setCustomInput("");
                }
              }}
              options={options}
              placeholder="请选择模型"
              loadingText="加载模型列表..."
              statusType={loading ? "loading" : "finished"}
              filteringType="auto"
             expandToViewport/>
          </FormField>
          {selectedValue === CUSTOM_MODEL_VALUE && (
            <FormField
              label="自定义模型 ID"
              description="输入跨区域推理配置文件 ID 或其他自定义模型 ID"
            >
              <Input
                value={customInput}
                onChange={({ detail }) => setCustomInput(detail.value)}
                placeholder="例如: us.anthropic.claude-sonnet-4-20250514-v1:0"
              />
            </FormField>
          )}
        </SpaceBetween>
      </Container>

      <Modal
        visible={confirmOpen}
        onDismiss={() => setConfirmOpen(false)}
        header="确认切换模型"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setConfirmOpen(false)}>取消</Button>
              <Button variant="primary" loading={saving} onClick={handleConfirm}>
                确认
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>
            当前模型：<Box variant="code" display="inline">{formatModel(currentModelId)}</Box>
          </Box>
          <Box>
            新模型：<Box variant="code" display="inline">{formatModel(effectiveSelectedId)}</Box>
          </Box>
          <Alert type="warning">
            配置最多 5 分钟生效。进行中的会话继续使用原模型。
          </Alert>
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}


// ─── Tab 6: 巡检白名单 ─────────────────────────────────
function WhitelistTab({ flash }: TabProps) {
  const [items, setItems] = useState<WhitelistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedItems, setSelectedItems] = useState<WhitelistItem[]>([]);

  // Resource Type 筛选器
  const [resourceTypeFilter, setResourceTypeFilter] = useState<ResourceTypeFilter>("rds");
  // 请求序号，防止快速切换筛选器时的竞态条件
  const requestSeqRef = useRef(0);

  // 内联添加表单
  const [showForm, setShowForm] = useState(false);
  const [formInstanceId, setFormInstanceId] = useState("");
  const [formAccountId, setFormAccountId] = useState("");
  const [formReason, setFormReason] = useState("");
  const [formDays, setFormDays] = useState("30");
  const [formResourceType, setFormResourceType] = useState<string>("");
  const [adding, setAdding] = useState(false);

  // 范围确认弹窗
  const [showScopeConfirmModal, setShowScopeConfirmModal] = useState(false);
  const [scopeConfirmMessage, setScopeConfirmMessage] = useState("");

  // 修改有效期弹窗
  const [showExpiryModal, setShowExpiryModal] = useState(false);
  const [expiryTarget, setExpiryTarget] = useState<WhitelistItem | null>(null);
  const [expiryDays, setExpiryDays] = useState("30");
  const [updatingExpiry, setUpdatingExpiry] = useState(false);

  // 从巡检实例中选择弹窗
  const [showPickerModal, setShowPickerModal] = useState(false);
  const [pickerInstances, setPickerInstances] = useState<Record<string, string>[]>([]);
  const [pickerSelected, setPickerSelected] = useState<Record<string, string>[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerReason, setPickerReason] = useState("");
  const [pickerDays, setPickerDays] = useState("30");
  const [pickerAdding, setPickerAdding] = useState(false);
  const [pickerResourceType, setPickerResourceType] = useState<string>(
    resourceTypeFilter !== "all" ? resourceTypeFilter : "rds"
  );

  const fetchWhitelist = useCallback(async (filter: ResourceTypeFilter) => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (filter !== "all") {
        params.resource_type = filter;
      }
      const resp = await getHealthCheckWhitelist(params);
      if (seq === requestSeqRef.current) {
        setItems((resp.data.items ?? []) as WhitelistItem[]);
      }
    } catch (e) {
      if (seq === requestSeqRef.current) {
        console.error("Failed to load whitelist", errMsg(e));
        flash.show("error", "加载白名单失败");
      }
    } finally {
      if (seq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchWhitelist(resourceTypeFilter);
  }, [fetchWhitelist, resourceTypeFilter]);

  const doAdd = async () => {
    const effectiveResourceType =
      resourceTypeFilter !== "all" ? resourceTypeFilter : formResourceType;

    if (!effectiveResourceType) {
      flash.show("error", "请选择服务类型");
      return;
    }

    const days = parseInt(formDays, 10);
    setAdding(true);
    try {
      await addHealthCheckWhitelist({
        instance_id: formInstanceId.trim() || undefined,
        account_id: formAccountId.trim() || undefined,
        resource_type: effectiveResourceType,
        reason: formReason.trim() || undefined,
        expires_days: Number.isInteger(days) && days > 0 ? days : undefined,
      });
      flash.show("success", "白名单条目已添加");
      setFormInstanceId("");
      setFormAccountId("");
      setFormReason("");
      setFormDays("30");
      setFormResourceType("");
      setShowForm(false);
      await fetchWhitelist(resourceTypeFilter);
    } catch (e) {
      console.error("Failed to add whitelist entry", errMsg(e));
      flash.show("error", "添加白名单失败");
    } finally {
      setAdding(false);
    }
  };

  const handleAdd = async () => {
    const hasInstance = !!formInstanceId.trim();
    const hasAccount = !!formAccountId.trim();

    if (!hasInstance && !hasAccount) {
      flash.show("error", "请至少填写实例 ID 或账户 ID");
      return;
    }

    if (hasInstance && !hasAccount) {
      setScopeConfirmMessage("只填写实例 ID 将覆盖所有账户下的同名实例，确认添加？");
      setShowScopeConfirmModal(true);
      return;
    }

    if (!hasInstance && hasAccount) {
      setScopeConfirmMessage("只填写账户 ID 将把该账户下所有实例加入白名单，确认添加？");
      setShowScopeConfirmModal(true);
      return;
    }

    await doAdd();
  };

  const handleDelete = async (item: WhitelistItem) => {
    try {
      await deleteHealthCheckWhitelist({ instance_id: item.instance_id, account_id: item.account_id ?? "", resource_type: item.resource_type });
      flash.show("success", "白名单条目已删除");
      setSelectedItems([]);
      await fetchWhitelist(resourceTypeFilter);
    } catch (e) {
      console.error("Failed to delete whitelist entry", errMsg(e));
      flash.show("error", "删除白名单失败");
    }
  };

  const handleBatchDelete = async () => {
    if (selectedItems.length === 0) return;
    try {
      await deleteHealthCheckWhitelistBatch(selectedItems.map((i) => ({ instance_id: i.instance_id, account_id: i.account_id ?? "", resource_type: i.resource_type })));
      flash.show("success", `已删除 ${selectedItems.length} 条白名单`);
      setSelectedItems([]);
      await fetchWhitelist(resourceTypeFilter);
    } catch (e) {
      console.error("Failed to batch delete", errMsg(e));
      flash.show("error", "批量删除失败");
    }
  };

  const openExpiryModal = (item: WhitelistItem) => {
    setExpiryTarget(item);
    setExpiryDays("30");
    setShowExpiryModal(true);
  };

  const handleUpdateExpiry = async () => {
    if (!expiryTarget) return;
    const days = parseInt(expiryDays, 10);
    if (!Number.isInteger(days) || days <= 0) return;
    setUpdatingExpiry(true);
    try {
      await updateHealthCheckWhitelistExpiry({ instance_id: expiryTarget.instance_id, account_id: expiryTarget.account_id ?? "", resource_type: expiryTarget.resource_type, expires_days: days });
      flash.show("success", "有效期已更新");
      setShowExpiryModal(false);
      setExpiryTarget(null);
      await fetchWhitelist(resourceTypeFilter);
    } catch (e) {
      console.error("Failed to update expiry", errMsg(e));
      flash.show("error", "更新有效期失败");
    } finally {
      setUpdatingExpiry(false);
    }
  };

  const handleSetPermanent = async () => {
    if (!expiryTarget) return;
    setUpdatingExpiry(true);
    try {
      await updateHealthCheckWhitelistExpiry({ instance_id: expiryTarget.instance_id, account_id: expiryTarget.account_id ?? "", resource_type: expiryTarget.resource_type, expires_days: null });
      flash.show("success", "已设为永久");
      setShowExpiryModal(false);
      setExpiryTarget(null);
      await fetchWhitelist(resourceTypeFilter);
    } catch (e) {
      console.error("Failed to set permanent", errMsg(e));
      flash.show("error", "设置永久失败");
    } finally {
      setUpdatingExpiry(false);
    }
  };

  const fetchPickerInstances = async (resourceType: string) => {
    setPickerLoading(true);
    try {
      const resp = await getHealthCheckWhitelistInstances({ resource_type: resourceType });
      setPickerInstances((resp.data.items ?? []) as Record<string, string>[]);
    } catch (e) {
      console.error("Failed to load inspected instances", errMsg(e));
      flash.show("error", "加载巡检实例列表失败");
    } finally {
      setPickerLoading(false);
    }
  };

  const openPickerModal = async () => {
    const initialType = resourceTypeFilter !== "all" ? resourceTypeFilter : "rds";
    setPickerResourceType(initialType);
    setShowPickerModal(true);
    setPickerSelected([]);
    setPickerReason("");
    setPickerDays("30");
    await fetchPickerInstances(initialType);
  };

  const handlePickerAdd = async () => {
    if (pickerSelected.length === 0) return;
    const days = parseInt(pickerDays, 10);
    setPickerAdding(true);
    try {
      await addHealthCheckWhitelistBatch({
        items: pickerSelected.map((i) => ({
          instance_id: i.instance_id,
          account_id: i.account_id,
        })),
        resource_type: pickerResourceType,
        reason: pickerReason.trim() || undefined,
        expires_days: Number.isInteger(days) && days > 0 ? days : undefined,
      });
      flash.show("success", `已添加 ${pickerSelected.length} 条白名单`);
      setShowPickerModal(false);
      await fetchWhitelist(resourceTypeFilter);
    } catch (e) {
      console.error("Failed to batch add whitelist", errMsg(e));
      flash.show("error", "批量添加白名单失败");
    } finally {
      setPickerAdding(false);
    }
  };

  return (
    <SpaceBetween size="l">
      {/* 内联添加表单 */}
      {showForm && (
        <Container header={<Header variant="h3">添加白名单条目</Header>}>
          <SpaceBetween size="m">
            {resourceTypeFilter === "all" && (
              <FormField label="服务类型" errorText={!formResourceType ? "请选择服务类型" : undefined}>
                <Select
                  selectedOption={
                    formResourceType
                      ? { label: formResourceType === "rds" ? "RDS" : "ElastiCache", value: formResourceType }
                      : null
                  }
                  onChange={({ detail }) => setFormResourceType(detail.selectedOption.value ?? "")}
                  options={[
                    { label: "RDS", value: "rds" },
                    { label: "ElastiCache", value: "elasticache" },
                  ]}
                  placeholder="请选择服务类型"
                 expandToViewport/>
              </FormField>
            )}
            <FormField label="实例 ID">
              <Input value={formInstanceId} onChange={({ detail }) => setFormInstanceId(detail.value)} placeholder="例如: my-rds-instance" />
            </FormField>
            <FormField label="账户 ID">
              <Input value={formAccountId} onChange={({ detail }) => setFormAccountId(detail.value)} placeholder="例如: 123456789012" />
            </FormField>
            <FormField label="原因">
              <Input value={formReason} onChange={({ detail }) => setFormReason(detail.value)} placeholder="加入白名单的原因" />
            </FormField>
            <FormField label="有效天数" description="留空或 0 表示永久" constraintText="请输入正整数">
              <Input value={formDays} onChange={({ detail }) => setFormDays(detail.value)} type="number" placeholder="30" />
            </FormField>
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="primary" onClick={handleAdd} loading={adding}>确认添加</Button>
              <Button onClick={() => setShowForm(false)}>取消</Button>
            </SpaceBetween>
          </SpaceBetween>
        </Container>
      )}

      {/* Resource Type 筛选器 */}
      <FormField label="服务类型筛选">
        <Select
          selectedOption={RESOURCE_TYPE_OPTIONS.find((o) => o.value === resourceTypeFilter) ?? null}
          onChange={({ detail }) => {
            const val = detail.selectedOption.value as ResourceTypeFilter;
            setResourceTypeFilter(val);
            setSelectedItems([]);
          }}
          options={RESOURCE_TYPE_OPTIONS}
         expandToViewport/>
      </FormField>

      {/* 白名单表格 */}
      <Table
        items={items}
        loading={loading}
        loadingText="加载中..."
        trackBy={(item: WhitelistItem) => `${item.instance_id}::${item.account_id}::${item.resource_type}`}
        selectionType="multi"
        selectedItems={selectedItems}
        onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems)}
        columnDefinitions={[
          { id: "instance_id", header: "实例 ID", cell: (item: WhitelistItem) => item.instance_id || "（整个账户）" },
          { id: "account_id", header: "账户 ID", cell: (item: WhitelistItem) => item.account_id || "（所有账户）" },
          { id: "resource_type", header: "服务类型", cell: (item: WhitelistItem) => item.resource_type },
          { id: "reason", header: "原因", cell: (item: WhitelistItem) => item.reason ?? "-" },
          {
            id: "remaining",
            header: "剩余有效期",
            cell: (item: WhitelistItem) => (
              <Button variant="inline-link" onClick={() => openExpiryModal(item)}>
                {formatRemaining(item.expires_at)}
              </Button>
            ),
          },
          { id: "created_at", header: "添加时间", cell: (item: WhitelistItem) => item.created_at ?? "-" },
          {
            id: "actions",
            header: "操作",
            cell: (item: WhitelistItem) => (
              <Button variant="inline-link" onClick={() => handleDelete(item)}>删除</Button>
            ),
          },
        ]}
        header={
          <Header variant="h2" actions={
            <SpaceBetween direction="horizontal" size="xs">
              {selectedItems.length > 0 && (
                <Button onClick={handleBatchDelete}>批量删除 ({selectedItems.length})</Button>
              )}
              {!showForm && <Button onClick={() => setShowForm(true)}>手动添加</Button>}
              <Button variant="primary" onClick={openPickerModal}>从巡检实例选择</Button>
            </SpaceBetween>
          }>
            巡检白名单
          </Header>
        }
        empty={<Box textAlign="center" padding="xxl">暂无白名单条目</Box>}
      />

      {/* 修改有效期弹窗 */}
      <Modal visible={showExpiryModal} onDismiss={() => setShowExpiryModal(false)}
        header="修改有效期"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={handleSetPermanent} loading={updatingExpiry}>设为永久</Button>
              <Button variant="primary" loading={updatingExpiry} onClick={handleUpdateExpiry}
                disabled={!expiryDays || !/^\d+$/.test(expiryDays) || parseInt(expiryDays, 10) <= 0}>
                确认
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <FormField label="实例 ID">
            <Input value={expiryTarget?.instance_id ?? ""} disabled />
          </FormField>
          <FormField label="新的有效天数" description="从现在起计算" constraintText="请输入正整数"
            errorText={expiryDays && (!/^\d+$/.test(expiryDays) || parseInt(expiryDays, 10) <= 0) ? "请输入大于 0 的正整数" : undefined}>
            <Input value={expiryDays} onChange={({ detail }) => setExpiryDays(detail.value)} type="number" placeholder="30" />
          </FormField>
        </SpaceBetween>
      </Modal>

      {/* 范围确认弹窗 */}
      <Modal
        visible={showScopeConfirmModal}
        onDismiss={() => setShowScopeConfirmModal(false)}
        header="确认白名单范围"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setShowScopeConfirmModal(false)}>取消</Button>
              <Button variant="primary" loading={adding} onClick={async () => {
                setShowScopeConfirmModal(false);
                await doAdd();
              }}>保存</Button>
            </SpaceBetween>
          </Box>
        }
      >
        {scopeConfirmMessage}
      </Modal>

      {/* 从巡检实例选择弹窗 */}
      <Modal
        visible={showPickerModal}
        onDismiss={() => setShowPickerModal(false)}
        header="从巡检实例中选择"
        size="large"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setShowPickerModal(false)}>取消</Button>
              <Button variant="primary" loading={pickerAdding} onClick={handlePickerAdd}
                disabled={pickerSelected.length === 0}>
                添加 {pickerSelected.length > 0 ? `(${pickerSelected.length})` : ""}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <FormField label="服务类型">
            <Select
              selectedOption={
                pickerResourceType === "rds"
                  ? { label: "RDS", value: "rds" }
                  : { label: "ElastiCache", value: "elasticache" }
              }
              onChange={({ detail }) => {
                const newType = detail.selectedOption.value ?? "rds";
                setPickerResourceType(newType);
                setPickerSelected([]);
                fetchPickerInstances(newType);
              }}
              options={[
                { label: "RDS", value: "rds" },
                { label: "ElastiCache", value: "elasticache" },
              ]}
             expandToViewport/>
          </FormField>
          <Table
            items={pickerInstances}
            loading={pickerLoading}
            loadingText="加载巡检实例..."
            trackBy={(item) => `${item.instance_id}::${item.account_id}`}
            selectionType="multi"
            selectedItems={pickerSelected}
            onSelectionChange={({ detail }) => setPickerSelected(detail.selectedItems)}
            columnDefinitions={[
              { id: "instance_id", header: "实例 ID", cell: (item) => item.instance_id },
              { id: "account_id", header: "账户 ID", cell: (item) => item.account_id },
              { id: "region", header: "区域", cell: (item) => item.region },
              { id: "engine", header: "引擎", cell: (item) => item.engine ?? "-" },
              { id: "instance_class", header: "实例类型", cell: (item) => item.instance_class ?? "-" },
            ]}
            empty={<Box textAlign="center" padding="l">没有可添加的巡检实例（全部已在白名单中）</Box>}
          />
          <FormField label="原因">
            <Input value={pickerReason} onChange={({ detail }) => setPickerReason(detail.value)} placeholder="加入白名单的原因" />
          </FormField>
          <FormField label="有效天数" description="留空或 0 表示永久">
            <Input value={pickerDays} onChange={({ detail }) => setPickerDays(detail.value)} type="number" placeholder="30" />
          </FormField>
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}
