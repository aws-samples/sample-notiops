import { useEffect, useMemo, useRef, useState } from "react";
import { useT, useLocale } from "../i18n";
import { IconSkill, IconConnector, IconPlugin, IconPlus, IconRename, IconTrash, IconFileText, IconUpload, IconClose, IconChevronRight, IconCheck, IconPublish } from "./icons";
import {
  listSkills, getSkill, saveSkill, deleteSkill, skillExists, slugify,
  listVersions, rollbackSkill, importSkillZip, skillDisplay,
  listDevopsTargets, uploadSkillToDevops, removeSkillFromDevops,
  type Skill, type SkillVersion, type DevopsTarget, type DevopsUpload,
} from "../api/skills";

// Customize 页：连接器 / 插件（均占位"即将上线"）。
// Skills 已提为左侧一级入口（only="skills" 渲染），故这里不再重复 Skills 标签。
type Tab = "connectors" | "plugins";

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
  </svg>
);

// only="skills" → 独立 Skills 视图（不含「定制」左侧子导航，直接是 Skills 管理页）；
// 缺省 → 完整「定制」页（Skills / 连接器 / 插件 三标签）。
// homeSignal：左侧「Skills」入口每次点击自增。已在 Skills 视图时（可能停在某 skill 详情/编辑器），
// 据此回到列表首页——无未保存修改直接回，有则先确认。
export default function CustomizePanel({ only, homeSignal }: { only?: "skills"; homeSignal?: number } = {}) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("connectors");

  // 独立 Skills：跳过 cz-side 子导航，主区直接渲染 SkillsTab。
  if (only === "skills") {
    return (
      <div className="cz cz-standalone">
        <div className="cz-main"><SkillsTab homeSignal={homeSignal} /></div>
      </div>
    );
  }

  // 完整「定制」页：仅连接器 / 插件（Skills 已独立为一级入口，不在此重复）。
  return (
    <div className="cz">
      {/* 左侧子导航 */}
      <div className="cz-side">
        <div className="cz-side-title">{t("nav.customize")}</div>
        <button className={"cz-navitem" + (tab === "connectors" ? " active" : "")} onClick={() => setTab("connectors")}>
          <IconConnector size={16} /> {t("cz.nav.connectors")} <span className="cz-soon">{t("cz.soon")}</span>
        </button>
        <button className={"cz-navitem" + (tab === "plugins" ? " active" : "")} onClick={() => setTab("plugins")}>
          <IconPlugin size={16} /> {t("cz.nav.plugins")} <span className="cz-soon">{t("cz.soon")}</span>
        </button>
      </div>

      {/* 主区 */}
      <div className="cz-main">
        <SoonTab tab={tab} />
      </div>
    </div>
  );
}

function SoonTab({ tab }: { tab: "connectors" | "plugins" }) {
  const t = useT();
  const Icon = tab === "connectors" ? IconConnector : IconPlugin;
  return (
    <div className="cz-empty">
      <div className="cz-hero-ic"><Icon size={40} /></div>
      <div className="cz-hero-title">{t(tab === "connectors" ? "cz.nav.connectors" : "cz.nav.plugins")}</div>
      <div className="cz-hero-sub">{t(tab === "connectors" ? "cz.connectors.desc" : "cz.plugins.desc")}</div>
      <span className="cz-soon-badge">{t("cz.soon")}</span>
    </div>
  );
}

type SortKey = "recent" | "name";
// 预置 skill 的 author 标记（系统内置）；其余视为客户自建。
const _isPreset = (s: Skill) => (s.author || "") === "notiops-system";
// 该 skill 已上传到几个 Agent Space（世界 B）。0 = 未发布。
const _uploadCount = (s: Skill) => Object.keys(s.devops_agent?.uploads || {}).length;

