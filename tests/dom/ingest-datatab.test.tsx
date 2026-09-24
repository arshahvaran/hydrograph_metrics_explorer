/** Data tab regressions from the ingest audit: header unit detection and the
 *  stale unit (ingest-08), the import unit choices the README promises
 *  (ingest-12, units-09), the decimal-mark question (ingest-01) and the
 *  large-table confirmation for workbooks (SEC-WB). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, within, waitFor } from '@testing-library/react'
import * as XLSX from 'xlsx'
import { DataTab } from '../../src/ui/DataTab'
import { useApp } from '../../src/store/store'
import { LIMITS } from '../../src/ingest/limits'

const uploadText = async (name: string, text: string) => {
  const f = new File([text], name, { type: 'text/csv' });
  await act(async () => { fireEvent.change(screen.getByLabelText('Upload CSV, TXT, TSV or XLSX data files'), { target: { files: [f] } }); });
  await waitFor(() => expect(screen.getByLabelText('Discharge unit')).toBeTruthy());
};
const unitValue = () => (screen.getByLabelText('Discharge unit') as HTMLSelectElement).value;
const rows2 = '\n2020-01-01,100,110\n2020-01-02,120,115';

beforeEach(() => { useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null }); });
afterEach(() => cleanup());

describe('ingest-08: the discharge unit comes from the headers of the file being loaded', () => {
  it('reads the tool\'s own "ft³/s" label and other common spellings', async () => {
    render(<DataTab />);
    for (const [hdr, id] of [['ft³/s', 'cfs'], ['m3 s-1', 'm3s'], ['m^3/s', 'm3s'], ['cms', 'm3s'], ['L/s', 'ls'],
      ['m³/day', 'm3day'], ['ML/d', 'MLday'], ['MGD', 'MGD'], ['ac-ft/day', 'acftday'], ['cfs', 'cfs']] as const) {
      await uploadText('a.csv', `date,flow_obs [${hdr}],flow_sim [${hdr}]${rows2}`);
      expect(unitValue(), hdr).toBe(id);
    }
    expect(screen.getByText('Discharge unit set to ft³/s (cfs) from the column headers.')).toBeTruthy();
  });
  it('a file without a unit does not inherit the previous file\'s unit', async () => {
    render(<DataTab />);
    await uploadText('b.csv', `date,obs [cfs],sim [cfs]${rows2}`);
    expect(unitValue()).toBe('cfs');
    await uploadText('c.csv', `date,obs,sim${rows2}`);
    expect(unitValue()).toBe('m3s');
    expect(screen.queryByText(/from the column headers/)).toBeNull();
  });
  it('headers naming two different units reset the selector and say so', async () => {
    render(<DataTab />);
    await uploadText('d.csv', `date,obs [cfs],sim [m3/s]${rows2}`);
    expect(unitValue()).toBe('m3s');
    expect(screen.getByText('The column headers name different units (ft³/s (cfs), m³/s); one unit applies to every value column, so set the Discharge unit and convert the other columns before loading.')).toBeTruthy();
  });
});

describe('ingest-12 / units-09: the import unit choices match the README', () => {
  it('offers m³/day, ML/day, MGD and acre-ft/day besides m³/s, ft³/s, L/s and the depth units', async () => {
    render(<DataTab />);
    await uploadText('e.csv', `date,obs,sim${rows2}`);
    const opts = Array.from((screen.getByLabelText('Discharge unit') as HTMLSelectElement).options).map(o => o.value);
    expect(opts).toEqual(['m3s', 'cfs', 'ls', 'm3day', 'MLday', 'MGD', 'acftday', 'mm_step', 'in_day']);
  });
});

describe('ingest-01: an undecidable decimal comma is asked, not guessed', () => {
  it('shows the question, and the Decimal mark selector answers it', async () => {
    render(<DataTab />);
    await uploadText('f.csv', 'Datum;Abfluss;Modell\n01.01.2020;12,345;1\n02.01.2020;3,250;2\n13.01.2020;4,000;3');
    fireEvent.change(screen.getByLabelText('Role for column Datum'), { target: { value: 'date' } });
    fireEvent.change(screen.getByLabelText('Role for column Abfluss'), { target: { value: 'observed' } });
    fireEvent.change(screen.getByLabelText('Role for column Modell'), { target: { value: 'run' } });
    expect(screen.getByText(/Column “Abfluss” has values such as “12,345” that read as 12345 with a decimal point or 12.345 with a decimal comma/)).toBeTruthy();
    expect((screen.getByText('Use this data →') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Decimal mark'), { target: { value: 'comma' } });
    expect(screen.queryByText(/has values such as/)).toBeNull();
    expect((screen.getByText('Use this data →') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('SEC-WB: a large workbook asks the same large-table question as a large CSV', () => {
  const warnRows = LIMITS.warnRows;
  afterEach(() => { (LIMITS as { warnRows: number }).warnRows = warnRows; });

  it('asks before the table is shown; Cancel loads nothing, Continue loads it', async () => {
    (LIMITS as { warnRows: number }).warnRows = 20;              // a small table stands in for 250,000 rows
    const aoa: (string | number)[][] = [['date', 'obs', 'sim']];
    for (let i = 0; i < 30; i++) aoa.push([`2020-01-${String(i + 1).padStart(2, '0')}`, i, i + 1]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Data');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    render(<DataTab />);
    for (const cont of [false, true]) {
      await act(async () => { fireEvent.change(screen.getByLabelText('Upload CSV, TXT, TSV or XLSX data files'), { target: { files: [new File([buf], 'flows.xlsx')] } }); });
      const dlg = await screen.findByRole('dialog', {}, { timeout: 10000 });
      expect(dlg).toHaveAccessibleName('Large dataset');
      expect(dlg.textContent).toMatch(/This table has 30 rows and 3 columns\. Loading and mapping it will take roughly/);
      expect(screen.queryByText('Map columns')).toBeNull();
      fireEvent.click(within(dlg).getByRole('button', { name: cont ? 'Continue' : 'Cancel' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      if (!cont) expect(screen.queryByText('Map columns')).toBeNull();
      else expect(screen.getByText('Map columns')).toBeTruthy();
    }
  }, 30000);
});
