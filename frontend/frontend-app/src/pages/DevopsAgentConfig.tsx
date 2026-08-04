/**
 * DevOps Agent Summarizer_Config 配置页面（R18.3, R18.4）。
 *
 * Bedrock 模型 dropdown（复用 RDS 巡检的模型列表 API）+ agent_prompt 文本域。
 * 存储到 devops_agent_config 表。Callback Lambda 与 Health_Report_Parser 从此
 * 读取 bedrock_model_id 和可选 agent_prompt（三级降级链：DB → env → hardcode）。
 */
import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Container,
  FormField,
  Header,
  Select,
  SpaceBetween,
  Spinner,
  Textarea,
  Alert,
  Input,
} from "@cloudscape-design/components";
import {
  getDevopsAgentConfig,
  updateDevopsAgentConfig,
  getRdsHealthCheckModels,
} from "../api";

export default function DevopsAgentConfig() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [bedrockModelId, setBedrockModelId] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [modelOptions, setModelOptions] = useState<{ label: string; value: string }[]>([]);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [cfgRes, modelsRes] = await Promise.all([
        getDevopsAgentConfig(),
        getRdsHealthCheckModels().catch(() => ({ data: { items: [] } })),
      ]);
      const items = cfgRes.data?.items || [];
      const modelItem = items.find((i: any) => i.config_key === "bedrock_model_id");
      const promptItem = items.find((i: any) => i.config_key === "agent_prompt");
      setBedrockModelId(modelItem?.config_value || "");
      setAgentPrompt(promptItem?.config_value || "");

      // 复用 RDS 巡检模型列表
      const models = modelsRes.data?.items || modelsRes.data?.models || [];
      const opts = models.map((m: any) => ({
        label: m.model_name || m.name || m.id || m.model_id,
        value: m.model_id || m.id,
      }));
      setModelOptions(opts);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); }, []);

  const handleSave = async () => {
    setError("");
    setSuccess("");
    setSaving(true);
    try {
      await updateDevopsAgentConfig({
        bedrock_model_id: bedrockModelId,
        agent_prompt: agentPrompt,
      });
      setSuccess("已保存 ✓");
    } catch (e: any) {
      setError(e?.response?.data?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Container header={<Header variant="h1">DevOps Agent 配置</Header>}>
      {loading ? <Spinner /> : (
        <SpaceBetween size="l">
          {error && <Alert type="error">{error}</Alert>}
          {success && <Alert type="success">{success}</Alert>}

          <Alert type="info" header="配置用途">
            此处配置用于 Callback Lambda 精简调查报告（长报告 → 短卡片）和 Lambda4 Health_Report_Parser 解析巡检报告。
            留空则使用环境变量 DEVOPS_AGENT_SUMMARIZER_MODEL_ID，再次降级使用硬编码默认 <code>global.anthropic.claude-opus-4-6-v1</code>。
          </Alert>

          <FormField
            label="Bedrock 模型 ID"
            description="复用 RDS 巡检的模型列表；不在列表中也可手动输入任意合法 model ID / inference profile ARN"
          >
            {modelOptions.length > 0 ? (
              <Select
                selectedOption={
                  modelOptions.find((o) => o.value === bedrockModelId) ??
                  (bedrockModelId ? { label: bedrockModelId, value: bedrockModelId } : null)
                }
                onChange={(e) => setBedrockModelId(e.detail.selectedOption.value ?? "")}
                options={modelOptions}
                placeholder="选择模型 ID"
               expandToViewport/>
            ) : (
              <Input value={bedrockModelId} onChange={(e) => setBedrockModelId(e.detail.value)} placeholder="global.anthropic.claude-opus-4-6-v1" />
            )}
          </FormField>

          <FormField
            label="Agent Prompt（可选）"
            description="自定义精简报告的 system prompt。留空则使用硬编码默认（三段式：Symptoms / Root Cause / Findings）"
          >
            <Textarea rows={8} value={agentPrompt} onChange={(e) => setAgentPrompt(e.detail.value)} />
          </FormField>

          <Box>
            <Button variant="primary" onClick={handleSave} loading={saving}>保存配置</Button>
          </Box>
        </SpaceBetween>
      )}
    </Container>
  );
}
