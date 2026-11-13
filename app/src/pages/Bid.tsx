import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { currentSalt, fromBase64, mtBalanceOf, simulateIntents, toHex, type MultiPayload } from '@tender/intents';
import { BidForm, type BidFormValues } from '../components/BidForm';
import { CopyButton } from '../components/CopyButton';
import { DepositBox } from '../components/DepositBox';
import { Loading, ReadError } from '../components/Feedback';
import { PasteSealedBid } from '../components/PasteSealedBid';
import { Rich } from '../components/Rich';
import { saleEyebrow } from '../components/SaleCard';
import { StepList } from '../components/StepList';
import { TxLink } from '../components/TxLink';
import { WalletPicker } from '../components/WalletPicker';
import { config } from '../config';
import { HOSTED_BUNDLE, NOT_STORED_CAUSES, UNRECOVERABLE_TRANSFER, originBadge } from '../copy';
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
  storedCopy,
  type Recovery,
  type Step,
} from '../lib/bidFlow';
import { useChainClock } from '../lib/chainClock';
import { humanError } from '../lib/errors';
import { formatCountdown, formatNsUtc, formatPrice, formatUnits, formatUsdc, shortId, tokenLabel, tokenSymbol } from '../lib/format';
import { priceUnitLabel } from '../lib/amounts';
import { loadSaleBundle, type SaleBundle } from '../lib/loaders';
import { addIntentsKey } from '../lib/near-tx';
import { getStatus, isTerminal, quoteDeposit, submitDeposit, type QuoteResponse, type StatusResponse } from '../lib/oneclick';
import type { PastedBid } from '../lib/pasteSealed';
import { clearQuote, loadQuote, quoteKey, reusableQuote, saveQuote, shouldWarnOnUnload } from '../lib/quoteStore';
import { RelayError, relay, type RelayKind } from '../lib/relay';
import { sealWithConfig } from '../lib/sealBid';
import { chainIO, isFinal, offers, pendingText, preSign, readBids, readForSign, refundedText, routeFailure, settle as settleChain, type BidRow, type Settled } from '../lib/settle';
import { claimTicket, clearTicket, loadTicket, saveTicket, type Ticket } from '../lib/ticket';
import { usePolling } from '../lib/usePolling';
import { getConfig, type Bid, type Sale } from '../lib/views';
import type { IntentSigner } from '../wallets/types';

interface Plan {
  /** Escrow B in micro-USDC; the amount of the one transfer. */
  B: bigint;
  /** Wizard bids carry p and q until they are sealed; a pasted bid is already sealed. */
  secret: { p: bigint; q: bigint } | null;
  pasted: PastedBid | null;
  /** How many bids this account had in the sale when the plan began; fixed for the whole plan (fund, re-seal, re-sign). */
  seq: number;
}

interface Sealed {
  ct: string;
  cm: string;
  origin: 'base' | 'arb' | 'sol' | 'near';
}

/** HH:MM UTC of an instant. */
const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16) + ' UTC';

const ALL = { sign: true, fund: true, seal: true, another: true };

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
    <div className="wrap page">
      <p className="crumb">
        <a href={`#/sale/${id}`}>← Sale #{id}</a>
      </p>
      <header className="page-head">
        <p className="eyebrow">{saleEyebrow(id)}</p>
        <h1>Bid on sale #{id}</h1>
        {sale ? <SaleStrip sale={sale} nowNs={nowNs} /> : null}
      </header>
      <ReadError error={error} stale={data !== null} compact />
      {loading && !data ? <Loading what="sale" /> : null}
      {data && !sale ? <p className="note">Sale #{id} does not exist yet.</p> : null}
      {sale ? <Wizard id={id} sale={sale} bids={data?.bids ?? []} nowNs={nowNs} synced={synced} fundOnly={fundOnly} /> : null}
    </div>
  );
}

