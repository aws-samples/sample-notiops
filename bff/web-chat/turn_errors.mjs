/**
 * /stream 里 agent 这一轮失败时给用户的话（从 index.mjs 挪出来，2026-10-23，待办 #30）。
 *
 * 三种失败形态，各有各的话：
 *   ① 一个字都没吐就失败了 → `modelFailureText`：说清是哪一档、给能做的下一步；
 *   ② 同一个会话上一轮还没结束（strands 的 Agent 锁，`ConcurrencyException`）→ 「会话忙」档，
 *      **不重试**：上一轮可能还要跑好几分钟，重发只会再撞一次锁；
 *   ③ 已经吐了部分正文、然后断了（runtime 发来错误帧，或流读到一半抛了）→ `interruptedNote`，
 *      追加在正文后面。以前这种情况被**静默吞掉**：会话里只剩一句开场白，没有报错、没有下一步
 *      （2026-10-17 验证账号实测：模型先说「我先查一下官方文档…」，调完工具后 300 秒零字节，
 *      用户看到的是一个停在半句话上的回答）。
 *
 * 只回显**错误类型**（如 InternalServerException），不回显原始报文
 * （docs/LOGGING_STANDARD.md：日志与用户可见文案都不带模型/服务的原始 message）。
 */

/** 错误类型名：runtime 错误帧报的 `error_type` 优先，其次是异常名。 */
export function errorKind(err) {
  return String(err?.runtimeErrorType || err?.name || "").trim() || "UnknownError";
}

/**
 * 错误必须分档，且与 agent 侧（main.py 的 _MODEL_TIMEOUT_ERRORS / AccessDenied /
 * ValidationException 那几档）**同一口径** —— 否则同一次失败，agent 说"权限没配"、BFF 说
 * "请再发一次"，用户按后者一直重试到放弃。判据：
 *   busy       → 同一会话上一轮还在跑；重发一样撞锁，得等它结束或换个会话
 *   permission → 重发一万次也不会好，得管理员去开权限（Bedrock 模型访问 / IAM）
 *   badRequest → 重发同样内容不会好：模型在本区不可用、或这轮请求本身不合法/过长
 *   timeout    → 模型迟迟不返回：同样的问题给同一个模型大概率再超一次，该拆小或换模型
 *                （ConnectionClosed / EndpointConnection 也归这档 —— agent 的 _MODEL_TIMEOUT_ERRORS 就是这么分的）
 *   transient  → 重发大概率就好（服务端抖动 / 限流 / 连接被断开）
 *   other      → 多为本端 bug，只说失败 + 反馈管理员，不误导成"模型的问题"
 * 顺序有讲究：busy 最先（它的类型名里什么都可能有）；timeout 在 transient 之前
 * （`ModelTimeoutException` 一类名字两边都沾，按超时说才对）。
 */
export function classifyTurnError(kind) {
  const k = String(kind || "");
  if (/ConcurrencyException/i.test(k)) return "busy";
  if (/AccessDenied|UnrecognizedClient|InvalidSignature|ExpiredToken|Unauthorized|Forbidden/i.test(k)) return "permission";
  if (/Validation|ResourceNotFound|ModelNotFound|Serialization/i.test(k)) return "badRequest";
  if (/Timeout|ConnectionClosed|EndpointConnection/i.test(k)) return "timeout";
  if (/InternalServer|ServiceUnavailable|Throttl|ModelError|ModelNotReady|ProtocolError|ResponseStreaming/i.test(k)) return "transient";
  return "other";
}

/** 「会话忙」：上一轮还在这个会话里跑（runtime 侧 strands 的 Agent 锁）。 */
export function isBusyError(err) {
  return classifyTurnError(errorKind(err)) === "busy";
}

