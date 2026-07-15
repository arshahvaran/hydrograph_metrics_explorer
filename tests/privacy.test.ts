/** AGENT F — privacy manifest. The headline promise: user series data never
 *  leaves the browser. This test freezes the egress surface; adding any new
 *  network call fails it until the manifest is consciously updated. */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
}

describe('privacy manifest', () => {
  it('src contains exactly the two known fetch sites, both local', () => {
    const hits: string[] = [];
    for (const f of walk('src')) {
      if (!/\.(ts|tsx)$/.test(f)) continue;
      const t = readFileSync(f, 'utf8');
      for (const [i, line] of t.split('\n').entries()) {
        if (/\bfetch\s*\(/.test(line)) hits.push(`${f}:${i + 1}`);
      }
    }
    expect(hits.sort()).toEqual([
      'src/ingest/ingest.ts:107',   // same-origin sample loader (BASE_URL/samples/…)
      'src/report/report.ts:141',   // data: URLs only (plot images into the DOCX)
    ]);
  });
  it('src has no beacons, sockets, or geolocation', () => {
    for (const f of walk('src')) {
      if (!/\.(ts|tsx)$/.test(f)) continue;
      const t = readFileSync(f, 'utf8');
      expect(t).not.toMatch(/sendBeacon|new WebSocket|EventSource|navigator\.geolocation/);
    }
  });
  it('production bundles contain zero beacon/websocket call sites', () => {
    for (const f of walk('dist/assets').filter(f => f.endsWith('.js'))) {
      const t = readFileSync(f, 'utf8');
      expect((t.match(/sendBeacon/g) ?? []).length, f).toBe(0);
      expect((t.match(/new WebSocket\(/g) ?? []).length, f).toBe(0);
    }
  });
  it('the only tile endpoint our code configures is OSM (documented egress)', () => {
    const map = readFileSync('src/ui/MapTab.tsx', 'utf8');
    const urls = map.match(/https?:\/\/[^'"`\s]+/g) ?? [];
    expect(urls.every(u => u.includes('openstreetmap.org'))).toBe(true);
  });
});
