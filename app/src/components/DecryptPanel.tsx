import { useState } from 'react';
import { config } from '../config';
import { decryptSale, type DecryptResult } from '../lib/decrypt';
import { humanError } from '../lib/errors';
import { formatUsdc, shortId } from '../lib/format';
import type { Bid, Config, Sale } from '../lib/views';

const STATUS_TEXT = { ok: 'decrypted · commitment matches', invalid_ct: 'cannot be decrypted', cm_mismatch: 'commitment mismatch' } as const;

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

  const run = async () => {
    if (!cfg) return;
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
    <section className="card" style={{ marginTop: 16 }} aria-label="Decrypt">
      <h2 style={{ marginTop: 0 }}>Decrypt</h2>
      <p className="small muted">
        The sale key is public once released. Decryption happens in this browser; nothing you see here is sent anywhere.
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
      <button type="button" className="primary" onClick={run} disabled={!cfg || progress !== null || bids.length === 0}>
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
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>bidder</th>
                <th>price (USDC per lot)</th>
                <th>size (USDC)</th>
                <th>check</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.idx} className={r.status === 'ok' ? 'row-ok' : 'row-bad'}>
                  <td>{r.idx}</td>
                  <td className="mono">{shortId(byIdx.get(r.idx)?.bidder ?? '', 8, 6)}</td>
                  <td>{r.p !== undefined ? formatUsdc(r.p) : '–'}</td>
                  <td>{r.q !== undefined ? formatUsdc(r.q) : '–'}</td>
                  <td>
                    <span className={r.status === 'ok' ? 'pill ok' : 'pill bad'}>{STATUS_TEXT[r.status]}</span>
                    {r.status === 'cm_mismatch' ? <span className="small muted"> (copy of another bid or wrong signer)</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">
            {result.rows.filter((r) => r.status === 'ok').length} of {result.rows.length} bids decrypted with a matching commitment.
          </p>
        </div>
      ) : null}
    </section>
  );
}
