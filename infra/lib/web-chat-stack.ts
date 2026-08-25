/**
 * WebChatStack — NotiOps 面向客户的 agentic Web Chat。
 *
 * Phase 0 部署：
 *   - notiops-web-chat DDB 表（会话/消息，单表 + TTL）
 *   - Web Chat BFF：Node 20 Lambda + Function URL（response streaming, SSE）
 *   - chat-app 前端：S3 + CloudFront
 *   - config.json 注入（chatApiBase = Function URL；cognito* 复用 idle 池）
 *
 * 认证复用 NotiOpsBackendStack 的 Cognito 池（props 传入 userPoolId/clientId）。
 * Phase 1 起 BFF 内部改为调用 AgentCore Runtime（本 stack 结构不变）。
 *
 * ⚠️ 资源定义全部在 lib/constructs/web-chat-core.ts 的 `createWebChatCore()` 里 ——
 * 一键部署（Launch Stack）的 standalone 单栈复用同一份定义。
 * 那里导出的是**函数**而非 Construct 子类，
 * 目的就是让本栈的逻辑 ID 一个都不变（Construct 会多插一层路径 → 全量重建）。
 */
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { createWebChatCore, WebChatCoreProps } from "./constructs/web-chat-core";

export interface WebChatStackProps extends cdk.StackProps, WebChatCoreProps {}

export class WebChatStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebChatStackProps) {
    super(scope, id, props);

    createWebChatCore(this, props);
  }
}
