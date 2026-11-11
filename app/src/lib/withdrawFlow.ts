import {
  buildPayload,
  buildVersionedNonce,
  currentSalt,
  isNonceUsed,
  makeDeadline,
  transferIntent,
  withdrawNonce,
  type DefusePayload,
} from '@tender/intents';
import { config } from '../config';
import { chainNowMs } from './chainClock';
import { parseUnits } from './amounts';
import { finalBlock } from './settle';
import { OneClickError, getStatus, isTerminal, type QuoteResponse, type StatusResponse } from './oneclick';
import { recipientError, type DestChain, type WithdrawSource } from './withdrawRoutes';

// Pure decisions and builders of the withdraw page: validate the form, check a quote, build the one Transfer, follow 1Click.

export type WithdrawValidation = { ok: true; amount: bigint } | { ok: false; errors: string[] };

/** Checks the form. The amount is typed in the source token's own decimals and may not exceed the Intents balance. */
export function validateWithdraw(o: {
  amountText: string;
  source: WithdrawSource;
  balance: bigint | null;
  chain: DestChain;
  recipient: string;
}): WithdrawValidation {
  const errors: string[] = [];
  let amount = 0n;
  try {
    amount = parseUnits(o.amountText, o.source.decimals);
    if (amount <= 0n) errors.push('Amount must be above zero.');
  } catch (e) {
    errors.push(`Amount: ${(e as Error).message}`);
  }
  if (o.balance === null) errors.push('Your Intents balance is not loaded yet.');
  else if (errors.length === 0 && amount > o.balance) errors.push(`Amount is above your Intents balance of this token.`);
  const r = recipientError(o.chain, o.recipient);
  if (r) errors.push(`Recipient: ${r}`);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, amount };
}

/** What the form says while "Get quote" is disabled: an empty amount gets its own sentence instead of silence. */
export function withdrawMessages(check: Extract<WithdrawValidation, { ok: false }>, amountText: string): string[] {
  return amountText.trim() === '' ? ['Enter an amount to withdraw.', ...check.errors.filter((e) => !e.startsWith('Amount'))] : check.errors;
}

/** `null` when the quote can be paid with a Transfer now, else why not. */
export function quoteProblem(quote: QuoteResponse, balance: bigint, nowMs: number = Date.now()): string | null {
  const q = quote.quote;
  if (!q.depositAddress) return '1Click returned no deposit address.';
  if (BigInt(q.amountIn) > balance) return 'The quoted amount is above your Intents balance.';
  if (q.deadline && Date.parse(q.deadline) <= nowMs) return 'This quote has expired. Get a new one.';
  return null;
}

/**
 * The one Intents Transfer that pays a withdrawal quote: exactly `quote.amountIn` of the source token to the quote's
 * `depositAddress` (an Intents account id). No `msg`, so no notification call and no `min_gas`. Salt is read live.
 * With the quote's deadline the nonce is tied to the quote (`withdrawNonce`): every signature of the same quote repeats it, so
 * intents.near runs at most one of them, and the payload never outlives the quote. Without a deadline the nonce is random.
 */
export async function buildWithdrawPayload(o: {
  signerId: string;
  depositAddress: string;
  tokenId: string;
  amountIn: bigint;
  /** The quote's deadline (ms). */
  quoteDeadlineMs?: number;
  saltHex?: string;
  nowMs?: number;
}): Promise<DefusePayload> {
  const saltHex = o.saltHex ?? (await currentSalt(config.rpcUrls, config.intentsContractId));
  const nowMs = o.nowMs ?? chainNowMs();
  if (o.quoteDeadlineMs !== undefined && o.quoteDeadlineMs <= nowMs) throw new Error('This quote has expired. Get a new one.');
  const { deadlineMs, deadlineIso } = makeDeadline(nowMs, 600_000, o.quoteDeadlineMs);
  return buildPayload({
    signerId: o.signerId,
    verifyingContract: config.intentsContractId,
    deadlineIso,
    nonce:
      o.quoteDeadlineMs === undefined
        ? buildVersionedNonce({ saltHex, deadlineMs })
        : withdrawNonce({ saltHex, deadlineMs: o.quoteDeadlineMs, signer: o.signerId, depositAddress: o.depositAddress, tokenId: o.tokenId, amount: o.amountIn }),
    intents: [transferIntent({ receiverId: o.depositAddress, tokenId: o.tokenId, amount: o.amountIn })],
  });
}

