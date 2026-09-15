/**
 * 「加载失败」条 —— 各仪表盘共用。
 *
 * 存在的理由：**「我们没问到」和「答案是没有 / 不可用」是两件事**，指向完全不同的下一步。
 *   「不可用」（灰色小字）  = 这就是你环境的事实（没开这个服务 / 支持计划不够）→ 别再等了。
 *   「加载失败」（本组件）  = 我们这边没请求成功（未登录 / http_5xx / 网络断）→ 重试 / 查权限。
 *
 * 两态混成一态时，一次 HTTP 500 会被画成「你没在用 AWS Backup」「需 Business Support」
 * 甚至「当前无告警 ✓」—— 用户会当真，不会重试，也不会报障。所以这条**刻意**长得
 * 和「不可用」不一样：红色边框 + 重试按钮。
 *
 * `code` 只放我们自己的错误码（`http_500` / `fetch_failed` / `not_authenticated`，或后端
 * 回的异常**类型名**）。**绝不**放上游 message 或 `String(e)` —— 那里面有账号 id / ARN /
 * 表名 / 请求 URL，而这里是要画到界面上的。见 docs/LOGGING_STANDARD.md。
 */
export default function FailBanner({
  zh, what, code, onRetry,
}: {
  zh: boolean;
  /** 没取到的是什么（已本地化的名词短语，如「CloudWatch 告警」）。 */
  what: string;
  code?: string;
  onRetry?: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 13, color: "var(--text)",
      background: "rgba(209,50,18,.06)", border: "1px solid rgba(209,50,18,.35)", borderRadius: 9, padding: "8px 11px" }}>
      <span style={{ color: "#d13212", fontWeight: 700 }}>{zh ? "加载失败" : "Load failed"}</span>
      <span style={{ color: "var(--muted)" }}>
        {zh ? `${what} 没能取到 —— 这不代表没有数据，也不代表功能不可用。` : `Could not fetch ${what} — this does not mean there is no data, nor that the feature is unavailable.`}
        {code ? ` (${code})` : ""}
      </span>
      {onRetry && (
        <button onClick={onRetry}
          style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, padding: "2px 12px", borderRadius: 100, border: "1px solid var(--orange)", background: "rgba(255,153,0,.10)", color: "var(--text)", cursor: "pointer" }}>
          {zh ? "重试" : "Retry"}
        </button>
      )}
    </div>
  );
}
