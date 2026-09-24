// @vitest-environment jsdom
/** Audit project-08: Load asks before it replaces open datasets, as New does. */
import { it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import { useApp } from '../../src/store/store'
import { parseProjectFile } from '../../src/store/projectLoad'
import { __resetComputeCachesForTests } from '../../src/ui/compute'
import App from '../../src/App'

const n = 60, t0 = Date.UTC(2006, 0, 1);
const dates = Array.from({ length: n }, (_, i) => t0 + i * 864e5);
const obs = dates.map((_, i) => 6 + Math.sin(i / 5));
const projectFile = (name: string) => ({
  schemaVersion: 1,
  datasets: [{ name, dates, observed: { name: 'obs', values: obs, inputUnit: 'm3s' },
    runs: [{ name: 'sim', values: obs.map(v => v * 1.1), inputUnit: 'm3s', visible: true }],
    targetUnit: 'm3s', location: null, area: null, view: { activeTab: 'data' } }],
});
const upload = async (file: File) => {
  await act(async () => { fireEvent.change(screen.getByLabelText('Load a saved .hme.json project'), { target: { files: [file] } }); });
};

beforeEach(() => {
  __resetComputeCachesForTests();
  useApp.getState().loadProject(parseProjectFile(JSON.stringify(projectFile('open work'))).project);
});

it('project-08: Cancel keeps the open project; Load project replaces it', async () => {
  render(<App />);
  const f = new File([JSON.stringify(projectFile('from file'))], 'p.hme.json', { type: 'application/json' });
  await upload(f);
  let dlg = await screen.findByRole('dialog');
  expect(dlg).toHaveAccessibleName('Replace the open project?');
  fireEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }));
  expect(useApp.getState().project.datasets[0].name).toBe('open work');

  await upload(f);
  dlg = await screen.findByRole('dialog');
  await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: 'Load project' })); });
  await screen.findByRole('option', { name: 'from file' }, { timeout: 5000 });
  expect(useApp.getState().project.datasets.map(d => d.name)).toEqual(['from file']);
});
