import { useState } from 'react';
import { config } from '../config';
import { openCheckLine } from '../copy';
import { priceUnitLabel } from '../lib/amounts';
import { decryptSale, revealedWithoutCiphertext, type DecryptResult } from '../lib/decrypt';
import { humanError } from '../lib/errors';
import { formatUsdc, shortId, tokenSymbol } from '../lib/format';
import { summarizeCheck } from '../lib/openCheck';
import type { Bid, Config, Sale } from '../lib/views';

const STATUS_TEXT = { ok: 'decrypted · commitment matches', invalid_ct: 'cannot be decrypted', cm_mismatch: 'commitment mismatch', out_of_range: 'size outside 1..escrow' } as const;

/** Decrypts every bid with the released sale key, in this browser, and checks each commitment. */
export function DecryptPanel({
  sale,
  bids,
  cfg,
  cfgError = null,
  onRetryCfg,
  result,
  onResult,
}: {
  sale: Sale;
  bids: Bid[];
  cfg: Config | null;
  cfgError?: string | null;
  onRetryCfg?: () => void;
  result: DecryptResult | null;
  onResult: (r: DecryptResult) => void;
}) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const byIdx = new Map(bids.map((b) => [b.idx, b]));
  const busy = progress !== null;
  const unable = !cfg || bids.length === 0;
  const summary = result ? summarizeCheck(bids, result) : null;

  const run = async () => {
    // aria-disabled, not disabled: the button keeps keyboard focus while it works, so focus is not dropped to the page.
    if (!cfg || busy) return;
    setError(null);
    setProgress({ done: 0, total: bids.length });
    try {
      onResult(
        await decryptSale({ config: cfg, sale, bids, contractId: config.tenderContractId, onProgress: (done, total) => setProgress({ done, total }) }),
      );
    } catch (e) {
      setError(humanError(e));
    } finally {
      setProgress(null);
    }
  };

  return (
    <section className="card pad" aria-label="Decrypt">
      <h2>Open the bids yourself</h2>
      <p className="small muted">
        The sale key is public once released. This page opens every bid on your machine and checks each one against the commitment its bidder stored
        when the bid was sealed. Nothing you see here is sent anywhere.
      </p>
      {!cfg && cfgError ? (
        <p className="note" role="status">
          Config not loaded: reading the contract config failed, so bids cannot be decrypted yet.{' '}
          {onRetryCfg ? (
            <button type="button" onClick={onRetryCfg}>
              Retry
            </button>
          ) : null}
        </p>
      ) : null}
      <button type="button" className="primary" onClick={run} disabled={unable} aria-disabled={busy || undefined}>
        {progress ? `Decrypting ${progress.done} / ${progress.total}…` : 'Decrypt all bids in this browser'}
      </button>
      {progress ? <progress value={progress.done} max={progress.total} aria-label="Decryption progress" /> : null}
      {error ? (
        <p className="result bad" role="alert">
          {error}
        </p>
      ) : null}
      {result && !result.keyOk ? (
        <p className="result bad" role="alert">
          {result.keyError ?? 'Key check failed'}. Reveal stays disabled.
        </p>
      ) : null}
      {result?.keyOk ? (
        <>
          <p className="scroll-hint small muted" aria-hidden="true">
            Scroll sideways for every column →
          </p>
          <div className="table-wrap" style={{ marginTop: 12 }} tabIndex={0} role="region" aria-label="Decrypted bids; scrolls sideways on small screens">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>bidder</th>
                  <th>{`price (${priceUnitLabel(tokenSymbol(sale.token), sale.lotExp)})`}</th>
                  <th>spends up to (USDC)</th>
                  <th>check</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => {
                  const bid = byIdx.get(r.idx);
                  // A bid its owner revealed from their own copy: not a broken seal, the last-look case of the limits.
                  const lastLook = bid !== undefined && revealedWithoutCiphertext(bid, r);
                  return (
                    <tr key={r.idx} className={r.status === 'ok' ? 'row-ok' : lastLook ? 'row-warn' : 'row-bad'}>
                      <td>{r.idx}</td>
                      <td className="mono" title={bid?.bidder}>
                        {shortId(bid?.bidder ?? '')}
                      </td>
                      <td>{r.p !== undefined ? formatUsdc(r.p) : '–'}</td>
                      <td>{r.q !== undefined ? formatUsdc(r.q) : '–'}</td>
                      <td>
                        {lastLook ? (
                          <span className="pill warn pill-block">{r.status === 'ok' ? 'opens to a different bid than the one revealed' : "does not open · revealed from the owner's copy"}</span>
                        ) : (
                          <span className={r.status === 'ok' ? 'pill ok pill-block' : 'pill bad pill-block'}>{STATUS_TEXT[r.status]}</span>
                        )}
                        {r.status === 'cm_mismatch' && !lastLook ? <span className="small muted"> (copy of another bid or wrong signer)</span> : null}
                        {r.status === 'out_of_range' && !lastLook ? <span className="small muted"> (the contract refuses to reveal it)</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      <div role="status">
        {summary ? (
          <p className="small muted">
            {openCheckLine(summary)}
            {summary.lastLook.length > 0 ? (
              <>
                {' '}
                <a href="#/trust">Who can see your bid, and the limits</a>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    </section>
  );
}
