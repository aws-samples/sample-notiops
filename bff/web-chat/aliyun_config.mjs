/**
 * 阿里云凭据配置（Admin「多云」页 → 阿里云分页的后端）。
 *
 * 与 [dingtalk_config.mjs](dingtalk_config.mjs) / [feishu_config.mjs](feishu_config.mjs)
 * **同构但不合并**：那两个是 IM 机器人凭证，这个是**客户另一朵云的账号凭据**。三样东西
 * 不一样 —— 字段集、校验规则、以及"测试连接"能证明什么。合并的结果是一堆
 * `if (platform === ...)`，而这一页最贵的 bug 恰好是**界面骗人**（见下面 `mask` 那段）。
 *
 * 路由**不挂在 `/admin/notification-config` 上**（那一条是"一次请求画出全部 IM 平台"，
 * 见 index.mjs 里那段注释），而是自己的 `/admin/aliyun-config`。阿里云凭据不是 IM
 * 平台，混进去会让 IM 那一页的 `Promise.all` 多背一个失败源。
 *
 * 存储 = Secrets Manager 单 secret `notiops/aliyun-credentials`（一个 secret、JSON 里放
 * 字段，与飞书/钉钉同构）。**按字面名引用、不做跨栈 CFN import** —— 理由同 feishu_config.mjs。
 *
 * ⚠️ 本轮只支持 AccessKey（AK/SK）一种模式
 * ────────────────────────────────────────
 * 设计上首选的是 RAM 角色 + OIDC 联合身份（客户不交出长期密钥），但"从 AWS 侧身份能否
 * `AssumeRoleWithOIDC`"这条契约**还没核实**。所以这里**不预留半个 OIDC 表单**：
 * 存下一组"填了但运行时用不上"的 ARN，客户界面上会显示"已配置"，而实际一次调用都发不出去
 * —— 那正是「不许静默降级」要挡的东西。`auth_mode` 字段现在只接受 `"ak"`，将来加
 * `"oidc"` 是**追加**，不是破坏性改动。
 *
 * ⚠️ `region_id` 会被拼进 endpoint 主机名（`sts.<region>.aliyuncs.com`）
 * ────────────────────────────────────────────────────────────────
 * 所以它的校验**不是**"填得好看点"，是一道 SSRF 闸门：只允许小写字母、数字、连字符。
 * 放过一个点号就能把 endpoint 指到任意主机（`evil.com#` 之类），而这条请求是由 Lambda
 * 的执行角色发出去的。不许放宽（见 `REGION_RE`）。
 *
 * 凭据处置口径（docs/LOGGING_STANDARD.md）：`access_key_secret` **绝不进日志、绝不进
 * 任何文件、连长度都不记**；错误响应里**绝不回显客户填的值**（错误响应会被前端原样画在
 * 页面上、也会进浏览器控制台）。日志只留异常**类型名**（`safeErr`）。
 *
 * ARCC 未查询（MCP server 本次会话连不上）—— 本模块按标准做法处理凭据：脱敏回显、
 * 回传不覆盖、不记日志、写入按资源收窄的单个 secret。
 */
import {
  SecretsManagerClient, GetSecretValueCommand, UpdateSecretCommand, CreateSecretCommand,
} from "@aws-sdk/client-secrets-manager";
// safeErr：异常一律压成"类型名/错误码"再进响应体（见 safe_err.mjs）。
import { safeErr } from "./safe_err.mjs";

/**
 * secret 名。
 *
 * ⚠️ `ALIYUN_SECRET_NAME` 这个 env **今天没有任何部署路径注入**（飞书/钉钉/Slack 那三个
 * 同名 env 也一样：只注入到 IM 平台 Lambda，从来没进过 BFF 的 environment）。保留 env
 * 读取只为与那三个模块**逐字同构**，实际生效的永远是右边这个字面名。所以改名要同时改
 * 四处：本行、infra/lib/constructs/web-chat-core.ts 的授权清单、
 * infra/lib/notiops-webchat-standalone-stack.ts 的两份方式A清单、teardown.sh。
 */
const SECRET_ID = process.env.ALIYUN_SECRET_NAME || "notiops/aliyun-credentials";

let sm = new SecretsManagerClient({});

/** 测试接缝：注入假 Secrets Manager 客户端（风格同 dingtalk_config.mjs）。 */
export function __setClients(overrides = {}) {
  if (overrides.sm) sm = overrides.sm;
}

