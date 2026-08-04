import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { IconChatBubble, IconKebab, IconPin, IconRename, IconTrash, IconInvestigate, IconFinOps, IconCases, IconSecurity, IconWhatsNew } from "./icons";
import type { Conversation } from "../types";
import { tagDef } from "../types";

// 主题 key → 标签用的线条图标（含 general：用对话气泡，与其它主题 tag 设计一致）
const TOPIC_ICON: Record<string, React.FC<{ size?: number }>> = {
  investigate: IconInvestigate,
  finops: IconFinOps,
  cases: IconCases,
  security: IconSecurity,
  "whats-new": IconWhatsNew,
  general: IconChatBubble,
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
          {showTag && (() => {
            // tagDef 永远返回可渲染 tag（general 也有，设计与其它主题一致）。
            // 分组列表里 showTag=false（组标题已标明主题）；置顶组 showTag=true（混主题需显式标注）。
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