/** 「会话忙」那句话。不给具体分钟数：上一轮还要多久取决于它卡在哪一步，说不准的数不写。 */
export function busyText(locale) {
  if (locale === "en") {
    return "⏳ **The previous turn in this conversation hasn't finished yet**, so this message was not sent — a conversation runs one turn at a time. (The previous turn may still be waiting on the model, for example if you refreshed the page while it was answering.)\n\n**Next steps:**\n1. Wait for the previous turn to finish (or time out) — usually within a few minutes; refresh the page to see its answer, then send again;\n2. Or **start a new conversation** and keep going there — new conversations are not affected.";
  }
  return "⏳ **这个会话的上一轮还没结束**，这一条没有发出去 —— 同一个会话同一时间只能跑一轮。（上一轮可能还在等模型返回，比如它回答到一半时你刷新了页面。）\n\n**下一步：**\n1. 等上一轮出结果（或超时提示）—— 通常几分钟内；刷新页面能看到它的回答，再接着发；\n2. 不想等就**新建一个对话**接着问，新对话不受影响。";
}

/**
 * 本轮一个字都没产出、且**不是**冷启动 → 说清失败原因 + 给下一步（别再只给「（无响应）」）。
 *
 * 事故背景（2026-08-25 现网）：Grok 4.6 那轮 Bedrock ConverseStream 连续
 * InternalServerException，agent runtime 按约定发了 `{error, error_type}` 帧，但 BFF 当时
 * 不认识那帧、也就没有 lastErr → 用户只看到「（无响应）」，无从判断是该重试还是换模型。
 * 现在 agentcore.mjs 会把那帧变成异常，这里负责把它翻成人话。
 *
 * `retried`：BFF 这一轮**真的**替用户重发过（attemptsMade > 1）才说「已自动重试」。以前这句
 * 无条件写在 transient 那档里，而 BFF 只对冷启动类错误重试 —— InternalServerException 一次都没
 * 重试过，文案却说重试过了（待办 #30）。
 *
 * 「去哪儿换模型」与「不点名模型」必须与 agent 侧 main.py 那几条模型失败提示的 web 分支一致：
 *   · 模型选择器在输入框工具栏**最右**（输入框右下角，Composer.tsx 的 .cbar-right），**不在**
 *     输入框上方（上方那一行是看板胶囊）；
 *   · 不点名具体模型：这里写死过「Claude Sonnet 5」，它 2026-10-10 起在模型目录里停用，客户照着
 *     去选择器里找会找不到。选择器里列的都是管理员启用的，「换一个」就够了。
 */
export function modelFailureText(locale, err, { retried = false } = {}) {
  const kind = errorKind(err);
  const tier = classifyTurnError(kind);
  if (tier === "busy") return busyText(locale);
  if (locale === "en") {
    if (tier === "transient") {
      return `⚠️ The model service returned \`${kind}\` and this turn produced no answer${retried ? " (already retried automatically)" : ""}.\n\n**Next steps:**\n1. Send the message again — this class of error is usually transient;\n2. If it keeps failing, switch to a different model at the bottom right of the input box and retry.`;
    }
    if (tier === "timeout") {
      return `⏳ The model kept returning nothing (\`${kind}\`), so this turn stopped waiting.\n\nThat usually means the question is heavy and the model is doing a long reasoning pass. **Next steps:**\n1. Narrow the question (one service, a shorter time range) and send it again;\n2. Or switch to a different model at the bottom right of the input box and retry.`;
    }
    if (tier === "permission") {
      return `🔒 This turn was **denied by permissions** (\`${kind}\`) — resending will not help.\n\n**Next step:** ask your administrator to grant this deployment access to the selected model in **Amazon Bedrock → Model access**, and to check the IAM permissions of the NotiOps agent role. Once that is done, retry.`;
    }
    if (tier === "badRequest") {
      return `⚠️ The model rejected this request (\`${kind}\`) — resending the same message will not help.\n\n**Next steps:**\n1. Switch to a different model at the bottom right of the input box (the selected one may not be available in this Region);\n2. If your message or the conversation is very long, start a new conversation and shorten the question.`;
    }
    return `⚠️ This turn failed (\`${kind}\`) and produced no answer.\n\n**Next step:** send the message again. If it keeps failing, report it to your administrator with the time of this message.`;
  }
  if (tier === "transient") {
    return `⚠️ 模型服务返回 \`${kind}\`，本轮未能生成回答${retried ? "（已自动重试）" : ""}。\n\n**下一步：**\n1. 直接再发一次 —— 这类错误多为模型服务端的临时故障；\n2. 若连续失败，在输入框右下角切换到**另一个模型**后重试。`;
  }
  if (tier === "timeout") {
    return `⏳ 模型迟迟没有返回内容（\`${kind}\`），本轮已停止等待。\n\n这通常是问题太重、模型在做很长的推理。**下一步：**\n1. 把问题拆小一点（比如只问一个服务、缩小时间范围）再发；\n2. 或在输入框右下角**换一个模型**后重试。`;
  }
  if (tier === "permission") {
    return `🔒 本轮被**权限拒绝**（\`${kind}\`），再发一次也不会好。\n\n**下一步：** 请管理员在 **Amazon Bedrock → 模型访问（Model access）** 里为本部署开通所选模型，并检查 NotiOps agent 角色的 IAM 权限；开通后再重试。`;
  }
  if (tier === "badRequest") {
    return `⚠️ 模型拒绝了这次请求（\`${kind}\`），原样重发不会好。\n\n**下一步：**\n1. 在输入框右下角**换一个模型**（当前所选可能在本区域不可用）；\n2. 若这条消息或整段对话很长，请新建会话并把问题写短一些。`;
  }
  return `⚠️ 本轮处理失败（\`${kind}\`），未能生成回答。\n\n**下一步：** 请再发送一次。若持续失败，请把这条消息的时间点反馈给管理员。`;
}