/**
 * AccessKeyId 的形状。
 *
 * **刻意宽松**：阿里云的 AccessKeyId 历史上有过 `LTAI` 前缀（RAM 用户）、`STS.` 前缀
 * （临时凭证）和更早的纯随机串，官方没有承诺过格式。收紧到 `^LTAI` 的代价是**误拒一个
 * 合法 AK，而客户在界面上没有任何绕过手段** —— 那比放过一个错值贵得多（错值的表现是
 * "测试连接"当场返回阿里云自己的错误码，指向明确）。这里只挡住"明显不是 AK 的东西"：
 * 太短、带空白、带 `/` 或 `:`（说明客户粘错了整行）。
 */
const AK_ID_RE = /^[A-Za-z0-9._-]{12,}$/;

/**
 * region id 的形状 —— 见文件头，这是一道 SSRF 闸门，不是格式美化。
 *
 * 阿里云 region id 全部形如 `cn-hangzhou` / `ap-southeast-1` / `us-east-1`。
 * **不做穷举允许清单**：阿里云会新增地域，写死清单的代价是新地域上不了车而客户无从绕过；
 * 而字符集限制已经足够堵住主机名注入（没有 `.`、`/`、`@`、`#`、`:`，就拼不出别的主机）。
 */
const REGION_RE = /^[a-z0-9-]{4,32}$/;

/** 客户没选地域时的默认值 —— STAROps 现网就在杭州（见多云设计文档 D4）。 */
const DEFAULT_REGION = "cn-hangzhou";

/* ───────────────── STAROps 数字员工（「STAROps 对话」用）─────────────────
 * 这几个字段**复用同一个 secret**（`notiops/aliyun-credentials`），不新开一个：它们跟
 * AK/SK 是同一朵云、同一次上车动作，拆开只会多一份 IAM 授权、多一处 teardown、多一条
 * 方式A/方式B 的对等性负担，而客户界面上还是同一块表单。
 *
 * ⚠️ 只有 `starops_employee` 是必填。workspace / project 是**可选**的定位上下文：
 *    填了，数字员工的内置技能才知道去哪个工作空间查（不填不会报错，表现是"什么都查不到"
 *    —— 所以界面上必须说清楚这一点，见前端的说明文案）。
 *
 * 🔒 `starops_workspace` 的值里嵌着阿里云账号 UID（见 docs/_aliyun-m0-evidence §9）：
 *    可以回显给填它的管理员，但**绝不进日志**。
 */

/**
 * STAROps 的**接口**地域允许清单。官方元数据里 endpoints 一共就这两条。
 *
 * ⚠️ 注意它与上面那个 `region_id` 是**两件事**：
 *    · `region_id`      = 要**被巡检**的地域（客户资源在哪，如 cn-hangzhou）→ 走 variables.region
 *    · `starops_region` = STAROps **接口**在哪（数字员工资源所在地）
 *    混用会得到一个语义不明的 404，所以刻意是两个字段、两套校验。
 *
 * ⚠️ 这里能穷举就穷举（比 `REGION_RE` 严）：地域会被拼进 endpoint 主机名，而请求是 BFF 的
 *    执行角色发出去的 —— 这是一道允许清单式的 SSRF 闸门。将来阿里云新增 STAROps 地域时，
 *    往这个数组里加一条即可（前端的下拉框读的也是它的同一份文案 key）。
 *
 * ⚠️ 定义在**本文件**而不是 starops_chat.mjs：那边 import 本文件（读凭据），反向再 import
 *    就成了循环依赖。而且校验必须发生在**保存时**（客户此刻正盯着这块表单），不能拖到
 *    对话时才说"地域不对" —— 那时他早已离开这一页。
 */
export const STAROPS_REGIONS = ["cn-beijing", "ap-southeast-1"];
const DEFAULT_STAROPS_REGION = "cn-beijing";

/** 数字员工名 / workspace / project 的形状。它们会被拼进 URL 路径或请求体，
 *  这里只挡住"明显粘错了整行"（带空白、`/`、`:`、`#` 之类）—— 早失败、报得准。 */
const STAROPS_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** 本轮唯一接受的认证模式。见文件头「本轮只支持 AK/SK」。 */
const AUTH_MODES = ["ak"];

/**
 * 脱敏：只留后 4 位。
 *
 * **空值必须回显空串，不能回显 `****`** —— 与 feishu/dingtalk 同一条契约，理由也一样：
 * 方式B 里 CDK 建出来的 secret 里 `access_key_secret` 是**空串**，回 `****` 会让客户
 * 以为已经配好、跳过阿里云那边建 RAM 用户那一步，最后拿一个"什么都查不到"来排查。
 *
 * 长度 ≤4 的非空值整串遮掉 —— 后 4 位就是全部。
 */
const mask = (v) => (!v ? "" : v.length <= 4 ? "****" : `****${v.slice(-4)}`);
/** 回传值若是脱敏形态(****xxxx) → 保留原值。空串不以 **** 开头，所以「清空」仍是清空。 */
const mergeIfMasked = (nv, ov) => (typeof nv === "string" && nv.startsWith("****") && nv.length <= 8 ? ov : nv);

