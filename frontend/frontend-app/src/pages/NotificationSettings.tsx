/**
 * 通知设置管理页面。
 * 配置飞书 IM 机器人的凭证和推送群组列表。
 * (钉钉已下线:入站对话与出站推送均移除,后端 notification_config 仅支持飞书)
 */
import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Container,
  FormField,
  Header,
  Input,
  SpaceBetween,
  Spinner,
  // StatusIndicator removed - unused
} from "@cloudscape-design/components";
import {
  getNotificationConfig,
  updateNotificationConfig,
  testNotificationSend,
} from "../api";

interface FeishuConfig {
  app_id: string;
  app_secret: string;
  notify_chat_ids: string;
}

interface NotificationConfigData {
  feishu: FeishuConfig;
}

const EMPTY_FEISHU: FeishuConfig = {
  app_id: "",
  app_secret: "",
  notify_chat_ids: "",
};

export default function NotificationSettings() {
  const [loading, setLoading] = useState(true);
  const [feishuForm, setFeishuForm] = useState<FeishuConfig>(EMPTY_FEISHU);
  const [feishuChatIds, setFeishuChatIds] = useState<string[]>([""]);
  const [savingFeishu, setSavingFeishu] = useState(false);
  const [testingChatId, setTestingChatId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await getNotificationConfig();
      const data: NotificationConfigData = res.data;

      setFeishuForm(data.feishu || EMPTY_FEISHU);

      // 解析 chat_ids（逗号分隔）
      const feishuIds = (data.feishu?.notify_chat_ids || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      setFeishuChatIds(feishuIds.length > 0 ? feishuIds : [""]);
    } catch {
      setFeishuForm(EMPTY_FEISHU);
      setFeishuChatIds([""]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleSaveFeishu = async () => {
    setErrorMsg("");
    setSavingFeishu(true);
    try {
      const chatIdsStr = feishuChatIds.filter((id) => id.trim()).join(",");
      await updateNotificationConfig({
        platform: "feishu",
        config: {
          ...feishuForm,
          notify_chat_ids: chatIdsStr,
        },
      });
      await fetchData();
    } catch (e: any) {
      setErrorMsg(e.response?.data?.message || "保存失败");
    } finally {
      setSavingFeishu(false);
    }
  };

  const handleTestSend = async (platform: "feishu", chatId: string) => {
    if (!chatId.trim()) {
      setErrorMsg("请先输入 Chat ID");
      return;
    }
    const testKey = `${platform}-${chatId}`;
    setTestingChatId(testKey);
    setErrorMsg("");
    try {
      const res = await testNotificationSend({ platform, chat_id: chatId.trim() });
      if (res.data.success) {
        alert(`测试消息已发送至 ${platform} (${chatId})`);
      } else {
        setErrorMsg(`测试发送失败: ${res.data.message}`);
      }
    } catch (e: any) {
      setErrorMsg(e.response?.data?.message || "测试发送失败");
    } finally {
      setTestingChatId(null);
    }
  };

  const addFeishuChatId = () => setFeishuChatIds([...feishuChatIds, ""]);
  const removeFeishuChatId = (idx: number) =>
    setFeishuChatIds(feishuChatIds.filter((_, i) => i !== idx));
  const updateFeishuChatId = (idx: number, val: string) => {
    const updated = [...feishuChatIds];
    updated[idx] = val;
    setFeishuChatIds(updated);
  };

  if (loading)
    return (
      <Box textAlign="center" padding="xxxl">
        <Spinner size="large" />
      </Box>
    );

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description="配置飞书通知机器人的凭证和推送目标">
        通知设置
      </Header>

      {errorMsg && <Box color="text-status-error">{errorMsg}</Box>}

      {/* 飞书配置 */}
      <Container
        header={
          <Header
            variant="h2"
            actions={
              <Button variant="primary" loading={savingFeishu} onClick={handleSaveFeishu}>
                保存飞书配置
              </Button>
            }
          >
            飞书 (Feishu) 配置
          </Header>
        }
      >
        <SpaceBetween size="m">
          <FormField label="App ID">
            <Input
              value={feishuForm.app_id}
              onChange={({ detail }) =>
                setFeishuForm({ ...feishuForm, app_id: detail.value })
              }
              placeholder="cli_xxxxxxxxxxxxxxxx"
            />
          </FormField>
          <FormField label="App Secret" description="敏感信息，仅显示后4位">
            <Input
              type="password"
              value={feishuForm.app_secret}
              onChange={({ detail }) =>
                setFeishuForm({ ...feishuForm, app_secret: detail.value })
              }
              placeholder="留空保持不变"
            />
          </FormField>
          <FormField
            label="推送群组 Chat ID 列表"
            description="飞书群组的 Chat ID（如 oc_xxxxx），每个群组一行"
          >
            <SpaceBetween size="s">
              {feishuChatIds.map((chatId, idx) => (
                <SpaceBetween key={idx} direction="horizontal" size="xs">
                  <Input
                    value={chatId}
                    onChange={({ detail }) => updateFeishuChatId(idx, detail.value)}
                    placeholder="oc_xxxxxxxxxxxxx"
                  />
                  <Button
                    iconName="close"
                    variant="link"
                    onClick={() => removeFeishuChatId(idx)}
                    disabled={feishuChatIds.length === 1}
                  >
                    删除
                  </Button>
                  <Button
                    iconName="share"
                    variant="link"
                    loading={testingChatId === `feishu-${chatId}`}
                    onClick={() => handleTestSend("feishu", chatId)}
                  >
                    测试
                  </Button>
                </SpaceBetween>
              ))}
              <Button iconName="add-plus" variant="link" onClick={addFeishuChatId}>
                添加群组
              </Button>
            </SpaceBetween>
          </FormField>
        </SpaceBetween>
      </Container>

      <Box color="text-body-secondary">
        <b>使用说明：</b>
        <ul>
          <li>飞书群组 Chat ID 可通过机器人管理后台或群设置获取（格式：oc_xxxxx）</li>
          <li>App Secret 显示为脱敏格式，留空则保持原值不变</li>
          <li>长连接（Socket 模式）只需 App ID + App Secret，无需 Verification Token / Encrypt Key</li>
          <li>点击"测试"按钮可向对应群组发送测试消息，验证配置是否正确</li>
        </ul>
      </Box>
    </SpaceBetween>
  );
}
