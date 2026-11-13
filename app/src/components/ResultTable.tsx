import { priceUnitLabel } from '../lib/amounts';
import { revealedWithoutCiphertext, type DecryptResult } from '../lib/decrypt';
import { formatPrice, formatUnits, formatUsdc, shortId, tokenSymbol } from '../lib/format';
import { refundOf, type Recomputed } from '../lib/results';
import type { Bid, Sale, SaleResult } from '../lib/views';

function isMarginal(b: Bid, pStar: bigint | null): boolean {
  return pStar !== null && b.p === pStar && b.alloc > 0n && b.q !== null && b.spend < b.q;
}

/** The finalized sale: one clearing price, what every bidder got and paid, and whether this browser recomputed the same. */
export function ResultTable({
  sale,
  bids,
  result,
  recomputed,
  decrypted = null,
}: {
  sale: Sale;
  bids: Bid[];
  result: SaleResult;
  recomputed: Recomputed | null;
  /** The browser's decryption of the ciphertexts, when the visitor has run it: used to mark revealed bids whose ciphertext does not open to what was revealed. */
  decrypted?: DecryptResult | null;
}) {
  const name = tokenSymbol(sale.token);
  const rows = new Map(decrypted?.keyOk ? decrypted.rows.map((r) => [r.idx, r]) : []);
  const lastLook = bids.filter((b) => revealedWithoutCiphertext(b, rows.get(b.idx)));
  const tok = (v: bigint) => formatUnits(v, sale.decimals);
  return (
    <section className="card pad" aria-label="Result">
      <h2>Who got what</h2>
      {result.pStar === null ? (
        <p>
          <strong>No bid cleared.</strong> Every bid is refunded{result.penaltyPool > 0n ? ' (unrevealed bids less the 10% penalty)' : ''}.
        </p>
      ) : (
        <p>
          Every winner paid <strong data-testid="pstar-value">{formatPrice(result.pStar)}</strong> {priceUnitLabel(name, sale.lotExp)} · sold {tok(result.sold)} {name} · seller
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
      <p className="scroll-hint small muted" aria-hidden="true">
        Scroll sideways for every column →
      </p>
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Who got what, per bid; scrolls sideways on small screens">
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
              <th>penalty</th>
              <th>payout</th>
            </tr>
          </thead>
          <tbody>
            {bids.map((b) => (
              <tr key={b.idx} className={b.alloc > 0n && b.p === result.pStar ? 'row-pstar' : undefined}>
                <td>
                  {b.idx}
                  {b.alloc > 0n && b.p === result.pStar ? <span className="sr-only"> (bid at the clearing price P*)</span> : null}
                </td>
                <td className="mono" title={b.bidder}>
                  {shortId(b.bidder, 8, 6)}
                  {lastLook.includes(b) ? <span className="pill warn pill-block">ciphertext does not open to the revealed bid</span> : null}
                </td>
                <td className="num">{b.p !== null ? formatPrice(b.p) : <span className="muted">{b.state === 'Revealed' ? '–' : 'not revealed'}</span>}</td>
                <td className="num">{b.q !== null ? formatUsdc(b.q) : '–'}</td>
                <td className="num">
                  {tok(b.alloc)}
                  {isMarginal(b, result.pStar) ? <span className="pill pill-block">marginal · pro rata</span> : null}
                </td>
                <td className="num">{formatUsdc(b.spend)}</td>
                <td className="num">{formatUsdc(refundOf(b))}</td>
                <td className="num">{b.penaltyShare > 0n ? formatUsdc(b.penaltyShare) : b.penalty > 0n ? `−${formatUsdc(b.penalty)}` : '0'}</td>
                <td>{b.paid?.ok ? <span className="pill ok">paid</span> : <span className="pill">pending</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lastLook.length > 0 ? (
        <p className="note" role="note">
          Bid{lastLook.length === 1 ? '' : 's'} {lastLook.map((b) => `#${b.idx}`).join(', ')} {lastLook.length === 1 ? 'was' : 'were'} revealed from the opening alone: the ciphertext on chain does not open to the revealed price and size. Its owner could wait for the key
          to make every other bid public and then choose whether to reveal (a last look); an unrevealed bid costs 10% of its escrow.
        </p>
      ) : null}
      {bids.some((b) => isMarginal(b, result.pStar)) ? (
        <p className="small muted">
          <strong>marginal · pro rata</strong>: the bid was at the final price, so the tokens left at that price were shared between such bids in proportion to
          their size.
        </p>
      ) : null}
      <p className="small muted">
        payouts {sale.payoutsDone} / {sale.payoutsTotal} · penalty pool {formatUsdc(result.penaltyPool)} USDC (stays in the contract&apos;s Intents balance; no Tender method pays it out)
      </p>
    </section>
  );
}
