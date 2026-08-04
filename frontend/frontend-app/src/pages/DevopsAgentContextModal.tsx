/**
 * DevOps Agent 业务上下文编辑 Modal（R8.3, R8.4）。
 *
 * 业务方在此维护：术语、调查偏好、已知问题、联系人信息。
 * 共享账户还可看到 related_business_accounts 列表（只读）。
 */
import { useEffect, useState } from "react";
import {
  Box,
  Button,
  FormField,
  Modal,
  SpaceBetween,
  Spinner,
  Textarea,
  Alert,
} from "@cloudscape-design/components";
import { getDevopsAgentAccount, updateDevopsAgentContext } from "../api";

interface Props {
  accountId: string;
  onDismiss: () => void;
}

export default function DevopsAgentContextModal({ accountId, onDismiss }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [relatedAccounts, setRelatedAccounts] = useState<string[]>([]);
  const [terms, setTerms] = useState("");
  const [preferences, setPreferences] = useState("");
  const [knownIssues, setKnownIssues] = useState("");
  const [contacts, setContacts] = useState("");

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const res = await getDevopsAgentAccount(accountId);
        const ctx = res.data?.business_context || {};
        setTerms(ctx.terms || "");
        setPreferences(ctx.preferences || "");
        setKnownIssues(ctx.known_issues || "");
        setContacts(ctx.contacts || "");
        setRelatedAccounts(res.data?.related_business_accounts || []);
      } catch (e: any) {
        setError(e?.response?.data?.message ?? String(e));
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [accountId]);

  const handleSave = async () => {
    setError("");
    setSaving(true);
    try {
      await updateDevopsAgentContext(accountId, {
        terms,
        preferences,
        known_issues: knownIssues,
        contacts,
      });
      onDismiss();
    } catch (e: any) {
      setError(e?.response?.data?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      visible
      onDismiss={onDismiss}
      header={`Agent 业务上下文 — ${accountId}`}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={onDismiss}>取消</Button>
            <Button variant="primary" onClick={handleSave} loading={saving}>保存</Button>
          </SpaceBetween>
        </Box>
      }
    >
      {loading ? <Spinner /> : (
        <SpaceBetween size="m">
          {error && <Alert type="error">{error}</Alert>}
          {relatedAccounts.length > 0 && (
            <Alert type="info" header="相关业务账户（共享账户专用）">
              {relatedAccounts.join(", ")}
            </Alert>
          )}
          <FormField label="业务术语" description="业务方特有的术语/缩写，Agent 分析时会用到（如 '玩家大区' = 按 region 分库）">
            <Textarea rows={3} value={terms} onChange={(e) => setTerms(e.detail.value)} />
          </FormField>
          <FormField label="调查偏好" description="对调查优先级、关注维度等的偏好（如 '优先关注 P0/P1 告警 + 成本影响 > $50/天'）">
            <Textarea rows={3} value={preferences} onChange={(e) => setPreferences(e.detail.value)} />
          </FormField>
          <FormField label="已知问题" description="Agent 应知晓的已知问题（如 'rds-prod-01 处于维护窗口，高 CPU 是预期'）">
            <Textarea rows={3} value={knownIssues} onChange={(e) => setKnownIssues(e.detail.value)} />
          </FormField>
          <FormField label="联系人信息" description="可包含值班/责任人 email 或飞书 ID（如 'oncall@example.com, 飞书群: xxx'）">
            <Textarea rows={2} value={contacts} onChange={(e) => setContacts(e.detail.value)} />
          </FormField>
        </SpaceBetween>
      )}
    </Modal>
  );
}
