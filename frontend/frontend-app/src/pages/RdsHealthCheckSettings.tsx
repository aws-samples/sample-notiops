/**
 * AI 巡检设置页面。
 * 使用 Cloudscape Tabs 组件组织三个标签页：模型设置、Agent Prompt、巡检白名单。
 */
import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
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
  Select,
  SpaceBetween,
  Table,
  Tabs,
  Textarea,
  type SelectProps,
  type FlashbarProps,
} from "@cloudscape-design/components";
import {
  getRdsHealthCheckConfig,
  updateRdsHealthCheckConfig,
  getRdsHealthCheckModels,
  getElastiCacheHealthCheckConfig,
  updateElastiCacheHealthCheckConfig,
  getHealthCheckWhitelist,
  getHealthCheckWhitelistInstances,
  addHealthCheckWhitelist,
  addHealthCheckWhitelistBatch,
  deleteHealthCheckWhitelist,
  deleteHealthCheckWhitelistBatch,
  updateHealthCheckWhitelistExpiry,
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
export default function RdsHealthCheckSettings() {
  const navigate = useNavigate();
  const flash = useFlash();

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
      >
        AI 巡检设置
      </Header>

      <Flashbar items={flash.items} />

      <Tabs
        tabs={[
          {
            label: "模型设置",
            id: "model",
            content: <ModelSettingsTab flash={flash} />,
          },
          {
            label: "RDS Agent Prompt",
            id: "rds-prompt",
            content: <AgentPromptTab flash={flash} serviceType="rds" />,
          },
          {
            label: "ElastiCache Agent Prompt",
            id: "ec-prompt",
            content: <AgentPromptTab flash={flash} serviceType="elasticache" />,
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

// ─── Tab 1: 模型设置 ───────────────────────────────────
interface TabProps {
  flash: ReturnType<typeof useFlash>;
}

function ModelSettingsTab({ flash }: TabProps) {
  const [models, setModels] = useState<ModelOption[]>([]);
  // RDS 模型状态
  const [rdsSelectedValue, setRdsSelectedValue] = useState<string>("");
  const [rdsCustomModelId, setRdsCustomModelId] = useState("");
  const [rdsOriginalModelId, setRdsOriginalModelId] = useState("");
  // ElastiCache 模型状态
  const [ecSelectedValue, setEcSelectedValue] = useState<string>("");
  const [ecCustomModelId, setEcCustomModelId] = useState("");
  const [ecOriginalModelId, setEcOriginalModelId] = useState("");

  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  // API Key 状态
  const [apiKey, setApiKey] = useState("");
  const [apiKeyMasked, setApiKeyMasked] = useState("");
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const results = await Promise.allSettled([
        getRdsHealthCheckConfig(),
        getElastiCacheHealthCheckConfig(),
        getRdsHealthCheckModels(),
      ]);
      if (cancelled) return;

      const [rdsConfigResult, ecConfigResult, modelsResult] = results;

      // 处理模型列表
      let modelList: ModelOption[] = [];
      if (modelsResult.status === "fulfilled") {
        modelList = modelsResult.value.data.models ?? [];
        setModels(modelList);
      } else {
        console.error("Failed to load models", errMsg(modelsResult.reason));
        flash.show("error", "加载模型列表失败");
      }

      // 处理 RDS 配置
      if (rdsConfigResult.status === "fulfilled") {
        const rdsModelId: string = rdsConfigResult.value.data.bedrock_model_id ?? "";
        setRdsOriginalModelId(rdsModelId);
        const found = modelList.some((m) => m.model_id === rdsModelId);
        if (found) {
          setRdsSelectedValue(rdsModelId);
        } else if (rdsModelId) {
          setRdsSelectedValue(CUSTOM_MODEL_VALUE);
          setRdsCustomModelId(rdsModelId);
        }
        // 读取 API Key 配置
        setApiKeyMasked(rdsConfigResult.value.data.bedrock_api_key_masked ?? "");
        setApiKeyConfigured(rdsConfigResult.value.data.bedrock_api_key_configured ?? false);
      } else {
        console.error("Failed to load RDS config", errMsg(rdsConfigResult.reason));
        flash.show("error", "加载 RDS 模型配置失败");
      }

      // 处理 ElastiCache 配置
      if (ecConfigResult.status === "fulfilled") {
        const ecModelId: string = ecConfigResult.value.data.bedrock_model_id ?? "";
        setEcOriginalModelId(ecModelId);
        const found = modelList.some((m) => m.model_id === ecModelId);
        if (found) {
          setEcSelectedValue(ecModelId);
        } else if (ecModelId) {
          setEcSelectedValue(CUSTOM_MODEL_VALUE);
          setEcCustomModelId(ecModelId);
        }
      } else {
        console.error("Failed to load EC config", errMsg(ecConfigResult.reason));
        flash.show("error", "加载 ElastiCache 模型配置失败");
      }

      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const options: SelectProps.Options = [
    ...models.map((m) => ({
      label: m.model_name,
      value: m.model_id,
    })),
    { label: "自定义模型 ID", value: CUSTOM_MODEL_VALUE },
  ];

  const rdsEffectiveModelId =
    rdsSelectedValue === CUSTOM_MODEL_VALUE ? rdsCustomModelId.trim() : rdsSelectedValue;
  const ecEffectiveModelId =
    ecSelectedValue === CUSTOM_MODEL_VALUE ? ecCustomModelId.trim() : ecSelectedValue;

  const handleSave = async () => {
    if (!rdsEffectiveModelId) {
      flash.show("error", "请选择或输入 RDS 模型 ID");
      return;
    }
    if (!ecEffectiveModelId) {
      flash.show("error", "请选择或输入 ElastiCache 模型 ID");
      return;
    }

    const rdsChanged = rdsEffectiveModelId !== rdsOriginalModelId;
    const ecChanged = ecEffectiveModelId !== ecOriginalModelId;
    const apiKeyChanged = !!apiKey;

    if (!rdsChanged && !ecChanged && !apiKeyChanged) {
      flash.show("info", "没有检测到配置变更");
      return;
    }

    const promises: { label: string; promise: Promise<unknown> }[] = [];

    // RDS 模型变更或 API Key 变更时调用 RDS API
    if (rdsChanged || apiKeyChanged) {
      const payload: Record<string, unknown> = { bedrock_model_id: rdsEffectiveModelId };
      if (apiKeyChanged) payload.bedrock_api_key = apiKey;
      promises.push({ label: "RDS", promise: updateRdsHealthCheckConfig(payload) });
    }

    // EC 模型变更时调用 EC API
    if (ecChanged) {
      promises.push({ label: "ElastiCache", promise: updateElastiCacheHealthCheckConfig({ bedrock_model_id: ecEffectiveModelId }) });
    }

    setSaving(true);
    try {
      const results = await Promise.allSettled(promises.map((p) => p.promise));
      let hasError = false;
      results.forEach((result, idx) => {
        if (result.status === "rejected") {
          hasError = true;
          console.error(`Failed to save ${promises[idx].label} config`, errMsg(result.reason));
          flash.show("error", `保存 ${promises[idx].label} 配置失败`);
        }
      });

      if (!hasError) {
        flash.show("success", "配置已保存");
      }

      // 更新成功部分的 original 值
      results.forEach((result, idx) => {
        if (result.status === "fulfilled") {
          if (promises[idx].label === "RDS") {
            setRdsOriginalModelId(rdsEffectiveModelId);
            if (apiKey) {
              setApiKeyConfigured(true);
              setApiKeyMasked("****" + apiKey.slice(-4));
              setApiKey("");
            }
          } else if (promises[idx].label === "ElastiCache") {
            setEcOriginalModelId(ecEffectiveModelId);
          }
        }
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Container header={<Header variant="h2">模型设置</Header>}>
      <SpaceBetween size="l">
        {/* RDS 模型选择区域 */}
        <Container header={<Header variant="h3">RDS 模型</Header>}>
          <SpaceBetween size="m">
            <FormField
              label="选择 Bedrock 模型"
              description="模型名称前缀表示数据处理区域，影响请求路由和数据驻留位置。"
            >
              <Select
                selectedOption={
                  options.find((o) => o.value === rdsSelectedValue) ?? null
                }
                onChange={({ detail }) => {
                  setRdsSelectedValue(detail.selectedOption.value ?? "");
                  if (detail.selectedOption.value !== CUSTOM_MODEL_VALUE) {
                    setRdsCustomModelId("");
                  }
                }}
                options={options}
                placeholder="请选择模型"
                loadingText="加载中..."
                statusType={loading ? "loading" : "finished"}
               expandToViewport/>
            </FormField>

            {rdsSelectedValue === CUSTOM_MODEL_VALUE && (
              <FormField
                label="自定义模型 ID"
                description="输入跨区域推理配置文件 ID 或其他自定义模型 ID"
              >
                <Input
                  value={rdsCustomModelId}
                  onChange={({ detail }) => setRdsCustomModelId(detail.value)}
                  placeholder="例如: us.anthropic.claude-sonnet-4-20250514-v1:0"
                />
              </FormField>
            )}
          </SpaceBetween>
        </Container>

        {/* ElastiCache 模型选择区域 */}
        <Container header={<Header variant="h3">ElastiCache 模型</Header>}>
          <SpaceBetween size="m">
            <FormField
              label="选择 Bedrock 模型"
              description="模型名称前缀表示数据处理区域，影响请求路由和数据驻留位置。"
            >
              <Select
                selectedOption={
                  options.find((o) => o.value === ecSelectedValue) ?? null
                }
                onChange={({ detail }) => {
                  setEcSelectedValue(detail.selectedOption.value ?? "");
                  if (detail.selectedOption.value !== CUSTOM_MODEL_VALUE) {
                    setEcCustomModelId("");
                  }
                }}
                options={options}
                placeholder="请选择模型"
                loadingText="加载中..."
                statusType={loading ? "loading" : "finished"}
               expandToViewport/>
            </FormField>

            {ecSelectedValue === CUSTOM_MODEL_VALUE && (
              <FormField
                label="自定义模型 ID"
                description="输入跨区域推理配置文件 ID 或其他自定义模型 ID"
              >
                <Input
                  value={ecCustomModelId}
                  onChange={({ detail }) => setEcCustomModelId(detail.value)}
                  placeholder="例如: us.anthropic.claude-sonnet-4-20250514-v1:0"
                />
              </FormField>
            )}
          </SpaceBetween>
        </Container>

        <Box variant="div" padding={{ top: "xxs" }}>
          <Box variant="small" color="text-body-secondary">
            <SpaceBetween size="xxs">
              <div><Box variant="span" fontWeight="bold">JP</Box> — 请求仅在日本区域处理，数据不出日本，合规要求最严格</div>
              <div><Box variant="span" fontWeight="bold">APAC</Box> — 请求在亚太区域处理（Tokyo、Singapore、Sydney 等），数据不出亚太</div>
              <div><Box variant="span" fontWeight="bold">Global</Box> — 请求可路由到全球任意可用区域，延迟最低但数据可能跨区域</div>
            </SpaceBetween>
          </Box>
        </Box>

        <FormField
          label="Bedrock API Key"
          description={apiKeyConfigured ? `当前已配置: ${apiKeyMasked}` : "未配置"}
        >
          <Input
            type="password"
            value={apiKey}
            onChange={({ detail }) => setApiKey(detail.value)}
            placeholder={apiKeyConfigured ? apiKeyMasked : "输入 Bedrock API Key"}
          />
        </FormField>

        <Box variant="small" color="text-body-secondary">
          API Key 为空时将使用当前账号 IAM 凭证调用 Bedrock
        </Box>

        <Button variant="primary" onClick={handleSave} loading={saving} disabled={loading}>
          保存
        </Button>
      </SpaceBetween>
    </Container>
  );
}


// ─── Tab 2: Agent Prompt ────────────────────────────────
interface AgentPromptTabProps {
  flash: ReturnType<typeof useFlash>;
  serviceType: "rds" | "elasticache";
}

const API_MAP = {
  rds: { getConfig: getRdsHealthCheckConfig, updateConfig: updateRdsHealthCheckConfig },
  elasticache: { getConfig: getElastiCacheHealthCheckConfig, updateConfig: updateElastiCacheHealthCheckConfig },
};

function AgentPromptTab({ flash, serviceType }: AgentPromptTabProps) {
  const { getConfig, updateConfig } = API_MAP[serviceType];
  const [promptText, setPromptText] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getConfig()
      .then((resp) => {
        if (!cancelled) setPromptText(resp.data.agent_prompt ?? "");
      })
      .catch((e) => {
        console.error("Failed to load agent prompt", errMsg(e));
        flash.show("error", "加载 Agent Prompt 失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [getConfig]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateConfig({ agent_prompt: promptText });
      flash.show("success", "Agent Prompt 已保存");
    } catch (e) {
      console.error("Failed to save agent prompt", errMsg(e));
      flash.show("error", "保存 Agent Prompt 失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SpaceBetween size="l">
      <Container
        header={
          <Header
            variant="h2"
            actions={
              <Button variant="primary" onClick={handleSave} loading={saving}>
                保存
              </Button>
            }
          >
            Agent Prompt
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
            placeholder={loading ? "加载中..." : "输入 Agent Prompt 内容"}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <Box variant="small" fontWeight="bold" padding={{ bottom: "xs" }}>预览</Box>
          <div
            data-testid="markdown-preview"
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

// ─── Tab 3: 巡检白名单 ─────────────────────────────────
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

  // 范围确认弹窗（部分填写时提示用户）
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
  // 弹窗中的服务类型（始终可切换，方便用户查看不同服务的实例）
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
      // 仅当此请求仍是最新请求时才更新状态
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
    // 确定 resource_type：非"全部"时使用筛选器值，"全部"时使用用户显式选择
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

    // 两个都填了，直接保存
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
          data-testid="resource-type-filter"
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
