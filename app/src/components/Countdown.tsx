import { formatCountdown, formatNsUtc } from '../lib/format';

/** Time to close on chain time. `nowNs` comes from `useChainClock()`. */
export function Countdown({ closeNs, nowNs, label }: { closeNs: bigint; nowNs: bigint; label?: string }) {
  const remaining = closeNs - nowNs;
  return (
    <div>
      {label ? <div className="small muted">{label}</div> : null}
      <div className="countdown" aria-live="off">
        {remaining > 0n ? formatCountdown(remaining) : 'closed'}
      </div>
      <div className="small muted">closes {formatNsUtc(closeNs)}</div>
    </div>
  );
}
