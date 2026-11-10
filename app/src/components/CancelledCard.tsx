import { formatUsdc } from '../lib/format';
import type { Bid, Sale } from '../lib/views';

/**
 * What a Cancelled sale means for the bidders. The key label itself (never requested, or may be decryptable) is
 * rendered once by the sale card; this card adds the refund and the request counter.
 */
export function CancelledCard({ sale, bids }: { sale: Sale; bids: Bid[] }) {
  if (sale.state !== 'Cancelled') return null;
  const total = bids.reduce((a, b) => a + b.escrow, 0n);
  return (
    <section className="card" style={{ marginTop: 16 }} aria-label="Cancelled">
      <h2 style={{ marginTop: 0 }}>Cancelled</h2>
      <p>
        Every bid is refunded in full: {formatUsdc(total)} USDC across {bids.length} bids (refunds sent {sale.payoutsDone} / {sale.payoutsTotal}).
      </p>
      <p className="small">
        key requests: <strong>{sale.keyRequests}</strong> · <a href="#/keys">Key ledger</a>
      </p>
    </section>
  );
}