async function readSecret() {
  try {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
    return JSON.parse(r.SecretString || "{}");
  } catch (e) {
    // 不存在 = 首次配置这一**正常状态**，不是错误（方式A 从不预建这个 secret）。
    if (e?.name === "ResourceNotFoundException") return null;
    throw e;
  }
}

/**
 * GET：读配置，敏感字段脱敏。secret 不存在 → 空表单（首次配置场景）。
 *
 * `configured` 是给前端的**明确信号**，不让它去猜"空串是没配还是读失败"：只有 AK id 与
 * AK secret 都非空才算配好。少了任何一个，阿里云那边一次调用都发不出去。
 */
export async function apiGetAliyunConfig() {
  const data = (await readSecret()) || {};
  const akId = data.access_key_id || "";
  const akSecret = data.access_key_secret || "";
  return {
    aliyun: {
      // AccessKeyId 不是凭证（单独拿它签不出任何请求，阿里云签名要 id+secret 成对），
      // 与钉钉 app_key / 飞书 app_id 同口径：明文回显，否则客户没法核对填的是哪把钥匙。
      access_key_id: akId,
      access_key_secret: mask(akSecret),
      region_id: data.region_id || DEFAULT_REGION,
      auth_mode: data.auth_mode || "ak",
      configured: Boolean(akId && akSecret),
      // STAROps 数字员工（「STAROps 对话」用）。这几个都不是凭证，明文回显 ——
      // 客户必须看得见自己填的是哪个数字员工，否则"对话对象不可用"完全无从排查。
      starops_employee: data.starops_employee || "",
      starops_region: data.starops_region || DEFAULT_STAROPS_REGION,
      starops_workspace: data.starops_workspace || "",
      starops_project: data.starops_project || "",
      // 单独一个判据：AK 配好了不等于能跟数字员工对话（还差员工名）。两者合成一个
      // `configured` 会让「多云已连通」与「STAROps 对话可用」互相冒充 —— 界面骗人。
      starops_configured: Boolean(akId && akSecret && data.starops_employee),
    },
  };
}

/**
 * PUT：校验 + 合并（脱敏字段不覆盖）+ 写回。
 *
 * 校验失败一律 `return {error, status}` 而不是抛 —— 路由层（index.mjs）把 `error` 改名成
 * `message` 回给前端，抛出去会变成一条 500，前端分不清"你填错了"和"服务坏了"。
 */
