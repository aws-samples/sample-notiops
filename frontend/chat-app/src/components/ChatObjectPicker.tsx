import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { getDeepInvestigationAvailability, getStarOpsAvailability } from "../api/chat";
import { MULTICLOUD_UI } from "../featureFlags";
import Logo from "./Logo";
import { IconInvestigate, IconCloud } from "./icons";

/**
 * 「对话对象」选择器 —— 只出现在**通用会话**的新对话主页（产品决定：主题页不给这个选择，
 * 故障调查页保持原样的平铺开关）。
 *
 * 为什么做成"选对象"而不是"一个开关"：开关是**每轮**的修饰（这轮开着就直连），客户很难看出
 * "接下来这一整段是谁在答"；而这条路径的答话方、可用工具集全都不同。选一次、发出第一句
 * 就固定，语义才和后端一致 —— DevOps Agent 的多轮上下文挂在它自己的 `executionId` 上
 * 本来就是"一个会话一个对象"。STAROps 同理（挂在它自己的 `threadId` 上）。
 *
 * 形态是**分段控件**而不是卡片：主页下方已经有 4 张描边卡片，再放几张同样的卡会读成
 * "同级入口一大排"，而这一排其实是页面的模式开关（顺带换掉下面 4 张卡的池子）。
 *
 * 三条硬要求（改错了都不报错、只是显示错）：
 *  · **可跳过**：不选直接打字 = NotiOps（老用户零回归）。所以默认选中态是 NotiOps 段，
 *    不是"哪段都不选"的空状态。
 *  · **置灰要给原因，但只在客户去碰它的时候给**：这个部署/这个账号没接入 DevOps Agent
 *    （或没登记阿里云 STAROps）时，那一段置灰、点不动，客户**点它**才把原因写进提示行 ——
 *    否则客户选了它，发一轮才收到 no_local_agent_space / 「尚未配置」。
 *    ⚠️ 原因**不许**在默认视图上抢占提示行：默认选中的是 NotiOps，那一行属于 NotiOps 自己的
 *    说明。抢占的后果是绝大多数部署（没配阿里云的那些）的每一个新对话首页都在说
 *    「尚未登记阿里云凭据」—— 一句与客户此刻要做的事毫无关系、而且看着像出错的话。
 *    这也是为什么置灰段用 `aria-disabled` 而不是原生 `disabled`：原生 disabled 会把点击
 *    一并吞掉，「点它才解释」就永远触发不了（读屏也会整段跳过，连原因都读不到）。
 *  · **置灰时把已选的对象退回 NotiOps**：否则客户带着一个必然失败的对象继续发。
 *    （此前这条自动退回逻辑在 Composer 的开关里；通用会话已经没有那个开关了，
 *    探测与退回都搬到这里，且**每条各只探一次** —— 每次进主页多一个签名请求就够贵了。）
 *
 * ⚠️ 两条探测是**独立**的两个请求，绝不能合并成一条：一条查的是 AWS DevOps Agent 的
 *    Agent Space 接入，另一条查的是客户填没填阿里云 AK + 数字员工名。合成一条的后果是
 *    任一朵云没配就把**两个**对话对象一起藏掉。
 *
 * ⚠️ 2026-09-15 起 STAROps 那一段由 `featureFlags.ts` 的 `MULTICLOUD_UI` 门控，当前
 *    **不渲染**（产品决策：多云先不对外）。关着的时候连那次 `/features/starops` 探测也
 *    不打 —— 藏了入口还去问"配没配"，等于每个新对话首页白花一个签名请求。
 *    执行链路（BFF 路由、`starops_chat`、DDB 会话段）一行没动，翻成 `true` 就整套回来。
 */
