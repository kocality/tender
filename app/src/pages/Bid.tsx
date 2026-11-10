import { useCallback, useEffect, useRef, useState } from 'react';
import { fromBase64, mtBalanceOf, simulateIntents, toHex, type MultiPayload } from '@tender/intents';
import { BidForm, type BidFormValues } from '../components/BidForm';
import { CopyButton } from '../components/CopyButton';
import { DepositBox } from '../components/DepositBox';
import { HonestNote } from '../components/HonestNote';
import { PasteSealedBid } from '../components/PasteSealedBid';
import { SaleCard } from '../components/SaleCard';
import { StepList } from '../components/StepList';
import { TxLink } from '../components/TxLink';
import { WalletPicker } from '../components/WalletPicker';
import { config } from '../config';
import { HOSTED_BUNDLE } from '../copy';
import { buildBidPayload } from '../lib/bidPayload';
import { bidsOf, fundDecision, recoveryFor, type Recovery, type Step } from '../lib/bidFlow';
import { useChainClock } from '../lib/chainClock';
import { formatUsdc } from '../lib/format';
import { loadSaleBundle } from '../lib/loaders';
import { addIntentsKey } from '../lib/near-tx';
import { getStatus, isTerminal, quoteDeposit, submitDeposit, type QuoteResponse, type StatusResponse } from '../lib/oneclick';
import type { PastedBid } from '../lib/pasteSealed';
import { RelayError, confirmBid, relay } from '../lib/relay';
import { sealForSale } from '../lib/sealBid';
import { usePolling } from '../lib/usePolling';
import { getConfig, type Bid, type Sale } from '../lib/views';
import { walletErrorMessage, type IntentSigner } from '../wallets/types';

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

const NEAR_FUND_CMD = (gap: bigint, quoteToken: string) =>
  `near contract call-function as-transaction ${quoteToken.replace(/^nep141:/, '')} ft_transfer_call json-args '{"receiver_id":"${config.intentsContractId}","amount":"${gap}","msg":""}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as <account> network-config ${config.network} sign-with-legacy-keychain send`;

