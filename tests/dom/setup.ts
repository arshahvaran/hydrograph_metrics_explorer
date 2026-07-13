import '@testing-library/jest-dom/vitest'
// jsdom lacks a few browser APIs the app touches; provide inert versions.
if (typeof window !== 'undefined') {
  window.matchMedia = window.matchMedia || ((q: string) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  })) as any;
  window.URL.createObjectURL = window.URL.createObjectURL || (() => 'blob:test');
  window.URL.revokeObjectURL = window.URL.revokeObjectURL || (() => {});
  (window as any).ResizeObserver = (window as any).ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
  window.HTMLElement.prototype.scrollIntoView = window.HTMLElement.prototype.scrollIntoView || (() => {});
}
// Plotly cannot run in jsdom (needs canvas/webgl); stub the module for DOM tests.
import { vi } from 'vitest'
vi.mock('plotly.js-dist-min', () => ({
  default: {
    react: vi.fn(), newPlot: vi.fn(), purge: vi.fn(),
    toImage: vi.fn(async () => 'data:image/png;base64,iVBORw0KGgo='),
    downloadImage: vi.fn(),
  },
}));
// Leaflet also needs a real layout engine; stub minimal surface.
vi.mock('leaflet', () => {
  const chain: any = new Proxy(() => chain, { get: () => () => chain, apply: () => chain });
  return { default: { map: () => chain, tileLayer: () => chain, marker: () => chain, icon: () => ({}), divIcon: () => ({}) } };
});