interface Props {
  /** 当前会话对象是不是 DevOps Agent（= conversation.devopsChat）。 */
  devopsChat: boolean;
  /** 当前会话对象是不是阿里云 STAROps 数字员工（= conversation.starops）。 */
  starops: boolean;
  onPick: (obj: "notiops" | "devops" | "starops") => void;
  /** 当前选中的账号（空=部署账号）：DevOps Agent 是**按账号**接入的，探测要带上它。
   *  STAROps 的探测**不带** —— 它是阿里云侧的数字员工，与 AWS 账号无关。 */
  accountId?: string;
}

export default function ChatObjectPicker({ devopsChat, starops, onPick, accountId = "" }: Props) {
  const t = useT();
  /** 「这一页上 STAROps 算不算选中」—— 多云关着时恒为 false，提示行与选中态都不许再提它。
   *  原始的 `starops` prop 仍然要用在下面那个退回 effect 上（真的落过盘的会话要退回来）。 */
  const so = MULTICLOUD_UI && starops;
  // "" = 可用（或还没探出来 —— 探测不确定一律按可用处理，见 api/chat.ts 的注释）。
  const [na, setNa] = useState("");
  const [soNa, setSoNa] = useState("");
  /** 客户刚点过哪个置灰段（""=没点过）—— 只有点过之后，提示行才让给「为什么点不动」。 */
  const [why, setWhy] = useState<"" | "devops" | "starops">("");

  useEffect(() => {
    let stop = false;
    getDeepInvestigationAvailability(accountId)
      .then((r) => { if (!stop) setNa(r.available ? "" : (r.reason || "unavailable")); })
      .catch(() => { /* 探测失败按可用处理 */ });
    return () => { stop = true; };
  }, [accountId]);

  // STAROps 的探测**不依赖 accountId**，所以单独一个 effect 且依赖为空 —— 挂在上面那个
  // effect 里会让每次切换 AWS 账号都白打一次阿里云配置探测。
  useEffect(() => {
    if (!MULTICLOUD_UI) return;      // 段不渲染 → 不问"配没配"，见文件头最后一条 ⚠️
    let stop = false;
    getStarOpsAvailability()
      .then((r) => { if (!stop) setSoNa(r.available ? "" : (r.reason || "unavailable")); })
      .catch(() => { /* 探测失败按可用处理 */ });
    return () => { stop = true; };
  }, []);

  // 探到不可用时把已经选上的对象退回 NotiOps（那一段已置灰，客户自己点不回来）。
  useEffect(() => {
    if (na && devopsChat) onPick("notiops");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [na, devopsChat]);
  // `!MULTICLOUD_UI` 也算"不可用"：多云关掉之后，历史上真的选过 STAROps 的会话必须退回
  // NotiOps，否则它会带着一个界面上已经看不见的对象继续发（用户问 AWS、答案来自阿里云）。
  useEffect(() => {
    if ((soNa || !MULTICLOUD_UI) && starops) onPick("notiops");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soNa, starops]);

  const naHint = na === "account_not_onboarded_to_devops_agent"
    ? t("composer.devops.na.account") : t("composer.devops.na.self");
  /** STAROps 置灰原因 → 一句"缺哪一项、去哪儿填"。
   *
   * 逐个映射而不是回一句"未配置"：这几种缺失的**修法完全不同** —— 没填 AK 要去登记凭据，
   * 员工名写错要去改那一格，region 不对是只有两个可选值。回一句笼统的话等于让管理员
   * 把「多云」页从头翻一遍。reason 的取值由 BFF 的 loadStarOpsConfig 决定（starops_chat.mjs）。 */
  const soHintKey = soNa === "no_credentials" ? "obj.starops.na.creds"
    : soNa === "no_employee" ? "obj.starops.na.employee"
    : soNa === "bad_employee" ? "obj.starops.na.badEmployee"
    : soNa === "bad_region" ? "obj.starops.na.badRegion"
    : (soNa === "bad_workspace" || soNa === "bad_project") ? "obj.starops.na.badVars"
    : "obj.starops.na.other";
  const soNaHint = t(soHintKey);
  /** 提示行说什么，四档优先级（顺序本身就是契约）：
   *  ① **已选中**的那个对象不可用 —— 恢复出一段旧会话时会短暂出现（下面那两个 effect 正要
   *     把它退回 NotiOps），这一瞬必须说清为什么会被退回，不然客户只看到对象自己变了；
   *  ② 客户**刚点过**某个置灰段 —— 让给「为什么点不动」；
   *  ③ 选中的是可用的 DevOps Agent / STAROps —— 说那个对象自己的说明；
   *  ④ 其余（= 默认的 NotiOps）—— **一定**是 NotiOps 自己的说明，绝不借这行去说别的对象没配好。 */
  const hint = (devopsChat && na) ? naHint
    : (so && soNa) ? soNaHint
    : why === "devops" ? naHint
    : why === "starops" ? soNaHint
    : devopsChat ? t("obj.devops.hint")
    : so ? t("obj.starops.hint")
    : t("obj.notiops.hint");

  /** 选了个能用的对象就把「为什么点不动」收回去 —— 那句话已经答完了，留着会盖住新对象的说明。 */
  const pick = (obj: "notiops" | "devops" | "starops") => { setWhy(""); onPick(obj); };

  return (
    <div className="obj-pick">
      {/* obj.caption 只做 radiogroup 的 aria-label（读屏需要一句"这是在选什么"），界面上不显示。 */}
      <div className="obj-seg" role="radiogroup" aria-label={t("obj.caption")}>
        <button type="button" role="radio" aria-checked={!devopsChat && !so}
          className={"obj-seg-btn" + (!devopsChat && !so ? " sel" : "")}
          onClick={() => pick("notiops")}>
          <Logo size={15} />{t("obj.notiops.name")}
        </button>
        {/* 置灰段：`aria-disabled` + 拦在 onClick 里，**不用**原生 disabled —— 见文件头注释。
            点它只解释原因，绝不真的切过去（`pick` 都不调，所以父组件收不到任何选择）。 */}
        <button type="button" role="radio" aria-checked={devopsChat}
          className={"obj-seg-btn" + (devopsChat ? " sel" : "") + (na ? " disabled" : "")}
          aria-disabled={na ? "true" : undefined}
          title={na ? naHint : undefined}
          onClick={na ? () => setWhy("devops") : () => pick("devops")}>
          <IconInvestigate size={15} />{t("obj.devops.name")}
        </button>
        {/* STAROps 段：`MULTICLOUD_UI` 关着就整段不渲染（不是置灰）—— 置灰的语义是
            「有这个功能、你还没配」，而现在的事实是「这个功能暂时不对外」，置灰会
            引出一句解释不清的原因，还让客户去「多云」页找一个已经没有入口的设置。 */}
        {MULTICLOUD_UI && (
        <button type="button" role="radio" aria-checked={so}
          className={"obj-seg-btn" + (so ? " sel" : "") + (soNa ? " disabled" : "")}
          aria-disabled={soNa ? "true" : undefined}
          title={soNa ? soNaHint : undefined}
          onClick={soNa ? () => setWhy("starops") : () => pick("starops")}>
          <IconCloud size={15} />{t("obj.starops.name")}
          {/* beta 徽标：只有这一段有。`title` 挂在徽标自己身上而不是按钮上 —— 按钮的 title
              在置灰时要留给「为什么点不动」那句原因，两者抢同一个属性会互相盖掉。
              `aria-hidden` 不能加：读屏用户同样需要知道这一段还不是正式功能。 */}
          <span className="obj-seg-beta" title={t("obj.starops.beta.hint")}>
            {t("obj.starops.beta")}
          </span>
        </button>
        )}
      </div>
      {/* aria-live：这一行现在会因为「点了置灰段」而变，读屏用户看不到视觉变化，得播出来。 */}
      <div className="obj-hint" aria-live="polite">{hint}</div>
    </div>
  );
}
