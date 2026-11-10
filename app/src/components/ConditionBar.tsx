import { formatUsdc } from '../lib/format';
import type { Sale } from '../lib/views';

function Meter({ value, max, met }: { value: bigint; max: bigint; met: boolean }) {
  const pct = max <= 0n ? 100 : Number(value >= max ? 100n : (value * 100n) / max);
  return (
    <div className={met ? 'bar met' : 'bar'} aria-hidden="true">
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Public open conditions of a sale: escrow against min_escrow and distinct bidders against min_bidders. */
export function ConditionBar({ sale }: { sale: Sale }) {
  const escrowMet = sale.escrowTotal >= sale.minEscrow;
  const biddersMet = sale.bidders >= sale.minBidders;
  return (
    <div>
      <div className="cond">
        <div className="row small">
          <span>
            escrow {formatUsdc(sale.escrowTotal)} / {formatUsdc(sale.minEscrow)} USDC min
          </span>
          <span className={escrowMet ? 'pill ok' : 'pill'}>{escrowMet ? 'met' : 'not met'}</span>
        </div>
        <Meter value={sale.escrowTotal} max={sale.minEscrow} met={escrowMet} />
      </div>
      <div className="cond">
        <div className="row small">
          <span>
            bidders {sale.bidders} / {sale.minBidders} min
          </span>
          <span className={biddersMet ? 'pill ok' : 'pill'}>{biddersMet ? 'met' : 'not met'}</span>
        </div>
        <Meter value={BigInt(sale.bidders)} max={BigInt(sale.minBidders)} met={biddersMet} />
      </div>
    </div>
  );
}
