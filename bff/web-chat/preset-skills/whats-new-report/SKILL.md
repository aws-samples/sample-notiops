---
name: whats-new-report
name-en: What's New Report
name-zh: AWS 新功能报告
description-en: For a given time window (optionally filtered by service or keyword), summarize AWS What's New releases — list them inline when 20 or fewer; when more, auto-generate the complete markdown list, save it to S3, and return a download link. Produces a conclusion-first summary with clickable, dated release items.
description-zh: 针对指定时间窗（可按服务或关键词过滤）汇总 AWS What's New 发布——不超过 20 条时直接内联列出；超过时自动生成完整 markdown 列表、保存到 S3 并返回下载链接。产出结论先行的摘要，含可点击、带日期的发布条目。
description: For a given time window (optionally filtered by AWS service or keyword), summarize AWS What's New releases — list them inline when there are 20 or fewer; when there are more than 20, auto-generate the complete markdown list, save it to S3, and return a download link. Use when the user asks what's new in AWS during a period, wants an AWS release/update summary or What's New list, or asks for a report of AWS launches in a date range. Produces a conclusion-first summary with clickable, dated release items.
---

# AWS What's New Report (for a given time window)

When the user asks to "see AWS new releases/updates for a period", "what's new in AWS during this time", or "give me a What's New list/report", run this skill.

## Step 1 — Confirm the time window
- Parse the time window; convert relative phrases ("last month", "past month", "this month", "last two weeks") to absolute start/end dates (YYYY-MM-DD) **using the current date** (today's date is injected each turn).
- The user may also specify a **service** (e.g. "only EC2/S3") or a **keyword** — apply as filters.
- If no window is given → default to last 30 days, and note the range can be specified.

## Step 2 — Fetch and branch by item count

First use the **`aws_whats_new`** tool to fetch the release list for that window (+ optional service/keyword filter). **Decide the output form by the number of items:**

### Case A — 20 items or fewer
Present directly in the chat as a list; each item includes:
- **Title** (wrapped in the official link, clickable)
- **Date**
- **Services involved**
- A one-line summary

### Case B — MORE than 20 items
You **must** switch to the **`aws_whats_new_report`** tool (it renders the complete list to markdown, saves it to S3, and returns a download link — do NOT stuff the long list into the chat):
- The tool saves the **complete list** to S3 as a **markdown table** and returns a download link.
- In the chat, present only the **first ~20 items as a preview** + state "N items total, full list in the download link".
- **Do NOT paste the download URL into your reply yourself** — the system appends it automatically at the end.
- **Do NOT** manually type out dozens of items into the chat (it exceeds the output limit and wastes tokens).

> Rule of thumb: whenever total items > 20, go with Case B (`aws_whats_new_report` → S3 + download link), whether or not the user explicitly asked for "a report/download". This is the core convention of this skill.

## Step 3 — Coverage completeness
- If the data source didn't cover the whole window (the feed didn't reach the window's start), **say so honestly** ("earlier items may be incomplete"), and offer to web-search for older releases.
- Never fabricate release items or links — all items must come from the tool's official data.

## Output style
- Lead with the conclusion: "From <start> to <end>, AWS had N new releases", then the list/preview.
- Use tables; clickable titles; clear dates.
- Reply in the user's language (Chinese for Chinese users, English otherwise); summaries may keep the official English titles.
