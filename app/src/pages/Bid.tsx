import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { fromBase64, mtBalanceOf, simulateIntents, toHex, type MultiPayload } from '@tender/intents';
import { BidForm, type BidFormValues } from '../components/BidForm';
import { Countdown } from '../components/Countdown';
import { CopyButton } from '../components/CopyButton';
import { DepositBox } from '../components/DepositBox';
import { Loading, ReadError } from '../components/Feedback';
import { HonestNote } from '../components/HonestNote';
import { PasteSealedBid } from '../components/PasteSealedBid';
import { SaleCard } from '../components/SaleCard';
import { StepList } from '../components/StepList';
import { TxLink } from '../components/TxLink';
import { WalletPicker } from '../components/WalletPicker';
import { config } from '../config';
import { HOSTED_BUNDLE } from '../copy';
import { buildBidPayload } from '../lib/bidPayload';
import {
  SELF_REVEAL_RESERVE,
  announcementFor,
  bidsOf,
  biddingBlock,
  canRegisterKey,
  fundDecision,
  isFunded,
  nearFundCommand,
  problemSection,
  recoveryFor,
  stepAfterRelayFailure,
  type Recovery,
  type Step,
} from '../lib/bidFlow';
import { useChainClock } from '../lib/chainClock';
import { humanError } from '../lib/errors';
import { formatUsdc } from '../lib/format';
import { loadSaleBundle, type SaleBundle } from '../lib/loaders';
import { addIntentsKey } from '../lib/near-tx';
import { getStatus, isTerminal, quoteDeposit, submitDeposit, type QuoteResponse, type StatusResponse } from '../lib/oneclick';
import type { PastedBid } from '../lib/pasteSealed';
import { clearQuote, loadQuote, quoteKey, reusableQuote, saveQuote, shouldWarnOnUnload } from '../lib/quoteStore';
import { RelayError, confirmBid, relay } from '../lib/relay';
import { sealWithConfig } from '../lib/sealBid';
import { usePolling } from '../lib/usePolling';
import { getConfig, type Bid, type Sale } from '../lib/views';
import type { IntentSigner } from '../wallets/types';

interface Plan {
  /** Escrow B in micro-USDC; the amount of the one transfer. */
  B: bigint;
  /** Wizard bids carry p and q until they are sealed; a pasted bid is already sealed. */
  secret: { p: bigint; q: bigint } | null;
  pasted: PastedBid | null;
}

interface Sealed {
  ct: string;
  cm: string;
  origin: 'base' | 'arb' | 'sol' | 'near';
}

export function Bid({ id, fundOnly }: { id: string; fundOnly: boolean }) {
  const { nowNs, synced } = useChainClock();
  const { data, error, loading } = usePolling(() => loadSaleBundle(id), 5000, [id]);
  return <BidView id={id} data={data} error={error} loading={loading} nowNs={nowNs} synced={synced} fundOnly={fundOnly} />;
}

