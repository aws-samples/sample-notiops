/**
 * Admin「多云」→ 右侧抽屉里的**阿里云凭据配置详细步骤**（zh / en）。
 *
 * 与 feishuGuide.ts / dingtalkGuide.ts 同一套 `GuideBlock` 协议、同一个渲染壳
 * （ImGuideDrawer），理由见 feishuGuide.ts 文件头：成段的操作文档不拆进 i18n.ts。
 *
 * ⚠️ **本文件刻意不含 `webhookUrl` 块。** 那个块是「回显本部署真实的回调地址 + 一键
 *    复制」，是 IM 三个平台特有的：配 IM 时客户需要把**我们的**地址填进 IM 后台。
 *    配阿里云是反方向 —— 全程只有「从阿里云控制台复制到本页」，我们这边没有任何
 *    需要交给阿里云的地址。所以 AliyunGuideDrawer 也不传那三个 url 相关 prop。
 *    这条不变量由 `AdminPanel.aliyun.test.tsx` 断言（见那里的理由）：ImGuideDrawer
 *    对没接线的 `webhookUrl` 块是**静默不渲染**的，靠人看是看不出来的。
 *
 * ## 内容边界（别把下面这些写进来）
 *
 * · **只写 STAROps 的「权限」那一小半，别写开通流程。** 🔁 2026-09-13 **第二次修订**：这条上一版
 *   写的是「`AliyunReadOnlyAccess` 按 `*:Describe*` / `*:List*` / `*:Get*` 通配覆盖，通配不到
 *   `CreateThread` / `CreateChat`，所以要客户再手写一份自定义策略」。**那两句都是错的**，已按真
 *   账号实测改掉：
 *     ① `AliyunReadOnlyAccess` 这个策略**根本不存在**（枚举了阿里云全部 979 条系统策略，无产品
 *        前缀的只有 `AdministratorAccess` / `PowerUserAccess` / `ReadOnlyAccess`）—— 客户照上一版
 *        文案去策略里搜，搜到的是空列表；
 *     ② 官方的 `AliyunSTAROpsReadOnlyAccess` **自己就含** `starops:CreateThread` /
 *        `starops:CreateChat`（资源限定 `digitalemployee/apsara-*`）⇒ **内置**数字员工只需勾这一条，
 *        不需要客户手写任何 JSON。
 *   §2 里的 Action 名、资源 ARN 与策略内容**不是猜的**：是 `ram:GetPolicy` 逐字取回的策略正文，
 *   加上 2026-09-13 在真账号（cn-beijing / 内置员工 `apsara-ops`）上跑通的全链路（GetDigitalEmployee
 *   / CreateThread / CreateChat 三个 200 + 完整回答）。改那一段前回到同一个来源核对，**不要凭印象
 *   增删 Action**：多给等于让客户超授权，少给等于把 403 写进说明书。
 *   仍然**不写**的是:开通 STAROps、建/改数字员工、配数据源与工具、地域可用性 ——
 *   那些都在阿里云控制台做，本页没有对应入口，写成步骤等于给一句无法在这里执行的指路。
 * · **自建数字员工必须单独写一段（不是可选提示）。** 官方策略的资源前缀 `digitalemployee/apsara-*`
 *   只覆盖内置员工；自建员工实测 `CreateThread` → **403 `NoPermission`**（名字对不上时
 *   `GetDigitalEmployee` 先回 404 `DigitalEmployeeNotExist`）。而 NotiOps 侧的员工 ID 校验
 *   （`bff/web-chat/starops_chat.mjs::EMPLOYEE_RE`）**不拦**自建名字 ⇒ 本页会显示「已接入」、
 *   「新对话」里也能选中，**第一句才被拒**。所以 §2 必须给出那条限定到客户自己员工 ARN 的
 *   自定义策略处方。⚠️ 其中 `ram:PassRole` 那一句**必须保留「未实测」标注**：官方权限配置页说
 *   「和数字员工对话时需要 PassRole」，但 `AliyunSTAROpsFullAccess` 里的 `PassRole` 是限定到
 *   服务关联角色 `AliyunServiceRoleForSTAROps` 的，**不是**员工自己的 `roleArn`；我们手上只有内置
 *   员工，无法证实自建员工到底需不需要它 —— 所以写成「撞上 RAM 错误再加」，不写成前置步骤。
 * · **不写 RAM 角色 / OIDC。** 后端当前只接受 `auth_mode="ak"`，传别的会被显式 400。
 *   写「也可以用角色」等于让客户去做一件本页保存不了的事。
 * · **不写具体的 Deny 分片策略 JSON。** 这条约束仍然有效，但**理由换了**。旧理由是「账号级只读会
 *   覆盖数据面，所以要告诉客户自己叠 Deny」。现在推荐的路径**根本不挂账号级只读** —— 实测把
 *   `ReadOnlyAccess` 从那个 RAM 用户上摘掉之后，数字员工读到的资源实体**逐字不变**（5 类 18 个、
 *   零权限错误），因为那些读走的是 STAROps / 云监控自己的资源中心，**不消耗客户给我们的这副 AK**。
 *   所以仍然是：给判断依据，不给一份会过期的 JSON。
 * · **「谁是边界」这一段 2026-09-13 第三次修订，别改回去。** 上一版写的是「真正的边界不在这副 AK 上，
 *   而在 STAROps 的纳管范围与数字员工自己那个角色上 —— 想收窄就去调那两处」。**那句把客户指向了两个
 *   在内置员工上并不存在的旋钮，而且与它上一段自己的「不要挂账号级只读」互相矛盾**：
 *     ① 内置员工**没有自己的角色** —— 实测 `GetDigitalEmployee` 回来的 `roleArn` 是空字符串
 *        （`employeeType:"system"`）。「去改员工角色」只对**自建**员工成立。
 *     ② 阿里云官方权限配置页的口径是**系统内置员工继承调用者权限**（本仓库阿里云设计文档 §6.6.1
 *        已核实；§8.2A 方案 C —— 也就是我们实际发货的这条路 —— 的前提就是这一条）⇒ 对内置员工，
 *        **这副 AK 的 RAM 策略就是它权限上限的一半**。照上一版「这副 AK 不是边界、想收窄去别处」读，
 *        客户会推出「那挂个账号级只读也无所谓」，正好撞上上一段刚劝住的那件事。
 *     ③ 我们的对照实验只证明了「它读实体库那一段不花这副 AK」，**没有**证明「AK 与它能看到什么无关」。
 *        「继承调用者权限」的**实际范围我们没能实测出来**（内置员工连 aliyun CLI 都被 STAROps 自己禁掉，
 *        逐字回 `Aliyun CLI is forbidden for system employee`，那条继承今天没有落地路径）—— 设计文档
 *        U-23 也仍然把它标成 ⚠️ 未验证。所以文案里必须按「上限 / 未实测」写，不许写成确切范围。
 */
