import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { getDeepInvestigationAvailability } from "../api/chat";
import Logo from "./Logo";
import { IconInvestigate } from "./icons";

/**
 * 「对话对象」选择器 —— 只出现在**通用会话**的新对话主页（产品决定：主题页不给这个选择，
 * 故障调查页保持原样的平铺开关）。
 *
 * 为什么做成"选对象"而不是"一个开关"：开关是**每轮**的修饰（这轮开着就直连），客户很难看出
 * "接下来这一整段是谁在答"；而这条路径的答话方、可用工具集全都不同。选一次、发出第一句
 * 就固定，语义才和后端一致 —— DevOps Agent 的多轮上下文挂在它自己的 `executionId` 上
 * 本来就是"一个会话一个对象"。
 *
 * 形态是**分段控件**而不是两张卡：主页下方已经有 4 张描边卡片，再放两张同样的卡会读成
 * "8 个同级入口"，而这一排其实是页面的模式开关（顺带换掉下面 4 张卡的池子）。
 *
 * 三条硬要求（改错了都不报错、只是显示错）：
 *  · **可跳过**：不选直接打字 = NotiOps（老用户零回归）。所以默认选中态是 NotiOps 段，
 *    不是"两段都不选"的空状态。
 *  · **置灰要给原因**：这个部署/这个账号没接入 DevOps Agent 时，那一段必须置灰并把原因
 *    写在下面的提示行里 —— 否则客户选了它，发一轮才收到 no_local_agent_space。
 *  · **置灰时把已选的对象退回 NotiOps**：否则客户带着一个必然失败的对象继续发。
 *    （此前这条自动退回逻辑在 Composer 的开关里；通用会话已经没有那个开关了，
 *    探测与退回都搬到这里，且**只探一次** —— 两处各探一次等于每次进主页两个签名请求。）
 */
interface Props {
  /** 当前会话对象是不是 DevOps Agent（= conversation.devopsChat）。 */
  devopsChat: boolean;
  onPick: (obj: "notiops" | "devops") => void;
  /** 当前选中的账号（空=部署账号）：DevOps Agent 是**按账号**接入的，探测要带上它。 */
  accountId?: string;
}

export default function ChatObjectPicker({ devopsChat, onPick, accountId = "" }: Props) {
  const t = useT();
  // "" = 可用（或还没探出来 —— 探测不确定一律按可用处理，见 api/chat.ts 的注释）。
  const [na, setNa] = useState("");

  useEffect(() => {
    let stop = false;
    getDeepInvestigationAvailability(accountId)
      .then((r) => { if (!stop) setNa(r.available ? "" : (r.reason || "unavailable")); })
      .catch(() => { /* 探测失败按可用处理 */ });
    return () => { stop = true; };
  }, [accountId]);

  // 探到不可用时把已经选上的 DevOps Agent 退回 NotiOps（那一段已置灰，客户自己点不回来）。
  useEffect(() => {
    if (na && devopsChat) onPick("notiops");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [na, devopsChat]);

  const naHint = na === "account_not_onboarded_to_devops_agent"
    ? t("composer.devops.na.account") : t("composer.devops.na.self");
  // 置灰时提示行让给"为什么点不动"——那是此刻唯一值得占这行的信息。
  const hint = na ? naHint : (devopsChat ? t("obj.devops.hint") : t("obj.notiops.hint"));

  return (
    <div className="obj-pick">
      {/* obj.caption 只做 radiogroup 的 aria-label（读屏需要一句"这是在选什么"），界面上不显示。 */}
      <div className="obj-seg" role="radiogroup" aria-label={t("obj.caption")}>
        <button type="button" role="radio" aria-checked={!devopsChat}
          className={"obj-seg-btn" + (!devopsChat ? " sel" : "")}
          onClick={() => onPick("notiops")}>
          <Logo size={15} />{t("obj.notiops.name")}
        </button>
        <button type="button" role="radio" aria-checked={devopsChat}
          className={"obj-seg-btn" + (devopsChat ? " sel" : "") + (na ? " disabled" : "")}
          disabled={!!na}
          aria-disabled={na ? "true" : undefined}
          title={na ? naHint : undefined}
          onClick={na ? undefined : () => onPick("devops")}>
          <IconInvestigate size={15} />{t("obj.devops.name")}
        </button>
      </div>
      <div className="obj-hint">{hint}</div>
    </div>
  );
}