/** The bid page for one read of the sale; pure in its props so it can be rendered in tests. */
export function BidView({
  id,
  data,
  error,
  loading,
  nowNs,
  synced,
  fundOnly,
}: {
  id: string;
  data: SaleBundle | null;
  error: string | null;
  loading: boolean;
  nowNs: bigint;
  synced: boolean;
  fundOnly: boolean;
}) {
  const sale = data?.sale ?? null;
  return (
    <div>
      <h1>Bid on sale #{id}</h1>
      <ReadError error={error} stale={data !== null} />
      {loading && !data ? <Loading what="sale" /> : null}
      {data && !sale ? <p className="note">Sale #{id} does not exist yet.</p> : null}
      {sale ? (
        <>
          <SaleCard id={id} sale={sale} nowNs={nowNs} />
          {sale.state === 'Open' ? (
            <div className="card" style={{ marginTop: 16 }}>
              <Countdown closeNs={sale.closeNs} nowNs={nowNs} />
              <p className="small muted" style={{ marginBottom: 0 }}>
                After close anyone can open the sale. Bids are revealed in a window of at least {Number(sale.revealSecs) / 3600} hours after the key is released.
              </p>
            </div>
          ) : null}
          <Wizard id={id} sale={sale} bids={data?.bids ?? []} nowNs={nowNs} synced={synced} fundOnly={fundOnly} />
        </>
      ) : null}
    </div>
  );
}

export function Wizard({
  id,
  sale,
  bids,
  nowNs,
  synced,
  fundOnly,
}: {
  id: string;
  sale: Sale;
  bids: Bid[];
  nowNs: bigint;
  synced: boolean;
  fundOnly: boolean;
}) {
  const [tab, setTab] = useState<'wizard' | 'paste'>('wizard');
  const [signer, setSigner] = useState<IntentSigner | null>(null);
  const [step, setStep] = useState<Step>('wallet');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [sealed, setSealed] = useState<Sealed | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [signed, setSigned] = useState<MultiPayload | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [stored, setStored] = useState<Bid | null | 'unknown' | undefined>(undefined);
  const quoting = useRef(false);
  const terminal = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const firstStep = useRef(true);
  /** Bumped by every reset: an answer that arrives for an earlier account or bid is dropped. */
  const flow = useRef(0);

  const rpc = config.rpcUrls;
  const quoteToken = sale.quoteToken;

  // The sale is re-read every 5 s and the clock every second: whatever the wizard did before, a bid is only sent while the sale can still take it.
  const block = biddingBlock(sale, nowNs, plan?.B);
  const live = block === null;
  const liveRef = useRef(live);
  liveRef.current = live;

  const readBalance = useCallback(async (who: string): Promise<bigint> => {
    const b = await mtBalanceOf(rpc, config.intentsContractId, who, quoteToken);
    setBalance(b);
    return b;
  }, [rpc, quoteToken]);

  const fail = (e: unknown) => setProblem(humanError(e));

  /** Origin wallet address that gets any refund from 1Click. EVM signer ids are the address; Phantom keeps the base58 key. */
  const refundAddress = (s: IntentSigner): string => (s.kind === 'phantom' ? (s.publicKey ?? s.signerId) : s.signerId);

  const requestQuote = async (s: IntentSigner, deposit: bigint, fresh = false) => {
    if (s.origin === 'near' || quoting.current) return;
    const g = flow.current;
    const key = quoteKey(config.network, id, s.signerId);
    // A reload during the swap must not ask for a second address: the first one is still waiting for the deposit.
    const kept = fresh ? null : reusableQuote(loadQuote(key), deposit, Date.now());
    if (kept) {
      terminal.current = false;
      setQuote(kept);
      setStatus(null);
      return;
    }
    quoting.current = true;
    setBusy('quote');
    setProblem(null);
    try {
      const res = await quoteDeposit({ origin: s.origin, amount: deposit, quoteToken, refundTo: refundAddress(s), recipient: s.signerId, dry: false });
      if (g !== flow.current) return;
      terminal.current = false;
      saveQuote(key, res);
      setQuote(res);
      setStatus(null);
    } catch (e) {
      if (g === flow.current) fail(e);
    } finally {
      quoting.current = false;
      if (g === flow.current) setBusy(null);
    }
  };

  /** After the form (or a pasted bid): skip the deposit when the Intents account already holds the escrow. */
  const enterFund = async (s: IntentSigner, p: Plan) => {
    const g = flow.current;
    setBusy('balance');
    setProblem(null);
    try {
      const bal = await readBalance(s.signerId);
      if (g !== flow.current) return;
      const d = fundDecision(bal, p.B);
      if (d.skip) {
        setStep(fundOnly ? 'fund' : 'seal');
      } else {
        setStep('fund');
        setQuote(null);
        await requestQuote(s, d.deposit);
      }
    } catch (e) {
      if (g === flow.current) fail(e);
    } finally {
      if (g === flow.current) setBusy(null);
    }
  };

  const resetFlow = () => {
    flow.current += 1;
    quoting.current = false;
    terminal.current = false;
    setPlan(null);
    setSealed(null);
    setBalance(null);
    setQuote(null);
    setStatus(null);
    setBusy(null);
    setProblem(null);
    setRecovery(null);
    setSigned(null);
    setTxHash(null);
    setStored(undefined);
  };

  // A new connection is a new account: nothing signed, quoted or recovered for the old one may be relayed or paid for it.
  const onConnect = (s: IntentSigner) => {
    resetFlow();
    setSigner(s);
    setStep('bid');
  };

  const placeAnother = () => {
    resetFlow();
    setStep('bid');
  };

  const onForm = (v: BidFormValues) => {
    if (!signer) return;
    const why = biddingBlock(sale, nowNs, v.B);
    if (why) {
      setProblem(why);
      return;
    }
    const p: Plan = { B: v.B, secret: { p: v.p, q: v.q }, pasted: null };
    setPlan(p);
    void enterFund(signer, p);
  };

  const onPasted = (bid: PastedBid) => {
    if (!signer) return;
    const why = biddingBlock(sale, nowNs, bid.escrow);
    if (why) {
      setProblem(why);
      return;
    }
    const p: Plan = { B: bid.escrow, secret: null, pasted: bid };
    setPlan(p);
    setSealed({ ct: bid.ct, cm: bid.cm, origin: bid.origin ?? signer.origin });
    void enterFund(signer, p);
  };

  // While funding: follow the 1Click swap and the Intents balance every 5 s. This only reads; no signature is requested here.
  const depositAddress = quote?.quote.depositAddress;
  const qKey = signer ? quoteKey(config.network, id, signer.signerId) : '';
  useEffect(() => {
    if (step !== 'fund' || !signer || !plan) return;
    let alive = true;
    const tick = async () => {
      try {
        if (depositAddress && !terminal.current) {
          const st = await getStatus(depositAddress);
          terminal.current = isTerminal(st.status);
          if (terminal.current) clearQuote(qKey);
          if (alive) setStatus(st);
        }
        const bal = await readBalance(signer.signerId);
        if (alive && isFunded(bal, plan.B) && !fundOnly && liveRef.current) setStep('seal');
      } catch {
        // a missed poll is retried in 5 s
      }
    };
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void tick();
    }, 5000);
    void tick();
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [step, signer, plan, depositAddress, fundOnly, readBalance, qKey]);

  // Reload, back button or closing the tab loses the funding view and any signature request that is open.
  useEffect(() => {
    if (!shouldWarnOnUnload(step, quote !== null, busy)) return;
    const warn = (ev: BeforeUnloadEvent) => ev.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [step, quote, busy]);

  // Keyboard and screen-reader users: after a step change the button that had focus is gone, so focus the new section's heading.
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    const section = step === 'sign' || step === 'relay' ? 'sign' : step === 'done' ? 'result' : step;
    root.current?.querySelector<HTMLElement>(`[data-step="${section}"] h2`)?.focus();
  }, [step]);

  const doSeal = async () => {
    if (!signer || !plan?.secret) return;
    if (block) {
      setProblem(block);
      return;
    }
    setBusy('seal');
    setProblem(null);
    try {
      const cfg = await getConfig();
      const out = sealWithConfig({
        contractId: config.tenderContractId,
        sale: BigInt(id),
        mpk: cfg.mpcPublicKey,
        path: sale.path,
        bidder: signer.signerId,
        B: plan.B,
        p: plan.secret.p,
        q: plan.secret.q,
      });
      setSealed({ ct: out.ct, cm: out.cm, origin: signer.origin });
      setStep('sign');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const route = (r: Recovery) => {
    setRecovery(r);
    setProblem(r.message);
    if (r.to === 'fund' && signer && plan) void enterFund(signer, plan);
    setStep(stepAfterRelayFailure(r));
  };

  const doPreflightAndRelay = async (mp: MultiPayload) => {
    const g = flow.current;
    setBusy('relay');
    setProblem(null);
    setRecovery(null);
    try {
      const sim = await simulateIntents(rpc, config.intentsContractId, [mp]);
      if (g !== flow.current) return;
      if (!sim.ok) {
        route(recoveryFor(sim.kind, sim.message, mp.standard));
        return;
      }
      setStep('relay');
      const { txHash: h } = await relay([mp]);
      if (g !== flow.current) return;
      setTxHash(h);
      clearQuote(qKey);
      setBusy('confirm');
      const found = signer && sealed ? await confirmBid({ sale: id, bidder: signer.signerId, cm: sealed.cm }) : null;
      if (g !== flow.current) return;
      setStored(found);
      setStep('done');
    } catch (e) {
      if (g !== flow.current) return;
      if (e instanceof RelayError) route(recoveryFor(e.kind, e.message, mp.standard));
      else {
        fail(e);
        setStep('sign');
      }
    } finally {
      if (g === flow.current) setBusy(null);
    }
  };

  // Runs only from the click on "Sign": a signature request is never started by an effect.
  const doSign = async () => {
    if (!signer || !plan || !sealed) return;
    if (block) {
      setProblem(block);
      return;
    }
    const g = flow.current;
    setBusy('sign');
    setProblem(null);
    setRecovery(null);
    try {
      const payload = await buildBidPayload({
        signerId: signer.signerId,
        receiverId: config.tenderContractId,
        quoteToken,
        amount: plan.B,
        sale: id,
        ct: sealed.ct,
        cm: sealed.cm,
        origin: sealed.origin,
      });
      const mp = await signer.sign(payload);
      if (g !== flow.current) return;
      setSigned(mp);
      await doPreflightAndRelay(mp);
    } catch (e) {
      if (g !== flow.current) return;
      fail(e);
      setBusy(null);
    }
  };

  const doRegisterKey = async () => {
    if (!signed || !canRegisterKey(signed, signer?.signerId) || signed.standard !== 'nep413') return;
    setBusy('register');
    setProblem(null);
    try {
      await addIntentsKey(signed.public_key);
      await doPreflightAndRelay(signed);
    } catch (e) {
      fail(e);
      setBusy(null);
    }
  };

  const recheck = async () => {
    if (!signer || !sealed) return;
    const g = flow.current;
    setBusy('confirm');
    const found = await confirmBid({ sale: id, bidder: signer.signerId, cm: sealed.cm, timeoutMs: 15_000 });
    if (g !== flow.current) return;
    setStored(found);
    setBusy(null);
  };

  const onSubmitTx = async (h: string) => {
    if (!depositAddress || h === '') return;
    try {
      await submitDeposit(h, depositAddress);
    } catch (e) {
      fail(e);
      throw e;
    }
  };

  const mine = signer ? bidsOf(bids, signer.signerId) : 0;
  const ctPreview = sealed ? toHex(fromBase64(sealed.ct)).slice(0, 48) : '';
  const needed = plan ? plan.B + SELF_REVEAL_RESERVE - (balance ?? 0n) : 0n;

  // A sale that stopped taking bids hides the wizard, unless a bid is already under way: its result must stay on screen.
  if (sale.state !== 'Open' && (step === 'wallet' || step === 'bid')) {
    return <p className="note">This sale is {sale.state}; it no longer takes bids.</p>;
  }

  const where = problemSection(step, signer !== null);
  const problemFor = (section: typeof where): ReactNode =>
    problem && where === section ? (
      <p className="result bad" role="alert">
        {problem}
      </p>
    ) : null;
  const closedNote: ReactNode = block ? <p className="note">{block}</p> : null;
  const clockNote: ReactNode = !synced ? <p className="small muted">The chain clock is not read yet; close times use your device clock until it is.</p> : null;

  return (
    <div ref={root}>
      <div className="sr-only" role="status">
        {announcementFor(step, busy, stored)}
      </div>
      <HonestNote>{HOSTED_BUNDLE}</HonestNote>
      <StepList current={step} failed={step === 'done' && stored !== undefined && !(stored && stored !== 'unknown')} doneLabel={stored === 'unknown' ? 'Not confirmed' : undefined} />
      <div className="tabs" role="group" aria-label="How to seal">
        <button type="button" aria-pressed={tab === 'wizard'} onClick={() => setTab('wizard')}>
          Seal here
        </button>
        <button type="button" aria-pressed={tab === 'paste'} onClick={() => setTab('paste')}>
          Paste a sealed bid
        </button>
      </div>

      <section className="card" aria-label="Wallet" data-step="wallet">
        <h2 className="sub">1. Wallet</h2>
        <WalletPicker signer={signer} onConnect={onConnect} />
        {signer && mine > 0 ? <p className="small muted">You already have {mine} bid{mine === 1 ? '' : 's'} in this sale.</p> : null}
        {problemFor('wallet')}
      </section>

      {signer && (step === 'bid' || step === 'wallet') ? (
        <section className="card" style={{ marginTop: 16 }} aria-label="Bid" data-step="bid">
          <h2 className="sub" tabIndex={-1}>
            2. Bid
          </h2>
          {tab === 'wizard' ? (
            <BidForm sale={sale} nowNs={nowNs} disabled={busy !== null} onSubmit={onForm} />
          ) : (
            <PasteSealedBid saleId={id} signerId={signer.signerId} disabled={busy !== null} onSubmit={onPasted} />
          )}
          {problemFor('bid')}
        </section>
      ) : null}

      {signer && plan && step === 'fund' ? (
        <section className="card" style={{ marginTop: 16 }} aria-label="Fund" data-step="fund">
          <h2 className="sub" tabIndex={-1}>
            3. Fund your Intents account
          </h2>
          <p className="small">
            Escrow <strong>{formatUsdc(plan.B)} USDC</strong> · your Intents balance{' '}
            <strong>{balance === null ? '…' : `${formatUsdc(balance)} USDC`}</strong>
          </p>
          {balance !== null && isFunded(balance, plan.B) ? (
            <>
              <p className="result ok">Already funded in NEAR Intents ({formatUsdc(balance)} USDC) · skipping deposit</p>
              {fundOnly ? <p className="small muted">Funding check complete (fund-only mode).</p> : null}
            </>
          ) : signer.origin === 'near' ? (
            <>
              <p className="small">
                1Click cannot fund a NEAR-native USDC balance. Move NEAR USDC into your Intents account yourself ({formatUsdc(needed)} USDC missing, which includes
                0.000001 USDC left over for the gasless reveal). The command is signed by your NEAR account <span className="mono">{signer.signerId}</span>:
              </p>
              <pre className="payload">{nearFundCommand({ amount: needed, quoteToken, signerId: signer.signerId })}</pre>
              <CopyButton text={nearFundCommand({ amount: needed, quoteToken, signerId: signer.signerId })} label="Copy command" />
            </>
          ) : quote ? (
            <DepositBox
              origin={signer.origin}
              quote={quote}
              status={status}
              need={needed}
              onSubmitTx={onSubmitTx}
              onNewQuote={() => {
                const d = fundDecision(balance ?? 0n, plan.B);
                if (!d.skip) void requestQuote(signer, d.deposit, true);
              }}
            />
          ) : busy === 'quote' ? (
            <p className="muted">Requesting a deposit address…</p>
          ) : (
            <>
              <p className="muted">No deposit address yet.</p>
              <button
                type="button"
                className="primary"
                disabled={busy !== null}
                onClick={() => {
                  const d = fundDecision(balance ?? 0n, plan.B);
                  if (!d.skip) void requestQuote(signer, d.deposit);
                }}
              >
                Get a deposit address
              </button>
            </>
          )}
          {closedNote}
          {problemFor('fund')}
        </section>
      ) : null}

      {signer && plan && step === 'seal' ? (
        <section className="card" style={{ marginTop: 16 }} aria-label="Seal" data-step="seal">
          <h2 className="sub" tabIndex={-1}>
            4. Seal
          </h2>
          {plan.pasted ? (
            <p className="result ok">Using your pasted sealed bid. The browser never saw its price.</p>
          ) : (
            <button type="button" className="primary" onClick={doSeal} disabled={busy !== null || !live}>
              {busy === 'seal' ? 'Sealing…' : 'Seal in this browser'}
            </button>
          )}
          {plan.pasted ? (
            <div style={{ marginTop: 8 }}>
              <button type="button" className="primary" onClick={() => setStep('sign')} disabled={!live}>
                Continue to signing
              </button>
            </div>
          ) : null}
          {closedNote}
          {clockNote}
          {problemFor('seal')}
        </section>
      ) : null}

      {signer && plan && sealed && (step === 'sign' || step === 'relay' || step === 'done') ? (
        <section className="card" style={{ marginTop: 16 }} aria-label="Sign" data-step="sign">
          <h2 className="sub" tabIndex={-1}>
            5. Sign one transfer
          </h2>
          <p className="result ok">
            {plan.pasted ? 'Sealed bid pasted' : 'Sealed in your browser'} · ciphertext <span className="mono">{ctPreview}…</span>
          </p>
          <p className="small muted">
            One Intents <code>Transfer</code> of {formatUsdc(plan.B)} USDC to <span className="mono">{config.tenderContractId}</span> carrying your sealed
            bid. It expires in 10 minutes; sign and send right away.
          </p>
          {step === 'sign' ? (
            <button type="button" className="primary" onClick={doSign} disabled={busy !== null || !live}>
              {busy === 'sign' ? 'Waiting for wallet…' : recovery?.to === 'sign_again' ? 'Sign again' : 'Sign with wallet'}
            </button>
          ) : null}
          {recovery?.to === 'register_key' && signed && canRegisterKey(signed, signer.signerId) ? (
            <div style={{ marginTop: 8 }}>
              <button type="button" className="primary" onClick={doRegisterKey} disabled={busy !== null}>
                {busy === 'register' ? 'Waiting for wallet…' : 'Register this key with NEAR Intents (1 yoctoNEAR)'}
              </button>
            </div>
          ) : null}
          {recovery?.to === 'retry' && signed ? (
            <div style={{ marginTop: 8 }}>
              <button type="button" onClick={() => void doPreflightAndRelay(signed)} disabled={busy !== null || !live}>
                Try the relayer again
              </button>
            </div>
          ) : null}
          {busy === 'relay' ? <p className="muted">Checking with simulate_intents, then relaying…</p> : null}
          {busy === 'confirm' ? <p className="muted">Relayed. Waiting for the contract to confirm the bid (up to 90 seconds)…</p> : null}
          {step !== 'done' ? closedNote : null}
          {clockNote}
          {problemFor('sign')}
        </section>
      ) : null}

      {step === 'done' ? (
        <section className="card" style={{ marginTop: 16 }} aria-label="Result" data-step="result">
          <h2 className="sub" tabIndex={-1}>
            6. Result
          </h2>
          {txHash ? (
            <p className="small">
              Relay transaction <TxLink hash={txHash} />
            </p>
          ) : null}
          {stored && stored !== 'unknown' ? (
            <>
              <p className="result ok">Bid #{stored.idx} stored · Sealed</p>
              <p className="small">
                On-chain commitment <span className="mono">{stored.cm}</span>
              </p>
            </>
          ) : stored === 'unknown' ? (
            <>
              <p className="result warn" role="alert">
                Could not confirm: the RPC did not answer. Your bid may be stored, so check the ciphertext wall before bidding again.
              </p>
              <button type="button" onClick={() => void recheck()} disabled={busy !== null}>
                Check again
              </button>
            </>
          ) : (
            <p className="result bad" role="alert">
              Not stored: the bid did not appear on chain within 90 seconds, so the contract most likely refunded the transfer (see tx logs){txHash ? <> · <TxLink hash={txHash} /></> : null}
            </p>
          )}
          <p className="small muted">Anyone can relay a signed payload from their own account; the relayer cannot change it.</p>
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={placeAnother} disabled={busy !== null}>
              Place another bid
            </button>
          </div>
          {problemFor('result')}
        </section>
      ) : null}

      {signed ? (
        <details className="debug-only" style={{ marginTop: 16 }}>
          <summary>Signed payload</summary>
          <pre className="payload">{JSON.stringify(signed, null, 2)}</pre>
          <CopyButton text={JSON.stringify(signed, null, 2)} label="Copy signed payload" />
        </details>
      ) : null}
    </div>
  );
}
