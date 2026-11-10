import { useEffect, useState } from 'react';
import { connectEvm } from '../wallets/evm';
import { connectNear, nearReady } from '../wallets/near';
import { connectPhantom } from '../wallets/phantom';
import { walletErrorMessage, type IntentSigner } from '../wallets/types';

/** Connects one of the three wallet kinds. A connection only reads the account; nothing is signed here. */
export function WalletPicker({ signer, onConnect }: { signer: IntentSigner | null; onConnect: (s: IntentSigner) => void }) {
  const [evmOrigin, setEvmOrigin] = useState<'base' | 'arb'>('base');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nearState, setNearState] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  useEffect(() => {
    let alive = true;
    nearReady().then(
      () => alive && setNearState('ready'),
      () => alive && setNearState('unavailable'),
    );
    return () => {
      alive = false;
    };
  }, []);

  const run = async (kind: string, connect: () => Promise<IntentSigner>) => {
    setBusy(kind);
    setError(null);
    try {
      onConnect(await connect());
    } catch (e) {
      setError(walletErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="row">
        <button type="button" disabled={busy !== null} onClick={() => run('evm', () => connectEvm(evmOrigin))}>
          {busy === 'evm' ? 'Waiting for wallet…' : 'MetaMask'}
        </button>
        <label className="small">
          Funds come from{' '}
          <select value={evmOrigin} onChange={(e) => setEvmOrigin(e.target.value as 'base' | 'arb')}>
            <option value="base">Base</option>
            <option value="arb">Arbitrum</option>
          </select>
        </label>
        <button type="button" disabled={busy !== null} onClick={() => run('phantom', connectPhantom)}>
          {busy === 'phantom' ? 'Waiting for wallet…' : 'Phantom (Solana)'}
        </button>
        <button type="button" disabled={busy !== null || nearState !== 'ready'} onClick={() => run('near', connectNear)}>
          {busy === 'near' ? 'Waiting for wallet…' : nearState === 'loading' ? 'Loading wallets…' : nearState === 'unavailable' ? 'NEAR wallets unavailable' : 'NEAR wallet'}
        </button>
      </div>
      {signer ? (
        <p className="small" style={{ margin: '8px 0 0' }}>
          Your NEAR Intents account: <span className="mono">{signer.signerId}</span>
        </p>
      ) : null}
      {error ? (
        <p className="result bad" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
