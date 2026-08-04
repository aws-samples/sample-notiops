"""CSV export helpers shared by the report routes.

CSV formula-injection (a.k.a. CSV injection) neutralization: when a CSV is
opened in Excel / Google Sheets / LibreOffice, a cell whose text starts with
`=`, `+`, `-`, `@` (or a leading tab / CR) is interpreted as a formula and can
execute (e.g. `=HYPERLINK`, `=WEBSERVICE`, DDE). Since export cells contain
AWS metadata, instance tags and LLM-generated text (attacker-influenceable),
every cell must be neutralized before writing.

Fix per OWASP guidance: prefix risky cells with a single quote so the
spreadsheet treats them as literal text.
"""
from __future__ import annotations

_RISKY_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def csv_safe(value) -> str:
    """Return a spreadsheet-safe string for a single CSV cell."""
    s = "" if value is None else str(value)
    if s and s[0] in _RISKY_PREFIXES:
        return "'" + s
    return s


def csv_safe_row(row: dict) -> dict:
    """Return a copy of `row` with every value neutralized for CSV export."""
    return {k: csv_safe(v) for k, v in row.items()}
