import { type ReactNode } from "react";
import { useT } from "../i18n";
import { IconInvestigate, IconChatBubble } from "./icons";

/**
 * 「谁来答这一轮」的那一小排开关 —— 工具条上「DevOps 对话」/「深度调查」两枚**平铺** pill。
 *
 * 🔁 2026-09-13 **第二次修订（产品指定，一次改了四件事）**。上一版是一个叫「回答模式」的
 * 下拉，里面有四项（不启用 / DevOps 对话 / 深度调查 / 深度调查（直连）），成本主题还多一项
 * 永久置灰的「FinOps」。现在：
 *  ① **「深度调查」（经我们的 agent 转交，`devopsAgent`）从界面上撤掉** —— 它与下面那项
 *     是同一个能力的两个实现，区别只在"要不要先花 token 让我们的模型转交一次"。留两个
 *     并列的入口，客户没有任何依据去选，而选错的那一个只是更慢更贵。
 *  ② **原「深度调查（直连）」改名成「深度调查」** —— 现在它是唯一的那一个，「（直连）」
 *     这个限定词失去了对照对象，只剩下"内部实现细节"这一个含义，不该出现在按钮上。
 *  ③ **下拉拆回平铺** —— 撤掉 ① 之后每个主题最多只剩两项（investigate = DevOps 对话 +
 *     深度调查，其余 deepShown 主题 = 深度调查），把两项藏进一个要点开的下拉，纯粹是
 *     多一层点击。
 *  ④ **成本主题里那项「FinOps」删掉** —— 它是个永久 disabled 的占位（功能未上线），
 *     除了让客户点一下发现点不动之外没有别的作用。功能真上线时再加回来。
 *
 * ⚠️ **`devopsAgent` 的代码通路刻意保留**（props 仍收 `devopsAgent` / `onToggleDevopsAgent`，
 *    Composer 与 BFF 侧一行没改）：撤掉的是**界面入口**，不是能力。但这带来一个必须堵住的
 *    洞 —— 一个界面上没有开关的模式如果还能被"恢复"出来，客户就会遇到一个看不见却生效的
 *    模式。所以 `convMode.ts::restorableMode` 把历史会话里的 `"agent"` 一律恢复成 `"off"`
 *    （那里有对应注释）。改这里之前先读那一段。
 *
 * 三条要守住的东西（与上一版逐字相同）：
 *  · **默认全关**：深度调查要跑几分钟，不能替客户默认选上。关着时前端不传对应字段，
 *    后端行为与从前逐字节一致。
 *  · **互斥由 ChatApp 保证**：这里只调用现成的 `onToggle*`，不自己算互斥 —— 互斥规则
 *    （含 objMode 的例外）写在 ChatApp 一处，两处各写一份必然漂。
 *  · **置灰要给原因**：没有 Agent Space（或所选账号没接入 DevOps Agent）时，依赖它的项
 *    置灰并把原因写进 tooltip，而不是只挂一个「未接入」小徽标。
 *
 * ⚠️ **通用会话（objMode）不用这个控件**：那里对话对象已经是客户自己的 DevOps Agent，
 * 剩下的唯一开关「深度调查」是**这一轮的修饰**（对象不变，只决定这轮直接问答还是发起调查），
 * 不是"选模式"。把它折进来会说错话，Composer 侧仍保留那个单独的开关。
 */
interface Props {
  /** 该主题是否提供 DevOps Agent 深度调查（= types.ts 的 `topicHasDevopsAgent`）。 */
  deepShown: boolean;
  /** 该主题是否提供「DevOps 对话」入口（产品显式列举，当前只有故障调查）。 */
  chatShown: boolean;
  /** DevOps Agent 不可用的原因码（""=可用）。非空则依赖它的项**全部**置灰。 */
  deepNa: string;
  /** 上面那个原因对应的人话（部署没有 Agent Space / 所选账号没接入，两句不同）。
   *  文案只讲原因、不点名某个功能，因为同一句要给这几项和 ChatObjectPicker 共用。 */
  deepNaHint: string;
  devopsAgentDirect: boolean;
  devopsChat: boolean;
  onToggleDevopsAgentDirect?: () => void;
  onToggleDevopsChat?: () => void;
}
// ⚠️ 这里**刻意不再收** `topic` / `devopsAgent` / `onToggleDevopsAgent`（上一版收了）：
//    · `topic` 只被那项 FinOps 占位用过，占位删掉后就是个没人读的入参；
//    · `devopsAgent` 那一项已经从界面上撤掉（见文件头 ①），字段本身仍活着但**这个组件
//      不再碰它**。留着一个不读的 prop，下一个人会以为"撤掉的那项还在这里管着"。
//    真要把「转交」那一项加回来时，连同这两个 prop 一起加回来即可。

