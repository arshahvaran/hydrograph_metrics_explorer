import { useEffect, useState, type CSSProperties } from 'react'

export interface NumFieldProps {
  value: number;
  onCommit: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  integer?: boolean;
  /** Human name used in the clamp note ("Peak window"). */
  label: string;
  /** Unit word for the whole-number note ("steps" gives "must be a whole
   *  number of steps"); without it the note ends at "whole number". */
  unit?: string;
  /** Called with a sentence when a typed value had to be changed, saying
   *  what happened (`kind`: clamped to the range, or rounded to a whole
   *  number), and with null when a later value commits cleanly (so a shown
   *  note can clear). */
  onClamp?: (note: string | null, kind?: 'range' | 'rounded') => void;
  style?: CSSProperties;
  'aria-label'?: string;
  disabled?: boolean;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6))));

/**
 * A number box that validates at the control. It keeps its own text while
 * the user types (so a field can be cleared and retyped, which a store-bound
 * value never allowed), commits only finite numbers, rounds integers, and
 * clamps to [min, max]; each correction comes with a note that says which
 * one happened, for the caller to show. Non-numeric input (a lone minus, an
 * empty box) leaves the stored value untouched.
 */
export function NumField({ value, onCommit, min, max, step, integer, label, unit, onClamp, style, disabled, ...rest }: NumFieldProps) {
  const [text, setText] = useState(fmt(value));
  useEffect(() => {
    // an outside change (defaults switch, unit conversion, project load) refreshes the box
    setText(t => (Number(t) === value && t.trim() !== '' ? t : fmt(value)));
  }, [value]);
  return (
    <input type="number" value={text} min={min} max={Number.isFinite(max) ? max : undefined} step={step} style={style} disabled={disabled}
      aria-label={rest['aria-label']}
      onChange={e => {
        const raw = e.target.value;
        setText(raw);
        if (raw.trim() === '') return;
        const n = Number(raw);
        if (!Number.isFinite(n)) return;
        const x = integer ? Math.round(n) : n;
        const c = Math.min(max, Math.max(min, x));
        if (c !== x) {
          const range = Number.isFinite(max) ? `${fmt(min)} to ${fmt(max)}` : `at least ${fmt(min)}`;
          onClamp?.(`${label} is limited to ${range}; the value was set to ${fmt(c)}.`, 'range');
        } else if (x !== n) {
          onClamp?.(`${label} must be a whole number${unit ? ` of ${unit}` : ''}; ${fmt(n)} was rounded to ${fmt(c)}.`, 'rounded');
        } else onClamp?.(null);
        if (c !== value) onCommit(c);
      }}
      onBlur={() => { if (text.trim() === '' || Number(text) !== value) setText(fmt(value)); }} />
  );
}
