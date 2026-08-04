/**
 * Cognito 登录页面。
 * 支持首次登录强制修改密码（NEW_PASSWORD_REQUIRED）。
 */
import { useState } from "react";
import { signIn, confirmSignIn } from "aws-amplify/auth";
import { useNavigate } from "react-router-dom";
import {
  Box,
  Button,
  Container,
  Form,
  FormField,
  Header,
  Input,
  SpaceBetween,
  Alert,
} from "@cloudscape-design/components";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [needNewPassword, setNeedNewPassword] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async () => {
    setError("");
    setLoading(true);
    try {
      const result = await signIn({ username, password });
      if (
        result.nextStep?.signInStep ===
        "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED"
      ) {
        setNeedNewPassword(true);
      } else if (result.isSignedIn) {
        navigate("/", { replace: true });
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "登录失败");
    } finally {
      setLoading(false);
    }
  };

  const handleNewPassword = async () => {
    setError("");
    if (newPassword !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    if (newPassword.length < 8) {
      setError("密码长度至少 8 位");
      return;
    }
    setLoading(true);
    try {
      const result = await confirmSignIn({
        challengeResponse: newPassword,
      });
      if (result.isSignedIn) {
        navigate("/", { replace: true });
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "密码修改失败");
    } finally {
      setLoading(false);
    }
  };

  if (needNewPassword) {
    return (
      <Box padding="xxxl">
        <Container
          header={<Header variant="h1">首次登录 — 请设置新密码</Header>}
        >
          <Form
            actions={
              <Button
                variant="primary"
                loading={loading}
                onClick={handleNewPassword}
              >
                确认修改
              </Button>
            }
          >
            <SpaceBetween size="l">
              {error && <Alert type="error">{error}</Alert>}
              <Alert type="info">
                首次登录需要修改密码。密码要求：至少 8 位，包含大小写字母和数字。
              </Alert>
              <FormField label="新密码">
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.detail.value)}
                />
              </FormField>
              <FormField label="确认新密码">
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.detail.value)}
                />
              </FormField>
            </SpaceBetween>
          </Form>
        </Container>
      </Box>
    );
  }

  return (
    <Box padding="xxxl">
      <Container header={<Header variant="h1">NotiOps</Header>}>
        <Form
          actions={
            <Button variant="primary" loading={loading} onClick={handleSubmit}>
              登录
            </Button>
          }
        >
          <SpaceBetween size="l">
            {error && <Alert type="error">{error}</Alert>}
            <FormField label="用户名">
              <Input
                value={username}
                onChange={(e) => setUsername(e.detail.value)}
              />
            </FormField>
            <FormField label="密码">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.detail.value)}
              />
            </FormField>
          </SpaceBetween>
        </Form>
      </Container>
    </Box>
  );
}
