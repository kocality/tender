import { fromUnits } from "./units.js";

// 1Click (NEAR Intents swap API) for the ops scripts: quote bodies, quote call, status polling. No JWT.
// /v0/generate-intent and /v0/submit-intent are not used (they need an API key); we sign our own Transfer.

export const ONECLICK_API = "https://1click.chaindefuser.com";

export const TOKEN = {
  usdcNear: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  usdcBase: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  wnear: "nep141:wrap.near",
  jambo: "nep141:jambo-1679.meme-cooking.near",
} as const;

const QUOTE_TTL_MS = 30 * 60_000;
export const TERMINAL = ["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"] as const;
export const isTerminal = (s: string): boolean => (TERMINAL as readonly string[]).includes(s);

export interface Quote {
  quote: {
    depositAddress?: string;
    amountIn: string;
    amountInFormatted?: string;
    minAmountIn?: string;
    amountOut: string;
    amountOutFormatted?: string;
    minAmountOut: string;
    deadline?: string;
    timeEstimate?: number;
  };
  [k: string]: unknown;
}

export interface StatusBody {
  status: string;
  swapDetails?: {
    nearTxHashes?: unknown[];
    originChainTxHashes?: unknown[];
    destinationChainTxHashes?: unknown[];
    amountOut?: string;
    refundedAmount?: string;
    refundReason?: string;
  };
  [k: string]: unknown;
}

export type Fetch = typeof fetch;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export function assertEvm(addr: string): void {
  if (!EVM_ADDRESS.test(addr)) throw new Error(`--evm must be a 0x address with 40 hex digits, got "${addr}"`);
}

const deadline = (nowMs: number) => new Date(nowMs + QUOTE_TTL_MS).toISOString();

/** S5 forward leg: USDC on Base -> the EVM address's own Intents account. recipient is lowercase. */
export function forwardQuoteBody(o: { evm: string; amount: bigint; dry: boolean; nowMs?: number }) {
  assertEvm(o.evm);
  return {
    dry: o.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: TOKEN.usdcBase,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: TOKEN.usdcNear,
    amount: o.amount.toString(),
    refundTo: o.evm,
    refundType: "ORIGIN_CHAIN",
    recipient: o.evm.toLowerCase(),
    recipientType: "INTENTS",
    deadline: deadline(o.nowMs ?? Date.now()),
  };
}

/** S5 return leg: the EVM address's Intents USDC -> Base USDC at the same address. refundTo is the Intents account. */
export function returnQuoteBody(o: { evm: string; amount: bigint; dry: boolean; nowMs?: number }) {
  assertEvm(o.evm);
  return {
    dry: o.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: TOKEN.usdcNear,
    depositType: "INTENTS",
    destinationAsset: TOKEN.usdcBase,
    amount: o.amount.toString(),
    refundTo: o.evm.toLowerCase(),
    refundType: "INTENTS",
    recipient: o.evm,
    recipientType: "DESTINATION_CHAIN",
    deadline: deadline(o.nowMs ?? Date.now()),
  };
}

/** Swap between two tokens that both stay inside one Intents account (H-JAMBO). */
export function swapQuoteBody(o: { from: string; to: string; amount: bigint; account: string; dry: boolean; nowMs?: number }) {
  return {
    dry: o.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: o.from,
    depositType: "INTENTS",
    destinationAsset: o.to,
    amount: o.amount.toString(),
    refundTo: o.account,
    refundType: "INTENTS",
    recipient: o.account,
    recipientType: "INTENTS",
    deadline: deadline(o.nowMs ?? Date.now()),
  };
}

async function call<T>(f: Fetch, path: string, init?: RequestInit): Promise<T> {
  const res = await f(`${ONECLICK_API}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { message?: string };
      if (typeof j.message === "string") message = j.message;
    } catch {
      // keep the raw text
    }
    throw new Error(`1Click ${res.status}: ${message || res.statusText}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export const postQuote = (body: object, f: Fetch = fetch) =>
  call<Quote>(f, "/v0/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const getStatus = (depositAddress: string, f: Fetch = fetch) =>
  call<StatusBody>(f, `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);

/** Tells 1Click which origin transaction paid the deposit address (speeds up detection; optional). */
export const submitDeposit = (txHash: string, depositAddress: string, f: Fetch = fetch) =>
  call<unknown>(f, "/v0/deposit/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txHash, depositAddress }) });

export interface TokenInfo { assetId: string; symbol: string; decimals: number; price?: number }

export async function listTokens(f: Fetch = fetch): Promise<TokenInfo[]> {
  const list = await call<TokenInfo[]>(f, "/v0/tokens");
  return list.filter((t) => typeof t?.assetId === "string");
}

/** Polls GET /v0/status until a terminal state (I11) or the timeout. Intermediate states keep waiting. */
export async function pollStatus(
  depositAddress: string,
  o: { fetch?: Fetch; sleep?: (ms: number) => Promise<void>; now?: () => number; intervalMs?: number; timeoutMs?: number; onStatus?: (s: string) => void } = {},
): Promise<StatusBody> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const end = now() + (o.timeoutMs ?? 40 * 60_000);
  let last = "";
  for (;;) {
    let body: StatusBody | null = null;
    try {
      body = await getStatus(depositAddress, o.fetch);
    } catch (e) {
      // 404 right after the quote or a rate limit: keep waiting until the timeout
      if (now() >= end) throw e;
    }
    if (body) {
      if (body.status !== last) {
        last = body.status;
        o.onStatus?.(last);
      }
      if (isTerminal(body.status)) return body;
    }
    if (now() >= end) throw new Error(`timed out waiting for 1Click; last status ${last || "(none)"}`);
    await sleep(o.intervalMs ?? 5000);
  }
}

/** 1Click lists hashes as strings or as `{hash, explorerUrl}`; keep the hash strings. */
export function hashesOf(list: unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const x of list ?? []) {
    const h = typeof x === "string" ? x : (x as { hash?: unknown } | null)?.hash;
    if (typeof h === "string" && h !== "") out.push(h);
  }
  return out;
}

/** "22477.4578..." -> "22477" above 1000, else 4 decimals, trimmed. For human output only. */
export function approx(v: bigint, decimals: number): string {
  const s = fromUnits(v, decimals);
  const [whole, frac = ""] = s.split(".");
  if ((whole as string).length >= 4) return whole as string;
  const f = frac.slice(0, 4).replace(/0+$/, "");
  return f ? `${whole}.${f}` : (whole as string);
}
