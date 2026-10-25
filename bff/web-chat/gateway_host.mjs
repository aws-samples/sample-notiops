/**
 * OpenAI 兼容网关地址的主机检查（BFF 那一层）—— 与 Python 的 `shared/gateway_host.py`
 * 同一份名单、同一套规则（待办 #3，2026-10-23）。为什么要有唯一一份名单、名单里为什么是这些段，
 * 见那个文件的文件头；这里只说 JS 这边的差别。
 *
 * ⚠️ `BLOCKED_NETWORKS` / `BLOCKED_NAME_SUFFIXES` 必须与 Python 版逐条一致（顺序也一样）：
 *    `tests/test_gateway_host.py` 从本文件源码里抠出这两个数组去比，用例表
 *    `tests/fixtures/gateway_host_cases.json` 由 `bff/web-chat/tests/gateway_host.test.mjs` 跑本文件。
 *
 * JS 这边多一件事：WHATWG URL 解析会把 `0x7f.1`、`2130706433`、`0177.0.0.1` 这类写法**先换算成**
 * 点分 IPv4（`new URL(...).hostname` 已经是 `127.0.0.1`），所以「只收标准点分写法」那条要拿**原串里**
 * 的主机去判 —— 见 `rawHostOf`。
 */
import net from "node:net";

/** 不许连的网段（IPv4 在前、IPv6 在后）。与 shared/gateway_host.py::BLOCKED_NETWORKS 逐条一致。 */
export const BLOCKED_NETWORKS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "3fff::/20",
  "5f00::/16",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
];

/** 不许用的主机名后缀（外加恰好等于 `localhost`）。与 Python 版一致。 */
export const BLOCKED_NAME_SUFFIXES = [".localhost", ".internal", ".local"];

const _blocked = (() => {
  const bl = new net.BlockList();
  for (const cidr of BLOCKED_NETWORKS) {
    const [addr, bits] = cidr.split("/");
    bl.addSubnet(addr, Number(bits), addr.includes(":") ? "ipv6" : "ipv4");
  }
  return bl;
})();

const NUMERIC_HOST_RE = /^(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+)){0,3}$/;
// IDNA 认作点号的几个字符：`gw．local` 解析时就是 `gw.local`（与 Python 版同一张表）。
const DOT_LIKE_RE = /[。．｡]/g;

const _clean = (host) => String(host ?? "").trim().replace(/^\[|\]$/g, "").toLowerCase()
  .replace(DOT_LIKE_RE, ".").replace(/\.+$/, "");

/**
 * 地址落在 `BLOCKED_NETWORKS` 里（IPv4 映射的 IPv6 按里面那个 IPv4 判）。
 * 不是合法 IP 的一律当拦（调用方只会拿 DNS 解析结果来问）。
 */
export function isBlockedAddress(addr) {
  const a = _clean(addr);
  const v = net.isIP(a);
  if (!v) return true;
  try {
    if (v === 6) {
      const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
      if (dotted) return _blocked.check(dotted[1], "ipv4");
      // `::ffff:7f00:1` 这种十六进制写法的 IPv4 映射：换回点分再判。
      const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(a);
      if (hex) {
        const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
        return _blocked.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, "ipv4");
      }
      return _blocked.check(a, "ipv6");
    }
    return _blocked.check(a, "ipv4");
  } catch {
    return true;   // BlockList 不认的写法（如带 zone id 的 `fe80::1%eth0`）：当拦，失败方向保守
  }
}

/**
 * URL 里的主机（解析 DNS **之前**）有什么问题；没问题返回 ""。
 * 返回固定的枚举词（`empty` / `localhost` / `internal_name` / `non_public_ip` / `numeric_host`），
 * 与 Python 版 `host_problem` 逐个一致。
 */
export function hostProblem(host) {
  const h = _clean(host);
  if (!h) return "empty";
  if (h === "localhost" || h.endsWith(".localhost")) return "localhost";
  if (BLOCKED_NAME_SUFFIXES.some((s) => h.endsWith(s))) return "internal_name";
  if (net.isIP(h)) return isBlockedAddress(h) ? "non_public_ip" : "";
  if (NUMERIC_HOST_RE.test(h)) return "numeric_host";
  return "";
}

/** `https://user@host:443/path` 里**原样**的主机部分（没经过 WHATWG 换算）。取不出来返回 ""。 */
export function rawHostOf(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(String(url ?? "").trim());
  if (!m) return "";
  const authority = m[1].slice(m[1].lastIndexOf("@") + 1);
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    return end > 0 ? authority.slice(1, end) : "";
  }
  return authority.split(":")[0];
}
