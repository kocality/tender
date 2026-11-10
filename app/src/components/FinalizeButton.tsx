import { useState } from 'react';
import { finalizeSale } from '../lib/near-tx';
import { ensureNear } from '../wallets/near';
import { walletErrorMessage } from '../wallets/types';
import { TxLink } from './TxLink';

/** `finalize` is open to anyone: it settles a Keyed sale once its reveal window is over and pays out the next 8 items. */
export function FinalizeButton({ saleId }: { saleId: string }) {
  const [busy, setBusy] = useState(false);
  const [hash, setHash] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await ensureNear();
      setHash(await finalizeSale(saleId));
    } catch (e) {
      setError(walletErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="actions">
      <button type="button" className="primary" onClick={() => void run()} disabled={busy}>
        {busy ? 'Waiting for wallet…' : 'Finalize (anyone)'}
      </button>
      <div role="status">
        {hash !== undefined ? (
          <p className="small">
            Finalize submitted{hash ? <> · transaction <TxLink hash={hash} /></> : null}. The page follows the sale state every few seconds.
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
