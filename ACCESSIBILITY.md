# Accessibility audit — v1.1.0 (CP8)

Scope: WCAG 2.1 AA-oriented review of the shipped SPA (both themes), performed alongside the
CP8 build. Format: finding → resolution. Items marked *partial* are stated honestly rather than
claimed.

## Contrast (measured, WCAG relative-luminance formula)

| Text / background pair | Light | Dark | AA (≥4.5:1) |
|---|---|---|---|
| Muted text on panel | 4.96:1 | 6.41:1 | ✅ |
| Muted text on page background | 4.63:1 | 7.03:1 | ✅ |
| Accent links/text on panel | 5.67:1 | 4.86:1 | ✅ |
| Accent text on accent-soft (badges) | 4.95:1 | — | ✅ |
| Button label on accent (primary) | 5.67:1 | 5.53:1 | ✅ |
| Body ink on timing-row tint | 17.1:1 | — | ✅ |

Lowest measured pair is 4.63:1 — passes AA for normal text; no reliance on large-text exemptions.

## Keyboard & focus

- **Skip link** ("Skip to content") added as the first focusable element → `#main`.
- **Tabs** implement the ARIA tabs pattern: `role=tablist/tab`, `aria-selected`, roving
  `tabindex` (active tab is the single stop), Arrow ←/→ and Home/End move + activate + focus.
- **File inputs** were `hidden`, which removed them from the accessibility tree and made
  upload/load unreachable by keyboard. Replaced with a visually-hidden (`.vh`) class so they
  remain focusable; both carry `aria-label`s.
- `:focus-visible` rings on all interactive elements; `prefers-reduced-motion` kills
  transitions/animations globally.

## Names, roles, values

- Icon-only controls all carry `aria-label` (theme toggle, remove-dataset ✕, window/season
  clear ×); grid cells and header-rename inputs are individually labelled
  ("row 3 observed", "name of predicted column 2").
- Key data tables carry `aria-label`s (metric values, composite ranking, timing summary,
  events, reference); the reference table is reachable and filterable by keyboard.
- Async status is announced politely: metric-panel busy note, bootstrap progress
  ("bootstrapping… 43%"), and report-generation stages use `aria-live="polite"`/`role="status"`.

## Colour-independent encoding

Observed vs runs are distinguished by hue **and** line style (solid vs dashed) per spec §19/§20;
best-in-row cells use bold + underline in addition to colour; timing rows pair the tint with the
⏱ glyph. The run palette (paper blue + ColorBrewer Dark2) is colour-vision-deficiency safe.

## Known partials (stated, not hidden)

- **Plotly charts render to canvas** and are not screen-reader readable point-by-point. Each
  plot is paired with a text note summarising what it shows, and every plot offers a CSV
  download of exactly the plotted data — the accessible equivalent. Modebar buttons expose
  native titles.
- **Leaflet map**: pan/zoom controls are keyboard-operable natively; the marker popup carries
  the dataset name. Location can equally be set through the validated lat/lon inputs, so the
  map is never the only path.
- The editable grid supports Tab/Shift-Tab cell traversal and block paste; it does not
  implement arrow-key spreadsheet navigation (documented limitation of the light grid).
