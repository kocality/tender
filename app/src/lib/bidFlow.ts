import type { MultiPayload } from '@tender/intents';
import { parseUnits, priceToP } from './amounts';
import { config } from '../config';
import { humanError } from './errors';
import type { RelayKind } from './relay';
import { depositAmountFor } from './oneclick';
import type { Bid, Sale } from './views';

// Pure decisions of the bid wizard: what to validate, when funding is skipped and where each failure sends the user.

export const MIN_ESCROW = 1_000_000n; // 1 USDC per bid (the contract refunds anything smaller)
const MAX_ESCROW_TOTAL = 1_000_000_000_000n; // contract cap on the sum of a sale's escrows (1,000,000 USDC)
/** The bid is not worth sending in the last minute: the chain clock lags and the relay queue is serial. */
export const CLOSE_MARGIN_NS = 60_000_000_000n;
/** Micro-USDC that must stay in the Intents account after the bid: it pays the 1 micro-USDC self-reveal transfer (I9). */
export const SELF_REVEAL_RESERVE = 1n;
const U64_MAX = (1n << 64n) - 1n;

export type Step = 'wallet' | 'bid' | 'fund' | 'seal' | 'sign' | 'relay' | 'done';

export const STEPS: { id: Step; label: string }[] = [
  { id: 'wallet', label: 'Connect your wallet' },
  { id: 'bid', label: 'Choose your price' },
  { id: 'fund', label: 'Move USDC in' },
  { id: 'seal', label: 'Seal your bid' },
  { id: 'sign', label: 'Sign once' },
  { id: 'relay', label: 'Relay' },
  { id: 'done', label: 'Bid stored' },
];

export type BidValidation =
  | { ok: true; p: bigint; q: bigint; B: bigint; warnings: string[] }
  | { ok: false; errors: string[] };

/**
 * Checks the form against the sale. `q` is the most the bidder will spend (USDC), `B` the escrow that is locked.
 * Chain time (`nowNs`) decides whether the sale is still open for bids.
 */
export function validateBid(o: {
  priceText: string;
  sizeText: string;
  escrowText: string;
  sale: Pick<Sale, 'state' | 'closeNs' | 'reserve' | 'lotExp'>;
  nowNs: bigint;
}): BidValidation {
  const errors: string[] = [];
  let p = 0n;
  let q = 0n;
  let B = 0n;
  try {
    p = priceToP(o.priceText, o.sale.lotExp);
  } catch (e) {
    errors.push(`Price: ${(e as Error).message}`);
  }
  try {
    q = parseUnits(o.sizeText, 6);
  } catch (e) {
    errors.push(`Size: ${(e as Error).message}`);
  }
  try {
    B = parseUnits(o.escrowText, 6);
  } catch (e) {
    errors.push(`Escrow: ${(e as Error).message}`);
  }
  if (errors.length === 0) {
    if (B < MIN_ESCROW) errors.push('Escrow must be at least 1 USDC.');
    if (q < 1n) errors.push('Size must be above zero.');
    if (q > B) errors.push('Size cannot exceed the escrow.');
    if (q > U64_MAX) errors.push('Size is too large.');
  }
  if (o.sale.state !== 'Open') errors.push(`This sale is ${o.sale.state}; it no longer takes bids.`);
  else if (o.nowNs >= o.sale.closeNs) errors.push('This sale is closed.');
  if (errors.length > 0) return { ok: false, errors };
  const warnings: string[] = [];
  if (p < o.sale.reserve) {
    warnings.push(
      'Below reserve: this bid will not win and will be refunded in full once it is revealed; it still counts toward the public open conditions.',
    );
  }
  if (q === B) {
    warnings.push('Escrow equals size, so your size is public: the escrow is visible on chain before close. Set the escrow above your size to keep the size sealed.');
  }
  return { ok: true, p, q, B, warnings };
}

/** Which input a validation message belongs to (they start with "Price:", "Size:" or "Escrow:"); `null` for messages about the sale. */
export function fieldOfError(message: string): 'price' | 'size' | 'escrow' | null {
  if (message.startsWith('Price')) return 'price';
  if (message.startsWith('Size')) return 'size';
  if (message.startsWith('Escrow')) return 'escrow';
  return null;
}

/** First click on a form with warnings shows them; the same values submitted again are confirmed. `seen` is the key of the last warned values. */
export function submitDecision(res: BidValidation, seen: string | null): { action: 'reject' } | { action: 'confirm'; key: string } | { action: 'submit' } {
  if (!res.ok) return { action: 'reject' };
  if (res.warnings.length === 0) return { action: 'submit' };
  const key = `${res.p}/${res.q}/${res.B}/${res.warnings.join('|')}`;
  return seen === key ? { action: 'submit' } : { action: 'confirm', key };
}

/**
 * Why a bid cannot be sent now, from the freshest sale read and chain time; `null` when it still can. The contract
 * refunds a late or surplus bid, but the 1Click fee, the relayer gas and the user's time are spent by then.
 */
export function biddingBlock(
  sale: Pick<Sale, 'state' | 'inFlight' | 'key' | 'closeNs' | 'bids' | 'maxBids' | 'escrowTotal'>,
  nowNs: bigint,
  escrow?: bigint,
): string | null {
  if (sale.state !== 'Open') return `This sale is ${sale.state}; it no longer takes bids.`;
  if (sale.inFlight || sale.key) return 'A key request is under way for this sale; it no longer takes bids.';
  if (nowNs >= sale.closeNs) return 'This sale is closed.';
  if (nowNs + CLOSE_MARGIN_NS >= sale.closeNs) return 'This sale closes in under 60 seconds; a bid sent now would likely arrive after close and be refunded.';
  if (sale.bids >= sale.maxBids) return `This sale already holds its maximum of ${sale.maxBids} bids.`;
  if (escrow !== undefined && sale.escrowTotal + escrow > MAX_ESCROW_TOTAL) return 'This bid would take the sale past its escrow cap.';
  return null;
}

