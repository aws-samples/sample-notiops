# Attribution — third-party assets bundled in this repository

This file is the ledger for **third-party material that ships inside NotiOps' own source
tree** (icons, fonts, vendored snippets — anything that is redistributed as part of our
code rather than pulled at build time by a package manager).

Two ledgers exist, deliberately kept separate because they answer different questions:

| Ledger | Covers | Question it answers |
|--------|--------|---------------------|
| **this file** | third-party assets inside our source tree | "where did this icon / snippet come from, and may we redistribute it?" |
| [`bff/web-chat/preset-skills/ATTRIBUTION.md`](../bff/web-chat/preset-skills/ATTRIBUTION.md) | preset Skills imported from open-source repos | "where did this Skill come from, was it modified?" |

Declared dependencies (`package.json`, `requirements.txt`, `infra/package.json`) are **not**
listed here — they are resolved by the package manager and their licenses travel with them.

> **Rule (mandatory).** Anything added to this repository that we did not write ourselves
> must be recorded here *and* carry a source comment at the point of use: upstream URL,
> license, copyright holder, upstream version/commit, import date, and what was or was not
> modified. Same rule as the preset-Skills ledger. The point is that a year from now nobody
> has to guess whether a file is ours, whether it may be shipped, or whether someone edited it.

---

## 1. GitHub logo (Octicons `mark-github`)

| Field | Value |
|-------|-------|
| Used in | [`frontend/chat-app/src/components/icons.tsx`](../frontend/chat-app/src/components/icons.tsx) — exported as `IconGitHub`, rendered in the sidebar footer as the "star us on GitHub" link |
| Upstream | https://github.com/primer/octicons — `build/svg/mark-github-16.svg` |
| Version | `@primer/octicons@19.36.0` |
| License (code) | MIT License — © GitHub, Inc. |
| Trademark | The GitHub logo is a **trademark of GitHub, Inc.** The MIT license covers the Octicons *code*; it does **not** waive the trademark. See https://github.com/logos |
| Import date | 2026-09-11 |
| Integrity | `sha256` of the `d` attribute (721 chars) = `b9b3b853d453448426fabeb3bde9df1660b7daa0e458b0eadbef0dcb86226deb` — verified byte-identical against both `raw.githubusercontent.com/primer/octicons` and `unpkg.com/@primer/octicons@19.36.0` |
| Modified? | **No.** The path data is copied verbatim. The only additions are the surrounding React wrapper and `fill="currentColor"` (upstream ships the path with no `fill` attribute, expecting the consumer to supply one). |

### Why this icon does not follow our own icon conventions

Every other icon in `icons.tsx` is a 24×24 stroked outline sharing the `base()` helper.
This one deliberately is not, and it must stay that way:

- **`viewBox` is `0 0 16 16`**, not 24×24. Forcing it into a 24 viewBox shrinks the mark.
- **It is a solid fill, not a stroke.** Upstream's `<path>` has neither `fill` nor `stroke`,
  i.e. a filled shape under the nonzero rule. Adding `stroke` or `fill="none"` produces a
  hollow, wrong-looking shape.
- **The path data is never redrawn or simplified.** GitHub's brand guidelines forbid
  reshaping, distorting, skewing, gradients and shadows, and allow recolouring only to a
  single flat colour (white or black). We render it with `currentColor` so it inherits the
  sidebar text colour — a single flat colour, and therefore compliant.

Our use — a link to the project's GitHub repository, indicating an integration with GitHub —
is a use GitHub's brand guidelines explicitly permit.

### MIT notice (retained per the license)

```
MIT License

Copyright (c) GitHub, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Checklist when adding a third-party asset

1. Confirm the license permits redistribution and commercial use. NotiOps is delivered to
   many AWS customers, so copyleft (GPL) and non-commercial licenses need review **before**
   the asset lands.
2. Copy the asset **verbatim**. Do not "tidy" or re-optimise it — that destroys traceability
   and, for logos, may breach trademark terms.
3. Record the upstream version/commit and a content hash so drift is detectable.
4. Add a source comment at the point of use, and add a row to this file.
5. Retain the upstream license text if the license requires it (MIT, Apache-2.0, BSD, …).
6. Check for a separate **trademark** policy. A permissive code license does not grant
   trademark rights — logos almost always carry extra restrictions on colour and shape.
