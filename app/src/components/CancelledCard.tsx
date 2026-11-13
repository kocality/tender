import { formatUsdc } from '../lib/format';
import type { Bid, Sale } from '../lib/views';

/**
 * What a Cancelled sale means for the bidders. The key label itself (never requested, or may be decryptable) is
 * rendered once by the sale card, and the request counter sits in the aside; this card adds the refund.
 */
export function CancelledCard({ sale, bids }: { sale: Sale; bids: Bid[] }) {
  if (sale.state !== 'Cancelled') return null;
  const total = bids.reduce((a, b) => a + b.escrow, 0n);
  const n = bids.length;
  return (
    <section className="card pad" aria-label="Cancelled">
      <h2>Every bid refunded in full</h2>
      <p>
        Every bid is refunded in full: {formatUsdc(total)} USDC across {n} {n === 1 ? 'bid' : 'bids'}, to each bidder&apos;s NEAR Intents account (transfers
        sent {sale.payoutsDone} of {sale.payoutsTotal}: one per bid, plus the seller&apos;s tokens back). <a href="#/withdraw">Withdraw</a> moves it to another
        chain; 1Click fees are not refunded.
      </p>
    </section>
  );
}