export async function apiPutAliyunConfig(body) {
  if (!body || !body.config || typeof body.config !== "object") {
    return { error: "config object is required", status: 400 };
  }
  const cfg = body.config;

  if (cfg.auth_mode !== undefined && !AUTH_MODES.includes(cfg.auth_mode)) {
    // 显式拒绝而不是静默当成 ak：将来加 OIDC 时，老前端传 "oidc" 必须当场失败，
    // 不能被悄悄降级成"存了一把不存在的 AK"。
    return {
      error: `Unsupported auth_mode (only 'ak' is implemented in this release; RAM role / OIDC federation is not wired yet)`,
      status: 400,
    };
  }
  if (cfg.access_key_id && !AK_ID_RE.test(cfg.access_key_id)) {
    // 回显 AccessKeyId 是可以的（它不是凭证，且客户需要看到自己粘进去的是哪一串），
    // 但**绝不回显 access_key_secret**。
    return {
      error: `Invalid Aliyun access_key_id format: ${cfg.access_key_id} (expected at least 12 characters, letters/digits/./-/_ only)`,
      status: 400,
    };
  }
  if (cfg.region_id !== undefined && cfg.region_id !== "" && !REGION_RE.test(cfg.region_id)) {
    // 见文件头：region 会被拼进 endpoint 主机名。报错里不回显客户填的值 —— 一个被拒的
    // region 串可能正是一次注入尝试，原样画回页面等于把它反射给浏览器。
    return {
      error: "Invalid Aliyun region_id: expected lowercase letters, digits and hyphens only (for example cn-hangzhou)",
      status: 400,
    };
  }
  // STAROps 三个名字字段：**保存时**就拒，别拖到对话时才说"填得不对"（那时客户早已
  // 离开这一页，只会看到"连不上数字员工"这种指不到真因的话）。报错不回显客户填的值。
  for (const k of ["starops_employee", "starops_workspace", "starops_project"]) {
    if (cfg[k] !== undefined && cfg[k] !== "" && !STAROPS_NAME_RE.test(String(cfg[k]))) {
      return {
        error: `Invalid ${k}: expected letters, digits, dot, hyphen or underscore only (no spaces or slashes)`,
        status: 400,
      };
    }
  }
  if (cfg.starops_region !== undefined && cfg.starops_region !== ""
      && !STAROPS_REGIONS.includes(String(cfg.starops_region))) {
    // 穷举清单（见 STAROPS_REGIONS 的 ⚠️）。这里可以回显合法取值 —— 那是我们自己的常量，
    // 不是客户输入；客户填的那个串不回显。
    return {
      error: `Invalid starops_region: STAROps is only available in ${STAROPS_REGIONS.join(" and ")}`,
      status: 400,
    };
  }

  const existing = (await readSecret()) || {};
  const updated = {
    // 先摊开原有内容：CDK 建 secret 时生成的 `placeholder`、以及将来可能加的字段
    // （如 OIDC 的 role_arn）都不在这个表单里，摊开才不会被这次保存悄悄抹掉。
    ...existing,
    auth_mode: cfg.auth_mode ?? existing.auth_mode ?? "ak",
    access_key_id: cfg.access_key_id ?? existing.access_key_id ?? "",
    access_key_secret: mergeIfMasked(cfg.access_key_secret ?? "", existing.access_key_secret ?? ""),
    region_id: cfg.region_id || existing.region_id || DEFAULT_REGION,
    // ⚠️ 用 `??` 而不是 `||`：这三个字段**允许清空**（客户换数字员工时先清掉旧的），
    //    `||` 会把空串当"没传"从而把旧值粘回去 —— 客户按了保存却没生效，界面骗人。
    starops_employee: cfg.starops_employee ?? existing.starops_employee ?? "",
    starops_workspace: cfg.starops_workspace ?? existing.starops_workspace ?? "",
    starops_project: cfg.starops_project ?? existing.starops_project ?? "",
    // 地域反过来：它是个下拉框，空值没有意义，落回默认地域。
    starops_region: cfg.starops_region || existing.starops_region || DEFAULT_STAROPS_REGION,
  };
  const payload = JSON.stringify(updated);
  try {
    await sm.send(new UpdateSecretCommand({ SecretId: SECRET_ID, SecretString: payload }));
  } catch (e) {
    if (e?.name === "ResourceNotFoundException") {
      // 方式A 从不预建这个 secret（一键模板里没有任何凭据资源），首次保存走这条。
      // ⚠️ Tags 不是可选的：方式A 里这个 secret 由 BFF 建出来，栈级 Tags 盖不到它，
      // 不在这里打就永远没有 `project` / `auto-delete` 标签（仓库强制标签规则）。
      await sm.send(new CreateSecretCommand({
        Name: SECRET_ID,
        SecretString: payload,
        Tags: [
          { Key: "project", Value: "notiops" },
          { Key: "auto-delete", Value: "no" },
        ],
      }));
    } else throw e;
  }
  return { message: "Aliyun credentials updated successfully" };
}

/**
 * 只给同一进程内的数据面读用（不经 HTTP 暴露）：拿到**未脱敏**的凭据。
 *
 * 单独开一个函数而不是让调用方自己 `readSecret()`：这样"谁读了明文"在 git grep 里是
 * 一个可数的清单。返回 `null` 表示没配好 —— 调用方必须当场失败并告诉用户去配，
 * **不许**回落到"跳过阿里云那部分继续答"（那是静默降级）。
 */
export async function loadAliyunCredentials() {
  try {
    const d = (await readSecret()) || {};
    const id = String(d.access_key_id || "").trim();
    const secret = String(d.access_key_secret || "").trim();
    if (!id || !secret) return null;
    const region = REGION_RE.test(String(d.region_id || "")) ? d.region_id : DEFAULT_REGION;
    return {
      accessKeyId: id, accessKeySecret: secret, regionId: region,
      // STAROps 子配置。这里**只搬运、不判空**：缺员工名时要由调用方（starops_chat.mjs
      // 的 loadStarOpsConfig）报出"缺哪一项"，在这里一起 return null 会让"没填 AK"和
      // "没填数字员工"变成同一句话 —— 客户会去重填已经填好的 AK。
      staropsEmployee: String(d.starops_employee || "").trim(),
      staropsRegion: STAROPS_REGIONS.includes(String(d.starops_region || ""))
        ? d.starops_region : DEFAULT_STAROPS_REGION,
      staropsWorkspace: String(d.starops_workspace || "").trim(),
      staropsProject: String(d.starops_project || "").trim(),
    };
  } catch (e) {
    // 只记异常类型名 —— 绝不记凭据本身，连长度都不记。
    console.warn(`[BFF] load aliyun credentials failed: ${safeErr(e)}`);
    return null;
  }
}
