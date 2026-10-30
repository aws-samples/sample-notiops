import qrcode from "qrcode-generator";

/**
 * 二维码（两步验证绑定用）。**在浏览器本地生成**：内容是 `otpauth://` 地址，里面带着验证器密钥 ——
 * 交给任何在线二维码服务（图片 URL 之类）就等于把密钥发给了第三方。
 *
 * 用 React 画 SVG 方块而不是 `createSvgTag()` + `dangerouslySetInnerHTML`：不往 DOM 里塞 HTML 字符串，
 * 哪怕内容是自己生成的。纠错级别 M（扫描容错与码尺寸的常规折中）。
 */
export default function QrCode({ value, size = 184, label }: { value: string; size?: number; label: string }) {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4; // 规范要求的四格白边
  const dim = n + quiet * 2;
  const cells: string[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) cells.push(`M${c + quiet} ${r + quiet}h1v1h-1z`);
    }
  }
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${dim} ${dim}`}
         shapeRendering="crispEdges" style={{ background: "#fff", borderRadius: 8, display: "block" }}>
      <path d={cells.join("")} fill="#000" />
    </svg>
  );
}
