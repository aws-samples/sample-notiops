/** NotiOps 品牌 logo。
 *  solid（默认，脉冲款渐变实心，与落地页/侧栏一致）；
 *  hero（无边框，一笔脉冲线走出字母「N」的轨迹——既是监控/心电波形，又映射主 logo 的 N；
 *        高亮沿线流动，右波峰发光点带「由内向外扩散再收回」的呼吸波纹。用于通用主页）。 */
export default function Logo({ size = 26, variant = "solid" }: { size?: number; variant?: "solid" | "hero" }) {
  if (variant === "hero") {
    // 脉冲 N：平线进 → 左竖峰(N 左腿) → 中间斜画(N 斜杠) → 右竖峰(N 右腿) → 平线出。
    const NPATH = "M5 45 L16 45 L21 19 L47 52 L51 19 L56 45 L67 45";
    return (
      <svg className="notiops-hero-logo" viewBox="0 0 72 72" width={size} height={size} role="img" aria-label="NotiOps" style={{ width: size, height: size }}>
        <defs>
          <linearGradient id="notiops-grad-hero" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffb84d" />
            <stop offset="55%" stopColor="#ff9900" />
            <stop offset="1" stopColor="#ec7211" />
          </linearGradient>
        </defs>
        {/* 脉冲 N 底线（淡） */}
        <path d={NPATH} fill="none" stroke="url(#notiops-grad-hero)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" opacity=".26" />
        {/* 高亮段：沿整条 N 线流动，像监控数据在跑 */}
        <path className="hero-flow" d={NPATH} fill="none" stroke="url(#notiops-grad-hero)" strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round" pathLength={100} strokeDasharray="24 76" />
        {/* 右波峰发光点 + 呼吸波纹（由内向外扩散再收回） */}
        <circle className="hero-ripple" cx="51" cy="19" r="5" fill="none" stroke="url(#notiops-grad-hero)" strokeWidth="1.6" />
        <circle cx="51" cy="19" r="3.2" fill="url(#notiops-grad-hero)" />
      </svg>
    );
  }
  return (
    <svg className="sb-logo" viewBox="0 0 56 56" width={size} height={size} role="img" aria-label="NotiOps" style={{ width: size, height: size }}>
      <defs>
        <linearGradient id="notiops-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff9900" />
          <stop offset="1" stopColor="#ec7211" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="52" height="52" rx="13" fill="url(#notiops-grad)" />
      <path d="M16 40 L16 18 L40 40 L40 18" fill="none" stroke="#fff" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="40" cy="15" r="7.5" fill="url(#notiops-grad)" stroke="#fff" strokeWidth="3" />
      <circle cx="40" cy="15" r="3" fill="#fff" />
    </svg>
  );
}