/** 1Click lists hashes as strings or as `{hash, explorerUrl}`; keep the hash strings. */
export function txHashes(list: unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const x of list ?? []) {
    const h = typeof x === 'string' ? x : (x as { hash?: unknown } | null)?.hash;
    if (typeof h === 'string' && h !== '') out.push(h);
  }
  return out;
}

export interface WithdrawEvidence {
  step: 'withdraw';
  deposit_address: string;
  near_tx_hashes: string[];
  destination_tx: string | null;
  relay_tx: string | null;
}

export function withdrawEvidence(o: { depositAddress: string; status: StatusResponse; relayTx: string | null }): WithdrawEvidence {
  return {
    step: 'withdraw',
    deposit_address: o.depositAddress,
    near_tx_hashes: o.status.swapDetails?.nearTxHashes ?? [],
    destination_tx: txHashes(o.status.swapDetails?.destinationChainTxHashes)[0] ?? null,
    relay_tx: o.relayTx,
  };
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Polls 1Click every 5 s until a terminal status. The deposit address is unknown to 1Click for a few seconds, so a
 * 404 is retried; the third 404 in a row is an error. Other network errors are retried until the timeout.
 */
export async function followWithdraw(o: {
  depositAddress: string;
  onStatus?: (s: StatusResponse) => void;
  fetchStatus?: (depositAddress: string) => Promise<StatusResponse>;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  maxNotFound?: number;
  maxPolls?: number;
}): Promise<StatusResponse> {
  const { fetchStatus = getStatus, sleep = sleepMs, intervalMs = 5000, maxNotFound = 3, maxPolls = 120 } = o;
  let notFound = 0;
  for (let i = 0; i < maxPolls; i++) {
    try {
      const st = await fetchStatus(o.depositAddress);
      notFound = 0;
      o.onStatus?.(st);
      if (isTerminal(st.status)) return st;
    } catch (e) {
      if (e instanceof OneClickError && e.status === 404) {
        notFound++;
        if (notFound >= maxNotFound) throw new Error('1Click does not know this deposit address (404 three times in a row).');
      }
    }
    await sleep(intervalMs);
  }
  throw new Error('1Click did not finish in 10 minutes. The withdrawal may still complete; check the deposit address status.');
}

export type WithdrawVerdict = { kind: 'ran' } | { kind: 'pending'; untilMs: number } | { kind: 'dead' } | { kind: 'unknown' };

/**
 * What the chain says about a signed withdrawal. `used` is whether intents.near has run its nonce (`null` when the read failed),
 * `nowMs` is chain time. Only `dead` frees "Get a new quote": a payload that can still land would pay the old deposit address.
 */
export function withdrawVerdict(o: { used: boolean | null; nowMs: number; deadlineMs: number }): WithdrawVerdict {
  if (o.used === null) return { kind: 'unknown' };
  if (o.used) return { kind: 'ran' };
  return o.nowMs <= o.deadlineMs ? { kind: 'pending', untilMs: o.deadlineMs } : { kind: 'dead' };
}

/** One read at one final block of the signed withdrawal's nonce, then the verdict. */
export async function settleWithdraw(o: { signerId: string; nonceB64: string; deadlineMs: number }): Promise<WithdrawVerdict> {
  try {
    const b = await finalBlock();
    const used = await isNonceUsed(config.rpcUrls, config.intentsContractId, o.signerId, o.nonceB64, { blockId: b.height });
    return withdrawVerdict({ used, nowMs: b.tsMs, deadlineMs: o.deadlineMs });
  } catch {
    return { kind: 'unknown' };
  }
}
