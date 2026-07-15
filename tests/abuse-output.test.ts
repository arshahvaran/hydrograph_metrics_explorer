/** QA output and project-file abuse. Guards QA-007 (hostile/legacy/broken
 *  project files) and QA-008 (CSV formula injection + quoting). */
import { describe, it, expect } from 'vitest'
import { csvCell, csvLine } from '../src/ui/format'
import { parseProjectFile } from '../src/store/projectLoad'
import { serialiseProject, useApp } from '../src/store/store'
import { stage, parseDelimited } from '../src/ingest/ingest'

describe('QA-008 CSV hardening', () => {
  it('prefixes formula-starting strings with an apostrophe', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe("'=HYPERLINK(\"\"http://evil\"\")".replace("'=", "\"'=") + '"');
    // simpler, structural assertions:
    expect(csvCell('=1+2')).toMatch(/^'=/);
    expect(csvCell('+cmd')).toMatch(/^'\+/);
    expect(csvCell('@ref')).toMatch(/^'@/);
    expect(csvCell('-danger')).toMatch(/^'-/);
  });
  it('leaves numbers and numeric-looking strings intact (negatives stay numeric)', () => {
    expect(csvCell(-3.5)).toBe('-3.5');
    expect(csvCell('-3.5')).toBe('-3.5');
    expect(csvCell('+2e-3')).toBe('+2e-3');
    expect(csvCell('  -7 ')).toBe('  -7 ');
  });
  it('quotes cells containing separators, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('tab\tsep', '\t')).toMatch(/^"/);
    expect(csvCell('a,b', '\t')).toBe('a,b'); // comma is safe when tab-separated
  });
  it('csvLine composes cells and survives a hostile header row', () => {
    const line = csvLine(['metric', '=SUM(A1:A9)', 'model,two'], ',');
    expect(line.split(',').length).toBe(4); // quoted comma keeps 3 logical cells (one contains a comma)
    expect(line).toContain("'=SUM");
    expect(line).toContain('"model,two"');
  });
});

describe('QA-007 project-file loading', () => {
  const validProjectJson = () => {
    useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
    const rows = ['date,observed,m1,m2'];
    for (let i = 0; i < 30; i++) rows.push(`${new Date(Date.UTC(2002, 0, 1) + i * 864e5).toISOString().slice(0, 10)},${5 + Math.sin(i / 3)},${5 + Math.sin((i - 1) / 3)},${4.4 + Math.sin(i / 3)}`);
    useApp.getState().commitDataset(stage(parseDelimited(rows.join('\n')), { name: 'rt', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run', 'run'] }).commit!);
    return serialiseProject(useApp.getState().project);
  };

  it('truncated JSON → friendly error, no crash', () => {
    const txt = validProjectJson().slice(0, 120);
    expect(() => parseProjectFile(txt)).toThrow(/not valid JSON|truncated/i);
  });
  it('valid JSON, wrong shape → friendly error', () => {
    expect(() => parseProjectFile('{"foo":1}')).toThrow(/schema|project/i);
    expect(() => parseProjectFile('{"schemaVersion":2,"datasets":[]}')).toThrow(/schemaVersion 1|Unsupported/i);
    expect(() => parseProjectFile('{"schemaVersion":1,"datasets":"nope"}')).toThrow(/datasets/i);
  });
  it('hostile __proto__ payload cannot pollute and unknown keys are dropped', () => {
    const evil = `{"schemaVersion":1,"activeDatasetId":null,"__proto__":{"polluted":true},
      "datasets":[{"name":"x","__proto__":{"polluted":true},"evilKey":1,
        "dates":[1,2,3],"observed":{"name":"o","values":[1,2,3]},
        "runs":[{"name":"r","values":[1,2,3]}]}]}`;
    const { project } = parseProjectFile(evil);
    expect(({} as any).polluted).toBeUndefined();
    expect((project as any).evilKey).toBeUndefined();
    expect((project.datasets[0] as any).evilKey).toBeUndefined();
    expect(project.datasets[0].runs[0].values.length).toBe(3);
  });
  it('legacy project missing newer fields loads with defaults (forward compat)', () => {
    const legacy = `{"schemaVersion":1,"activeDatasetId":null,"datasets":[{
      "name":"old","dates":[86400000,172800000,259200000,345600000],
      "observed":{"name":"obs","values":[1,2,3,4]},
      "runs":[{"name":"r1","values":[1.1,2.1,2.9,4.2]}]}]}`;
    const { project } = parseProjectFile(legacy);
    const ds = project.datasets[0];
    expect(ds.view.showBootstrapCIs).toBe(false);
    expect(ds.view.priorityMetrics.length).toBeGreaterThan(0);
    expect(ds.runs[0].color).toMatch(/^#/);
    expect(ds.view.activeTab).toBeDefined();
  });
  it('unsorted dates inside the file are re-sorted through the commit path', () => {
    const shuffled = `{"schemaVersion":1,"activeDatasetId":null,"datasets":[{
      "name":"sh","dates":[259200000,86400000,345600000,172800000],
      "observed":{"name":"o","values":[3,1,4,2]},
      "runs":[{"name":"r","values":[30,10,40,20]}]}]}`;
    const { project } = parseProjectFile(shuffled);
    expect(project.datasets[0].dates).toEqual([86400000, 172800000, 259200000, 345600000]);
    expect(Array.from(project.datasets[0].observed.values as number[])).toEqual([1, 2, 3, 4]);
    expect(Array.from(project.datasets[0].runs[0].values as number[])).toEqual([10, 20, 30, 40]);
  });
  it('one broken dataset is skipped with a warning; valid siblings still load', () => {
    const mixed = `{"schemaVersion":1,"activeDatasetId":null,"datasets":[
      {"name":"bad","dates":[1,2,3],"observed":{"name":"o","values":[1,2]},"runs":[{"name":"r","values":[1,2,3]}]},
      {"name":"good","dates":[86400000,172800000,259200000],"observed":{"name":"o","values":[1,2,3]},"runs":[{"name":"r","values":[1,2,3]}]}]}`;
    const { project, warnings } = parseProjectFile(mixed);
    expect(project.datasets.length).toBe(1);
    expect(project.datasets[0].name).toBe('good');
    expect(warnings.join(' ')).toMatch(/bad/);
  });
  it('round-trip: serialise → parse preserves data and view', () => {
    const json = validProjectJson();
    const before = useApp.getState().project;
    const { project: after } = parseProjectFile(json);
    expect(after.datasets.length).toBe(before.datasets.length);
    expect(after.datasets[0].dates).toEqual(before.datasets[0].dates);
    expect(Array.from(after.datasets[0].observed.values as number[]))
      .toEqual(Array.from(before.datasets[0].observed.values as number[]));
    expect(after.datasets[0].view.transform).toBe(before.datasets[0].view.transform);
  });
});
