import { priceUnitLabel } from '../lib/amounts';
import { formatUnits, formatUsdc, shortId, tokenLabel } from '../lib/format';
import { refundOf, type Recomputed } from '../lib/results';
import type { Bid, Sale, SaleResult } from '../lib/views';

function isMarginal(b: Bid, pStar: bigint | null): boolean {
  return pStar !== null && b.p === pStar && b.alloc > 0n && b.q !== null && b.spend < b.q;
}

/** The finalized sale: one clearing price, what every bidder got and paid, and whether this browser recomputed the same. */
export function ResultTable({ sale, bids, result, recomputed }: { sale: Sale; bids: Bid[]; result: SaleResult; recomputed: Recomputed | null }) {
  const name = tokenLabel(sale.token);
  const tok = (v: bigint) => formatUnits(v, sale.decimals);
  return (
    <section className="card" style={{ marginTop: 16 }} aria-label="Result">
      <h2 style={{ marginTop: 0 }}>Result</h2>
      {result.pStar === null ? (
        <p>
          <strong>No bid cleared.</strong> Every bid is refunded{result.penaltyPool > 0n ? ' (unrevealed bids less the 10% penalty)' : ''}.
        </p>
      ) : (
        <p>
          Clearing price <strong data-testid="pstar-value">{formatUsdc(result.pStar)}</strong> {priceUnitLabel(name, sale.lotExp)} · sold {tok(result.sold)} {name} · seller
          receives {formatUsdc(result.sellerUsdc)} USDC · {tok(result.sellerTokensBack)} {name} returned to the seller
        </p>
      )}
      {recomputed ? (
        recomputed.match ? (
          <p className="result ok">Recomputed in your browser: match</p>
        ) : (
          <div className="result bad" role="alert">
            Recomputed in your browser: the result differs from the contract&apos;s.
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>field</th>
                    <th>contract</th>
                    <th>recomputed</th>
                  </tr>
                </thead>
                <tbody>
                  {recomputed.diffs.map((d) => (
                    <tr key={d.field}>
                      <td>{d.field}</td>
                      <td className="mono">{d.onChain}</td>
                      <td className="mono">{d.recomputed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      ) : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>bidder</th>
              <th>price</th>
              <th>size</th>
              <th>tokens</th>
              <th>spent</th>
              <th>refund</th>
              <th>penalty share</th>
              <th>payout</th>
            </tr>
          </thead>
          <tbody>
            {bids.map((b) => (
              <tr key={b.idx} className={b.alloc > 0n && b.p === result.pStar ? 'row-pstar' : undefined}>
                <td>{b.idx}</td>
                <td className="mono">{shortId(b.bidder, 8, 6)}</td>
                <td>{b.p !== null ? formatUsdc(b.p) : <span className="muted">{b.state === 'Revealed' ? '–' : 'not revealed'}</span>}</td>
                <td>{b.q !== null ? formatUsdc(b.q) : '–'}</td>
                <td>
                  {tok(b.alloc)}
                  {isMarginal(b, result.pStar) ? <span className="pill warn"> marginal · pro rata</span> : null}
                </td>
                <td>{formatUsdc(b.spend)}</td>
                <td>{formatUsdc(refundOf(b))}</td>
                <td>{b.penaltyShare > 0n ? formatUsdc(b.penaltyShare) : b.penalty > 0n ? `−${formatUsdc(b.penalty)}` : '0'}</td>
                <td>{b.paid?.ok ? <span className="pill ok">paid</span> : <span className="pill">pending</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        payouts {sale.payoutsDone} / {sale.payoutsTotal} · penalty pool {formatUsdc(result.penaltyPool)} USDC (to revealed bidders, never to the seller)
      </p>
    </section>
  );
}
