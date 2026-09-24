/**
 * Final sweep, accessibility: text contrast (WCAG 1.4.3, 4.5:1 for body text)
 * of the theme tokens, computed from src/theme.css for both themes. axe in a
 * real browser (v1.14) found:
 *  - muted text (--ink-soft #697080) at 4.43:1 on --panel-2 and 4.49:1 on
 *    --timing-bg (light);
 *  - the Sandbox slider values (--accent #5b93a8) at 4.46:1 on --accent-soft
 *    (dark);
 *  - run names coloured with their plot colour: #d95f02 at 3.35:1 (light) and
 *    3.98:1 (dark); yellow runs are worse. They now keep the text colour and
 *    carry the plot colour as a swatch (RunName).
 * The a11y DOM test turns axe's contrast rule off (jsdom has no layout) and
 * says contrast is verified analytically; this is that check.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

const css = readFileSync('src/theme.css', 'utf8')
const block = (sel: RegExp) => {
  const m = css.match(sel)!
  const out: Record<string, string> = {}
  for (const t of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[t[1]] = t[2].toLowerCase()
  return out
}
const LIGHT = block(/:root[^{]*\{([^}]*)\}/)
const DARK = { ...LIGHT, ...block(/html\[data-theme="dark"\]\s*\{([^}]*)\}/) }
const lum = (h: string) => {
  const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

// text token -> backgrounds it is drawn on
const PAIRS: [string, string[]][] = [
  ['ink', ['bg', 'panel', 'panel-2', 'field', 'timing-bg', 'accent-soft', 'warn-bg', 'err-bg']],
  ['ink-soft', ['bg', 'panel', 'panel-2', 'field', 'timing-bg', 'accent-soft']],
  ['accent', ['bg', 'panel', 'panel-2', 'accent-soft']],
  ['accent-ink', ['accent']],
]

describe('theme text contrast is at least 4.5:1', () => {
  for (const [name, theme] of [['light', LIGHT], ['dark', DARK]] as const) {
    for (const [fg, bgs] of PAIRS) {
      for (const bg of bgs) {
        it(`${name}: --${fg} on --${bg}`, () => {
          expect(theme[fg], fg).toBeDefined()
          expect(theme[bg], bg).toBeDefined()
          expect(ratio(theme[fg], theme[bg])).toBeGreaterThanOrEqual(4.5)
        })
      }
    }
  }
})

it('run names in the Metrics, Timing and Compare tables are not coloured text', () => {
  for (const f of ['src/ui/MetricsTab.tsx', 'src/ui/TimingTab.tsx', 'src/ui/CompareTab.tsx']) {
    const src = readFileSync(f, 'utf8')
    expect(src, f).not.toMatch(/style=\{\{ color: (r|runs\[i\]|winnerRun)\.color \}\}/)
    expect(src, f).toMatch(/<RunName /)
  }
})
