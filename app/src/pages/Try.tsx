import { useEffect, useState, type ReactNode } from 'react';
import { payloadString, simulateIntents, type MultiPayload } from '@tender/intents';
import { ChainGlyph } from '../components/ChainGlyph';
import { CopyButton } from '../components/CopyButton';
import { NetworkBadge } from '../components/NetworkBadge';
import { config } from '../config';
import { HOME, NEAR_INTENTS } from '../copy';
import { useContractMissing } from '../lib/contractStatus';
import { buildTryBid, liveQuoteToken } from '../lib/bidPayload';
import { useChainOffset } from '../lib/chainClock';
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
  useChainOffset(); // payload deadlines follow the chain's clock
  const [cards, setCards] = useState<Record<Kind, CardState>>({ evm: IDLE, phantom: IDLE, near: IDLE });
  const [evmOrigin, setEvmOrigin] = useState<'base' | 'arb'>('base');
  const [nearLoading, setNearLoading] = useState(true);
  const [nearUnavailable, setNearUnavailable] = useState(false);
  // The wallet-free check needs a sale to open: shown once the contract has answered on this network.
  const contractLive = useContractMissing() === false;

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
    if (cards[kind].busy) return; // the button stays focusable while busy (aria-disabled), so a second press lands here
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
        outcome: interpretSimulation(sim, signed.standard),
        signed,
        signedString: payloadString(payload),
      });
    } catch (e) {
      patch(kind, { busy: false, error: walletErrorMessage(e) });
    }
  };

  return (
    <div className="wrap page">
      <header className="page-head">
        <NetworkBadge />
        <h1>Try signing (free)</h1>
        <p className="lead">Sign the message a real bid uses; nothing is sent, and “insufficient balance” means it worked.</p>
      </header>
      <div className="grid-3">
        <WalletCard
          title="MetaMask"
          standard="erc191"
          state={cards.evm}
          onRun={() => run('evm')}
          install={['MetaMask', 'https://metamask.io/download/']}
          extra={
            <label className="small origin-select">
              Funds would come from{' '}
              <select value={evmOrigin} onChange={(e) => setEvmOrigin(e.target.value as 'base' | 'arb')}>
                <option value="base">Base</option>
                <option value="arb">Arbitrum</option>
              </select>
            </label>
          }
        />
        <WalletCard title="Phantom" standard="raw_ed25519" state={cards.phantom} onRun={() => run('phantom')} install={['Phantom', 'https://phantom.com/download']} />
        <WalletCard
          title="NEAR wallet"
          standard="nep413"
          state={cards.near}
          onRun={() => run('near')}
          disabled={nearLoading || nearUnavailable}
          buttonLabel={nearLoading ? 'Loading wallets…' : nearUnavailable ? 'NEAR wallets unavailable' : undefined}
        />
      </div>
      {contractLive ? (
        <p className="try-nowallet">
          <a href={`#/sale/${config.twinSales[0]}`}>
            {HOME.tryNoWallet}
            <span aria-hidden="true">{' →'}</span>
          </a>
        </p>
      ) : null}
      <details className="fold proves-fold">
        <summary>What this proves</summary>
        <p className="note info">
          <strong>This proves your wallet can place a real Tender bid, without spending anything.</strong> Success reads{' '}
          <span className="mono">signature valid · insufficient balance</span>: {NEAR_INTENTS}, the NEAR contract that holds balances your own wallet controls
          and checks every signature, accepted your signature as a real bid, then stopped because the account holds no USDC there.
        </p>
        <ol className="proves">
          <li>
            <span className="n mono">01</span>
            <strong>Your own wallet, on your own chain.</strong>
            <span className="muted small">A wallet on Base, Arbitrum, Solana or NEAR signs a Tender bid directly.</span>
          </li>
          <li>
            <span className="n mono">02</span>
            <strong>Checked by the {NEAR_INTENTS} contract, not by our server.</strong>
            <span className="muted small">The check is a view call to that contract on NEAR; our server is not involved.</span>
          </li>
          <li>
            <span className="n mono">03</span>
            <strong>Not shown here: sealing.</strong>
            <span className="muted small">
              A real bid is sealed in the page before it is signed (developers can seal on their own machine with <code>pnpm seal:bid</code>). Here the sealed part
              is random.
            </span>
          </li>
        </ol>
        <details className="fold tech">
          <summary>Technical details</summary>
          <ul className="small check-list">
            <li>
              The check is a view call, <code>simulate_intents</code>, to <code>{config.intentsContractId}</code>. Nothing is sent to any relayer.
            </li>
            <li>
              The bid is addressed to <span className="mono">{config.tryReceiver}</span>; its sealed part is random, and its sale id does not exist.
            </li>
            <li>
              Signature standards: MetaMask signs <code>erc191</code>, Phantom <code>raw_ed25519</code>, a NEAR wallet <code>nep413</code>. The chain you pick for
              MetaMask is declared by you, not proven.
            </li>
          </ul>
        </details>
      </details>
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
  install,
}: {
  title: string;
  standard: string;
  state: CardState;
  onRun: () => void;
  extra?: ReactNode;
  disabled?: boolean;
  buttonLabel?: string;
  /** [wallet name, its download page]: offered when the wallet is not installed in this browser. */
  install?: [string, string];
}) {
  const { outcome } = state;
  const headId = `try-${standard}`;
  return (
    <section className="card pad wallet-card" aria-label={title}>
      <div className="row">
        <span className="wallet-chains" aria-hidden="true">
          {(standard === 'erc191' ? ['base', 'arb'] : standard === 'raw_ed25519' ? ['sol'] : ['near']).map((c) => (
            <ChainGlyph key={c} chain={c} />
          ))}
        </span>
        <h2 className="sub" id={headId} style={{ margin: 0 }}>
          {title}
        </h2>
      </div>
      <p className="small muted" style={{ margin: '4px 0 0' }}>
        {standard === 'erc191' ? 'Base or Arbitrum' : standard === 'raw_ed25519' ? 'Solana' : 'NEAR'}
      </p>
      <div className="row" style={{ margin: '12px 0' }}>
        {/* Three equal choices: none is the page's one primary action. aria-disabled while busy keeps keyboard focus on it. */}
        <button type="button" onClick={onRun} disabled={disabled} aria-disabled={state.busy || undefined} aria-describedby={headId}>
          {state.busy ? 'Waiting for wallet…' : (buttonLabel ?? (outcome?.signAgain ? 'Sign again' : 'Connect and sign'))}
        </button>
        {extra}
      </div>
      {state.signerId ? (
        <p className="small muted" style={{ margin: '0 0 8px' }}>
          account <span className="mono">{state.signerId}</span>
        </p>
      ) : null}
      <div role="status">{outcome ? <p className={`result ${outcome.tone}`}>{outcome.text}</p> : null}</div>
      {state.error ? (
        <p className="result bad" role="alert">
          {state.error}
          {install && /not found|Install/.test(state.error) ? (
            <>
              {' '}
              <a href={install[1]} target="_blank" rel="noreferrer">
                {`Get ${install[0]}`}
                <span aria-hidden="true">{' →'}</span>
              </a>
            </>
          ) : null}
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
