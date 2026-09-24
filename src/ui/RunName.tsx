/** A simulation's name with its plot colour as a small swatch in front. The
 *  name keeps the text colour: as text, several run colours (orange, yellow)
 *  fail the 4.5:1 contrast of WCAG 1.4.3 on the table backgrounds. */
export function RunName({ name, color }: { name: string; color: string }) {
  return <><span className="swatch" style={{ background: color }} aria-hidden="true" />{name}</>;
}
