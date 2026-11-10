import { useState } from 'react';
import { openConditions } from '../lib/conditions';
import { cancelSale, openSale } from '../lib/near-tx';
import type { Sale } from '../lib/views';
import { walletErrorMessage } from '../wallets/types';
import { ensureNear } from '../wallets/near';
import { BlockLink, TxLink } from './TxLink';

/**
 * Open and Cancel for anyone with a NEAR wallet. The buttons follow chain time and the public open conditions; the
 * contract re-checks everything, so a stale button can only produce a refused call.
 */
export function OpenPanel({ sale, nowNs, keyRequestBlock }: { sale: Sale; nowNs: bigint; keyRequestBlock?: bigint | null }) {
  const [busy, setBusy] = useState<'open' | 'cancel' | null>(null);
  const [tx, setTx] = useState<{ kind: 'open' | 'cancel'; hash: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cond = openConditions(sale, nowNs);

  const run = async (kind: 'open' | 'cancel') => {
    setBusy(kind);
    setError(null);
    try {
      await ensureNear();
      const hash = await (kind === 'open' ? openSale(sale.id) : cancelSale(sale.id));
      setTx({ kind, hash });
    } catch (e) {
      setError(walletErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const key = sale.key;
  return (
    <div className="actions" aria-label="Open and cancel">
      {key ? (
        <p className="result ok" role="status">
          Key released at block <BlockLink block={key.block.toString()} />
          {keyRequestBlock != null ? ` (+${key.block - keyRequestBlock} blocks after the request)` : ''}
        </p>
      ) : null}
      {sale.state === 'Opening' || (sale.inFlight && !key) ? (
        <p className="result warn" role="status">
          Request in flight: waiting for NEAR&apos;s MPC network to answer.
        </p>
      ) : null}
      {cond.canOpen ? (
        <button type="button" className="primary" onClick={() => run('open')} disabled={busy !== null} aria-label={busy === 'open' ? undefined : `Open (anyone), sale ${sale.id}`}>
          {busy === 'open' ? 'Waiting for wallet…' : 'Open (anyone)'}
        </button>
      ) : null}
      {cond.canCancel ? (
        <button type="button" onClick={() => run('cancel')} disabled={busy !== null} aria-label={busy === 'cancel' ? undefined : `Cancel (anyone), sale ${sale.id}`}>
          {busy === 'cancel' ? 'Waiting for wallet…' : 'Cancel (anyone)'}
        </button>
      ) : null}
      {cond.canCancel && cond.cancelReason === 'no_key_after_24h' ? (
        <p className="small muted">More than 24 hours after close with no key and no request in flight.</p>
      ) : null}
      <div role="status">
        {tx ? (
          <p className="small" style={{ margin: 0 }}>
            {tx.kind === 'open' ? 'Open submitted' : 'Cancel submitted'}
            {tx.hash ? (
              <>
                {' '}
                · transaction <TxLink hash={tx.hash} />
              </>
            ) : null}
            . The page follows the sale state every few seconds.
          </p>
        ) : null}
      </div>
      {error ? (
        <p className="result bad" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