/** The sale in one line: what is sold, the lowest price, the clock and the public open conditions. */
function SaleStrip({ sale, nowNs }: { sale: Sale; nowNs: bigint }) {
  const token = tokenSymbol(sale.token);
  const open = sale.state === 'Open' && nowNs < sale.closeNs;
  return (
    <>
      <p className="sale-strip small">
        <span>
          <strong className="mono">
            {formatUnits(sale.supply, sale.decimals)} {token}
          </strong>{' '}
          for sale
        </span>
        <span>
          minimum price <strong className="mono">{formatPrice(sale.reserve)}</strong> {priceUnitLabel(token, sale.lotExp)}
        </span>
        <span>
          {open ? (
            <>
              closes in{' '}
              <strong className="countdown" aria-live="off">
                {formatCountdown(sale.closeNs - nowNs)}
              </strong>{' '}
              · closes {formatNsUtc(sale.closeNs)}
            </>
          ) : (
            <>closed {formatNsUtc(sale.closeNs)}</>
          )}
        </span>
        <span>
          opens if deposits reach <strong className="mono">{formatUsdc(sale.minEscrow)} USDC</strong> and <strong className="mono">{sale.minBidders}</strong>{' '}
          {sale.minBidders === 1 ? 'bidder' : 'bidders'} (now{' '}
          <span className="mono">
            {formatUsdc(sale.escrowTotal)} USDC, {sale.bidders} {sale.bidders === 1 ? 'bidder' : 'bidders'}
          </span>
          )
        </span>
      </p>
      <p className="small muted" style={{ margin: '8px 0 0' }}>
        {tokenSymbol(sale.token) !== tokenLabel(sale.token) ? (
          <>
            Token <span className="mono">{tokenLabel(sale.token)}</span> ·{' '}
          </>
        ) : null}
        Seller <span className="mono">{sale.seller}</span>
        {config.teamAccounts.includes(sale.seller) ? ' · team-funded demo sale' : ''}
        {sale.state === 'Open'
          ? ` · after close anyone can open the sale; bids are revealed in a window of at least ${Number(sale.revealSecs) / 3600} hours after the key is released.`
          : ''}
      </p>
    </>
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
  const [stored, setStored] = useState<Pick<Bid, 'idx' | 'cm'> | null | 'unknown' | undefined>(undefined);
  /** The saved ticket of the live sealed bid (DOUBLE-PLAN step 6) and what the chain said about it last. */
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [verdict, setVerdict] = useState<Settled | null>(null);
  /** The account already has bids: the named confirmation that precedes a deliberate additional bid. */
  const [extra, setExtra] = useState<{ plan: Plan; mine: BidRow[] } | null>(null);
  /** The chain read before Fund failed: nothing was quoted; "Check again" repeats it. */
  const [again, setAgain] = useState<{ plan: Plan; confirmed: number | null } | null>(null);
  /** More bids of this account are stored than the plan's seq: they are named and the user chooses. */
  const [stale, setStale] = useState<number[] | null>(null);
  const [remembers, setRemembers] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const quoting = useRef(false);
  const terminal = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const firstStep = useRef(true);
  /** Bumped by every reset: an answer that arrives for an earlier account or bid is dropped. */
  const flow = useRef(0);
  const ticketRef = useRef<Ticket | null>(null);
  /** The deadline (ms) of the payload the wallet just signed. */
  const deadlineRef = useRef<number>(0);
  /** What the form holds right now, for the "Who sees what" panel only. */
  const [draft, setDraft] = useState({ price: '', size: '', escrow: '' });

  const rpc = config.rpcUrls;
  const quoteToken = sale.quoteToken;

  // The sale is re-read every 5 s and the clock every second: whatever the wizard did before, a bid is only sent while the sale can still take it.
  const block = biddingBlock(sale, nowNs, plan?.B);
  const live = block === null;
  const liveRef = useRef(live);
  liveRef.current = live;
  // What the chain allows next. Once a payload of the plan was sent (or the chain was asked about it), only the same-nonce Sign and
  // "Check the chain" are open until the verdict is final; a first send that has not happened yet gates nothing.
  const gate = verdict ? offers(verdict) : ticket?.sent ? offers({ kind: 'unknown' }) : ALL;
  const gateRef = useRef(gate);
  gateRef.current = gate;

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
    const key = quoteKey(config.network, id, s.signerId, s.origin);
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
  const enterFund = async (s: IntentSigner, p: Plan, reopened = false) => {
    if (!reopened && !gateRef.current.fund) return;
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
    ticketRef.current = null;
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
    setTicket(null);
    setVerdict(null);
    setExtra(null);
    setAgain(null);
    setStale(null);
    setNotice(null);
  };

  const ticketKeyFor = (s: IntentSigner) => ({ network: config.network, contract: config.tenderContractId, sale: id, saleCreatedNs: String(sale.createdNs), signer: s.signerId });

  /** Changes the live ticket (memory and the browser's storage). Blocked storage only means the page will not remember it. */
  const update = (patch: Partial<Ticket>): Ticket => {
    const t = { ...ticketRef.current!, ...patch };
    ticketRef.current = t;
    setTicket(t);
    if (!saveTicket(t)) setRemembers(false);
    return t;
  };

  /** What the chain said: a final verdict closes the ticket; an unclear one keeps the gate shut. */
  const showVerdict = (v: Settled, t: Ticket) => {
    setVerdict(v);
    if (v.kind === 'stored') {
      clearTicket(t);
      setStored({ idx: v.idx, cm: v.cm });
      setProblem(null);
      setRecovery(null);
      setStale(null);
      setStep('done');
    } else if (v.kind === 'refunded') {
      clearTicket(t);
      setStored(null);
      setProblem(null);
      setRecovery(null);
      setStep('done');
    } else if (v.kind === 'dead') {
      clearTicket(t);
      setStep('sign');
    }
  };

  /** The one resolver: ask the chain what became of the live bid. `quiet` is the background poll (no busy flag). */
  const runSettle = async (quiet = false): Promise<void> => {
    const t = ticketRef.current;
    if (!t) return;
    const g = flow.current;
    if (!quiet) setBusy('confirm');
    try {
      const r = await settleChain(chainIO(t), t);
      if (g !== flow.current) return;
      showVerdict(r.verdict, r.usedSeenMs !== t.usedSeenMs ? update({ usedSeenMs: r.usedSeenMs }) : t);
    } finally {
      if (!quiet && g === flow.current) setBusy(null);
    }
  };

  /** A saved bid of this account in this sale: back to its Sign step, and the chain is asked before anything else is offered. */
  const restore = (t: Ticket, why?: string) => {
    ticketRef.current = t;
    setTicket(t);
    setPlan({ B: BigInt(t.B), secret: null, pasted: null, seq: t.seq });
    setSealed({ ct: t.ct, cm: t.cms[t.cms.length - 1]!, origin: t.origin });
    setVerdict(null);
    setStale(null);
    setNotice(why ?? 'Found a bid you sealed earlier in this browser. The page is asking the chain what became of it before it offers anything else.');
    setStep('sign');
    void runSettle();
  };

  /** Writes the ticket of a freshly sealed bid. `false` when another tab already holds a live bid for this sale and account: that one is shown. */
  const openTicket = (a: { cm: string; ct: string; B: bigint; origin: Sealed['origin']; intentsSalt: string; seq: number }): boolean => {
    const base = ticketRef.current;
    const t: Ticket = {
      v: 1,
      ...ticketKeyFor(signer!),
      cms: base ? [...base.cms.filter((c) => c !== a.cm), a.cm] : [a.cm],
      ct: a.ct,
      B: String(a.B),
      origin: a.origin,
      intentsSalt: a.intentsSalt,
      seq: a.seq,
      closeNs: String(sale.closeNs),
      sent: false,
      payloadDeadlineMs: null,
      txHashes: [],
      relayer: null,
      usedSeenMs: null,
    };
    const c = claimTicket(t, base !== null);
    setRemembers(c.saved);
    if (c.restored) {
      restore(c.ticket, 'Another tab of this browser already holds a bid for this sale. It is shown here instead of a second one.');
      return false;
    }
    ticketRef.current = c.ticket;
    setTicket(c.ticket);
    setVerdict(null);
    return true;
  };

  // A new connection is a new account: nothing signed, quoted or recovered for the old one may be relayed or paid for it.
  const onConnect = (s: IntentSigner) => {
    resetFlow();
    setSigner(s);
    const saved = loadTicket(ticketKeyFor(s));
    if (saved && saved.closeNs === String(sale.closeNs)) restore(saved);
    else setStep('bid');
  };

  const placeAnother = () => {
    if (ticketRef.current) clearTicket(ticketRef.current);
    resetFlow();
    setStep('bid');
  };

  /**
   * The chain read that precedes every quote and deposit: a saved bid is restored, an account that already has bids gets a named
   * confirmation, and a read that fails asks for nothing. `confirmed` is the bid count the user confirmed.
   */
  const precheck = async (s: IntentSigner, p: Plan, confirmed: number | null) => {
    const g = flow.current;
    setBusy('check');
    setProblem(null);
    setExtra(null);
    setAgain(null);
    let handedOver = false;
    try {
      const saved = loadTicket(ticketKeyFor(s));
      if (saved && saved.closeNs === String(sale.closeNs)) {
        handedOver = true; // the resolver owns the busy flag from here
        restore(saved);
        return;
      }
      const r = await readBids(id);
      if (g !== flow.current) return;
      if (!r) {
        setProblem('The chain could not be read, so no deposit address or signature was requested. Check again.');
        setAgain({ plan: p, confirmed });
        return;
      }
      const mine = r.bids.filter((b) => b.bidder === s.signerId);
      if (p.pasted) {
        const dup = mine.find((b) => b.cm === p.pasted!.cm);
        if (dup) {
          setProblem(`This sealed bid is already stored as #${dup.idx}. Pasting it again would escrow it twice.`);
          return;
        }
        if (p.pasted.seq !== mine.length) {
          setProblem(
            `This file was sealed when you had ${p.pasted.seq} bid${p.pasted.seq === 1 ? '' : 's'} in this sale; you have ${mine.length} now, so the contract would refund it. Re-run \`pnpm seal:bid\` and paste its new output.`,
          );
          return;
        }
        setPlan(p);
        setSealed({ ct: p.pasted.ct, cm: p.pasted.cm, origin: p.pasted.origin ?? s.origin });
        await enterFund(s, p);
        return;
      }
      if (mine.length > 0 && confirmed !== mine.length) {
        setExtra({ plan: p, mine });
        return;
      }
      const next = { ...p, seq: mine.length };
      setPlan(next);
      await enterFund(s, next);
    } catch (e) {
      if (g === flow.current) fail(e);
    } finally {
      if (!handedOver && g === flow.current) setBusy(null);
    }
  };

  const onForm = (v: BidFormValues) => {
    if (!signer) return;
    const why = biddingBlock(sale, nowNs, v.B);
    if (why) {
      setProblem(why);
      return;
    }
    void precheck(signer, { B: v.B, secret: { p: v.p, q: v.q }, pasted: null, seq: 0 }, null);
  };

  const onPasted = (bid: PastedBid) => {
    if (!signer) return;
    const why = biddingBlock(sale, nowNs, bid.escrow);
    if (why) {
      setProblem(why);
      return;
    }
    const dup = storedCopy(bids, signer.signerId, bid.cm);
    if (dup) {
      setProblem(`This sealed bid is already stored as #${dup.idx}. Pasting it again would escrow it twice.`);
      return;
    }
    void precheck(signer, { B: bid.escrow, secret: null, pasted: bid, seq: bid.seq }, null);
  };

  // While funding: follow the 1Click swap and the Intents balance every 5 s. This only reads; no signature is requested here.
  const depositAddress = quote?.quote.depositAddress;
  const qKey = signer ? quoteKey(config.network, id, signer.signerId, signer.origin) : '';
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

  // A bid that may still land is asked about every 5 s until the chain gives a final answer; this only reads.
  const watching = signer !== null && ticket !== null && (ticket.sent || verdict !== null) && !(verdict && isFinal(verdict)) && (step === 'sign' || step === 'relay');
  useEffect(() => {
    if (!watching) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void runSettle(true);
    }, 5000);
    return () => clearInterval(t);
  }, [watching, ticket?.cms.length]);

  // Another tab of this browser may open or finish a bid for this sale and account.
  useEffect(() => {
    if (!signer) return;
    const onStorage = () => {
      const saved = loadTicket(ticketKeyFor(signer));
      if (saved && !ticketRef.current && step === 'bid' && saved.closeNs === String(sale.closeNs)) restore(saved);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [signer, step, sale.closeNs]);

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
      // The Intents salt is pinned now: every signature of this sealed bid must repeat the nonce, and the nonce contains the salt.
      const intentsSalt = await currentSalt(rpc, config.intentsContractId);
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
      if (!openTicket({ cm: out.cm, ct: out.ct, B: plan.B, origin: signer.origin, intentsSalt, seq: plan.seq })) return;
      setSealed({ ct: out.ct, cm: out.cm, origin: signer.origin });
      setStep('sign');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  /** The pasted bid is sealed already: its ticket is written when the user moves on to signing. */
  const continueToSign = () => {
    if (!signer || !plan?.pasted) return;
    const b = plan.pasted;
    if (openTicket({ cm: b.cm, ct: b.ct, B: b.escrow, origin: b.origin ?? signer.origin, intentsSalt: b.intentsSalt, seq: b.seq })) setStep('sign');
  };

  const route = (r: Recovery) => {
    setRecovery(r);
    setProblem(r.message);
    if (r.to === 'fund' && signer && plan) void enterFund(signer, plan);
    setStep(stepAfterRelayFailure(r));
  };

  /** Anything unclear after a send: show the one-sentence reason, keep a retry for an unreachable relayer, and let the chain decide. */
  const askChain = async (kind: RelayKind, message: string, standard: MultiPayload['standard']) => {
    const rec = recoveryFor(kind, message, standard);
    setRecovery(rec.to === 'retry' ? rec : null);
    setProblem(rec.message);
    setStep('sign');
    await runSettle();
  };

  const doPreflightAndRelay = async (mp: MultiPayload) => {
    const g = flow.current;
    const sentBefore = ticketRef.current?.sent === true;
    setBusy('relay');
    setProblem(null);
    setRecovery(null);
    try {
      const sim = await simulateIntents(rpc, config.intentsContractId, [mp]);
      if (g !== flow.current) return;
      if (!sim.ok) {
        // After a send, "not enough balance", "expired", "nonce used" can each mean an earlier signature ran: the chain decides.
        if (routeFailure(sim.kind, sentBefore) === 'settle') await askChain(sim.kind, sim.message, mp.standard);
        else {
          // Nothing was sent and no payload with an invalidated salt can ever run: pin the current salt so "Sign again" is not the same failure.
          if (sim.kind === 'invalid_salt' && ticketRef.current) {
            const s = await currentSalt(rpc, config.intentsContractId).catch(() => null);
            if (g !== flow.current) return;
            if (s && s !== ticketRef.current.intentsSalt) update({ intentsSalt: s });
          }
          route(recoveryFor(sim.kind, sim.message, mp.standard));
        }
        return;
      }
      // From here the payload may land whatever the relayer answers: write that down before it leaves the page.
      if (ticketRef.current) update({ sent: true, payloadDeadlineMs: Math.max(ticketRef.current.payloadDeadlineMs ?? 0, deadlineRef.current) });
      setStep('relay');
      const { txHash: h, sender } = await relay([mp]);
      if (g !== flow.current) return;
      setTxHash(h);
      if (ticketRef.current) update({ txHashes: [...new Set([...ticketRef.current.txHashes, h])], relayer: sender ?? ticketRef.current.relayer });
      clearQuote(qKey);
      await runSettle();
    } catch (e) {
      if (g !== flow.current) return;
      if (e instanceof RelayError) {
        if (e.unknown && ticketRef.current) {
          update({ txHashes: [...new Set([...ticketRef.current.txHashes, ...e.unknown.txHashes])], relayer: e.unknown.sender ?? ticketRef.current.relayer });
        }
        if (e.txHash) setTxHash(e.txHash);
        if (routeFailure(e.kind, true) === 'settle') await askChain(e.kind, e.message, mp.standard);
        else route(recoveryFor(e.kind, e.message, mp.standard));
      } else {
        fail(e);
        setStep('sign');
      }
    } finally {
      if (g === flow.current) setBusy(null);
    }
  };

  // Runs only from the click on "Sign": a signature request is never started by an effect.
  const doSign = async () => {
    const t0 = ticketRef.current;
    if (!signer || !plan || !sealed || !t0) return;
    if (block) {
      setProblem(block);
      return;
    }
    const dup = storedCopy(bids, signer.signerId, sealed.cm);
    if (dup) {
      setProblem(`This sealed bid is already stored as #${dup.idx}; signing it again would escrow it twice.`);
      return;
    }
    const g = flow.current;
    setBusy('check');
    setProblem(null);
    setRecovery(null);
    setStale(null);
    try {
      // The chain is read at one block just before the wallet prompt: a stored copy, a used nonce or a newer bid changes what is offered.
      const pre = preSign(await readForSign(t0), t0);
      if (g !== flow.current) return;
      if ('stored' in pre) {
        showVerdict({ kind: 'stored', idx: pre.stored, cm: pre.cm }, t0);
        return;
      }
      if ('settle' in pre) {
        await runSettle();
        return;
      }
      if ('stale' in pre) {
        setStale(pre.stale);
        return;
      }
      if ('retry' in pre && !pre.signAnyway) {
        setProblem('The chain could not be read, so no signature was requested. Try again in a moment.');
        return;
      }
      setBusy('sign');
      const t = ticketRef.current ?? t0;
      const payload = await buildBidPayload({
        signerId: signer.signerId,
        receiverId: config.tenderContractId,
        quoteToken,
        amount: plan.B,
        sale: id,
        ct: sealed.ct,
        cm: sealed.cm,
        origin: sealed.origin,
        closeNs: sale.closeNs,
        seq: t.seq,
        saltHex: t.intentsSalt,
      });
      const dl = Date.parse(payload.deadline);
      deadlineRef.current = Number.isNaN(dl) ? Date.now() + 600_000 : dl;
      const mp = await signer.sign(payload);
      if (g !== flow.current) return;
      setSigned(mp);
      await doPreflightAndRelay(mp);
    } catch (e) {
      if (g !== flow.current) return;
      fail(e);
    } finally {
      if (g === flow.current) setBusy(null);
    }
  };

  /** "Make this an additional bid": the account's newer bids are accepted as it is and the plan's seq moves to their count. */
  const makeAdditional = () => {
    if (!stale || !ticketRef.current) return;
    update({ seq: stale.length });
    setPlan((p) => (p ? { ...p, seq: stale.length } : p));
    void doSign();
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

  /** Seal the same price again (the contract refunded the first copy): a new commitment, the same plan and seq. */
  const sealAgain = () => {
    const t = ticketRef.current;
    if (t) {
      // The refunded bid's nonce is spent; the new commitment starts unsent. Its ticket is written when it is sealed.
      const fresh = { ...t, sent: false, payloadDeadlineMs: null, txHashes: [], relayer: null, usedSeenMs: null };
      ticketRef.current = fresh;
      setTicket(fresh);
    }
    setStored(undefined);
    setVerdict(null);
    setProblem(null);
    setSigned(null);
    setTxHash(null);
    if (signer && plan) void enterFund(signer, plan, true);
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

  // A sale that stopped taking bids (or closed and waits to be opened) hides the wizard, unless a bid is already under way:
  // its result must stay on screen. Presentation only: every later step keeps its own closed note and guards.
  if ((sale.state !== 'Open' || nowNs >= sale.closeNs) && (step === 'wallet' || step === 'bid')) {
    return closedPanel(id, sale);
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

  const unit = priceUnitLabel(tokenSymbol(sale.token), sale.lotExp);
  const shown = (v: string, suffix: string) => (v.trim() === '' ? 'not set yet' : `${v.trim()} ${suffix}`);
  return (
    <div ref={root} className="bid-flow">
      <div className="sr-only" role="status">
        {announcementFor(step, busy, stored)}
      </div>
      <p className="note bid-honest">
        <strong>Sealed means only you can read your price</strong>, unless 11 of the parties that hold, or ever held, a piece of NEAR&apos;s key work together, or
        this page is a bad copy that reads your price before sealing it. To rule out the second, developers can seal on their own machine with{' '}
        <code>pnpm seal:bid</code> and paste the result here. <a href="#/trust">Who can see your bid</a>
      </p>
      <StepList current={step} failed={step === 'done' && stored !== undefined && !(stored && stored !== 'unknown')} doneLabel={stored === 'unknown' ? 'Not confirmed' : undefined} />
      <div className="bid-main">
        <div className="tabs" role="group" aria-label="How to seal">
          <button type="button" aria-pressed={tab === 'wizard'} onClick={() => setTab('wizard')}>
            Seal here
          </button>
          <button type="button" aria-pressed={tab === 'paste'} onClick={() => setTab('paste')}>
            Paste a sealed bid
          </button>
        </div>

        <section className="card" aria-label="Wallet" data-step="wallet">
          <h2 className="sub">Connect your wallet</h2>
          <WalletPicker signer={signer} onConnect={onConnect} />
          {signer && mine > 0 ? <p className="small muted">You already have {mine} bid{mine === 1 ? '' : 's'} in this sale.</p> : null}
          {problemFor('wallet')}
        </section>

        {signer && (step === 'bid' || step === 'wallet') ? (
          <section className="card" style={{ marginTop: 16 }} aria-label="Bid" data-step="bid">
            <h2 className="sub" tabIndex={-1}>
              Choose your price
            </h2>
            {tab === 'wizard' ? <p className="small muted">Two numbers stay sealed until the sale opens. One is public now.</p> : null}
            {tab === 'wizard' ? (
              <BidForm sale={sale} nowNs={nowNs} disabled={busy !== null} onSubmit={onForm} onDraft={setDraft} />
            ) : (
              <PasteSealedBid saleId={id} signerId={signer.signerId} disabled={busy !== null} onSubmit={onPasted} />
            )}
            {extra ? (
              <div className="result warn" role="status" style={{ marginTop: 8 }}>
                <p style={{ marginTop: 0 }}>
                  You already have {extra.mine.map((b) => `bid #${b.idx}${b.escrow !== undefined ? `, escrow ${formatUsdc(b.escrow)} USDC` : ''}`).join('; ')} in this sale.
                  {' '}This will be an additional bid.
                </p>
                <button type="button" className="primary" disabled={busy !== null} onClick={() => signer && void precheck(signer, extra.plan, extra.mine.length)}>
                  Place an additional bid
                </button>{' '}
                <button type="button" disabled={busy !== null} onClick={() => setExtra(null)}>
                  Cancel
                </button>
              </div>
            ) : null}
            {again ? (
              <div style={{ marginTop: 8 }}>
                <button type="button" disabled={busy !== null} onClick={() => signer && void precheck(signer, again.plan, again.confirmed)}>
                  Check again
                </button>
              </div>
            ) : null}
            {busy === 'check' ? <p className="muted">Reading the chain…</p> : null}
            {problemFor('bid')}
          </section>
        ) : null}

        {signer && plan && step === 'fund' ? (
          <section className="card" style={{ marginTop: 16 }} aria-label="Fund" data-step="fund">
            <h2 className="sub" tabIndex={-1}>
              Move USDC into your Intents account
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
              Seal your bid
            </h2>
            {plan.pasted ? (
              <p className="result ok">Using your pasted sealed bid. The browser never saw its price.</p>
            ) : plan.secret ? (
              <button type="button" className="primary" onClick={doSeal} disabled={busy !== null || !live || !gate.seal}>
                {busy === 'seal' ? 'Sealing…' : 'Seal in this browser'}
              </button>
            ) : (
              <p className="result ok">Using the bid you sealed earlier in this browser.</p>
            )}
            {plan.pasted ? (
              <div style={{ marginTop: 8 }}>
                <button type="button" className="primary" onClick={continueToSign} disabled={!live || !gate.seal}>
                  Continue to signing
                </button>
              </div>
            ) : !plan.secret && sealed && ticket ? (
              // A restored bid (no price in this page) keeps its sealed bid and ticket: back to Sign, same nonce.
              <div style={{ marginTop: 8 }}>
                <button type="button" className="primary" onClick={() => setStep('sign')} disabled={!live || !gate.sign}>
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
              Sign one transfer
            </h2>
            <p className="result ok">
              {plan.pasted ? 'Sealed bid pasted' : 'Sealed in your browser'} · ciphertext <span className="mono">{ctPreview}…</span>
            </p>
            <p className="small muted">
              One Intents <code>Transfer</code> of {formatUsdc(plan.B)} USDC to <span className="mono">{config.tenderContractId}</span> carrying your sealed
              bid. It expires in 10 minutes, or a minute before the sale closes if that is sooner; sign and send right away.
            </p>
            {notice ? <p className="note">{notice}</p> : null}
            {verdict && verdict.kind !== 'stored' && verdict.kind !== 'refunded' ? <p className="note">{pendingText(verdict, hhmm)}</p> : null}
            {ticket && !remembers ? (
              <p className="note">
                This browser will not keep this bid (storage is blocked or this is a private window). If you reload, check the sale&apos;s bid list on the twin view before you fund or sign again.
              </p>
            ) : null}
            {stale ? (
              <div className="result warn" role="status" style={{ marginBottom: 8 }}>
                <p style={{ marginTop: 0 }}>
                  Your account now has {stale.map((i) => `bid #${i}`).join(', ')} in this sale, stored after this bid was prepared, so the contract would refund this one. Keep
                  what is stored, or make this an additional bid on purpose.
                </p>
                <button type="button" onClick={placeAnother}>
                  Keep {stale.map((i) => `#${i}`).join(', ')}
                </button>{' '}
                <button type="button" className="primary" onClick={makeAdditional} disabled={busy !== null}>
                  Make this an additional bid
                </button>
              </div>
            ) : null}
            {step === 'sign' && !stale ? (
              <button type="button" className="primary" onClick={doSign} disabled={busy !== null || !live || !gate.sign}>
                {busy === 'sign' ? 'Waiting for wallet…' : recovery?.to === 'sign_again' ? 'Sign again' : 'Sign with wallet'}
              </button>
            ) : null}
            {verdict?.kind === 'dead' ? (
              <div style={{ marginTop: 8 }}>
                <button type="button" onClick={placeAnother} disabled={busy !== null}>
                  Start over
                </button>
              </div>
            ) : null}
            {ticket && verdict && !isFinal(verdict) ? (
              <div style={{ marginTop: 8 }}>
                <button type="button" onClick={() => void runSettle()} disabled={busy !== null}>
                  Check the chain
                </button>
              </div>
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
            {busy === 'check' && step === 'sign' ? <p className="muted">Reading the chain before the wallet prompt…</p> : null}
            {busy === 'confirm' ? <p className="muted">Asking the chain what became of the bid…</p> : null}
            {step !== 'done' ? closedNote : null}
            {clockNote}
            {problemFor('sign')}
          </section>
        ) : null}

        {step === 'done' ? (
          <section className="card" style={{ marginTop: 16 }} aria-label="Result" data-step="result">
            <h2 className="sub" tabIndex={-1}>
              Result
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
            ) : (
              <p className="result bad" role="alert">
                {verdict?.kind === 'refunded' && refundedText(verdict.why, verdict.other) ? (
                  refundedText(verdict.why, verdict.other)
                ) : (
                  <>
                    Not stored:{' '}
                    {verdict?.kind === 'refunded' && verdict.why !== 'other' && verdict.why !== 'unlogged'
                      ? `the contract refunded this bid (reason ${verdict.why})`
                      : 'the bid did not appear on chain within 90 seconds of its nonce being used, so the contract most likely refunded the transfer (see tx logs)'}
                    {txHash ? <> · <TxLink hash={txHash} /></> : null}. {NOT_STORED_CAUSES}
                  </>
                )}
              </p>
            )}
            <p className="small muted">Anyone can relay a signed payload from their own account; the relayer cannot change it.</p>
            <div style={{ marginTop: 8 }}>
              {stored && stored !== 'unknown' ? (
                <button type="button" onClick={placeAnother} disabled={busy !== null || !gate.another}>
                  Place another bid
                </button>
              ) : (
                <>
                  {plan?.secret && gate.seal && !(verdict?.kind === 'refunded' && verdict.why === 'bid_seq') ? (
                    <>
                      <button type="button" className="primary" onClick={sealAgain} disabled={busy !== null || !live}>
                        Seal again
                      </button>{' '}
                    </>
                  ) : null}
                  <button type="button" onClick={placeAnother} disabled={busy !== null}>
                    Start over
                  </button>
                </>
              )}
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
      <aside className="bid-side">
        <section className="card pad" aria-label="Who sees what">
          <h2 className="sub">Who sees what</h2>
          <p className="eyebrow">Sealed until the sale opens</p>
          <dl className="kv-rows">
            <dt>Your price</dt>
            <dd className="mono">{shown(draft.price, unit)}</dd>
            <dt>Most you spend</dt>
            <dd className="mono">{shown(draft.size, 'USDC')}</dd>
          </dl>
          <p className="eyebrow">Everyone, from now on</p>
          <dl className="kv-rows">
            <dt>Deposit</dt>
            <dd className="mono">{shown(draft.escrow, 'USDC')}</dd>
            <dt>Account</dt>
            <dd className={signer ? 'mono' : 'muted'}>{signer ? shortId(signer.signerId, 8, 6) : 'shown after you connect'}</dd>
            <dt>Chain</dt>
            <dd className={signer ? undefined : 'muted'}>{signer ? originBadge(signer.origin) : 'shown after you connect'}</dd>
          </dl>
          <p className="small muted side-note">
            Sealed means only you can read it, unless 11 of the parties that hold, or ever held, a piece of NEAR&apos;s key work together (11 of 16 nodes on
            2026-11-10; <code>pnpm verify</code> prints today&apos;s count), or this page is a bad copy that reads your price before sealing it.{' '}
            <a href="#/trust">Who can see your bid →</a>
          </p>
          <p className="small muted side-note">
            <Rich text={UNRECOVERABLE_TRANSFER} />
          </p>
          <details className="fold tech side-note">
            <summary>If you do not trust this page</summary>
            <p className="small muted">
              <Rich text={HOSTED_BUNDLE} />
            </p>
          </details>
        </section>
        <section className="card pad" aria-label="After you bid">
          <h2 className="sub">After you bid</h2>
          <ol className="tl-vertical small">
            <li className={sale.state === 'Open' && nowNs < sale.closeNs ? 'now' : 'done'}>
              Sale takes bids{sale.state === 'Open' && nowNs < sale.closeNs ? ` · ${formatCountdown(sale.closeNs - nowNs)} left` : ''}
            </li>
            <li>Sale closes. It opens only if its public conditions hold; otherwise it is cancelled and every bid is refunded in full</li>
            <li>Key released; anyone can open the bids</li>
            <li>Bids are revealed: our keeper normally does it, you can too. An unrevealed bid can lose 10%</li>
            <li>One price; unspent USDC back</li>
          </ol>
        </section>
      </aside>
    </div>
  );
}

/** The bid page of a sale that no longer takes bids: why, and where to go instead (no dead end). */
function closedPanel(id: string, sale: Sale): ReactNode {
  const STATE_WORD = { Open: 'closed', Opening: 'closed and its key is being asked for', Keyed: 'closed and opened', Finalized: 'finished', Cancelled: 'cancelled' } as const;
  const head = `This sale is ${STATE_WORD[sale.state]}; it no longer takes bids.`;
  const next =
    sale.state === 'Open'
      ? 'Anyone can now open it if it met its public conditions, or cancel it if it did not. Both buttons are on the sale page.'
      : sale.state === 'Finalized'
        ? 'Its bids were opened and one price was set: the sale page shows who got what.'
        : sale.state === 'Keyed'
          ? 'Its key is public: anyone can open the bids on the sale page.'
          : sale.state === 'Opening'
            ? "Its key has been asked for; the sale page shows when it arrives."
            : 'Every bid is refunded in full; the sale page shows the refunds.';
  return (
    <div className="card pad empty-state" role="status">
      <p className="empty-title">{head}</p>
      <p className="muted">
        {next} You can still sign a practice bid with your own wallet: it is free and nothing is sent.
      </p>
      <p className="empty-actions">
        <a className="btn primary" href={`#/sale/${id}`}>
          {sale.state === 'Finalized' ? 'See the result' : 'Open the sale page'}
        </a>
        <a className="btn" href="#/try">
          Try signing (free)
        </a>
      </p>
    </div>
  );
}
