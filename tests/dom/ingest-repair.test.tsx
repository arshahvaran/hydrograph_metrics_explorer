/** Data tab regressions from the second ingest review: the discharge unit is
 *  taken from the Observed and Simulated headers once roles are mapped
 *  (ingest-08-unrecognised-bracket), an unknown header unit gets a note, and
 *  the Decimal mark selector says which columns it applies to
 *  (ingest-01-global-override). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import { DataTab } from '../../src/ui/DataTab'
import { useApp } from '../../src/store/store'

const uploadText = async (name: string, text: string) => {
  const f = new File([text], name, { type: 'text/csv' });
  await act(async () => { fireEvent.change(screen.getByLabelText('Upload CSV, TXT, TSV or XLSX data files'), { target: { files: [f] } }); });
  await waitFor(() => expect(screen.getByLabelText('Discharge unit')).toBeTruthy());
};
const unitValue = () => (screen.getByLabelText('Discharge unit') as HTMLSelectElement).value;
const setRole = (col: string, role: string) => fireEvent.change(screen.getByLabelText(`Role for column ${col}`), { target: { value: role } });

beforeEach(() => { useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null }); });
afterEach(() => cleanup());

describe('ingest-08-unrecognised-bracket: the unit follows the mapped flow columns', () => {
  const FILE = 'date,P [mm],Q_obs [cfs],Q_sim [cfs]\n2020-01-01,0,100,110\n2020-01-02,5,120,115\n2020-01-03,1,130,125';
  it('"P [mm]" next to two "[cfs]" flow columns: mapping the flow columns sets ft³/s', async () => {
    render(<DataTab />);
    await uploadText('p.csv', FILE);
    expect(unitValue()).toBe('m3s');                          // before mapping: two units in the headers
    setRole('date', 'date');
    setRole('Q_obs [cfs]', 'observed');
    setRole('Q_sim [cfs]', 'run');
    expect(unitValue()).toBe('cfs');
    expect(screen.getByText('Discharge unit set to ft³/s (cfs) from the column headers.')).toBeTruthy();
  });
  it('a unit the user picked is not changed by a later role change', async () => {
    render(<DataTab />);
    await uploadText('p.csv', FILE);
    fireEvent.change(screen.getByLabelText('Discharge unit'), { target: { value: 'ls' } });
    setRole('Q_obs [cfs]', 'observed');
    setRole('Q_sim [cfs]', 'run');
    expect(unitValue()).toBe('ls');
  });
  it('an unknown header unit is named in a note', async () => {
    render(<DataTab />);
    await uploadText('k.csv', 'date,obs [kcfs],sim [kcfs]\n2020-01-01,1,2\n2020-01-02,2,3');
    expect(unitValue()).toBe('m3s');
    expect(screen.getByText('The unit “[kcfs]” in the column headers is not a unit the tool knows, so the Discharge unit is set to m³/s. Check it.')).toBeTruthy();
  });
});

describe('ingest-01-global-override: the Decimal mark selector states its scope', () => {
  it('a Point or Comma choice says that it applies only to the columns the file cannot decide', async () => {
    render(<DataTab />);
    await uploadText('f.csv', 'date;obs;simA;simB\n2020-01-01;12,345;1,5;1.5\n2020-01-02;13,345;2,5;1.234\n2020-01-03;14,345;3,5;2.5\n');
    const hint = 'The Decimal mark choice applies only to the columns that the tool asks about. The other columns keep the mark found in the file.';
    expect(screen.queryByText(hint)).toBeNull();
    fireEvent.change(screen.getByLabelText('Decimal mark'), { target: { value: 'comma' } });
    expect(screen.getByText(hint)).toBeTruthy();
  });
});