import type { Locale } from "../i18n";
import type { GuideBlock } from "./feishuGuide";

const ZH: GuideBlock[] = [
  { k: "h", tx: "先看清这一步在做什么" },
  { k: "p", tx: "本页保存的是**你的阿里云账号**的一副只读访问密钥（AccessKey ID / AccessKey Secret）。NotiOps 用它以只读方式访问你的阿里云资源 —— 与 AWS 侧那条「只挂 ReadOnlyAccess」的边界是同一个思路。" },
  { k: "warn", tx: "绝对不要填阿里云**主账号**（根账号）的 AccessKey。主账号的密钥等于账号本身的全部权限，一旦泄漏无法用权限收敛来兜底，只能销号级别地处置。请按下面的步骤新建一个专用 RAM 用户。" },

  { k: "h", tx: "1. 新建一个专用 RAM 用户" },
  {
    k: "ol",
    items: [
      "用主账号登录阿里云，打开访问控制 RAM 控制台：https://ram.console.aliyun.com",
      "身份管理 → 用户 → 创建用户。登录名建议一眼能看出用途，例如 notiops-readonly。",
      "访问方式勾选「使用永久 AccessKey 访问」(OpenAPI 调用访问)；**不要**勾控制台登录 —— 这个身份不需要人去登。",
      "创建完成后页面会显示 AccessKey ID 与 AccessKey Secret。",
    ],
  },
  { k: "warn", tx: "AccessKey Secret **只在创建的那一刻显示一次**，关掉页面就再也取不回来（只能删掉重建一副）。请在关闭前先复制到本页并保存。" },
  { k: "p", tx: "RAM 用户的 AccessKey ID 通常以 `LTAI` 开头。本页对它只做宽松的形状校验（不钉死前缀），所以 STS 临时凭据形态的 id 也能填进来 —— 但**临时凭据不要填**，理由见最后一节。" },

  { k: "h", tx: "2. 给这个用户权限（一条官方策略；自建数字员工要多加一条）" },
  {
    k: "ol",
    items: [
      "还在 RAM 控制台：身份管理 → 用户 → 点开刚建的用户 → 权限管理 → 新增授权。",
      "授权范围选整个账号，策略里搜 `AliyunSTAROpsReadOnlyAccess` 并勾上。",
      "确定。**内置**数字员工（名字以 `apsara-` 开头，例如 `apsara-ops`）到这里就完了 —— 不用再加任何策略，也**不要**再挂账号级只读。",
    ],
  },
  { k: "p", tx: "`AliyunSTAROpsReadOnlyAccess` 是阿里云官方的 STAROps 只读系统策略。它里面有两部分：`starops:Get*` / `starops:List*`（读数字员工、读会话），以及**对话必需的** `starops:CreateThread` / `starops:CreateChat` —— 后两个的资源被官方限定在 `acs:starops:*:*:digitalemployee/apsara-*`，也就是**只覆盖内置数字员工**。2026-09-13 我们在真账号上（地域 cn-beijing、内置员工 apsara-ops）**只挂这一条**跑通了全链路：查员工 → 开会话 → 问一句 → 拿到完整回答。" },
  { k: "warn", tx: "**不要为了这个功能挂账号级只读（`ReadOnlyAccess`），也不要挂 `AliyunSTAROpsFullAccess`。** 我们实测过：把账号级只读从这个 RAM 用户上摘掉之后，数字员工读到的资源实体**逐字不变**（5 类 18 个），一个权限错误都没有 —— 因为它读的是 STAROps / 云监控自己的资源中心，那条读**不消耗你给我们的这副 AK**。所以账号级只读对这条路径是纯多余的授权。`AliyunSTAROpsFullAccess` 则额外带 `ram:CreateServiceLinkedRole` 与 `ram:PassRole`，本产品一个都不用。" },
  { k: "p", tx: "**「只读」不等于「数字员工看不到敏感数据」—— 但也别反过来以为这副 AK 无关紧要。** 分两半看：① **内置**数字员工（`apsara-*`）按阿里云官方权限配置页的口径是**继承调用者权限**的，也就是继承这副 AK 的 RAM 策略 ⇒ 「只挂 `AliyunSTAROpsReadOnlyAccess` 一条」本身就是把它权限上限的这一半按在最小面上；反过来，给这个 RAM 用户挂上账号级只读，等于把你**整个账号的读面**一并交出去 —— 包括数据面的读，例如取对象存储里的对象内容，以及 `ecs:DescribeInstanceVncUrl` 这种「访问级别标成 get、实际却给出可登录入口」的接口。② 但它读资源清单那一段**不花这副 AK**：实测把账号级只读摘掉之后，它读到的资源实体逐字不变（5 类 18 个、零权限错误），那一段走的是 STAROps / 云监控自己的资源中心 —— 这一半的范围由**纳管进 STAROps / 云监控的资源范围**决定，在这副 AK 上叠 Deny 收不住它。" },
  { k: "p", tx: "⚠️ 上面这两句 2026-09-13 修订过，有两处**别按旧说法去做**。**内置员工没有「自己的角色」可改** —— 实测 `GetDigitalEmployee` 回来的 `roleArn` 是空的；本页上一版让你「去改员工角色」，内置员工上根本没有这个对象。那条路只对**自建**员工成立，而自建员工那个角色才是它真正的硬边界，请按最小权限配。另外，「继承调用者权限」的**确切范围我们没能实测出来**：内置员工连 aliyun CLI 都被 STAROps 自己禁掉（它会逐字回一句 `Aliyun CLI is forbidden for system employee`），所以今天看不出这条继承落在哪些读上 —— 请把 ① 当**上限**读，别当「它确切能看到什么」。要一条能写进安全评审的确定边界，请找阿里云确认，或者改用自建员工 + 你自己配的只读角色。" },
  { k: "p", tx: "**自建数字员工（名字不以 `apsara-` 开头）：还要再加一条自定义策略。** 上面那条官方策略把 `CreateThread` / `CreateChat` 的资源限死在 `digitalemployee/apsara-*`，所以自建员工只挂它是**对不上话的** —— 我们实测过：开会话直接 403 `NoPermission`。这个缺陷的样子最坏：本页显示已接入、「新对话」里也能选中「阿里云 STAROps」，问第一句才被拒。✅ **2026-09-14 已在真账号上端到端跑通**（自建员工，`GetDigitalEmployee` → `CreateThread` → `CreateChat` 全 200 并拿到完整回答），下面那段 JSON 就是跑通的那一份，**可以整段复制**。" },
  { k: "p", tx: "⚠️ 2026-09-14 修订，**别按旧说法只写一条 ARN**。本页上一版说「官方那条自己就只写到员工这一级，我们在内置员工上按这个形状拿到过 200」—— 那个 200 其实什么都证明不了：官方那条是 `apsara-*`，而阿里云的 `*` 连 `/` 一起吃，所以它顺带把员工的**子资源**也覆盖了，精确到员工名的 ARN 不会。当天我们在一个真实的自建员工上实测：只写员工级那一条 ARN，`CreateThread` **仍然** 403 `NoPermission`（`AccessDeniedDetail` 是 `ImplicitDeny`，即「没有任何 Allow 命中」；阿里云**不返回** `AuthResource`，所以看不出它在鉴权哪个 ARN）；把子资源那条 ARN 补上之后，同一副 AK、同一个员工立刻全通 —— **缺的就是它**。**不要**自己把 Resource 放宽成 `*`。" },
  { k: "p", tx: "RAM 控制台 → 权限策略 → 创建权限策略 → **脚本编辑**，把下面这段整段粘进去（只改 `<你的数字员工ID>` 三处）：" },
  {
    k: "code",
    tx: [
      "{",
      '  "Version": "1",',
      '  "Statement": [',
      '    { "Effect": "Allow",',
      '      "Action": ["starops:Get*", "starops:List*"],',
      '      "Resource": "*" },',
      '    { "Effect": "Allow",',
      '      "Action": ["starops:CreateChat", "starops:CreateThread"],',
      '      "Resource": [',
      '        "acs:starops:*:*:digitalemployee/<你的数字员工ID>",',
      '        "acs:starops:*:*:digitalemployee/<你的数字员工ID>/*"',
      "      ] }",
      "  ]",
      "}",
    ].join("\n"),
  },
  { k: "p", tx: "`<你的数字员工ID>` 是员工的 **ID**（内置员工形如 `apsara-ops`），**不是它的显示名称**，且与 STAROps 控制台里**大小写完全一致**（ARN 匹配大小写敏感）；`digitalemployee` 是**全小写**、后面是斜杠。⚠️ 上面地域与账号 ID 那两位刻意留成 `*:*` —— **实测跑通的就是这个形状**；填成具体值是进一步收窄，方向上没错，但我们**没实测过**，所以本页不发那一版。前一段 `Get*` / `List*` 与官方那条只读策略重复（已经挂了官方策略的话它是多余的，留着不冲突）；两段合起来这一条策略**自己就够**，因为整条链路只用三个接口：`GetDigitalEmployee`、`CreateThread`、`CreateChat`（「停止生成」走的是 `CreateChat`，不是另一个 Action）。" },
  {
    k: "ol",
    items: [
      "Resource 那**两条 ARN 都要写**：第二条是员工的**子资源**（会话之类），少了它我们实测过仍会被拒，见上一段。",
      "把这条自定义策略**真正授权**给上面那个 RAM 用户：身份管理 → 用户 → 权限管理 → 新增授权 → 自定义策略。只在「权限策略」里创建出来是不够的 —— 没这一步它对谁都不生效，而报出来的错和「没写这条策略」一模一样。",
      "如果你是**改**一条已有的自定义策略：阿里云会新建一个策略版本，改完要确认**当前生效的版本**就是含这两条 Action 的那一版（权限策略 → 点开这条策略 → 版本）。停在旧版本上时，控制台看着已经改好了，鉴权用的却还是旧的。",
      "如果补完还是被拒、并且错误码里带 `RAM` 或 `PassRole` 字样：阿里云官方的「STAROps 权限配置」页写着「和数字员工对话时需要 PassRole」。那就再加一条 `ram:PassRole`，Resource 限定到**你这个数字员工用的那个角色**（在 STAROps 控制台的员工详情里能看到它的角色），不要写 `*`。⚠️ 这一条我们**没有实测过**（手上只有内置员工，内置员工不需要它），所以请只在真撞上 RAM 错误时再加，不要预防性地给。",
      "⚠️ 自建数字员工那个角色的权限**是另一套风险**：它在你账号里能看到什么、能不能改东西，取决于你给那个角色挂了什么，与我们这副只读 AK 无关 —— 我们这边的只读边界拦不住它。请按最小权限配那个角色。",
      "官方口径与按角色分的更完整示例，见阿里云的「STAROps 权限配置」页：https://help.aliyun.com/zh/starops/user-guide/permission-configuration/",
      "前提：STAROps 已经在阿里云控制台开通、并且已经有一个能用的数字员工。开通和建员工都在阿里云那边做，本页没有对应入口。",
    ],
  },
  { k: "warn", tx: "在「新对话」里选了「阿里云 STAROps」却问不通，按这个顺序查：⓿ 界面报的是「暂时不可用」这类 503 —— 先别怀疑阿里云故障：我们实测过，`CreateChat` 的**入参类型**错（例如时间戳传成了数字而不是字符串）时，阿里云回的就是一个泛化的 503 `ServiceUnavailable`，文案看着像它自己坏了。这一条现在由单测钉住，正常不该再出现；真出现了请报给我们，别去阿里云开工单。① 提示权限不足 / `NoPermission` → 你的数字员工是自建的，按上面那条自定义策略的**三个**常见漏法挨个查：只写了员工级那一条 ARN、少了 `/*` 子资源那条；策略建了但没「新增授权」给那个 RAM 用户；改过策略但生效的还是旧版本。② 提示签名不匹配 → 查这台机器的系统时钟（偏差超过 15 分钟会被拒）。③ 提示找不到（404）→ 大概率是把数字员工的**显示名**当 ID 填了（要填的是 ID 那种短标识，内置员工形如 `apsara-ops`），也可能是 ID 大小写不一致、或者「STAROps 接口地域」选错了。④ 一直超时 → 是网络出不去，不是权限问题。" },

  { k: "h", tx: "3. 填进本页并保存" },
  {
    k: "kv",
    rows: [
      ["AccessKey ID", "明文显示。它不是凭证（单独拿它调不通任何接口），明文摆着是为了让你能核对填的是哪一副密钥。"],
      ["AccessKey Secret", "保存后只回显后 4 位（****xxxx）。回传脱敏值 = 不修改，所以只想改地域时不用重填密钥。"],
      ["默认地域", "调用阿里云接口时用的默认地域，例如 cn-hangzhou。填你账号资源所在的那个地域。"],
    ],
  },
  { k: "p", tx: "两个密钥字段都不进日志 —— 连长度都不记（见 docs/LOGGING_STANDARD.md）。凭据存在本部署自己的 AWS Secrets Manager 里，不落浏览器、不落数据库。" },

  { k: "h", tx: "4. 轮换与撤销（这一步别跳）" },
  {
    k: "ul",
    items: [
      "撤销：在 RAM 控制台把这个用户的 AccessKey 禁用或删除，NotiOps 立刻就调不通了 —— 不需要先来本页清空。",
      "轮换：在 RAM 里新建一副 AccessKey，填进本页保存成功后，再回 RAM 删掉旧的那副。顺序反了会有一段调不通的窗口。",
      "不再需要多云能力时：直接删掉这个 RAM 用户，比清空本页表单更彻底。",
    ],
  },
  { k: "warn", tx: "**不要填 STS 临时凭据。** 临时 AK/SK/Token 会在几十分钟到几小时后过期，而本页没有刷新它的来源 —— 结果是「刚保存时测着是好的，过一会必坏」，而失败的样子和「密钥填错了」一模一样。要免长期密钥的方案（RAM 角色 / OIDC）还没接进来，接进来时本页会多一个明确的选项，届时选它。" },

  { k: "h", tx: "常见问题" },
  {
    k: "ul",
    items: [
      "保存时提示 AccessKey ID 形状不对：多半是把整行「AccessKey ID: LTAI…」连标签一起粘进来了，或者只粘到了一半。",
      "保存时提示地域不对：地域要写阿里云的地域 id（小写字母、数字和连字符，例如 cn-hangzhou / ap-southeast-1），不是「华东1（杭州）」这样的中文名，也不是一整条 endpoint 地址。",
      "表单显示未配置、但你确定填过：本页按「两个密钥字段是否都非空」判断，任一为空就算未配置 —— 半副密钥是配不通的，所以不显示成已配置。",
    ],
  },
];

