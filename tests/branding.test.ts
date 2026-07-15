/** Branding manifest. Pins the logo art rules that keep regressing:
 *  1. the tile frame is deliberately thin (author round 6: "make it a bit thinner"),
 *  2. simulated curves are SOLID everywhere, including the standalone icon
 *     (house rule; dashed is reserved for reference marks only). */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

const files = ['public/logo.svg', 'public/icon.svg'];

describe('logo / icon SVG branding rules', () => {
  it('tile frame stroke-width is exactly 2 (thin frame, round 6)', () => {
    for (const f of files) {
      const svg = readFileSync(f, 'utf8');
      const rect = svg.match(/<rect[^>]*>/)?.[0] ?? '';
      expect(rect, `${f} should contain the frame rect`).not.toBe('');
      expect(rect, `${f} frame width`).toMatch(/stroke-width="2"/);
    }
  });
  it('no dashed strokes anywhere in the logo art (solid-simulated house rule)', () => {
    for (const f of files) {
      const svg = readFileSync(f, 'utf8');
      expect(svg, `${f} must not dash any curve`).not.toMatch(/stroke-dasharray/);
    }
  });
  it('both assets carry the same two hydrograph curves (observed + simulated)', () => {
    const paths = files.map(f =>
      (readFileSync(f, 'utf8').match(/<path[^>]*d="([^"]+)"/g) ?? []).map(p => p.match(/d="([^"]+)"/)![1]).sort());
    expect(paths[0]).toEqual(paths[1]);
    expect(paths[0]).toHaveLength(2);
  });
});
