/**
 * 网关主机检查（待办 #3：三层 SSRF 名单统一成一份）。
 * 运行：node bff/web-chat/tests/gateway_host.test.mjs
 *
 * 钉的是：
 *   1. 共用用例表 tests/fixtures/gateway_host_cases.json —— Python 那三份副本跑的是同一张表
 *      （tests/test_gateway_host.py），所以「管理页能存、对话侧拒绝」这种两边结论不同的情况会在这里先红；
 *   2. 规整函数真的用上了这份名单（以前 BFF 不拦 `*.internal` / `*.local`、文档网段、
 *      `0x08.0x08.0x08.0x08` 这类经 WHATWG 换算后落到公网的写法，Python 两层却拒）；
 *   3. 原串主机的提取（WHATWG 换算之前）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hostProblem, isBlockedAddress, rawHostOf, BLOCKED_NETWORKS, BLOCKED_NAME_SUFFIXES } from "../gateway_host.mjs";
import { normalizeGatewayBaseUrl } from "../llm_config.mjs";

let ok = 0, fails = 0;
function t(name, fn) {
  try { fn(); ok++; console.log(`  ok   ${name}`); }
  catch (e) { fails++; console.log(`  FAIL ${name}\n       ${String(e?.message).split("\n")[0]}`); }
}

const cases = JSON.parse(readFileSync(new URL("./fixtures/gateway_host_cases.json", import.meta.url), "utf8"));

t("共用用例表：主机", () => {
  assert.ok(cases.hosts.length >= 50, "用例表被删短了");
  for (const [host, want] of cases.hosts) assert.equal(hostProblem(host), want, JSON.stringify(host));
});

t("共用用例表：DNS 解析出来的地址", () => {
  for (const [addr, want] of cases.addresses) assert.equal(isBlockedAddress(addr), want, JSON.stringify(addr));
});

t("名单本身：IPv4 在前、IPv6 在后，没有重复，每一条 BlockList 都认", () => {
  assert.equal(new Set(BLOCKED_NETWORKS).size, BLOCKED_NETWORKS.length);
  const firstV6 = BLOCKED_NETWORKS.findIndex((c) => c.includes(":"));
  assert.ok(firstV6 > 0 && BLOCKED_NETWORKS.slice(firstV6).every((c) => c.includes(":")));
  assert.deepEqual(BLOCKED_NAME_SUFFIXES, [".localhost", ".internal", ".local"]);
});

t("规整函数用的就是这份名单（以前 BFF 放行、Python 拒的几类）", () => {
  for (const raw of [
    "https://svc.internal/v1", "https://printer.local/v1", "https://gw．local/v1",
    "https://203.0.113.10/v1", "https://198.51.100.7/v1", "https://[2001:db8::1]/v1",
    "https://0x08.0x08.0x08.0x08/v1", "https://010.0.0.1/v1", "https://2130706433/v1",
    "https://[::ffff:7f00:1]/v1",
  ]) assert.equal(normalizeGatewayBaseUrl(raw), "", raw);
  assert.equal(normalizeGatewayBaseUrl("https://93.184.216.34/v1"), "https://93.184.216.34/v1");
  assert.equal(normalizeGatewayBaseUrl("https://gw.example.com"), "https://gw.example.com/v1");
});

t("原串主机：不经 WHATWG 换算，去掉用户信息与端口，IPv6 去方括号", () => {
  assert.equal(rawHostOf("https://0x7f.1/v1"), "0x7f.1");
  assert.equal(rawHostOf("https://user@gw.example.com:8443/v1"), "gw.example.com");
  assert.equal(rawHostOf("https://[::1]:443/v1"), "::1");
  assert.equal(rawHostOf("not a url"), "");
});

console.log(`\n${ok} passed, ${fails} failed`);
if (fails) process.exit(1);