function SkillsTab({ homeSignal }: { homeSignal?: number }) {
  const t = useT();
  const { locale } = useLocale();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Skill | "new" | null>(null);
  const [picking, setPicking] = useState(false);   // 「选择添加方式」选择器
  const [uploading, setUploading] = useState(false); // 「上传 zip」对话框
  const [publishing, setPublishing] = useState<Skill | null>(null); // 「发布到 DevOps Agent」对话框
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [collapsed, setCollapsed] = useState<{ preset: boolean; mine: boolean }>({ preset: false, mine: false });

  const refresh = () => { setLoading(true); listSkills().then((s) => { setSkills(s); setLoading(false); }).catch(() => setLoading(false)); };
  useEffect(() => { refresh(); }, []);

  // 左侧「Skills」被点击（homeSignal 自增）→ 回到列表首页：先收起各弹窗；编辑器（SkillEditor）
  // 自身通过 homeSignal 判断有无未保存修改再决定是否退出（无修改直接退，有则确认）。跳过首挂。
  const firstHome = useRef(true);
  useEffect(() => {
    if (firstHome.current) { firstHome.current = false; return; }
    setPicking(false);
    setUploading(false);
    setPublishing(null);
  }, [homeSignal]);

  // 搜索（名称/ID/描述，大小写不敏感）+ 排序 → 再按 预置/我的 分组。
  // 预置 skill 按当前语言的展示文本参与搜索/排序；客户自建按原文。
  const { preset, mine, total } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = skills.filter((s) => {
      if (!q) return true;
      const d = skillDisplay(s, locale);
      return d.name.toLowerCase().includes(q) || s.skill_id.toLowerCase().includes(q)
        || (d.description || "").toLowerCase().includes(q);
    });
    const sorter = sort === "name"
      ? (a: Skill, b: Skill) => skillDisplay(a, locale).name.localeCompare(skillDisplay(b, locale).name)
      : (a: Skill, b: Skill) => (b.updated_at || 0) - (a.updated_at || 0);
    const sorted = [...filtered].sort(sorter);
    return {
      preset: sorted.filter(_isPreset),
      mine: sorted.filter((s) => !_isPreset(s)),
      total: filtered.length,
    };
  }, [skills, query, sort, locale]);

  if (editing) {
    return <SkillEditor skill={editing === "new" ? null : editing} homeSignal={homeSignal}
      onDone={() => { setEditing(null); refresh(); }}
      onCancel={() => setEditing(null)} />;
  }

  // 点「新建 Skill」→ 先弹方式选择器；选「创建」→ 进表单，选「上传」→ 弹上传对话框
  const openPicker = () => setPicking(true);
  const chooseCreate = () => { setPicking(false); setEditing("new"); };
  const chooseUpload = () => { setPicking(false); setUploading(true); };

  const del = async (s: Skill) => {
    if (confirm(`${t("cz.skill.delete")}「${skillDisplay(s, locale).name}」?`)) { await deleteSkill(s.skill_id); refresh(); }
  };

  // 卡片式（截图风格）：圆角图标块 + 名称/标签 + 两行描述 + 底部版本/发布药丸与操作。
  // 整卡可点=编辑；右下操作区 stopPropagation，避免误触发编辑。
  const renderCard = (s: Skill) => {
    const preset = _isPreset(s);
    const published = _uploadCount(s);
    const disp = skillDisplay(s, locale);
    return (
      <div key={s.skill_id}
        className={"cz-skill-card2" + (preset ? " is-preset" : " is-mine")}
        role="button" tabIndex={0} title={t("cz.skill.edit")}
        onClick={() => setEditing(s)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditing(s); } }}>
        <div className="cz-skill-cbody">
          {/* 第一行：预置/自建标签（无图标）；第二行：skill 名称 */}
          <span className={"cz-skill-tag " + (preset ? "preset" : "mine")}>
            {preset ? t("cz.skill.tag.preset") : t("cz.skill.tag.mine")}
          </span>
          <span className="cz-skill-cname">{disp.name}</span>
          <div className="cz-skill-cdesc">{disp.description || s.skill_id}</div>
          <div className="cz-skill-cfoot">
            <div className="cz-skill-cfoot-meta">
              {s.latest_version && <span className="cz-skill-ver">v{s.latest_version}</span>}
              {published > 0 && (
                <span className="cz-skill-pub" title={t("cz.da.publishedTip")}>
                  <IconCheck size={12} /> {published > 1 ? t("cz.da.publishedN").replace("{n}", String(published)) : t("cz.da.published")}
                </span>
              )}
            </div>
            <div className="cz-skill-cactions" onClick={(e) => e.stopPropagation()}>
              <button className={"cz-icon-btn cz-da-btn" + (published > 0 ? " on" : "")}
                title={t("cz.da.publish")} onClick={() => setPublishing(s)}><IconPublish size={15} /></button>
              <button className="cz-icon-btn" title={t("cz.skill.edit")} onClick={() => setEditing(s)}><IconRename size={15} /></button>
              <button className="cz-icon-btn" title={t("cz.skill.delete")} onClick={() => del(s)}><IconTrash size={15} /></button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderGroup = (key: "preset" | "mine", label: string, list: Skill[]) => {
    if (list.length === 0) return null;
    const open = !collapsed[key];
    return (
      <div className="cz-skill-group">
        <button className="cz-skill-grouphead" onClick={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))}>
          <span className={"cz-grouphead-caret" + (open ? " open" : "")}><IconChevronRight size={14} /></span>
          {label} <span className="cz-grouphead-count">{list.length}</span>
        </button>
        {open && <div className="cz-skill-grid">{list.map(renderCard)}</div>}
      </div>
    );
  };

  return (
    <div className="cz-pane">
      <div className="cz-pane-head">
        <div>
          <div className="cz-pane-title"><IconSkill size={20} /> {t("cz.skills.title")}</div>
          <div className="cz-pane-desc">{t("cz.skills.desc")}</div>
        </div>
        <button className="cz-btn-primary" onClick={openPicker}>
          <IconPlus size={15} /> {t("cz.skills.new")}
        </button>
      </div>

      {loading ? (
        <div className="cz-empty"><div className="cz-hero-sub">…</div></div>
      ) : skills.length === 0 ? (
        <div className="cz-empty">
          <div className="cz-hero-ic"><IconSkill size={40} /></div>
          <div className="cz-hero-sub">{t("cz.skills.empty")}</div>
          <button className="cz-btn-primary" onClick={openPicker} style={{ marginTop: 14 }}>
            <IconPlus size={15} /> {t("cz.skills.new")}
          </button>
        </div>
      ) : (
        <>
          {/* 工具条：搜索 + 排序。列表变长时靠它保持清爽。 */}
          <div className="cz-skill-toolbar">
            <div className="cz-skill-search">
              <SearchIcon />
              <input value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder={t("cz.skills.search")} />
              {query && <button className="cz-search-clear" onClick={() => setQuery("")} title={t("cz.up.cancel")}><IconClose size={14} /></button>}
            </div>
            <select className="cz-skill-sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="recent">{t("cz.skills.sort.recent")}</option>
              <option value="name">{t("cz.skills.sort.name")}</option>
            </select>
          </div>

          {total === 0 ? (
            <div className="cz-empty"><div className="cz-hero-sub">{t("cz.skills.noMatch")}</div></div>
          ) : (
            <div className="cz-skill-groups">
              {renderGroup("preset", t("cz.skills.group.preset"), preset)}
              {renderGroup("mine", t("cz.skills.group.mine"), mine)}
            </div>
          )}
        </>
      )}

      {picking && <AddSkillPicker onCreate={chooseCreate} onUpload={chooseUpload} onClose={() => setPicking(false)} />}
      {uploading && <UploadSkillDialog onDone={() => { setUploading(false); refresh(); }} onClose={() => setUploading(false)} />}
      {publishing && <PublishDialog skill={publishing} onChanged={refresh} onClose={() => setPublishing(null)} />}
    </div>
  );
}

