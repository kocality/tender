import { useState } from 'react';
import { config } from '../config';
import { openCheckLine } from '../copy';
import { priceUnitLabel } from '../lib/amounts';
import { decryptSale, revealedWithoutCiphertext, type DecryptResult } from '../lib/decrypt';
import { humanError } from '../lib/errors';
import { formatUsdc, shortId, tokenSymbol } from '../lib/format';
import { summarizeCheck } from '../lib/openCheck';
import { useOverflowX } from '../lib/useOverflowX';
import type { Bid, Config, Sale } from '../lib/views';
import { originBadge } from '../copy';
import DecryptedText from '../fx/DecryptedText';
import StatusMark from '../fx/StatusMark';
import { ChainGlyph } from './ChainGlyph';

const STATUS_TEXT = { ok: 'decrypted · commitment matches', invalid_ct: 'cannot be decrypted', cm_mismatch: 'commitment mismatch', out_of_range: 'size outside 1..escrow' } as const;

/**
 * Decrypts every bid with the released sale key, in this browser, and checks each commitment. The sealed rows are on the
 * page from the start; each price decrypts in place when this browser has opened it (never before: a sealed cell draws
 * glyphs chosen by position only).
 */
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

  const [wrapRef, overflows] = useOverflowX<HTMLDivElement>();
  const rows = result?.keyOk ? new Map(result.rows.map((r) => [r.idx, r])) : null;
  const opened = summary ? summary.opened : 0;
  const mark = busy ? (['running', `decrypting ${progress.done} of ${progress.total}`] as const) : summary ? ([opened === summary.total ? 'done' : 'failed', `${opened} of ${summary.total} open and match`] as const) : (['pending', `${bids.length} to open here`] as const);
  return (
    <section className="card pad decrypt-panel" aria-label="Decrypt">
      <h2>Open the bids yourself</h2>
      <p className="small muted">The key is public. Your browser opens each bid and checks it against what its bidder stored.</p>
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
      <p className={overflows ? 'scroll-hint on small muted' : 'scroll-hint small muted'} aria-hidden="true">
        Scroll sideways for every column →
      </p>
      <div className="table-wrap" ref={wrapRef} style={{ marginTop: 12 }} tabIndex={0} role="region" aria-label="Bids; scrolls sideways on small screens">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>bidder</th>
              <th className="r">deposit (USDC)</th>
              <th className="r">{`price (${priceUnitLabel(tokenSymbol(sale.token), sale.lotExp)})`}</th>
              <th className="r">spends up to (USDC)</th>
              <th>check</th>
            </tr>
          </thead>
          <tbody>
            {bids.map((bid) => {
              const r = rows?.get(bid.idx);
              // A bid its owner revealed from their own copy: not a broken seal, the last-look case of the limits.
              const lastLook = r !== undefined && revealedWithoutCiphertext(bid, r);
              return (
                <tr key={bid.idx} className={!r ? undefined : r.status === 'ok' ? 'row-ok' : lastLook ? 'row-warn' : 'row-bad'}>
                  <td>{bid.idx}</td>
                  <td className="mono" title={bid.bidder}>
                    <span className="bidder-cell">
                      <ChainGlyph chain={bid.origin ?? ''} label={originBadge(bid.origin)} />
                      {shortId(bid.bidder)}
                    </span>
                  </td>
                  <td className="r mono">{formatUsdc(bid.escrow)}</td>
                  <td className="r">
                    {r && r.p === undefined ? '–' : <DecryptedText text={r?.p !== undefined ? formatUsdc(r.p) : ''} revealed={r !== undefined} sealedLabel="price not opened here yet" />}
                  </td>
                  <td className="r">
                    {r && r.q === undefined ? '–' : <DecryptedText text={r?.q !== undefined ? formatUsdc(r.q) : ''} revealed={r !== undefined} sealedLabel="size not opened here yet" />}
                  </td>
                  <td>
                    {!r ? (
                      <span className="muted small">not opened here yet</span>
                    ) : lastLook ? (
                      <span className="pill warn pill-block">{r.status === 'ok' ? 'opens to a different bid than the one revealed' : "does not open · revealed from the owner's copy"}</span>
                    ) : (
                      <span className={r.status === 'ok' ? 'pill ok pill-block' : 'pill bad pill-block'}>{STATUS_TEXT[r.status]}</span>
                    )}
                    {r?.status === 'cm_mismatch' && !lastLook ? <span className="small muted"> (copy of another bid or wrong signer)</span> : null}
                    {r?.status === 'out_of_range' && !lastLook ? <span className="small muted"> (the contract refuses to reveal it)</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="decrypt-actions">
        <button type="button" className="primary" onClick={run} disabled={unable} aria-disabled={busy || undefined}>
          {progress ? `Decrypting ${progress.done} / ${progress.total}…` : 'Decrypt all bids in this browser'}
        </button>
        <StatusMark status={mark[0]} label={mark[1]} size={18} fontSize={13} />
      </div>
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
      <details className="fold">
        <summary>What this checks</summary>
        <p className="small">
          The sale key is public once released. This page opens every bid on your machine and checks each one against the commitment its bidder stored when
          the bid was sealed. Nothing you see here is sent anywhere.
        </p>
      </details>
    </section>
  );
}
