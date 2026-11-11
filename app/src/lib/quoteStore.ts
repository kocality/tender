import type { Step } from './bidFlow';
import type { QuoteResponse } from './oneclick';

// A 1Click deposit address must survive a reload while the swap is still PROCESSING: a new tab state would request a
// second address and the user would fund twice. The browser's local storage (shared by its tabs, so a second tab reuses the
// open address) holds the quote only (address, amounts, deadline): never a price, a size, a salt or a ciphertext. Every access is
// guarded (private mode, blocked storage). Another device or browser still asks for its own address: that costs fees only.

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** One quote per network, sale, Intents account and origin chain: an EVM address is the same account on Base and Arbitrum. */
export function quoteKey(network: string, sale: string, signerId: string, origin: string): string {
  return `tender:quote:${network}:${sale}:${origin}:${signerId}`;
}

export function saveQuote(key: string, quote: QuoteResponse): void {
  try {
    store()?.setItem(key, JSON.stringify(quote));
  } catch {
    // storage is only a convenience
  }
}

export function loadQuote(key: string): QuoteResponse | null {
  try {
    const raw = store()?.getItem(key);
    const q = raw ? (JSON.parse(raw) as QuoteResponse) : null;
    return q?.quote?.depositAddress ? q : null;
  } catch {
    return null;
  }
}

/** A quote whose swap ended (or whose bid went out) must never be paid into again. */
export function clearQuote(key: string): void {
  try {
    store()?.removeItem(key);
  } catch {
    // storage is only a convenience
  }
}

/** A stored quote is reused while it has not expired and still covers the deposit this bid needs. */
export function reusableQuote(stored: QuoteResponse | null, deposit: bigint, nowMs: number): QuoteResponse | null {
  if (!stored?.quote.depositAddress) return null;
  const deadline = stored.quote.deadline ? Date.parse(stored.quote.deadline) : Number.NaN;
  if (Number.isNaN(deadline) || deadline <= nowMs) return null;
  return BigInt(stored.quote.amountIn) >= deposit ? stored : null;
}

/** Leaving the page loses the signature request or the funding view: ask first once there is something to lose. */
export function shouldWarnOnUnload(step: Step, hasQuote: boolean, busy: string | null): boolean {
  if (step === 'sign' || step === 'relay') return true;
  return step === 'fund' && (hasQuote || busy !== null);
}