// 「选择添加 Skill 的方式」选择器（截图①）：两张卡片 — 创建 / 上传
function AddSkillPicker({ onCreate, onUpload, onClose }: { onCreate: () => void; onUpload: () => void; onClose: () => void }) {
  const t = useT();
  return (
    <div className="cz-overlay" onClick={onClose}>
      <div className="cz-dialog cz-dialog-pick" onClick={(e) => e.stopPropagation()}>
        <div className="cz-dialog-head">
          <div className="cz-dialog-title">{t("cz.add.title")}</div>
          <button className="cz-icon-btn" onClick={onClose} title={t("cz.up.cancel")}><IconClose size={18} /></button>
        </div>
        <div className="cz-pick-group">{t("cz.add.createGroup")}</div>
        <button className="cz-pick-card" onClick={onCreate}>
          <div className="cz-pick-ic"><IconFileText size={26} /></div>
          <div className="cz-pick-name">{t("cz.add.create")}</div>
          <div className="cz-pick-desc">{t("cz.add.createDesc")}</div>
        </button>
        <div className="cz-pick-group">{t("cz.add.importGroup")}</div>
        <button className="cz-pick-card" onClick={onUpload}>
          <div className="cz-pick-ic"><IconUpload size={26} /></div>
          <div className="cz-pick-name">{t("cz.add.upload")}</div>
          <div className="cz-pick-desc">{t("cz.add.uploadDesc")}</div>
        </button>
      </div>
    </div>
  );
}