interface Item {
  id: string;
  icon: ReactNode;
  /** pill 上显示的短名。 */
  name: string;
  /** 正式全名，只走 hover。 */
  full: string;
  desc: string;
  sel: boolean;
  /** 置灰原因（""=可点）。置灰项不可选中，也不触发任何回调。 */
  na: string;
  /** 置灰时项名后面那个小徽标（「未接入」）。 */
  badge: string;
  /** 点一下：亮的灭掉、灭的点亮。ChatApp 的三个 `onToggle*` 本身就是这个语义。 */
  toggle: () => void;
}

export default function ModePicker(props: Props) {
  const t = useT();
  const { deepShown, chatShown, deepNa, deepNaHint,
          devopsAgentDirect, devopsChat, onToggleDevopsAgentDirect, onToggleDevopsChat } = props;

  const items: Item[] = [];

  // 「DevOps 对话」：这轮直接由**客户自己的 DevOps Agent** 回答（BFF 直连控制面
  // CreateChat/SendMessage 并逐 delta 转发），NotiOps 侧 0 token。只在故障调查主题提供
  // （chatShown 显式列举；通用会话改由新对话主页的「对话对象」选，见 ChatObjectPicker）。
  if (chatShown) {
    items.push({
      id: "chat",
      icon: <IconChatBubble size={15} />,
      name: t("composer.devopschat.short"),
      full: t("composer.devopschat"),
      desc: t("composer.devopschat.hint"),
      sel: devopsChat,
      na: deepNa ? deepNaHint : "",
      badge: deepNa ? t("composer.devops.na") : "",
      toggle: () => onToggleDevopsChat?.(),
    });
  }

  // 「深度调查」：BFF 直连 DevOps Agent API（不经大模型，0 token）。默认所有主题都提供，
  // 只排除少数不适用的（types.ts `topicHasDevopsAgent`，与后端 `_DEVOPS_TOPICS_EXCLUDED`
  // 同一口径）。⚠️ 它绑的字段是 `devopsAgentDirect` 而不是 `devopsAgent` —— 名字里没有
  // 「直连」，但走的就是直连那条（见文件头 ①②）。改这里前先看 objMode 那枚 pill
  // （Composer.tsx）：那一枚一直叫「深度调查」、一直调 `onToggleDevopsAgentDirect`，
  // 两处现在终于是同一件事。
  if (deepShown) {
    items.push({
      id: "direct",
      icon: <IconInvestigate size={15} />,
      name: t("composer.devops.short"),
      // `full` = **谁来答**（"AWS DevOps Agent"），不是这一项的另一个名字。以前这里挂的是
      // 「DevOps Agent（直连）」—— 「（直连）」当时是用来跟"转交"那一项区分的，那一项撤掉后
      // 它只剩"内部实现细节"这一个含义，出现在 tooltip 里只会让客户去猜"还有个不直连的？"。
      full: t("composer.devops"),
      desc: t("composer.devops.direct.hint"),
      sel: devopsAgentDirect,
      na: deepNa ? deepNaHint : "",
      badge: deepNa ? t("composer.devops.na") : "",
      toggle: () => onToggleDevopsAgentDirect?.(),
    });
  }

  // 这个主题一个模式都没有（如通用会话 / 案例 / What's New）→ 什么都不渲染。
  if (!items.length) return null;

  return (
    <>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          className={"websearch-toggle" + (it.sel ? " on" : "") + (it.na ? " disabled" : "")}
          onClick={it.na ? undefined : it.toggle}
          disabled={!!it.na}
          // 置灰时 tooltip = 全名 + 原因（"为什么点不动"是此刻唯一值得说的）；
          // 可点时 = 全名 + 说明，因为短名看不出这一项到底做什么、要跑多久、烧不烧 token。
          title={it.na ? it.full + " — " + it.na : it.full + " — " + it.desc}
          aria-pressed={it.sel}
          aria-disabled={it.na ? "true" : undefined}
        >
          {it.icon} {it.name}
          {it.badge && <span className="toggle-soon">{it.badge}</span>}
        </button>
      ))}
    </>
  );
}
