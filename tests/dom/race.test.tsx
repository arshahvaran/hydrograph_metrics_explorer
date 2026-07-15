/** AGENT D — concurrency: a slow worker result for dataset A arriving AFTER
 *  the user switched to dataset B must neither overwrite B's panel nor crash;
 *  switching back to A shows A's own (late) result. */
import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { computeAll } from '../../src/metrics/registry'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import { __resetComputeCachesForTests } from '../../src/ui/compute'
import App from '../../src/App'

class RacingWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  postMessage(msg: any) {
    const delay = msg.obs.length >= 100 ? 90 : 0;   // big dataset = slow lane
    setTimeout(() => {
      this.onmessage?.({ data: { id: msg.id, out: computeAll(msg.obs, msg.sim, msg.ctx) } });
    }, delay);
  }
  terminate() {}
}

const csv = (n: number) => {
  const rows = ['date,observed,m'];
  for (let i = 0; i < n; i++) rows.push(`${new Date(Date.UTC(2004, 0, 1) + i * 864e5).toISOString().slice(0, 10)},${(5 + Math.sin(i / 5)).toFixed(4)},${(5 + Math.sin((i - 2) / 5)).toFixed(4)}`);
  return rows.join('\n');
};
let idA = '', idB = '';
beforeAll(() => {
  (globalThis as any).Worker = RacingWorker;
  const st = useApp.getState();
  st.loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
  idA = st.commitDataset(stage(parseDelimited(csv(120)), { name: 'slow-A', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run'] }).commit!);
  idB = st.commitDataset(stage(parseDelimited(csv(80)), { name: 'fast-B', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run'] }).commit!);
});

describe('worker race: stale results never cross datasets', () => {
  it('B renders while A is in flight; A\'s late result lands under A only', async () => {
    __resetComputeCachesForTests();
    const st = useApp.getState();
    st.setActiveDataset(idA);
    useApp.getState().updateView({ activeTab: 'metrics' });
    render(<App />);
    // A is pending (slow lane). Switch to B before A resolves.
    st.setActiveDataset(idB);
    useApp.getState().updateView({ activeTab: 'metrics' });   // activeTab is per-dataset
    const bodyHas = (re: RegExp) => re.test(document.body.textContent ?? '');
    await waitFor(() => expect(bodyHas(/Valid pairs per run \(n\):\s*m:\s*80/)).toBe(true), { timeout: 3000 });
    // Let A's stale result arrive while B is displayed — must not corrupt B.
    await new Promise(r => setTimeout(r, 150));
    expect(bodyHas(/Valid pairs per run \(n\):\s*m:\s*80/)).toBe(true);
    expect(bodyHas(/Valid pairs per run \(n\):\s*m:\s*120/)).toBe(false);
    // Back to A: its late-arrived result is served from cache, correctly.
    useApp.getState().setActiveDataset(idA);
    await waitFor(() => expect(bodyHas(/Valid pairs per run \(n\):\s*m:\s*120/)).toBe(true), { timeout: 3000 });
  });
});
