import { config } from '../config';

// 1Click (NEAR Intents swap API): quote a deposit address, follow its status. No JWT, CORS open.
// Request bodies carry no `confidentiality` field (the API default applies).

export type DepositOrigin = 'base' | 'arb' | 'sol';

/** USDC on each origin chain, as the Intents token ids 1Click expects (6 decimals). */
export const ORIGIN_ASSET: Record<DepositOrigin, string> = {
  base: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  arb: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
  sol: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
};

/** Contract address (or mint) of the origin USDC, shown next to the deposit address so the right token is sent. */
export const ORIGIN_TOKEN_ADDRESS: Record<DepositOrigin, string> = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  arb: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  sol: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

export const ORIGIN_CHAIN_NAME: Record<DepositOrigin, string> = { base: 'BASE', arb: 'ARBITRUM', sol: 'SOLANA' };

const TEN_THOUSAND = 10_000n;
const QUOTE_TTL_MS = 30 * 60_000;
const SLIPPAGE_BPS = 100n;

const roundUpCent = (v: bigint) => ((v + TEN_THOUSAND - 1n) / TEN_THOUSAND) * TEN_THOUSAND;

/**
 * What to send from the origin chain so that, after the swap fee and slippage, the Intents balance still covers the
 * gap: gap plus 1 %, rounded up to 0.01 USDC, plus 0.05 USDC (I9). Any surplus stays in the Intents account. For gaps
 * above about 495 USDC that does not survive the quote's own 1 % slippage, so the amount is raised until 99 % of it covers the gap.
 */
export function depositAmountFor(gapMicro: bigint): bigint {
  const i9 = roundUpCent((gapMicro * 101n + 99n) / 100n) + 50_000n;
  const worstCase = (d: bigint) => (d * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  if (worstCase(i9) >= gapMicro) return i9;
  return roundUpCent((gapMicro * 10_000n + (10_000n - SLIPPAGE_BPS) - 1n) / (10_000n - SLIPPAGE_BPS)) + 50_000n;
}

/** How far the quote's guaranteed minimum falls short of what the Intents account still needs; 0 when it covers it. */
export function quoteShortfall(minAmountOut: string, need: bigint): bigint {
  const min = BigInt(minAmountOut);
  return min >= need ? 0n : need - min;
}

export interface QuoteResponse {
  correlationId?: string;
  timestamp?: string;
  signature?: string;
  quoteRequest?: unknown;
  quote: {
    depositAddress?: string;
    depositMemo?: string;
    amountIn: string;
    amountInFormatted?: string;
    minAmountIn?: string;
    amountOut: string;
    amountOutFormatted?: string;
    minAmountOut: string;
    deadline?: string;
    timeWhenInactive?: string;
    timeEstimate?: number;
    refundFee?: string;
    withdrawFee?: string;
  };
}

export type SwapStatus = 'KNOWN_DEPOSIT_TX' | 'PENDING_DEPOSIT' | 'INCOMPLETE_DEPOSIT' | 'PROCESSING' | 'SUCCESS' | 'REFUNDED' | 'FAILED';

export interface StatusResponse {
  status: SwapStatus;
  updatedAt?: string;
  swapDetails?: {
    intentHashes?: string[];
    nearTxHashes?: string[];
    originChainTxHashes?: unknown[];
    destinationChainTxHashes?: unknown[];
    amountOut?: string;
    refundedAmount?: string;
    refundReason?: string;
    depositedAmount?: string;
  };
}

/** Statuses after which polling stops. */
export const TERMINAL = ['SUCCESS', 'REFUNDED', 'FAILED', 'INCOMPLETE_DEPOSIT'] as const;

export function isTerminal(status: string): boolean {
  return (TERMINAL as readonly string[]).includes(status);
}

export class OneClickError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'OneClickError';
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${config.oneClickApiUrl}${path}`, init);
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { message?: string };
      if (typeof j.message === 'string') message = j.message;
    } catch {
      // keep the raw text
    }
    throw new OneClickError(`1Click ${res.status}: ${message || res.statusText}`, res.status);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** Request body of a deposit quote; exported so tests can assert its shape. */
export function depositQuoteBody(o: {
  origin: DepositOrigin;
  amount: bigint;
  quoteToken: string;
  refundTo: string;
  recipient: string;
  dry: boolean;
  nowMs?: number;
}) {
  return {
    dry: o.dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: Number(SLIPPAGE_BPS),
    originAsset: ORIGIN_ASSET[o.origin],
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: o.quoteToken,
    amount: o.amount.toString(),
    refundTo: o.refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: o.recipient,
    recipientType: 'INTENTS',
    deadline: new Date((o.nowMs ?? Date.now()) + QUOTE_TTL_MS).toISOString(),
  };
}

/**
 * Quote USDC on `origin` into the Intents account `recipient` (the signer id). `refundTo` is the origin wallet address.
 * `quoteToken` is the sale's quote token, read live from get_config().
 */
export async function quoteDeposit(o: {
  origin: DepositOrigin;
  amount: bigint;
  quoteToken: string;
  refundTo: string;
  recipient: string;
  dry: boolean;
}): Promise<QuoteResponse> {
  return call<QuoteResponse>('/v0/quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(depositQuoteBody(o)),
  });
}

/**
 * Request body of a withdrawal quote: tokens already in the signer's Intents account leave to a chain address.
 * `originAsset` is an Intents token id, `refundTo` the signer's Intents account id, `recipient` a chain address.
 */
export function withdrawQuoteBody(o: {
  originAsset: string;
  destinationAsset: string;
  amount: bigint;
  signerId: string;
  recipient: string;
  dry: boolean;
  nowMs?: number;
}) {
  return {
    dry: o.dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: o.originAsset,
    depositType: 'INTENTS',
    destinationAsset: o.destinationAsset,
    amount: o.amount.toString(),
    refundTo: o.signerId,
    refundType: 'INTENTS',
    recipient: o.recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date((o.nowMs ?? Date.now()) + QUOTE_TTL_MS).toISOString(),
  };
}

/**
 * Quote a withdrawal from the Intents account `signerId` to `recipient` on another chain. With `dry: false` the
 * response carries `depositAddress`, an Intents account id (not a chain address) that receives the signed Transfer.
 */
export async function quoteWithdraw(o: {
  originAsset: string;
  destinationAsset: string;
  amount: bigint;
  signerId: string;
  recipient: string;
  dry: boolean;
}): Promise<QuoteResponse> {
  return call<QuoteResponse>('/v0/quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(withdrawQuoteBody(o)),
  });
}

export function getStatus(depositAddress: string): Promise<StatusResponse> {
  return call<StatusResponse>(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
}

/** Tells 1Click which origin transaction paid the deposit address (speeds up detection; optional). */
export async function submitDeposit(txHash: string, depositAddress: string): Promise<void> {
  await call<unknown>('/v0/deposit/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ txHash, depositAddress }),
  });
}