export type FundDecision = { skip: true } | { skip: false; gap: bigint; deposit: bigint };

/** Skip the deposit when the Intents account already holds the escrow and the self-reveal reserve. */
export function fundDecision(balance: bigint, escrow: bigint): FundDecision {
  if (isFunded(balance, escrow)) return { skip: true };
  const gap = escrow + SELF_REVEAL_RESERVE - balance; // at least 1: isFunded failed
  return { skip: false, gap, deposit: depositAmountFor(gap) };
}

/** The escrow plus the self-reveal reserve is in the Intents account. */
export function isFunded(balance: bigint, escrow: bigint): boolean {
  return balance >= escrow + SELF_REVEAL_RESERVE;
}

export type Recovery =
  | { to: 'fund'; message: string }
  | { to: 'register_key'; message: string }
  | { to: 'sign_again'; message: string }
  /** The chain decides (the resolver): the payload ran, may still run, or was refused for a reason only the chain shows. */
  | { to: 'settle'; message: string }
  | { to: 'retry'; message: string }
  | { to: 'fail'; message: string };

/** Where a failed pre-flight simulation or a refused relay sends the user. The message is the one-sentence `humanError` text. */
export function recoveryFor(
  kind: RelayKind,
  detail: string,
  standard?: MultiPayload['standard'],
): Recovery {
  const message = humanError(kind, detail);
  switch (kind) {
    case 'insufficient_balance':
      return { to: 'fund', message };
    case 'public_key_not_registered':
      // Only a named NEAR account has a key to register. For EVM and Solana the same panic means the wallet signed as another account.
      if (standard !== undefined && standard !== 'nep413') {
        return { to: 'fail', message: 'The wallet signed with a different account than the one connected here. Reconnect the wallet and sign again.' };
      }
      return { to: 'register_key', message };
    case 'invalid_salt':
    case 'deadline_expired':
    case 'deadline_gt_nonce':
    case 'nonce_expired':
      return { to: 'sign_again', message };
    case 'nonce_used':
    case 'execute_unknown':
    case 'already_stored':
    case 'bid_seq':
      return { to: 'settle', message };
    case 'busy':
    case 'unavailable':
    case 'unconfigured':
      return { to: 'retry', message };
    default:
      return { to: 'fail', message };
  }
}

/** The step the wizard shows after a failed relay: back at Sign, where the retry and recovery buttons live, unless it re-enters funding. */
export function stepAfterRelayFailure(r: Recovery): Step {
  return r.to === 'fund' ? 'fund' : 'sign';
}

/** Registering a key only helps a named NEAR account, and only when that account is the one connected. */
export function canRegisterKey(signed: MultiPayload, connectedId: string | undefined): boolean {
  if (signed.standard !== 'nep413') return false;
  try {
    return connectedId !== undefined && (JSON.parse(signed.payload.message) as { signer_id?: unknown }).signer_id === connectedId;
  } catch {
    return false;
  }
}

/** The stored bid with this signer and commitment, if any: signing the same sealed bid again would escrow it twice (the contract keeps both and one opening reveals both). */
export function storedCopy(bids: Pick<Bid, 'idx' | 'bidder' | 'cm'>[], signerId: string, cm: string): Pick<Bid, 'idx'> | undefined {
  return bids.find((b) => b.bidder === signerId && b.cm === cm);
}

/** Existing bids of this signer in the sale (informational: several bids are allowed). */
export function bidsOf(bids: { bidder: string }[], signerId: string): number {
  return bids.filter((b) => b.bidder === signerId).length;
}

/** What a screen reader hears when the wizard moves on or finishes (one always-mounted status region says it). */
export function announcementFor(step: Step, busy: string | null, stored: Pick<Bid, 'idx'> | null | 'unknown' | undefined): string {
  if (busy === 'relay') return 'Checking the signed bid, then relaying it.';
  if (busy === 'confirm') return 'Relayed. Waiting for the contract to confirm the bid.';
  if (step === 'done') {
    if (stored === undefined) return '';
    if (stored === 'unknown') return 'Could not confirm whether the bid was stored. Use Check again.';
    if (stored === null) return 'Not stored: the contract refunded the transfer, or the bid did not appear in time.';
    return `Bid ${stored.idx} stored, sealed.`;
  }
  if (step === 'wallet') return '';
  const n = STEPS.findIndex((x) => x.id === step) + 1;
  return `Step ${n}: ${STEPS[n - 1]!.label}.`;
}

/** The wizard section whose error message sits next to the action that failed. */
export function problemSection(step: Step, connected: boolean): 'wallet' | 'bid' | 'fund' | 'seal' | 'sign' | 'result' {
  switch (step) {
    case 'fund':
    case 'seal':
      return step;
    case 'sign':
    case 'relay':
      return 'sign';
    case 'done':
      return 'result';
    default:
      return connected ? 'bid' : 'wallet';
  }
}

/** The near-cli line that moves NEAR USDC into the signing account's own Intents balance (1Click cannot fund a NEAR-native balance). */
export function nearFundCommand(o: { amount: bigint; quoteToken: string; signerId: string }): string {
  return `near contract call-function as-transaction ${o.quoteToken.replace(/^nep141:/, '')} ft_transfer_call json-args '{"receiver_id":"${config.intentsContractId}","amount":"${o.amount}","msg":"${o.signerId}"}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${o.signerId} network-config ${config.network} sign-with-legacy-keychain send`;
}