/**
 * 已经吐了部分正文、然后断了 → 追加在正文后面的一段（以 `---` 分隔，与 agent 侧
 * 「⏳ 模型在 N 分钟内没有返回内容」那段同一个排版）。必须明说上面的内容**不完整**：
 * 半句开场白看起来很像一个回答，用户会以为它就是答完了。
 */
export function interruptedNote(locale, err) {
  const kind = errorKind(err);
  const tier = classifyTurnError(kind);
  if (locale === "en") {
    const next = tier === "timeout"
      ? "1. Narrow the question (one service, a shorter time range) and send it again;\n2. Or switch to a different model at the bottom right of the input box and retry."
      : tier === "permission"
        ? "Resending will not help — ask your administrator to check this deployment's access to the selected model (Amazon Bedrock → Model access) and the agent role's IAM permissions."
        : tier === "badRequest"
          ? "Start a new conversation and ask a shorter question — resending the same message will hit the same error."
          : "Send the message again. If it keeps breaking at the same point, switch to a different model at the bottom right of the input box.";
    return `\n\n---\n⚠️ The answer was cut off (\`${kind}\`) — **what is above is incomplete**.\n\n**Next step${tier === "timeout" ? "s" : ""}:** ${tier === "timeout" ? "\n" : ""}${next}`;
  }
  const next = tier === "timeout"
    ? "1. 把问题拆小一点（比如只问一个服务、缩小时间范围）再发；\n2. 或在输入框右下角换一个模型后重试。"
    : tier === "permission"
      ? "重发不会好 —— 请管理员检查本部署对所选模型的访问权限（Amazon Bedrock → 模型访问）和 agent 角色的 IAM 权限。"
      : tier === "badRequest"
        ? "新建一个对话，把问题写短一些再问 —— 原样重发会撞上同一个错误。"
        : "直接再发一次。若反复断在同一处，在输入框右下角换一个模型后重试。";
  return `\n\n---\n⚠️ 回答在中途断了（\`${kind}\`），**上面的内容不完整**。\n\n**下一步：**${tier === "timeout" ? "\n" : ""}${next}`;
}

/**
 * 用户点了「停止」之后落库的那一句（待办 #30 第 ③ 档）。与前端本地显示的**逐字一致**
 * （ChatApp.tsx 的 handleSend 在 AbortError 分支里拼的同一句）—— 刷新前后看到的必须是同一条回答。
 */
export function stoppedNote(locale, hasText) {
  return (hasText ? "\n\n" : "") + (locale === "en" ? "_(stopped)_" : "_（已停止）_");
}
