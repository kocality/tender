import { useEffect, useState, type ReactNode } from 'react';
import { payloadString, simulateIntents, type MultiPayload } from '@tender/intents';
import { CopyButton } from '../components/CopyButton';
import { HonestNote } from '../components/HonestNote';
import { StatusPill } from '../components/StatusPill';
import { config } from '../config';
import { buildTryBid, liveQuoteToken } from '../lib/bidPayload';
import { interpretSimulation, type TryOutcome } from '../lib/tryResult';
import { connectEvm } from '../wallets/evm';
import { connectNear, nearReady } from '../wallets/near';
import { connectPhantom } from '../wallets/phantom';
import { walletErrorMessage, type IntentSigner } from '../wallets/types';

type Kind = 'evm' | 'phantom' | 'near';

interface CardState {
  busy: boolean;
  signerId?: string;
  outcome?: TryOutcome;
  error?: string;
  signed?: MultiPayload;
  signedString?: string;
}

const IDLE: CardState = { busy: false };

export function Try() {
  const [cards, setCards] = useState<Record<Kind, CardState>>({ evm: IDLE, phantom: IDLE, near: IDLE });
  const [evmOrigin, setEvmOrigin] = useState<'base' | 'arb'>('base');
  const [nearLoading, setNearLoading] = useState(true);
  const [nearUnavailable, setNearUnavailable] = useState(false);

  useEffect(() => {
    let alive = true;
    nearReady().then(
      () => alive && setNearLoading(false),
      () => {
        if (!alive) return;
        setNearLoading(false);
        setNearUnavailable(true);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const patch = (kind: Kind, next: CardState) => setCards((c) => ({ ...c, [kind]: next }));

  // Runs only from a click handler: a signature request must never be fired by an effect (StrictMode runs effects twice).
  const run = async (kind: Kind) => {
    patch(kind, { busy: true });
    try {
      const signer: IntentSigner =
        kind === 'evm' ? await connectEvm(evmOrigin) : kind === 'phantom' ? await connectPhantom() : await connectNear();
      patch(kind, { busy: true, signerId: signer.signerId });
      const quoteToken = await liveQuoteToken();
      const payload = await buildTryBid({ signerId: signer.signerId, receiverId: config.tryReceiver, quoteToken, origin: signer.origin });
      const signed = await signer.sign(payload);
      const sim = await simulateIntents(config.rpcUrls, config.intentsContractId, [signed]);
      patch(kind, {
        busy: false,
        signerId: signer.signerId,
        outcome: interpretSimulation(sim),
        signed,
        signedString: payloadString(payload),
      });
    } catch (e) {
      patch(kind, { busy: false, error: walletErrorMessage(e) });
    }
  };

  return (
    <div>
      <h1>Try signing (free)</h1>
      <p className="muted">
        Sign a real bid payload with your own wallet and ask <code>{config.intentsContractId}</code> to check it with{' '}
        <code>simulate_intents</code>. The ciphertext is random, the receiver is <code className="mono">{config.tryReceiver}</code>, nothing is
        sent to any relayer and no funds move.
      </p>
      <HonestNote>
        A valid signature on an account with no funds ends in &quot;insufficient balance&quot;. That is the expected result: it shows the
        signature was accepted before the balance check.
      </HonestNote>
      <div className="grid-2" style={{ marginTop: 16 }}>
        <WalletCard
          title="MetaMask (Base/Arbitrum)"
          standard="erc191"
          state={cards.evm}
          onRun={() => run('evm')}
          extra={
            <label className="small">
              Declared origin{' '}
              <select value={evmOrigin} onChange={(e) => setEvmOrigin(e.target.value as 'base' | 'arb')}>
                <option value="base">Base</option>
                <option value="arb">Arbitrum</option>
              </select>
            </label>
          }
        />
        <WalletCard title="Phantom (Solana)" standard="raw_ed25519" state={cards.phantom} onRun={() => run('phantom')} />
        <WalletCard
          title="NEAR wallet"
          standard="nep413"
          state={cards.near}
          onRun={() => run('near')}
          disabled={nearLoading || nearUnavailable}
          buttonLabel={nearLoading ? 'Loading wallets…' : nearUnavailable ? 'NEAR wallets unavailable' : undefined}
        />
      </div>
    </div>
  );
}

function WalletCard({
  title,
  standard,
  state,
  onRun,
  extra,
  disabled,
  buttonLabel,
}: {
  title: string;
  standard: string;
  state: CardState;
  onRun: () => void;
  extra?: ReactNode;
  disabled?: boolean;
  buttonLabel?: string;
}) {
  const { outcome } = state;
  return (
    <section className="card" aria-label={title}>
      <div className="row">
        <h3 style={{ margin: 0 }}>{title}</h3>
        <StatusPill>{standard}</StatusPill>
      </div>
      <div className="row" style={{ margin: '12px 0' }}>
        <button type="button" className="primary" onClick={onRun} disabled={state.busy || disabled}>
          {state.busy ? 'Waiting for wallet…' : (buttonLabel ?? (outcome?.signAgain ? 'Sign again' : 'Connect and sign'))}
        </button>
        {extra}
      </div>
      {state.signerId ? (
        <p className="small muted" style={{ margin: '0 0 8px' }}>
          account <span className="mono">{state.signerId}</span>
        </p>
      ) : null}
      {outcome ? (
        <p className={`result ${outcome.tone}`} role="status">
          {outcome.text}
        </p>
      ) : null}
      {state.error ? (
        <p className="result bad" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.signed && state.signedString ? (
        <details className="debug-only">
          <summary>Show signed payload</summary>
          <p className="small muted">Signed MultiPayload</p>
          <pre className="payload">{JSON.stringify(state.signed, null, 2)}</pre>
          <CopyButton text={JSON.stringify(state.signed, null, 2)} label="Copy payload" />
          <p className="small muted">Payload string that was signed</p>
          <pre className="payload">{state.signedString}</pre>
          <CopyButton text={state.signedString} label="Copy string" />
        </details>
      ) : null}
    </section>
  );
}
