/**
 * 推送深链的入口参数（R11b.7 / R11b.9）。
 *
 * IM 推送里每条 finding 后面挂一个「详情」链接，形状是
 * `https://<看板>/?account=<acct>&finding=<finding_id>&tab=<子页>`。
 * 拼接侧在 `inspection/adapters/links.py`，参数名两边必须一致
 * （有 Python 侧的元断言对着这个文件比）。
 *
 * ## 🔴 读一次就把参数从 URL 上摘掉
 *
 * 不摘的表现很难查：客户点开深链落在「高负载 / 账号 A」，然后手动切到
 * 账号 B —— 任何一次重渲染都会把 `account=A` 再读一遍，于是账号自己跳回去。
 * 客户会以为账号选择器坏了。
 *
 * 用 `history.replaceState` 而不是 `pushState`：后者会往历史里塞一条，
 * 于是「返回」按钮把带参数的 URL 又拿回来 —— 同一个问题绕一圈回来。
 *
 * ## ⚠️ 模块级读取，不是 hook
 *
 * 深链是**一次性**的启动参数。做成 hook 会让每个用它的组件各读一次，
 * 而「读一次就摘掉」意味着第二个组件永远读到空 —— 谁先渲染谁生效，
 * 那种顺序依赖在测试里表现正常、在生产里随机失效。
 */

export interface DeepLink {
  /** 要切到的账号；空串 = 链接里没带。 */
  account: string;
  /** 要高亮的 finding_id；空串 = 没带。 */
  finding: string;
  /** 要打开的子页 id（`high-load` / `idle` / `structural` / `scope`）。 */
  tab: string;
}

/**
 * ⚠️ **函数而不是共享常量。** 第一版写的是 `const EMPTY = {...}` 并在没有
 * 参数时 `return EMPTY` —— 于是模块加载时（正常访问，URL 上没有参数）
 * `deepLink` 与 `EMPTY` 变成**同一个对象**，之后任何一次写入都会污染那个
 * 「空」常量，后续的空返回就带着别人的值。测试抓到的正是这个。
 */
function empty(): DeepLink {
  return { account: "", finding: "", tab: "" };
}

function read(): DeepLink {
  if (typeof window === "undefined" || !window.location) return empty();
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(window.location.search || "");
  } catch {
    return empty();
  }
  const out: DeepLink = {
    account: (params.get("account") || "").trim(),
    finding: (params.get("finding") || "").trim(),
    tab: (params.get("tab") || "").trim(),
  };
  if (!out.account && !out.finding && !out.tab) return out;

  // 摘掉这三个，别的 query 参数原样留着（可能是别人的）。
  try {
    for (const k of ["account", "finding", "tab"]) params.delete(k);
    const rest = params.toString();
    const url = window.location.pathname + (rest ? `?${rest}` : "")
      + (window.location.hash || "");
    window.history.replaceState({}, "", url);
  } catch {
    // 摘不掉也不影响这一次跳转 —— 只是上面那个「账号跳回去」的问题会出现。
    // 宁可少一次清理，也不要让整个看板因为 history API 不可用而白屏。
  }
  return out;
}

/**
 * 本次会话的深链参数。**模块加载时读一次**，之后恒定。
 *
 * ⚠️ 导出的是值而不是函数：函数会诱使调用方在渲染里反复调，
 * 而第二次调用拿到的是已经被摘空的 URL。
 */
export const deepLink: DeepLink = read();

/** 测试用：重置并重读（生产代码 SHALL NOT 调）。 */
export function _rereadForTests(): DeepLink {
  const fresh = read();
  Object.assign(deepLink, fresh);
  return deepLink;
}
