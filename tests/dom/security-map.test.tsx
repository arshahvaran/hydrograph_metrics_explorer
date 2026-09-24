// @vitest-environment jsdom
/** Security regression (audit SEC-MAP): a dataset name is shown as text in the Map popup,
 *  never parsed as HTML. Uses the REAL Leaflet (the global DOM setup stubs it out). */
import { it, expect, vi } from 'vitest'

vi.unmock('leaflet');


it('SEC-MAP: a dataset name from a project file is rendered as text in the station popup', async () => {
  // jsdom has no SVGSVGElement.createSVGRect; Leaflet feature-detects SVG with it at import time.
  (window as any).SVGSVGElement.prototype.createSVGRect = () => ({});
  // give the map host a real size so Leaflet requests a realistic tile set
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });

  const { parseProjectFile } = await import('../../src/store/projectLoad');
  const { useApp } = await import('../../src/store/store');
  const { render } = await import('@testing-library/react');
  const { MapTab } = await import('../../src/ui/MapTab');

  const n = 40, t0 = Date.UTC(2006, 0, 1);
  const dates = Array.from({ length: n }, (_, i) => t0 + i * 864e5);
  const obs = dates.map((_, i) => 6 + Math.sin(i / 5));
  const PAYLOAD = 'Nith River <img src=x onerror="document.body.dataset.pwned=document.domain">';
  const file = {
    schemaVersion: 1,
    datasets: [{
      name: PAYLOAD, dates, observed: { name: 'obs', values: obs, inputUnit: 'm3s' },
      runs: [{ name: 'sim', values: obs.map(v => v * 1.1), inputUnit: 'm3s', visible: true }],
      targetUnit: 'm3s', location: { lat: 43.3, lon: -80.45 }, area: null, view: { activeTab: 'map' },
    }],
  };
  const { project } = parseProjectFile(JSON.stringify(file));
  useApp.getState().loadProject(project);
  expect(useApp.getState().project.datasets[0].name).toBe(PAYLOAD);   // loader keeps the string verbatim

  render(<MapTab />);
  // the station marker is an interactive SVG path; a user click opens its popup
  const path = document.querySelector('path.leaflet-interactive') as SVGPathElement;
  expect(path).not.toBeNull();
  path.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 400, clientY: 200 }));

  const content = document.querySelector('.leaflet-popup-content') as HTMLElement;
  const injected = content?.querySelector('img[onerror]') as HTMLImageElement | null;
  // In a browser the broken src=x fires 'error' by itself; jsdom does not fetch images, so fire it.
  injected?.dispatchEvent(new Event('error'));

  expect(injected).toBeNull();
  expect(content.querySelector('img')).toBeNull();
  expect(content.textContent).toContain(PAYLOAD);
  expect(document.body.dataset.pwned).toBeUndefined();
});
