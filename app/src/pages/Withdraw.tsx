import { useMemo, useState } from 'react';
import { mtBatchBalanceOf, simulateIntents, type MultiPayload } from '@tender/intents';
import { CopyButton } from '../components/CopyButton';
import { HonestNote } from '../components/HonestNote';
import { TxLink } from '../components/TxLink';
import { WalletPicker } from '../components/WalletPicker';
import { config } from '../config';
import { recoveryFor, type Recovery } from '../lib/bidFlow';
import { liveQuoteToken } from '../lib/bidPayload';
import { formatUnits } from '../lib/format';
import { addIntentsKey } from '../lib/near-tx';
import { quoteWithdraw, type QuoteResponse, type StatusResponse } from '../lib/oneclick';
import { RelayError, relay } from '../lib/relay';
import { buildWithdrawPayload, followWithdraw, quoteProblem, txHashes, validateWithdraw, withdrawEvidence } from '../lib/withdrawFlow';
import {
  WITHDRAW_TARGETS,
  defaultRecipient,
  destinationTxUrl,
  withdrawSources,
  type WithdrawSource,
  type WithdrawTarget,
} from '../lib/withdrawRoutes';
import { walletErrorMessage, type IntentSigner } from '../wallets/types';

export function Withdraw() {
  const [signer, setSigner] = useState<IntentSigner | null>(null);
  const [sources, setSources] = useState<WithdrawSource[]>([]);
  const [balances, setBalances] = useState<Record<string, bigint>>({});
  const [tokenId, setTokenId] = useState('');
  const [amountText, setAmountText] = useState('');
  const [targetId, setTargetId] = useState<WithdrawTarget['id']>('base-usdc');
  const [recipient, setRecipient] = useState('');
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [signed, setSigned] = useState<MultiPayload | null>(null);
  const [relayTx, setRelayTx] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<Recovery | null>(null);

  const source = sources.find((s) => s.tokenId === tokenId) ?? null;
  const target = WITHDRAW_TARGETS.find((t) => t.id === targetId)!;
  const balance = source ? (balances[source.tokenId] ?? null) : null;
  const depositAddress = quote?.quote.depositAddress ?? null;
  const locked = busy !== null || signed !== null;

  const fail = (e: unknown) => setProblem(e instanceof Error ? e.message : walletErrorMessage(e));

  const forgetQuote = () => {
    setQuote(null);
    setProblem(null);
    setRecovery(null);
  };

  const pickSource = (s: WithdrawSource, bal: bigint | undefined) => {
    setTokenId(s.tokenId);
    setAmountText(bal === undefined ? '' : formatUnits(bal, s.decimals));
    forgetQuote();
  };

  const onConnect = async (s: IntentSigner) => {
    setSigner(s);
    setRecipient(defaultRecipient(target.chain, s));
    setBusy('balances');
    forgetQuote();
    try {
      const list = withdrawSources(await liveQuoteToken());
      const values = await mtBatchBalanceOf(config.rpcUrls, config.intentsContractId, s.signerId, list.map((x) => x.tokenId));
      const next: Record<string, bigint> = {};
      list.forEach((x, i) => (next[x.tokenId] = values[i] ?? 0n));
      setSources(list);
      setBalances(next);
      const first = list.find((x) => (next[x.tokenId] ?? 0n) > 0n) ?? list[0]!;
      pickSource(first, next[first.tokenId]);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const onTarget = (id: WithdrawTarget['id']) => {
    const t = WITHDRAW_TARGETS.find((x) => x.id === id)!;
    setTargetId(id);
    if (signer) setRecipient(defaultRecipient(t.chain, signer));
    forgetQuote();
  };

  const check = signer && source ? validateWithdraw({ amountText, source, balance, chain: target.chain, recipient }) : null;

  const doQuote = async () => {
    if (!signer || !source || !check || !check.ok || balance === null) return;
    setBusy('quote');
    forgetQuote();
    try {
      const res = await quoteWithdraw({
        originAsset: source.tokenId,
        destinationAsset: target.assetId,
        amount: check.amount,
        signerId: signer.signerId,
        recipient: recipient.trim(),
        dry: false,
      });
      const bad = quoteProblem(res, balance);
      if (bad) setProblem(bad);
      else setQuote(res);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const refreshBalances = async () => {
    if (!signer) return;
    const values = await mtBatchBalanceOf(config.rpcUrls, config.intentsContractId, signer.signerId, sources.map((x) => x.tokenId)).catch(() => null);
    if (!values) return;
    const next: Record<string, bigint> = {};
    sources.forEach((x, i) => (next[x.tokenId] = values[i] ?? 0n));
    setBalances(next);
  };

  const route = (r: Recovery) => {
    setRecovery(r);
    setProblem(r.to === 'fund' ? 'Your Intents balance is below the quoted amount. Get a new quote.' : r.message);
  };

  /** Simulate for free, relay, then follow 1Click to its final status. Nothing here asks the wallet for a signature. */
  const sendAndFollow = async (mp: MultiPayload) => {
    if (!depositAddress) return;
    setBusy('relay');
    setProblem(null);
    setRecovery(null);
    try {
      const sim = await simulateIntents(config.rpcUrls, config.intentsContractId, [mp]);
      if (!sim.ok) {
        route(recoveryFor(sim.kind, sim.message));
        return;
      }
      const { txHash } = await relay([mp]);
      setRelayTx(txHash);
      setBusy('follow');
      const final = await followWithdraw({ depositAddress, onStatus: setStatus });
      setStatus(final);
      void refreshBalances();
    } catch (e) {
      if (e instanceof RelayError) route(recoveryFor(e.kind, e.message));
      else fail(e);
    } finally {
      setBusy(null);
    }
  };

  // Runs only from the click on "Sign & withdraw".
  const doSign = async () => {
    if (!signer || !source || !quote || !depositAddress || balance === null) return;
    const bad = quoteProblem(quote, balance);
    if (bad) {
      setProblem(bad);
      return;
    }
    setBusy('sign');
    setProblem(null);
    setRecovery(null);
    try {
      const payload = await buildWithdrawPayload({
        signerId: signer.signerId,
        depositAddress,
        tokenId: source.tokenId,
        amountIn: BigInt(quote.quote.amountIn),
      });
      const mp = await signer.sign(payload);
      setSigned(mp);
      await sendAndFollow(mp);
    } catch (e) {
      fail(e);
      setBusy(null);
    }
  };

  const doRegisterKey = async () => {
    if (!signed || signed.standard === 'erc191') return;
    setBusy('register');
    setProblem(null);
    try {
      await addIntentsKey(signed.public_key);
      await sendAndFollow(signed);
    } catch (e) {
      fail(e);
      setBusy(null);
    }
  };

  const startOver = () => {
    setSigned(null);
    setRelayTx(null);
    setStatus(null);
    forgetQuote();
  };

  const evidence = useMemo(
    () => (status && status.status === 'SUCCESS' && depositAddress ? JSON.stringify(withdrawEvidence({ depositAddress, status, relayTx }), null, 2) : null),
    [status, depositAddress, relayTx],
  );
  const destHashes = txHashes(status?.swapDetails?.destinationChainTxHashes);
  const nearHashes = status?.swapDetails?.nearTxHashes ?? [];
  const q = quote?.quote;

  return (
    <div>
      <h1>Withdraw to chain</h1>
      <HonestNote>
        Moves tokens from your NEAR Intents account to a wallet on Base, Arbitrum or Solana through 1Click. You sign one Intents transfer to the
        quote&apos;s deposit address; the relayer only pays gas and cannot change it. Each token needs its own quote and signature.
      </HonestNote>

      <section className="card" aria-label="Wallet">
        <h3>1. Wallet</h3>
        <WalletPicker signer={signer} onConnect={(s) => void onConnect(s)} />
      </section>

      {signer && source ? (
        <section className="card" style={{ marginTop: 16 }} aria-label="Withdrawal">
          <h3>2. What to withdraw</h3>
          <div className="stack">
            <label className="field">
              <span>Token in your Intents account</span>
              <select
                value={tokenId}
                disabled={locked}
                onChange={(e) => {
                  const s = sources.find((x) => x.tokenId === e.target.value)!;
                  pickSource(s, balances[s.tokenId]);
                }}
              >
                {sources.map((s) => (
                  <option key={s.tokenId} value={s.tokenId}>
                    {s.symbol} · {formatUnits(balances[s.tokenId] ?? 0n, s.decimals)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Amount ({source.symbol})</span>
              <span className="row">
                <input
                  value={amountText}
                  disabled={locked}
                  inputMode="decimal"
                  onChange={(e) => {
                    setAmountText(e.target.value);
                    forgetQuote();
                  }}
                />
                <button type="button" disabled={locked} onClick={() => pickSource(source, balances[source.tokenId] ?? 0n)}>
                  All
                </button>
              </span>
            </label>
            <label className="field">
              <span>Send to</span>
              <select value={targetId} disabled={locked} onChange={(e) => onTarget(e.target.value as WithdrawTarget['id'])}>
                {WITHDRAW_TARGETS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Recipient address on {target.chain === 'sol' ? 'Solana' : target.chain === 'base' ? 'Base' : 'Arbitrum'}</span>
              <input
                value={recipient}
                disabled={locked}
                spellCheck={false}
                className="mono"
                onChange={(e) => {
                  setRecipient(e.target.value);
                  forgetQuote();
                }}
              />
            </label>
          </div>
          {check && !check.ok && amountText !== '' ? (
            <ul className="small">
              {check.errors.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          ) : null}
          {!signed ? (
            <button type="button" className="primary" disabled={busy !== null || !check || !check.ok} onClick={() => void doQuote()}>
              {busy === 'quote' ? 'Requesting a quote…' : 'Get quote'}
            </button>
          ) : null}
        </section>
      ) : null}

      {q && source ? (
        <section className="card" style={{ marginTop: 16 }} aria-label="Quote">
          <h3>3. Quote</h3>
          <dl className="kv">
            <dt>You send</dt>
            <dd>
              {formatUnits(BigInt(q.amountIn), source.decimals)} {source.symbol} from your Intents account
            </dd>
            <dt>You receive</dt>
            <dd>
              about <strong>{formatUnits(BigInt(q.amountOut), target.decimals)} {target.symbol}</strong> on {target.label.split(' ')[0]}, at least{' '}
              {formatUnits(BigInt(q.minAmountOut), target.decimals)}
            </dd>
            <dt>Estimated time</dt>
            <dd>{q.timeEstimate ?? '?'} s</dd>
            {q.deadline ? (
              <>
                <dt>Quote valid until</dt>
                <dd>{q.deadline.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}</dd>
              </>
            ) : null}
            <dt>Deposit address</dt>
            <dd>
              <span className="mono">{depositAddress}</span> (a NEAR Intents account, not a chain address)
            </dd>
          </dl>
          {!signed ? (
            <button type="button" className="primary" disabled={busy !== null} onClick={() => void doSign()}>
              {busy === 'sign' ? 'Waiting for wallet…' : recovery?.to === 'sign_again' ? 'Sign again' : 'Sign & withdraw'}
            </button>
          ) : null}
          {recovery?.to === 'register_key' ? (
            <div style={{ marginTop: 8 }}>
              <button type="button" className="primary" onClick={() => void doRegisterKey()} disabled={busy !== null}>
                {busy === 'register' ? 'Waiting for wallet…' : 'Register this key with NEAR Intents (1 yoctoNEAR)'}
              </button>
            </div>
          ) : null}
          {recovery?.to === 'retry' && signed ? (
            <div style={{ marginTop: 8 }}>
              <button type="button" onClick={() => void sendAndFollow(signed)} disabled={busy !== null}>
                Try the relayer again
              </button>
            </div>
          ) : null}
          {busy === 'relay' ? <p className="muted">Checking with simulate_intents, then relaying…</p> : null}
        </section>
      ) : null}

      {signed && depositAddress ? (
        <section className="card" style={{ marginTop: 16 }} aria-label="Status">
          <h3>4. Status</h3>
          <p className="small" role="status">
            1Click status: <strong>{status?.status ?? (relayTx ? 'waiting for 1Click' : 'not relayed yet')}</strong>
            {busy === 'follow' ? ' · checking every 5 s' : ''}
          </p>
          {relayTx ? (
            <p className="small">
              Relay transaction <TxLink hash={relayTx} />
            </p>
          ) : null}
          {status?.status === 'SUCCESS' ? (
            <>
              <p className="result ok">
                Withdrawn · {destHashes.length > 0 ? 'on-chain transaction below' : 'destination transaction not listed yet'}
              </p>
              <ul className="small">
                {destHashes.map((h) => (
                  <li key={h}>
                    Destination{' '}
                    <a className="mono" href={destinationTxUrl(target.chain, h)} target="_blank" rel="noreferrer">
                      {h}
                    </a>
                  </li>
                ))}
                {nearHashes.map((h) => (
                  <li key={h}>
                    NEAR <TxLink hash={h} />
                  </li>
                ))}
              </ul>
              {evidence ? <CopyButton text={evidence} label="Copy evidence JSON" /> : null}
            </>
          ) : null}
          {status && (status.status === 'REFUNDED' || status.status === 'FAILED' || status.status === 'INCOMPLETE_DEPOSIT') ? (
            <p className="result bad" role="alert">
              {status.status}
              {status.swapDetails?.refundReason ? `: ${status.swapDetails.refundReason}` : ''}. The amount returns to your NEAR Intents account.
            </p>
          ) : null}
          {busy === null ? (
            <div style={{ marginTop: 8 }}>
              <button type="button" onClick={startOver}>
                New withdrawal
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {signed ? (
        <details style={{ marginTop: 16 }}>
          <summary>Signed payload</summary>
          <pre className="payload">{JSON.stringify(signed, null, 2)}</pre>
          <CopyButton text={JSON.stringify(signed, null, 2)} label="Copy signed payload" />
        </details>
      ) : null}

      {problem ? (
        <p className="result bad" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