const EN: GuideBlock[] = [
  { k: "h", tx: "What this step actually does" },
  { k: "p", tx: "This page stores one read-only access key pair (AccessKey ID / AccessKey Secret) for your Alibaba Cloud account. NotiOps uses it to read your Alibaba Cloud resources — the same boundary idea as the AWS side, where the agent only ever gets ReadOnlyAccess." },
  { k: "warn", tx: "Never paste the AccessKey of your Alibaba Cloud root account. A root key carries the account's full authority, so a leak cannot be contained by tightening permissions afterwards. Create a dedicated RAM user instead, as below." },

  { k: "h", tx: "1. Create a dedicated RAM user" },
  {
    k: "ol",
    items: [
      "Sign in with your root account and open the RAM console: https://ram.console.aliyun.com",
      "Identities → Users → Create User. Give it a name whose purpose is obvious, e.g. notiops-readonly.",
      "For access mode, tick \"Using permanent AccessKey to access\" (OpenAPI access). Do NOT tick console sign-in — no human needs to log in as this identity.",
      "The AccessKey ID and AccessKey Secret are shown once the user is created.",
    ],
  },
  { k: "warn", tx: "The AccessKey Secret is shown only at creation time. Once you leave that page it cannot be retrieved again — your only option is to delete the key pair and create a new one. Copy it into this page and save before closing it." },
  { k: "p", tx: "A RAM user's AccessKey ID usually starts with `LTAI`. This page only shape-checks it (it does not pin that prefix), so an STS-style id will also be accepted — but do not paste temporary credentials; see the last section for why." },

  { k: "h", tx: "2. Grant it permission (one official policy; a custom digital employee needs one more)" },
  {
    k: "ol",
    items: [
      "Still in the RAM console: Identities → Users → open the user you just created → Permissions → Grant Permission.",
      "Set the scope to the whole account, search for `AliyunSTAROpsReadOnlyAccess` and tick it.",
      "Confirm. For a BUILT-IN digital employee (its name starts with `apsara-`, e.g. `apsara-ops`) you are done here — nothing else to attach, and do NOT add account-wide read-only on top.",
    ],
  },
  { k: "p", tx: "`AliyunSTAROpsReadOnlyAccess` is Alibaba Cloud's official read-only system policy for STAROps. It carries two parts: `starops:Get*` / `starops:List*` (read digital employees and threads), plus the two actions a conversation actually needs — `starops:CreateThread` / `starops:CreateChat`. Alibaba Cloud scopes those two to `acs:starops:*:*:digitalemployee/apsara-*`, i.e. BUILT-IN employees only. On 2026-09-13 we exercised the whole chain against a real account (region cn-beijing, built-in employee apsara-ops) with ONLY this one policy attached: look up the employee, open a thread, ask a question, get a full answer." },
  { k: "warn", tx: "Do NOT attach account-wide read-only (`ReadOnlyAccess`) for this feature, and do NOT attach `AliyunSTAROpsFullAccess`. We measured it: after removing account-wide read-only from this RAM user, the resource entities the digital employee could read were byte-identical (5 types / 18 instances) with zero permission errors — because those reads go through STAROps' / CloudMonitor's own entity store, which does NOT consume the AccessKey you gave us. Account-wide read-only is therefore pure over-authorization on this path. `AliyunSTAROpsFullAccess` additionally carries `ram:CreateServiceLinkedRole` and `ram:PassRole`, neither of which this product uses." },
  { k: "p", tx: "Read-only does NOT mean the digital employee cannot see sensitive data — and do not read that the other way round either, as if this key pair were irrelevant. There are two halves. (1) Per Alibaba Cloud's own permission-configuration page, a BUILT-IN employee (`apsara-*`) inherits the CALLER's permissions — i.e. the RAM policy on this key pair. So attaching `AliyunSTAROpsReadOnlyAccess` and nothing else is itself what pins that half of its permission ceiling to the smallest surface; conversely, attaching account-wide read-only to this RAM user hands it the read surface of your ENTIRE account — data-plane reads included, e.g. fetching object contents from object storage, and APIs like `ecs:DescribeInstanceVncUrl` whose access level is classified as get yet hands out a usable login path. (2) The part where it reads a resource inventory, however, does NOT consume this key pair: with account-wide read-only detached, the entities it read back were byte-identical (5 types / 18 instances, zero permission errors) because that read goes through STAROps' / CloudMonitor's own entity store. The scope of that half is decided by which resources are onboarded into STAROps / CloudMonitor, and no Deny policy layered on this key pair can narrow it." },
  { k: "p", tx: "WARNING: both sentences above were revised on 2026-09-13; two things must NOT be done the old way. A built-in employee has no role of its own to tighten — we measured it, `GetDigitalEmployee` returns an empty `roleArn`. The previous revision of this page told you to go and adjust the employee's role; on a built-in employee there is no such object. That path exists for CUSTOM employees only, and for those the role IS the hard boundary — configure it with least privilege. Second, we could NOT measure the actual reach of inherits-the-caller's-permissions: STAROps itself forbids the built-in employee even the aliyun CLI (it answers `Aliyun CLI is forbidden for system employee` verbatim), so today there is no observable path for that inheritance to land on. Read (1) as a CEILING, not as what it can definitely see. If you need one boundary you can put in front of a security review, confirm it with Alibaba Cloud, or switch to a custom employee with a read-only role you configure yourself." },
  { k: "p", tx: "**CUSTOM digital employee (a name that does not start with `apsara-`): one more policy is required.** The official policy pins `CreateThread` / `CreateChat` to `digitalemployee/apsara-*`, so with that policy alone a custom employee cannot be talked to — we measured it: opening a thread comes back 403 `NoPermission` outright. This failure has the worst possible shape: this page reports configured, Alibaba Cloud STAROps is selectable in a new conversation, and only the first question is refused. VERIFIED on 2026-09-14 end to end against a real account (custom employee; `GetDigitalEmployee` → `CreateThread` → `CreateChat` all 200 with a full answer back) — the JSON below is that exact policy, and it can be pasted as-is." },
  { k: "p", tx: "WARNING: revised 2026-09-14 — do NOT follow the old wording and list only one ARN. The previous revision of this page said Alibaba Cloud's own policy stops at the employee level and that we got 200s with that shape against a built-in employee. Those 200s in fact prove nothing: the official policy is `apsara-*`, and an Alibaba Cloud `*` also spans `/`, so it happens to cover the employee's SUB-RESOURCES as well, which an ARN pinned to the employee name does not. That same day we measured a real custom employee: with only the employee-level ARN, `CreateThread` was STILL refused 403 `NoPermission` (`AccessDeniedDetail` says `ImplicitDeny`, i.e. no Allow matched at all; Alibaba Cloud does NOT return `AuthResource`, so there is no way to see which ARN it authorised against). Adding the sub-resource ARN made the same key pair and the same employee work immediately — that one ARN was the whole gap. Do NOT widen the Resource to `*` yourself." },
  { k: "p", tx: "RAM console → Permissions → Policies → Create Policy → **script editor**, and paste this whole document (only the three `<your-employee-id>` occurrences need editing):" },
  {
    k: "code",
    tx: [
      "{",
      '  "Version": "1",',
      '  "Statement": [',
      '    { "Effect": "Allow",',
      '      "Action": ["starops:Get*", "starops:List*"],',
      '      "Resource": "*" },',
      '    { "Effect": "Allow",',
      '      "Action": ["starops:CreateChat", "starops:CreateThread"],',
      '      "Resource": [',
      '        "acs:starops:*:*:digitalemployee/<your-employee-id>",',
      '        "acs:starops:*:*:digitalemployee/<your-employee-id>/*"',
      "      ] }",
      "  ]",
      "}",
    ].join("\n"),
  },
  { k: "p", tx: "`<your-employee-id>` is the employee's **ID** (a built-in one looks like `apsara-ops`) -- **not its display name** -- capitalised exactly as in the STAROps console (ARN matching is case-sensitive); `digitalemployee` is all lowercase and followed by a slash. WARNING: the region and account-id positions are deliberately left as `*:*` — that is the shape we measured working. Filling in concrete values is a further tightening; it is directionally right but we have NOT measured it, so this page does not ship that version. The first statement (`Get*` / `List*`) overlaps the official read-only policy — redundant if you already attached that one, harmless to keep. Together the two statements make this ONE policy sufficient on its own, because the whole chain uses only three APIs: `GetDigitalEmployee`, `CreateThread`, `CreateChat` (stop-generation goes through `CreateChat`, not a separate action)." },
  {
    k: "ol",
    items: [
      "BOTH Resource ARNs are required: the second one is the employee's SUB-RESOURCES (threads and the like); we measured that leaving it out is still refused — see the paragraph above.",
      "Actually GRANT that custom policy to the same RAM user: Identities → Users → Permissions → Grant Permission → Custom Policy. Creating it under Policies is not enough — without this step it applies to nobody, and the error it produces is indistinguishable from never having written the policy.",
      "If you EDIT an existing custom policy: Alibaba Cloud creates a new policy version, so confirm afterwards that the version IN EFFECT is the one carrying those two actions (Policies → open the policy → Versions). Left on the old version, the console looks correctly edited while authorisation still uses the old text.",
      "If it is still refused afterwards and the error code mentions `RAM` or `PassRole`: Alibaba Cloud's own STAROps permission-configuration page states that chatting with a digital employee requires PassRole. Add one `ram:PassRole` whose Resource is scoped to the role your digital employee uses (visible on the employee's detail page in the STAROps console), never `*`. We have NOT verified this one — we only had a built-in employee, and built-in employees do not need it — so add it only if you actually hit a RAM error, not pre-emptively.",
      "A custom digital employee's role is a separate risk model: what it can see in your account, and whether it can change anything, depends on what you attached to that role, not on the read-only key you gave us. Our read-only boundary cannot contain it, so configure that role with least privilege.",
      "For Alibaba Cloud's own wording and fuller per-role examples, see its STAROps permission-configuration page: https://help.aliyun.com/en/starops/user-guide/permission-configuration/",
      "Prerequisites: STAROps is already enabled in your Alibaba Cloud console and a working digital employee already exists. Enabling it and creating employees both happen on the Alibaba Cloud side; this page has no entry point for either.",
    ],
  },
  { k: "warn", tx: "If you pick Alibaba Cloud STAROps in a new conversation and it does not answer, check in this order. (0) The UI reports a 503 / temporarily-unavailable: do not blame an Alibaba Cloud outage first. We measured that a wrong parameter TYPE on `CreateChat` — a timestamp sent as a number instead of a string, for instance — comes back as a generic 503 `ServiceUnavailable` whose wording reads like their outage. A unit test now pins this, so it should not recur; if it does, report it to us rather than opening a ticket with Alibaba Cloud. (1) A permission error / `NoPermission` means your digital employee is a custom one; check the THREE common ways the extra policy above goes wrong: only the employee-level ARN was listed and the `/*` sub-resource one is missing; the policy was created but never granted to that RAM user; the policy was edited but the version in effect is still the old one. (2) A signature mismatch means this machine's clock is off (more than 15 minutes of skew is rejected). (3) A not-found error (404) most often means you filled in the digital employee's display name instead of its ID (a built-in employee shows a Chinese label in the console, but the value to send is `apsara-ops`); it can also be a capitalisation mismatch in the ID, or the wrong \"STAROps API region\". (4) A persistent timeout is network egress, not permissions." },

  { k: "h", tx: "3. Fill it in here and save" },
  {
    k: "kv",
    rows: [
      ["AccessKey ID", "Shown in full. It is not a credential on its own (nothing can be called with it alone); showing it lets you confirm which key pair is configured."],
      ["AccessKey Secret", "Only the last 4 chars are shown after saving (`****xxxx`). Submitting the masked value means \"unchanged\", so you do not need to retype the key just to change the region."],
      ["Default region", "The default region used when calling Alibaba Cloud APIs, e.g. cn-hangzhou. Use the region your resources live in."],
    ],
  },
  { k: "p", tx: "Neither secret field is ever logged — not even its length (see docs/LOGGING_STANDARD.md). The credentials live in this deployment's own AWS Secrets Manager; they are not stored in the browser or in a database." },

  { k: "h", tx: "4. Rotation and revocation (do not skip this)" },
  {
    k: "ul",
    items: [
      "Revoke: disable or delete the user's AccessKey in the RAM console and NotiOps stops working immediately — you do not have to clear this form first.",
      "Rotate: create a second AccessKey in RAM, save it here successfully, then delete the old one in RAM. The other order leaves a window where nothing works.",
      "Done with multi-cloud: delete the RAM user outright — that is more thorough than clearing this form.",
    ],
  },
  { k: "warn", tx: "Do not paste STS temporary credentials. A temporary AK/SK/Token expires in tens of minutes to a few hours, and this page has no source to refresh it from — so it tests fine right after saving and then certainly breaks, in a way that looks exactly like a mistyped key. A credential-free path (RAM role / OIDC) is not wired up yet; when it is, this page will offer it as an explicit option." },

  { k: "h", tx: "Troubleshooting" },
  {
    k: "ul",
    items: [
      "Save rejects the AccessKey ID shape: usually the whole line \"AccessKey ID: LTAI...\" was pasted including the label, or only half the id came across.",
      "Save rejects the region: use an Alibaba Cloud region id (lowercase letters, digits and hyphens, e.g. cn-hangzhou / ap-southeast-1) — not a display name and not a full endpoint URL.",
      "The form says not configured but you are sure you filled it in: this page judges by \"are both secret fields non-empty\", so either one being empty counts as not configured — half a key pair cannot work, so it is not reported as configured.",
    ],
  },
];

export const ALIYUN_GUIDE: Record<Locale, GuideBlock[]> = { zh: ZH, en: EN };
