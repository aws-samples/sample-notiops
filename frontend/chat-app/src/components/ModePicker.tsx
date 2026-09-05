import { useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n";
import { IconInvestigate, IconChatBubble, IconFinOps, IconSliders, IconCheck } from "./icons";

/**
 * 「回答模式」选择器 —— 把工具条上那一排 DevOps / FinOps 开关收成**一个**控件。
 *
 * 为什么必须收：这些开关**在状态上本来就是单选**（ChatApp 的
 * `setDevopsMode(mode: "agent" | "direct" | "chat" | "off")` 一次写三个字段，点亮一个自动灭
 * 其余两个），界面上却画成三个各自独立的并列 pill。单选画成复选有两个后果：
 *  · 占三倍宽度 —— 故障调查主题曾经是 5 个带文字的 pill + 模型 + 发送 = 7 个控件挤一行，
 *    英文标签更长（`Deep Dive` / `Deep Dive (Direct)` / `DevOps Chat`），`.cbar` 的
 *    `flex-wrap` 一折就是两行；
 *  · 看起来能同时开 —— 而同时开的后果不是"更强"，是同一个问题被送上两三条互不相干的链路。
 *
 * 为什么是**下拉**而不是分段控件：「深度调查」和「深度调查（直连）」两个标签只差四个字，
 * 真正的区别（谁来答、烧不烧 token、几秒还是几分钟）在 pill 上没有位置写，此前只藏在
 * `title` tooltip 里 —— 客户不悬停就看不见。下拉的每一项有名称 + 说明两行（复用模型菜单
 * 的 `.mm-name`/`.mm-desc` 结构），那句说明才是这个控件真正要给的信息。
 *
 * **只有一个模式可选时不收下拉**，仍画成原来那枚平铺 pill（产品要求：工具条上带文字的按钮
 * 总数 ≤2 就保持不变 —— 调用方左边总有一枚「联网」，所以"1 项 = 2 枚"）。当前主题集合走不到
 * 那条路（深度调查一来就是两项），见下面该分支的注释。
 *
 * 三条要守住的东西：
 *  · **默认「不启用」**：所有模式都默认关（深度调查要跑几分钟，不能替客户默认选上）。
 *    关着时前端不传对应字段，后端行为与从前逐字节一致。
 *  · **互斥仍由 ChatApp 保证**：这里只调用现成的三个 `onToggle*`，不自己算互斥 ——
 *    互斥规则（含 objMode 的例外）写在 ChatApp 一处，两处各写一份必然漂。
 *  · **置灰要给原因**：没有 Agent Space（或所选账号没接入 DevOps Agent）时，依赖它的项
 *    置灰并把原因写进那一项，而不是只在 pill 上挂一个「未接入」小徽标。
 *
 * ⚠️ **通用会话（objMode）不用这个控件**：那里对话对象已经是客户自己的 DevOps Agent，
 * 剩下的唯一开关「深度调查」是**这一轮的修饰**（对象不变，只决定这轮直接问答还是发起调查），
 * 不是"选模式"。把它折进来会说错话，Composer 侧仍保留那个单独的开关。
 */
interface Props {
  /** 当前会话主题：决定这个主题有哪些模式可选（FinOps 那一项只在成本主题出现）。 */
  topic: string;
  /** 该主题是否提供 DevOps Agent 深度调查（= types.ts 的 `topicHasDevopsAgent`）。 */
  deepShown: boolean;
  /** 该主题是否提供「DevOps 对话」平铺入口（产品显式列举，当前只有故障调查）。 */
  chatShown: boolean;
  /** 深度调查不可用的原因（""=可用）。非空则依赖 DevOps Agent 的项全部置灰。 */
  deepNa: string;
  /** 上面那个原因对应的人话（部署没有 Agent Space / 所选账号没接入，两句不同）。 */
  deepNaHint: string;
  devopsAgent: boolean;
  devopsAgentDirect: boolean;
  devopsChat: boolean;
  onToggleDevopsAgent?: () => void;
  onToggleDevopsAgentDirect?: () => void;
  onToggleDevopsChat?: () => void;
}

interface Item {
  id: string;
  icon: ReactNode;
  /** 收起态按钮上显示的短名（也是菜单里的项名）。 */
  name: string;
  /** 正式全名，只走 hover —— 菜单里显示短名，两者并存不冲突。 */
  full: string;
  desc: string;
  sel: boolean;
  /** 置灰原因（""=可点）。置灰项不可选中，也不触发任何回调。 */
  na: string;
  /** 置灰时项名后面那个小徽标（「未接入」/「即将上线」）。 */
  badge: string;
  pick: () => void;
}

export default function ModePicker(props: Props) {
  const t = useT();
  const { topic, deepShown, chatShown, deepNa, deepNaHint,
          devopsAgent, devopsAgentDirect, devopsChat,
          onToggleDevopsAgent, onToggleDevopsAgentDirect, onToggleDevopsChat } = props;
  const [open, setOpen] = useState(false);
  // 弹出方向：默认向上；但成本/案例这些带仪表盘的主题输入框顶在页面上方，向上弹会被视口
  // 顶部裁掉（模型选择器已经踩过一次，这里同一处理）。点开时量一次上方空间，不够就向下弹。
  const [dropUp, setDropUp] = useState(true);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  const off = !devopsAgent && !devopsAgentDirect && !devopsChat;

  const items: Item[] = [
    {
      id: "off",
      icon: <IconSliders size={15} />,
      name: t("composer.mode.off"),
      full: t("composer.mode.off"),
      desc: t("composer.mode.off.desc"),
      sel: off,
      na: "",
      badge: "",
      // 「不启用」= 把当前亮着的那个灭掉。三个 toggle 都是"再点一次就关"，所以直接点它自己。
      pick: () => {
        if (devopsAgent) onToggleDevopsAgent?.();
        else if (devopsAgentDirect) onToggleDevopsAgentDirect?.();
        else if (devopsChat) onToggleDevopsChat?.();
      },
    },
  ];

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
      pick: () => { if (!devopsChat) onToggleDevopsChat?.(); },
    });
  }

  // DevOps Agent 深度调查：默认所有主题都提供，只排除少数不适用的（types.ts
  // `topicHasDevopsAgent`，与后端 `_DEVOPS_TOPICS_EXCLUDED` 同一口径）。
  if (deepShown) {
    items.push({
      id: "deep",
      icon: <IconInvestigate size={15} />,
      name: t("composer.devops.short"),
      full: t("composer.devops"),
      desc: t("composer.devops.hint"),
      sel: devopsAgent,
      na: deepNa ? deepNaHint : "",
      badge: deepNa ? t("composer.devops.na") : "",
      pick: () => { if (!devopsAgent) onToggleDevopsAgent?.(); },
    });
    // 同一能力的 0 token 版本（BFF 直连 DevOps Agent API，不经大模型）。
    items.push({
      id: "direct",
      icon: <IconInvestigate size={15} />,
      name: t("composer.devops.direct.short"),
      full: t("composer.devops.direct"),
      desc: t("composer.devops.direct.hint"),
      sel: devopsAgentDirect,
      na: deepNa ? deepNaHint : "",
      badge: deepNa ? t("composer.devops.na") : "",
      pick: () => { if (!devopsAgentDirect) onToggleDevopsAgentDirect?.(); },
    });
  }

  // FinOps Agent 深度模式：仅成本主题。**暂不可用**（功能未完善）—— 永久置灰。
  // 放在最后一项：它永远点不动，摆在可用项中间纯属挡路（此前它是工具条上一个永远
  // disabled 的 pill，占一整个 pill 的宽度只为说一句「即将上线」）。
  if (topic === "finops") {
    items.push({
      id: "finops",
      icon: <IconFinOps size={15} />,
      name: t("composer.finops.short"),
      full: t("composer.finops"),
      desc: t("composer.finops.hint"),
      sel: false,
      na: t("composer.finops.soon"),
      badge: t("composer.soon"),
      pick: () => {},
    });
  }

  // 只剩「不启用」= 这个主题一个模式都没有（如通用会话）→ 不渲染这个控件，
  // 而不是给一个只有一项、点开还是"不启用"的空下拉。
  if (items.length <= 1) return null;

  // 只有**一个**模式可选时不收下拉，画成原来那样的平铺 pill —— 产品要求
  // （2026-09-04：「聊天框只有 ≤2 个按钮的（比如：联网+深度），可以保持不变」）。
  // 口径是"工具条上带文字的按钮总数 ≤2 就保持不变"：调用方（Composer 的 !objMode 分支）
  // 左边总有一枚「联网」，所以"模式项 1 个"就等于"总共 2 枚"。收下拉在这里是负收益 ——
  // 多一层点击、还不省宽度。
  // ⚠️ 当前主题集合走不到这里（深度调查一来就是**两项**，故 deepShown 主题至少 3 枚），
  // 它是给将来只提供单一模式的主题留的路；也正因为走不到，这里**必须复用上面那份 items**，
  // 不能另抄一份 pill 的门控/置灰逻辑 —— 抄一份就是一段没人跑的、迟早与上面漂开的死代码。
  if (items.length === 2) {
    const it = items[1];
    return (
      <button
        type="button"
        className={"websearch-toggle" + (it.sel ? " on" : "") + (it.na ? " disabled" : "")}
        onClick={it.na ? undefined : () => (it.sel ? items[0].pick() : it.pick())}
        disabled={!!it.na}
        title={it.na || it.full + " — " + it.desc}
        aria-pressed={it.sel}
        aria-disabled={it.na ? "true" : undefined}
      >
        {it.icon} {it.name}
        {it.badge && <span className="toggle-soon">{it.badge}</span>}
      </button>
    );
  }

  const cur = items.find((i) => i.sel) ?? items[0];

  return (
    <div className="mode-wrap" ref={ref}>
      <button
        type="button"
        className={"modepick" + (off ? "" : " on")}
        title={off ? t("composer.mode.hint") : cur.full + " — " + cur.desc}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("composer.mode.label")}
        onClick={(e) => {
          e.stopPropagation();
          if (!open) {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const MENU_H = 300;
            setDropUp(r.top >= MENU_H || r.top >= window.innerHeight - r.bottom);
          }
          setOpen((o) => !o);
        }}
      >
        {off ? <IconSliders size={15} /> : cur.icon}
        {off ? t("composer.mode.label") : cur.name}
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className={"modemenu" + (dropUp ? "" : " drop-down")} role="listbox"
             aria-label={t("composer.mode.label")} onClick={(e) => e.stopPropagation()}>
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              role="option"
              aria-selected={it.sel}
              aria-disabled={it.na ? "true" : undefined}
              disabled={!!it.na}
              className={"mode-item" + (it.sel ? " sel" : "") + (it.na ? " disabled" : "")}
              title={it.na || it.full}
              onClick={it.na ? undefined : () => { it.pick(); setOpen(false); }}
            >
              <span className="mode-ico">{it.icon}</span>
              <span className="mode-body">
                <span className="mode-name">
                  {it.name}
                  {it.badge && <span className="toggle-soon">{it.badge}</span>}
                </span>
                {/* 置灰时说明行让给"为什么点不动" —— 那是此刻唯一值得占这行的信息 */}
                <span className="mode-desc">{it.na || it.desc}</span>
              </span>
              {it.sel && <span className="mode-check"><IconCheck size={14} /></span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