export function Bid({ id, fundOnly }: { id: string; fundOnly: boolean }) {
  const { nowNs } = useChainClock();
  const { data, error, loading } = usePolling(() => loadSaleBundle(id), 5000, [id]);
  const sale = data?.sale ?? null;
  return (
    <div>
      <h1>Bid on sale #{id}</h1>
      {error ? <p className="note">Could not read {config.tenderContractId}: {error}</p> : null}
      {loading && !data ? <p className="muted">Loading sale…</p> : null}
      {data && !sale ? <p className="note">Sale #{id} does not exist yet.</p> : null}
      {sale ? (
        <>
          <SaleCard id={id} sale={sale} nowNs={nowNs} />
          <Wizard id={id} sale={sale} bids={data?.bids ?? []} nowNs={nowNs} fundOnly={fundOnly} />
        </>
      ) : null}
    </div>
  );
}

function Wizard({ id, sale, bids, nowNs, fundOnly }: { id: string; sale: Sale; bids: Bid[]; nowNs: bigint; fundOnly: boolean }) {
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
  const [stored, setStored] = useState<Bid | null | undefined>(undefined);
  const quoting = useRef(false);
  const terminal = useRef(false);

  const rpc = config.rpcUrls;
  const quoteToken = sale.quoteToken;

  const readBalance = useCallback(async (who: string): Promise<bigint> => {
    const b = await mtBalanceOf(rpc, config.intentsContractId, who, quoteToken);
    setBalance(b);
    return b;
  }, [rpc, quoteToken]);

  const fail = (e: unknown) => setProblem(e instanceof Error ? e.message : walletErrorMessage(e));

  /** Origin wallet address that gets any refund from 1Click. EVM signer ids are the address; Phantom keeps the base58 key. */
  const refundAddress = (s: IntentSigner): string => (s.kind === 'phantom' ? (s.publicKey ?? s.signerId) : s.signerId);

  const requestQuote = async (s: IntentSigner, deposit: bigint) => {
    if (s.origin === 'near' || quoting.current) return;
    quoting.current = true;
    setBusy('quote');
    setProblem(null);
    try {
      const res = await quoteDeposit({ origin: s.origin, amount: deposit, quoteToken, refundTo: refundAddress(s), recipient: s.signerId, dry: false });
      terminal.current = false;
      setQuote(res);
      setStatus(null);
    } catch (e) {
      fail(e);
    } finally {
      quoting.current = false;
      setBusy(null);
    }
  };

  /** After the form (or a pasted bid): skip the deposit when the Intents account already holds the escrow. */
  const enterFund = async (s: IntentSigner, p: Plan) => {
    setBusy('balance');
    setProblem(null);
    try {
      const bal = await readBalance(s.signerId);
      const d = fundDecision(bal, p.B);
      if (d.skip) {
        setStep(fundOnly ? 'fund' : 'seal');
      } else {
        setStep('fund');
        setQuote(null);
        await requestQuote(s, d.deposit);
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const onConnect = (s: IntentSigner) => {
    setSigner(s);
    setStep('bid');
    setProblem(null);
  };

  const onForm = (v: BidFormValues) => {
    if (!signer) return;
    const p: Plan = { B: v.B, secret: { p: v.p, q: v.q }, pasted: null };
    setPlan(p);
    void enterFund(signer, p);
  };

  const onPasted = (bid: PastedBid) => {
    if (!signer) return;
    const p: Plan = { B: bid.escrow, secret: null, pasted: bid };
    setPlan(p);
    setSealed({ ct: bid.ct, cm: bid.cm, origin: bid.origin ?? signer.origin });
    void enterFund(signer, p);
  };

  // While funding: follow the 1Click swap and the Intents balance every 5 s. This only reads; no signature is requested here.
  const depositAddress = quote?.quote.depositAddress;
  useEffect(() => {
    if (step !== 'fund' || !signer || !plan) return;
    let alive = true;
    const tick = async () => {
      try {
        if (depositAddress && !terminal.current) {
          const st = await getStatus(depositAddress);
          terminal.current = isTerminal(st.status);
          if (alive) setStatus(st);
        }
        const bal = await readBalance(signer.signerId);
        if (alive && bal >= plan.B && !fundOnly) setStep('seal');
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
  }, [step, signer, plan, depositAddress, fundOnly, readBalance]);

  const doSeal = async () => {
    if (!signer || !plan?.secret) return;
    setBusy('seal');
    setProblem(null);
    try {
      const cfg = await getConfig();
      const out = sealForSale({
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
    if (r.to === 'sign_again') setStep('sign');
  };

  const doPreflightAndRelay = async (mp: MultiPayload) => {
    setBusy('relay');
    setProblem(null);
    setRecovery(null);
    try {
      const sim = await simulateIntents(rpc, config.intentsContractId, [mp]);
      if (!sim.ok) {
        route(recoveryFor(sim.kind, sim.message));
        return;
      }
      setStep('relay');
      const { txHash: h } = await relay([mp]);
      setTxHash(h);
      const found = signer && sealed ? await confirmBid({ sale: id, bidder: signer.signerId, cm: sealed.cm }) : null;
      setStored(found);
      setStep('done');
    } catch (e) {
      if (e instanceof RelayError) route(recoveryFor(e.kind, e.message));
      else fail(e);
    } finally {
      setBusy(null);
    }
  };

  // Runs only from the click on "Sign": a signature request is never started by an effect.
  const doSign = async () => {
    if (!signer || !plan || !sealed) return;
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
      setSigned(mp);
      await doPreflightAndRelay(mp);
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
      await doPreflightAndRelay(signed);
    } catch (e) {
      fail(e);
      setBusy(null);
    }
  };

  const onSubmitTx = (h: string) => {
    if (!depositAddress || h === '') return;
    submitDeposit(h, depositAddress).catch(fail);
  };

  const mine = signer ? bidsOf(bids, signer.signerId) : 0;
  const ctPreview = sealed ? toHex(fromBase64(sealed.ct)).slice(0, 48) : '';

  return (
    <div>
      <HonestNote>{HOSTED_BUNDLE}</HonestNote>
      <StepList current={step} />
      <div className="tabs" role="group" aria-label="How to seal">
        <button type="button" aria-pressed={tab === 'wizard'} onClick={() => setTab('wizard')}>
          Seal here
        </button>
        <button type="button" aria-pressed={tab === 'paste'} onClick={() => setTab('paste')}>
          Paste a sealed bid
        </button>
      </div>

      <section className="card" aria-label="Wallet">
        <h3>1. Wallet</h3>
        <WalletPicker signer={signer} onConnect={onConnect} />
        {signer && mine > 0 ? <p className="small muted">You already have {mine} bid{mine === 1 ? '' : 's'} in this sale.</p> : null}
      </section>

      {signer && (step === 'bid' || step === 'wallet') ? (
        <section className="card" style={{ marginTop: 16 }} aria-label="Bid">
          <h3>2. Bid</h3>
          {tab === 'wizard' ? (
            <BidForm sale={sale} nowNs={nowNs} disabled={busy !== null} onSubmit={onForm} />
          ) : (
            <PasteSealedBid saleId={id} signerId={signer.signerId} disabled={busy !== null} onSubmit={onPasted} />
          )}
        </section>
      ) : null}

      {signer && plan && step === 'fund' ? (
        <section className="card" style={{ marginTop: 16 }} aria-label="Fund">
          <h3>3. Fund your Intents account</h3>
          <p className="small">
            Escrow <strong>{formatUsdc(plan.B)} USDC</strong> · your Intents balance{' '}
            <strong>{balance === null ? '…' : `${formatUsdc(balance)} USDC`}</strong>
          </p>
          {balance !== null && balance >= plan.B ? (
            <>
              <p className="result ok">Already funded in NEAR Intents ({formatUsdc(balance)} USDC) · skipping deposit</p>
              {fundOnly ? <p className="small muted">Funding check complete (fund-only mode).</p> : null}
            </>
          ) : signer.origin === 'near' ? (
            <>
              <p className="small">
                1Click cannot fund a NEAR-native USDC balance. Move NEAR USDC into your Intents account yourself ({formatUsdc(plan.B - (balance ?? 0n))} USDC
                missing):
              </p>
              <pre className="payload">{NEAR_FUND_CMD(plan.B - (balance ?? 0n), quoteToken)}</pre>
              <CopyButton text={NEAR_FUND_CMD(plan.B - (balance ?? 0n), quoteToken)} label="Copy command" />
            </>
          ) : quote ? (
            <DepositBox
              origin={signer.origin}
              quote={quote}
              status={status}
              onSubmitTx={onSubmitTx}
              onNewQuote={() => {
                const d = fundDecision(balance ?? 0n, plan.B);
                if (!d.skip) void requestQuote(signer, d.deposit);
              }}
            />
          ) : (
            <p className="muted">{busy === 'quote' ? 'Requesting a deposit address…' : 'No deposit address yet.'}</p>
          )}
        </section>
      ) : null}

      {signer && plan && step === 'seal' ? (
        <section className="card" style={{ marginTop: 16 }} aria-label="Seal">
          <h3>4. Seal</h3>
          {plan.pasted ? (
            <p className="result ok">Using your pasted sealed bid. The browser never saw its price.</p>
          ) : (
            <button type="button" className="primary" onClick={doSeal} disabled={busy !== null}>
              {busy === 'seal' ? 'Sealing…' : 'Seal in this browser'}
            </button>
          )}
          {plan.pasted ? (
            <div style={{ marginTop: 8 }}>
              <button type="button" className="primary" onClick={() => setStep('sign')}>
                Continue to signing
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {signer && plan && sealed && (step === 'sign' || step === 'relay' || step === 'done') ? (
        <section className="card" style={{ marginTop: 16 }} aria-label="Sign">
          <h3>5. Sign one transfer</h3>
          <p className="result ok">
            {plan.pasted ? 'Sealed bid pasted' : 'Sealed in your browser'} · ciphertext <span className="mono">{ctPreview}…</span>
          </p>
          <p className="small muted">
            One Intents <code>Transfer</code> of {formatUsdc(plan.B)} USDC to <span className="mono">{config.tenderContractId}</span> carrying your sealed
            bid. It expires in 10 minutes; sign and send right away.
          </p>
          {step === 'sign' ? (
            <button type="button" className="primary" onClick={doSign} disabled={busy !== null}>
              {busy === 'sign' ? 'Waiting for wallet…' : recovery?.to === 'sign_again' ? 'Sign again' : 'Sign with wallet'}
            </button>
          ) : null}
          {recovery?.to === 'register_key' ? (
            <div style={{ marginTop: 8 }}>
              <button type="button" className="primary" onClick={doRegisterKey} disabled={busy !== null}>
                {busy === 'register' ? 'Waiting for wallet…' : 'Register this key with NEAR Intents (1 yoctoNEAR)'}
              </button>
            </div>
          ) : null}
          {recovery?.to === 'retry' && signed ? (
            <div style={{ marginTop: 8 }}>
              <button type="button" onClick={() => void doPreflightAndRelay(signed)} disabled={busy !== null}>
                Try the relayer again
              </button>
            </div>
          ) : null}
          {busy === 'relay' ? <p className="muted">Checking with simulate_intents, then relaying…</p> : null}
        </section>
      ) : null}

      {step === 'done' ? (
        <section className="card" style={{ marginTop: 16 }} aria-label="Result">
          <h3>6. Result</h3>
          {txHash ? (
            <p className="small">
              Relay transaction <TxLink hash={txHash} />
            </p>
          ) : null}
          {stored ? (
            <p className="result ok">Bid #{stored.idx} stored · Sealed</p>
          ) : (
            <p className="result bad">
              Not stored: the contract refunded the transfer (see tx logs){txHash ? <> · <TxLink hash={txHash} /></> : null}
            </p>
          )}
          <p className="small muted">Anyone can relay a signed payload from their own account; the relayer cannot change it.</p>
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
