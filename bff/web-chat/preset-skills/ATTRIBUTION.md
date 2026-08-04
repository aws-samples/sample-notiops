# Preset Skills — 来源与署名（ATTRIBUTION）

本目录下的预置 skill（`author = notiops-system`）分两类：

1. **NotiOps 自研** —— 由本项目团队原创编写，无外部来源。
2. **外部导入** —— 从开源仓库 / 第三方引入。**规范（强制）：凡是从外部拿来的 skill，
   都必须在 skill 自身内部（`SKILL.md` H1 之后的 source 块，以及本地化 `SKILL.zh.md`）
   写清来源 —— 原始仓库 URL、许可证、版权方、上游 commit、导入日期、以及"改了什么/没改什么"，
   并在本文件补一条记录。** 目的：避免日后"这个 skill 哪来的、能不能用、改没改过"说不清楚。

> 判断某个 skill 是否为外部导入：看它的 `SKILL.md` 是否带 **Source / 来源** 块。
> 没有该块 = NotiOps 自研；有 = 外部导入，须在下方登记。

---

## 外部导入 skill 登记表

### `aws-well-architected-review-devops` — AWS Well-Architected Framework Review (WAFR)

| 字段 | 值 |
|------|----|
| 原始仓库 | https://github.com/aws-samples/sample-skills-for-AWS-Devops-agent |
| 原始 skill 目录 | `aws-wa-review-skill-devops` |
| 许可证 | MIT License |
| 版权 | © 2025 Amazon Web Services |
| 上游 commit | `375e1c192fc5f1d97bf1c5f688ed8d2c44ff0f9e`（2026-05-28） |
| 导入日期 | 2026-07-28 |
| 导入方式 | **原样导入（verbatim）**：`SKILL.md` 正文与 `references/`、`examples/` 下所有文件均未改动 |
| NotiOps 增补 | 仅：(a) `SKILL.md` H1 后的 source 块；(b) 本地化 frontmatter（`name-en/zh`、`description-en/zh`）；(c) 中文注入正文 `SKILL.zh.md`（含中文 source 块）；(d) 随附上游 `LICENSE` 副本 |
| 许可证副本 | `aws-well-architected-review-devops/LICENSE`（上游 MIT 原文） |

MIT 许可证要求"在软件的所有副本或实质部分中保留上述版权声明和本许可声明"。为满足该条款：
上游 `LICENSE` 原文已随 skill 一并保留于 `aws-well-architected-review-devops/LICENSE`，
且 `SKILL.md` / `SKILL.zh.md` 顶部 source 块均标注了版权方与许可证。

---

## 新增外部导入 skill 时的 checklist

1. 把上游 skill 目录**原样**放到 `preset-skills/<id>/`（尽量零改写，便于追溯与升级）。
2. 在 `SKILL.md` H1 之后加 **Source / 来源** 块：仓库 URL、许可证、版权、上游 commit、导入日期、改动说明。
3. 若有中文正文 `SKILL.zh.md`，同样在顶部加中文 source 块。
4. 保留上游 `LICENSE`（尤其 MIT/Apache 等要求保留版权声明的许可证）。
5. 在本文件"外部导入 skill 登记表"补一条记录。
6. 确认许可证允许再分发与修改；若为 copyleft（GPL 等）或 NC（非商业）等受限许可证，
   **先评估合规性再导入**（NotiOps 面向众多 AWS 客户交付，属商业分发场景）。
