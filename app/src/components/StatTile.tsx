import { RollingNumber } from './RollingNumber';

/** One number read from the chain, with its label: its digits rise when it first shows and when a read changes it (RollingNumber). */
export function StatTile({ value, label, unit, glow = false, exact }: { value: string; label: string; unit?: string; glow?: boolean; /** The unrounded value, on hover. */ exact?: string }) {
  // A rounded value says so on its face (≈), not only in the hover title phones and keyboards never see.
  const trimmed = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  const approx = exact !== undefined && exact !== trimmed;
  return (
    <div className={glow ? 'stat glow' : 'stat'}>
      <span className="n" title={exact}>
        {approx ? <span className="approx">≈</span> : null}
        <RollingNumber value={value} />
        {unit ? <span className="u">{` ${unit}`}</span> : null}
      </span>
      <span className="l">{label}</span>
    </div>
  );
}