// 「上传 Skill」对话框（截图②）：拖拽区 + 要求说明 + Cancel/Upload
function UploadSkillDialog({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const MAX = 6 * 1024 * 1024;

  const accept = (f: File | undefined | null) => {
    setErr("");
    if (!f) return;
    if (!/\.zip$/i.test(f.name)) { setErr(t("cz.up.badType")); return; }
    if (f.size > MAX) { setErr(t("cz.up.tooBig")); return; }
    setFile(f);
  };

  const submit = async () => {
    if (!file || busy) return;
    setBusy(true); setErr("");
    try {
      const buf = await file.arrayBuffer();
      let bin = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      await importSkillZip(btoa(bin));
      onDone();
    } catch (e) {
      setBusy(false);
      setErr((e as Error)?.message || String(e));
    }
  };

  return (
    <div className="cz-overlay" onClick={onClose}>
      <div className="cz-dialog cz-dialog-up" onClick={(e) => e.stopPropagation()}>
        <div className="cz-dialog-head">
          <div>
            <div className="cz-dialog-title">{t("cz.up.title")}</div>
            <div className="cz-dialog-sub">{t("cz.up.subtitle")}</div>
          </div>
          <button className="cz-icon-btn" onClick={onClose} title={t("cz.up.cancel")}><IconClose size={18} /></button>
        </div>

        <div className="cz-up-body">
          <p className="cz-up-intro">{t("cz.up.intro")}</p>

          <input ref={inputRef} type="file" accept=".zip" style={{ display: "none" }}
            onChange={(e) => { accept(e.target.files?.[0]); e.target.value = ""; }} />
          <div className={"cz-dropzone" + (dragOver ? " over" : "") + (file ? " has-file" : "")}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); accept(e.dataTransfer.files?.[0]); }}>
            <div className="cz-drop-ic"><IconUpload size={30} /></div>
            {file ? (
              <>
                <div className="cz-drop-main">{t("cz.up.picked")}: {file.name}</div>
                <div className="cz-drop-hint">{(file.size / 1024).toFixed(0)} KB</div>
              </>
            ) : (
              <>
                <div className="cz-drop-main">{dragOver ? t("cz.up.dropActive") : t("cz.up.drop")}</div>
                <div className="cz-drop-hint">{t("cz.up.dropHint")}</div>
              </>
            )}
          </div>

          <div className="cz-up-req">
            <div className="cz-up-req-title">{t("cz.up.reqTitle")}</div>
            <ul>
              <li>{t("cz.up.req1")}</li>
              <li>{t("cz.up.req2")}</li>
              <li>{t("cz.up.req3")}</li>
            </ul>
          </div>

          {err && <div className="cz-up-err">{err}</div>}
        </div>

        <div className="cz-dialog-foot">
          <button className="cz-btn-ghost" onClick={onClose} disabled={busy}>{t("cz.up.cancel")}</button>
          <button className="cz-btn-primary" onClick={submit} disabled={!file || busy}>
            {busy ? t("cz.skill.importing") : t("cz.up.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}

// 「发布到 DevOps Agent」对话框：选目标 Agent Space（本账号 / 已接入的成员账号），
// 一键把该 skill 打成 zip 上传（CreateAsset/UpdateAsset）；已发布的目标可撤下（DeleteAsset）。
function PublishDialog({ skill, onChanged, onClose }: { skill: Skill; onChanged: () => void; onClose: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  const [targets, setTargets] = useState<DevopsTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");   // 正在操作的 account_id/self
  const [err, setErr] = useState("");
  // 本地镜像上传状态（乐观更新，避免每次操作都全量刷新列表）
  const [uploads, setUploads] = useState<Record<string, DevopsUpload>>(skill.devops_agent?.uploads || {});

  useEffect(() => {
    listDevopsTargets().then((ts) => { setTargets(ts); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const keyOf = (tg: DevopsTarget) => (tg.scope === "self" ? "self" : tg.account_id);
  // 稳定定位一个目标的上传记录：优先规范键；否则按 Agent Space id 兜底命中。
  // （历史上 self 目标曾以真实账号 id 作键，与固定的 "self" 键错位，会误显示为「未发布」。）
  const recFor = (map: Record<string, DevopsUpload>, tg: DevopsTarget) =>
    map[keyOf(tg)] || Object.values(map).find((r) => r?.agent_space_id === tg.agent_space_id);

  const publish = async (tg: DevopsTarget) => {
    const k = keyOf(tg);
    setBusy(k); setErr("");
    try {
      const r = await uploadSkillToDevops(skill.skill_id, tg.scope === "self" ? "" : tg.account_id);
      const spaceId = r.agentSpaceId || tg.agent_space_id;
      setUploads((u) => {
        const n = { ...u };
        // 清掉指向同一 Agent Space 的旧键，避免同一目标出现两条记录（后端也会清洗）。
        for (const kk of Object.keys(n)) if (kk !== k && n[kk]?.agent_space_id === spaceId) delete n[kk];
        n[k] = {
          asset_id: r.assetId || "", agent_space_id: spaceId,
          scope: tg.scope, account_id: tg.account_id, uploaded_version: skill.latest_version || "",
          uploaded_at: new Date().toISOString(),
        };
        return n;
      });
      onChanged();
    } catch (e) { setErr((e as Error)?.message || String(e)); }
    finally { setBusy(""); }
  };

  const unpublish = async (tg: DevopsTarget) => {
    const k = keyOf(tg);
    if (!confirm(t("cz.da.confirmRemove").replace("{name}", tg.label))) return;
    setBusy(k); setErr("");
    try {
      await removeSkillFromDevops(skill.skill_id, tg.scope === "self" ? "" : tg.account_id);
      setUploads((u) => {
        const n = { ...u };
        // 删掉命中该目标的任意键（规范键或指向同一 Agent Space 的历史键）。
        for (const kk of Object.keys(n)) if (kk === k || n[kk]?.agent_space_id === tg.agent_space_id) delete n[kk];
        return n;
      });
      onChanged();
    } catch (e) { setErr((e as Error)?.message || String(e)); }
    finally { setBusy(""); }
  };

  return (
    <div className="cz-overlay" onClick={onClose}>
      <div className="cz-dialog cz-dialog-pub" onClick={(e) => e.stopPropagation()}>
        <div className="cz-dialog-head">
          <div>
            <div className="cz-dialog-title"><IconPublish size={18} /> {t("cz.da.title")}</div>
            <div className="cz-dialog-sub">{t("cz.da.subtitle").replace("{name}", skillDisplay(skill, locale).name)}</div>
          </div>
          <button className="cz-icon-btn" onClick={onClose} title={t("cz.up.cancel")}><IconClose size={18} /></button>
        </div>

        <div className="cz-pub-body">
          <p className="cz-pub-intro">{t("cz.da.intro")}</p>
          {loading ? (
            <div className="cz-pub-loading">…</div>
          ) : targets.length === 0 ? (
            <div className="cz-pub-none">{t("cz.da.noTargets")}</div>
          ) : (
            <div className="cz-pub-targets">
              {targets.map((tg) => {
                const k = keyOf(tg);
                const rec = recFor(uploads, tg);
                const isBusy = busy === k;
                return (
                  <div key={k} className={"cz-pub-row" + (rec ? " done" : "")}>
                    <div className="cz-pub-tgt">
                      <span className={"cz-pub-scope " + tg.scope}>{tg.scope === "self" ? t("cz.da.scope.self") : t("cz.da.scope.cross")}</span>
                      <div className="cz-pub-tgt-tx">
                        <div className="cz-pub-tgt-name">{tg.label}</div>
                        <div className="cz-pub-tgt-sub">{tg.agent_space_id}</div>
                      </div>
                    </div>
                    {rec ? (
                      <div className="cz-pub-actions">
                        <span className="cz-pub-state"><IconCheck size={13} /> {t("cz.da.state.published")}{rec.uploaded_version ? ` · v${rec.uploaded_version}` : ""}</span>
                        <button className="cz-btn-ghost sm" disabled={isBusy} onClick={() => publish(tg)}>{isBusy ? "…" : t("cz.da.reupload")}</button>
                        <button className="cz-btn-danger sm" disabled={isBusy} onClick={() => unpublish(tg)}>{t("cz.da.remove")}</button>
                      </div>
                    ) : (
                      <button className="cz-btn-primary sm" disabled={isBusy} onClick={() => publish(tg)}>
                        {isBusy ? t("cz.da.publishing") : t("cz.da.publishBtn")}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {err && <div className="cz-up-err">{err}</div>}
        </div>

        <div className="cz-dialog-foot">
          <button className="cz-btn-ghost" onClick={onClose}>{t("cz.da.close")}</button>
        </div>
      </div>
    </div>
  );
}

function SkillEditor({ skill, homeSignal, onDone, onCancel }: { skill: Skill | null; homeSignal?: number; onDone: () => void; onCancel: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  const isNew = !skill;
  // 预置 skill 按当前语言显示名/描述（编辑视图与列表一致）；客户自建按原文。
  const disp = skill ? skillDisplay(skill, locale) : { name: "", description: "" };
  const [name, setName] = useState(disp.name);
  const [desc, setDesc] = useState(disp.description);
  const [body, setBody] = useState(skill?.body ?? "");
  // 执行方式不再由客户在此指定：所有 skill 本地都能跑；是否走 DevOps Agent 深度调查由对话里的
  // DevOps Agent 开关决定，发布到 DevOps Agent 只是**解锁增强**（见列表页的「发布」按钮）。
  const [skillId, setSkillId] = useState(skill?.skill_id ?? "");
  const [idTouched, setIdTouched] = useState(false);   // 用户是否手动改过 ID
  const [idStatus, setIdStatus] = useState<"" | "checking" | "ok" | "taken" | "bad">("");
  const [saving, setSaving] = useState(false);
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  // 脏检查基线：正文异步加载/回滚后会更新，用于判断「有无未保存修改」。name/desc
  // 直接与初始派生值比较（下方 dirty）。
  const [baseBody, setBaseBody] = useState(skill?.body ?? "");

  const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

  // 新建：ID 默认从 name 自动推导（除非用户手动改过）
  useEffect(() => {
    if (isNew && !idTouched) setSkillId(slugify(name));
  }, [name, isNew, idTouched]);

  // 新建：ID 实时查重
  useEffect(() => {
    if (!isNew) return;
    const id = skillId.trim();
    if (!id) { setIdStatus(""); return; }
    if (!ID_RE.test(id)) { setIdStatus("bad"); return; }
    setIdStatus("checking");
    let cancelled = false;
    const tmr = setTimeout(() => {
      skillExists(id).then((ex) => { if (!cancelled) setIdStatus(ex ? "taken" : "ok"); }).catch(() => { if (!cancelled) setIdStatus(""); });
    }, 350);
    return () => { cancelled = true; clearTimeout(tmr); };
  }, [skillId, isNew]);

  // 编辑：拉正文 + 版本历史。预置 skill 按当前 UI 语言取本地化正文（zh→中文，缺失回退英文）；
  // 客户自建照原文。语言切换时重取正文，保证展示与列表/对话一致。
  useEffect(() => {
    if (skill) {
      getSkill(skill.skill_id, undefined, locale).then((full) => { if (full?.body !== undefined) { setBody(full.body || ""); setBaseBody(full.body || ""); } }).catch(() => {});
      listVersions(skill.skill_id).then(setVersions).catch(() => {});
    }
  }, [skill, locale]);

  // 是否有未保存修改（与进入编辑器时的基线比较）。正文以异步加载后的 baseBody 为准。
  const dirty = name !== disp.name || desc !== disp.description || body !== baseBody;

  // 左侧「Skills」被点击 → 回列表：无修改直接回；有未保存修改先确认（避免静默丢弃）。跳过首挂。
  const firstHome = useRef(true);
  useEffect(() => {
    if (firstHome.current) { firstHome.current = false; return; }
    if (!dirty || confirm(t("cz.skill.discardConfirm"))) onCancel();
    // 依赖仅 homeSignal：只在点击「Skills」时触发，不随输入实时跑。dirty/onCancel 用最新闭包值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeSignal]);

  const idOk = isNew ? (idStatus === "ok") : true;
  const canSave = name.trim().length > 0 && body.trim().length >= 20 && idOk && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await saveSkill({ skill_id: isNew ? skillId.trim() : skill!.skill_id, name, description: desc, body, mode: isNew ? "create" : "update" });
      onDone();
    } catch (e) {
      setSaving(false);
      alert(`${t("cz.skill.save")}失败：${(e as Error)?.message || e}`);
    }
  };

  const doRollback = async (v: string) => {
    if (!skill) return;
    if (!confirm(`${t("cz.skill.rollback")}: v${v}?`)) return;
    await rollbackSkill(skill.skill_id, v);
    listVersions(skill.skill_id).then(setVersions).catch(() => {});
    getSkill(skill.skill_id).then((full) => { if (full?.body !== undefined) { setBody(full.body || ""); setBaseBody(full.body || ""); } }).catch(() => {});
  };

  return (
    <div className="cz-pane">
      <div className="cz-pane-head">
        <div className="cz-pane-title"><IconRename size={18} /> {skill ? disp.name : t("cz.skills.new")}</div>
      </div>
      <div className="cz-form">
        <label className="cz-field">
          <span>{t("cz.skill.name")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("cz.skill.namePh")} />
        </label>
        {/* Skill ID：新建可编辑+查重；编辑只读（id 不可改，否则等于换 skill）*/}
        <label className="cz-field">
          <span>{t("cz.skill.id")}</span>
          <input value={skillId} disabled={!isNew}
            onChange={(e) => { setIdTouched(true); setSkillId(e.target.value.toLowerCase()); }}
            placeholder={t("cz.skill.idPh")} style={{ opacity: isNew ? 1 : 0.6 }} />
          {isNew && idStatus === "taken" && <span style={{ color: "#e5484d", fontSize: 12 }}>{t("cz.skill.idTaken")}</span>}
          {isNew && idStatus === "bad" && <span style={{ color: "#e5484d", fontSize: 12 }}>{t("cz.skill.idBad")}</span>}
          {isNew && idStatus === "ok" && <span style={{ color: "var(--green)", fontSize: 12 }}>✓</span>}
        </label>
        <label className="cz-field">
          <span>{t("cz.skill.desc")}</span>
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={t("cz.skill.descPh")} />
        </label>
        <label className="cz-field">
          <span>{t("cz.skill.body")}</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("cz.skill.bodyPh")} rows={12} />
        </label>
        <div className="cz-form-actions">
          <button className="cz-btn-ghost" onClick={onCancel}>{t("cz.skill.cancel")}</button>
          <button className="cz-btn-primary" onClick={save} disabled={!canSave}>{t("cz.skill.save")}</button>
        </div>

        {/* 版本历史（仅编辑已有 skill）*/}
        {skill && versions.length > 0 && (
          <div className="cz-versions">
            <div className="cz-field"><span>{t("cz.skill.versions")}</span></div>
            {versions.map((v) => (
              <div key={v.version} className="cz-ver-row">
                <span className="cz-ver-tag">v{v.version}{v.is_latest && <em> · {t("cz.skill.latest")}</em>}</span>
                <span className="cz-ver-meta">{(v.created_at || "").slice(0, 10)} {v.changelog}</span>
                {!v.is_latest && (
                  <button className="cz-ver-btn" onClick={() => doRollback(v.version)}>{t("cz.skill.rollback")}</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
