import { NEAR_INTENTS, WITHDRAW_TESTNET, cancelledLabel } from '../copy';
import StatusMark from '../fx/StatusMark';
import { formatPrice, formatUsdc } from '../lib/format';
import type { Bid, Sale } from '../lib/views';
import { StatTile } from './StatTile';

/**
 * What a Cancelled sale means for the bidders: a large cross, three numbers read from the chain, and the refund (its
 * detail one click away). The pinned key label (never requested, or may be decryptable) is rendered once, in the fold.
 */
export function CancelledCard({ sale, bids }: { sale: Sale; bids: Bid[] }) {
  if (sale.state !== 'Cancelled') return null;
  const total = bids.reduce((a, b) => a + b.escrow, 0n);
  const n = bids.length;
  const label = cancelledLabel(sale.state, sale.keyRequests);
  return (
    <section className="card pad cancelled-card" aria-label="Cancelled">
      <div className="cancelled-top">
        <StatusMark status="failed" label={sale.keyRequests === 0 ? 'key never requested' : 'no key arrived'} size={30} fontSize={15} />
        <h2>Every bid refunded in full</h2>
      </div>
      <div className="stats">
        <StatTile value={formatPrice(sale.escrowTotal)} label="USDC deposited" />
        <StatTile value={String(sale.keyRequests)} label={sale.keyRequests === 1 ? 'key request' : 'key requests'} />
        {sale.payoutsTotal > 0 ? <StatTile value={`${Math.floor((sale.payoutsDone * 100) / sale.payoutsTotal)}%`} label="refunded" /> : null}
      </div>
      <details className="fold">
        <summary>Where the refunds went</summary>
        {label ? <p className="small">{label}</p> : null}
        <p className="small">
          Every bid is refunded in full: {formatUsdc(total)} USDC across {n} {n === 1 ? 'bid' : 'bids'}, to each bidder&apos;s {NEAR_INTENTS} account (transfers
          sent {sale.payoutsDone} of {sale.payoutsTotal}: one per bid, plus the seller&apos;s tokens back). {WITHDRAW_TESTNET ?? (
            <>
              <a href="#/withdraw">Withdraw</a> moves it to another chain; 1Click fees are not refunded.
            </>
          )}
        </p>
      </details>
    </section>
  );
}
