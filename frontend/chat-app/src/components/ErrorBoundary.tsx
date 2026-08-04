import { Component, type ErrorInfo, type ReactNode } from "react";
import { recordRumError } from "../rum";

/**
 * 错误边界：包裹主内容区。任一视图/仪表盘渲染抛异常时，显示可恢复的错误卡，
 * 而不是让整个应用白/黑屏（此前无边界 → 单个组件崩溃即整页空白）。
 */
interface Props { children: ReactNode; label?: string }
interface State { error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    // 打到控制台便于排查（生产可接入上报）
    console.error("[NotiOps] UI error boundary caught:", error, info?.componentStack);
    recordRumError(error); // 上报 CloudWatch RUM
  }
  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: "40px 24px", maxWidth: 640, margin: "0 auto", color: "var(--text)" }}>
          <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderLeft: "3px solid #d13212", borderRadius: 11, padding: "16px 18px" }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>
              {this.props.label ? `${this.props.label} — ` : ""}页面加载出错 / Something went wrong
            </div>
            <div style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.6, marginBottom: 12 }}>
              该视图渲染时出现异常，已被隔离，未影响其它页面。可点下方重试，或切换到其它 tab。
              <br />This view hit an error and was isolated — other tabs are unaffected. Retry, or switch tabs.
            </div>
            <div style={{ fontSize: 11.5, color: "var(--muted)", fontFamily: "monospace", background: "var(--page, #0002)", padding: "6px 8px", borderRadius: 6, marginBottom: 12, overflowX: "auto" }}>
              {String(this.state.error?.message || this.state.error)}
            </div>
            <button className="navitem" style={{ width: "auto", padding: "6px 16px", borderRadius: 8 }} onClick={this.reset}>重试 / Retry</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
