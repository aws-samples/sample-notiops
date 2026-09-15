import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { IconChatBubble, IconKebab, IconPin, IconRename, IconTrash, IconInvestigate, IconFinOps, IconCases, IconSecurity, IconWhatsNew, IconCloud } from "./icons";
import Logo from "./Logo";
import type { Conversation } from "../types";
import { objTagDef, tagDef } from "../types";

// 主题 key → 标签用的线条图标（含 general：用对话气泡，与其它主题 tag 设计一致）
const TOPIC_ICON: Record<string, React.FC<{ size?: number }>> = {
  investigate: IconInvestigate,
  finops: IconFinOps,
  cases: IconCases,
  security: IconSecurity,
  "whats-new": IconWhatsNew,
  general: IconChatBubble,
};

// 「对话对象」key → 图标。与顶栏那三枚**同一套**（ChatApp 的 topbar-topic）：
// 同一段会话在侧栏和顶栏必须是同一个图标 + 同一个颜色，否则看着像两个不同的东西。
const OBJ_ICON: Record<string, React.FC<{ size?: number }>> = {
  starops: IconCloud,
  devops: IconInvestigate,
  notiops: Logo,
};

interface Props {
  conv: Conversation;
  active: boolean;
  busy?: boolean;    // 该会话正在生成(思考/流式输出) → 前导位显脉动活跃点
  unread?: boolean;  // 后台完成、尚未读 → 前导位显红点 + 标题加粗
  showTag?: boolean; // 是否显示主题 tag（分组列表里由组标题标明主题，隐藏 tag；置顶组混主题，显示 tag）。默认 true。
  onSelect: () => void;
  onRename: (title: string) => void;
  onTogglePin: () => void;
  onDelete: () => void;
}

export default function ConvItem({ conv, active, busy, unread, showTag = true, onSelect, onRename, onTogglePin, onDelete }: Props) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conv.title);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [menuOpen]);

  useEffect(() => {
    if (editing) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [editing]);

  const startRename = () => { setDraft(conv.title); setEditing(true); setMenuOpen(false); };
  const commitRename = () => {
    const v = draft.trim();
    if (v && v !== conv.title) onRename(v);
    setEditing(false);
  };

  return (
    <div className={"conv-wrap" + (active ? " active" : "")} ref={wrapRef}>
      {editing ? (
        <input
          ref={inputRef}
          className="conv-edit"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <button className="conv" onClick={onSelect} title={busy ? t("conv.busy") : unread ? t("conv.unread") : undefined}>
          <span className="ic">
            {busy ? (
              <span className="conv-dot busy" aria-label={t("conv.busy")} />
            ) : unread ? (
              <span className="conv-dot unread" aria-label={t("conv.unread")} />
            ) : conv.pinned ? <IconPin size={15} /> : <IconChatBubble />}
          </span>
          <span className={"conv-title" + (unread && !busy ? " unread" : "")}>{conv.title}</span>
          {(() => {
            // 一条会话最多一枚 tag（侧栏那一行放不下第二枚）。取谁：
            //  · 知道「对话对象」就用它（notiops / devops / starops）——**不看 showTag**：
            //    分组列表里组标题只说得清主题，说不清"这段是哪朵云的哪个 agent 答的"，
            //    而通用会话恰好全挤在「通用」一组里，那才是最需要区分的地方。
            //  · 不知道（老会话没这个属性）→ 回落到原来的主题 tag，且沿用 showTag 的老口径：
            //    分组列表里隐藏（组标题已标明），置顶组显示（混主题）。**不许**在这里猜成
            //    NotiOps —— 把一段阿里云会话标成 NotiOps 是跨云假信息，比不标糟得多。
            const od = objTagDef(conv.obj);
            if (od) {
              const ObjIcon = OBJ_ICON[od.key];
              return (
                <span className="conv-topic" style={{ color: od.color, borderColor: od.color }} title={t(od.hintKey)}>
                  {ObjIcon && <ObjIcon size={11} />}
                  <span className="conv-topic-label">{t(od.labelKey)}</span>
                </span>
              );
            }
            if (!showTag) return null;
            // tagDef 永远返回可渲染 tag（general 也有，设计与其它主题一致）。
            const td = tagDef(conv.topic);
            const TopicIcon = TOPIC_ICON[td.key];
            return (
              <span className="conv-topic" style={{ color: td.color, borderColor: td.color }} title={t(td.labelKey)}>
                {TopicIcon && <TopicIcon size={11} />}
                <span className="conv-topic-label">{t(td.labelKey)}</span>
              </span>
            );
          })()}
        </button>
      )}

      {!editing && (
        <button
          className="conv-kebab"
          title={t("conv.menu")}
          onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}
        >
          <IconKebab />
        </button>
      )}

      {menuOpen && (
        <div className="conv-menu" onClick={(e) => e.stopPropagation()}>
          <button className="cm-item" onClick={startRename}><IconRename /> {t("conv.rename")}</button>
          <button className="cm-item" onClick={() => { onTogglePin(); setMenuOpen(false); }}>
            <IconPin /> {conv.pinned ? t("conv.unpin") : t("conv.pin")}
          </button>
          <div className="cm-sep" />
          <button className="cm-item danger" onClick={() => { setMenuOpen(false); if (confirm(t("conv.deleteConfirm"))) onDelete(); }}>
            <IconTrash /> {t("conv.delete")}
          </button>
        </div>
      )}
    </div>
  );
}
