# C.R.A.S.H — Design Language Reference

A visual **re-skin** of the existing, working C.R.A.S.H site. Change the design
language only — **do not change any features, layout, screens, element IDs, or
behaviour.** Match this spec in spirit; it is the source of truth (it was
distilled from the reference prototype, so you do not need that large HTML file).

---

## The identity

**"Editorial civic-intelligence broadsheet."** Warm printed-paper background, an
editorial **serif** for headings (with occasional italic emphasis), a calm muted
**steel-blue** accent, near-sharp corners, warm 1px hairline borders instead of
heavy shadows, and **monospaced tabular numbers.** Authoritative, precise,
print-like — like a serious newspaper's data-graphics desk. Not clinical, not
glossy, not rounded-SaaS.

---

## Off-limits — never touch

- `backend/`, all `data/` files, `.env`, `render.yaml`, `requirements.txt`,
  `package.json`, and any config file.
- Any JavaScript logic, any element ID / class / variable that other code
  depends on.
- No renaming, deleting, moving, or duplicating files.

Only edit **CSS** — the existing stylesheet(s) / CSS custom properties, or **one
new CSS file that loads last** as an override. If a visual is set in JS (Chart.js
colors, Leaflet basemap tiles), **do not edit the JS** — just flag it and leave it.

---

## Color tokens

Remap the site's existing token variables to these values (keep the variable
**names**, change their values, add any missing). Make **warm light the default**;
keep the dark theme working on the toggle.

### Light (default)

| Token | Value |
|---|---|
| canvas | `#F4F0E7` |
| surface | `#FCFAF4` |
| surface-2 | `#EBE5D8` |
| border | `#D9D1C1` |
| border-soft | `#E7E0D0` |
| text | `#221F18` |
| text-muted | `#6E675A` |
| text-3 | `#857D6D` |
| accent | `#2F5C87` |
| accent-ink | `#FCFBF8` |
| accent-faint | `rgba(47,92,135,0.05)` |
| accent-soft | `rgba(47,92,135,0.10)` |
| accent-line | `rgba(47,92,135,0.26)` |
| row-hover | `#EFEADE` |
| row-alt | `#F1ECE0` |
| track | `#E7E0D0` |

### Dark (toggle)

| Token | Value |
|---|---|
| canvas | `#16191D` |
| surface | `#1E232A` |
| surface-2 | `#262C34` |
| border | `#333B44` |
| text | `#ECEAE4` |
| text-muted | `#99A2AC` |
| accent | `#6FA3D0` |
| accent-ink | `#14202B` |
| row-hover | `#242A31` |
| track | `#2A313A` |

### Data-only colors (never used as UI chrome)

- Severity: fatal `#BE2F2A` · serious `#CE8A2E` · slight — keep existing yellow.
- Comparison series: A `#2F5C87` · B `#A9773C`.
- Chart hues: day `#5F7488` · night `#33475C` · histogram `#A79F8D` · peak = accent.

---

## Typography

Import via CSS `@import` (no HTML/JS edits needed).

- **Headings / display:** `'Newsreader', Georgia, serif` — weight 600,
  letter-spacing −0.015em, line-height ~1.05, large sizes via `clamp()`,
  `text-wrap: balance`. Allow an `<em>` in serif *italic* for a key phrase in
  major headings (editorial voice).
- **Body / UI:** `'Roboto', system-ui, sans-serif` — line-height ~1.6.
- **Numbers, coordinates, risk scores, chart labels:** `'IBM Plex Mono'`,
  tabular figures.
- **Eyebrows / section labels:** uppercase, letter-spacing 0.12–0.16em, small,
  muted color.

---

## Shape & depth

- **Radius:** `--radius: 3px`, small `2px`, large `4px`. Sharp and print-like —
  remove pill/large rounding on cards, buttons, inputs. Keep circular dots /
  toggles at `50%`.
- Structure comes from **1px warm hairline borders** (`--border`), not shadows.
- Flat cards by default. Only a hero/feature element may use a soft long
  accent-tinted shadow: `0 20px 50px -28px rgba(47,92,135,0.35)`.

---

## Components

**Buttons**
- Primary: solid `--accent` background, `--accent-ink` text, 1px `--accent`
  border; include a small thin-line arrow icon where it reads as a CTA.
- Ghost / secondary: transparent background, `--accent` text, 1px `--accent-line`
  border.

**Icons & chips**
- Thin-line icons (1.6px stroke) in the accent color.
- Card icons sit in a 40px square chip: 3px radius, 1px `--accent-line` border,
  `--accent-faint` background.

**Apply the language to:** nav, cards/panels, the ranked-index list (warm row
hover + alternating rows), the dossier drawer, tables, and form controls.

---

## Work in phases

**Phase 0 — map, no edits.** Find the site's CSS variables, font imports, theme
toggle, and which visuals are set in JS vs CSS. List the exact files/lines you'd
change (confirm none are off-limits). Show the plan and wait for approval.

**Phase 1 — apply tokens, fonts, core styling** (above), then STOP for testing.

**Phase 2 — polish (only after Phase 1 is confirmed).** *Only if JS edits are
approved:* restyle Chart.js (steel-blue primary, warm thin gridlines, mono tick
labels, no heavy grid; severity charts use severity colors; comparison uses A/B)
and switch the Leaflet basemap dark→light (CARTO Positron), matching dark tiles
when the toggle is dark. Do not filter/tint tiles. Otherwise, just list these for
a separate decision. Optional: subtle CSS reveal-on-scroll (respect
`prefers-reduced-motion`, no bounce). Verify light + dark + mobile.

---

## Rules

- Pause for testing after each phase — do not chain phases.
- Change only presentation; never touch the off-limits files/JS/IDs.
- Commit at the end of each phase with a conventional message (`style:` / `fix:`),
  but **do not `git push` until I say "no bugs."**
- Name each file before editing and confirm it isn't off-limits.
- If a clean CSS-only result isn't possible somewhere, say so honestly instead of
  editing extra or important files.

**First step:** `git checkout -b style/editorial-redesign` so `main` stays safe.
