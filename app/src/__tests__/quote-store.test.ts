import { afterEach, describe, expect, test, vi } from 'vitest';
import { clearQuote, loadQuote, quoteKey, reusableQuote, saveQuote, shouldWarnOnUnload } from '../lib/quoteStore';
import type { QuoteResponse } from '../lib/oneclick';

afterEach(() => vi.unstubAllGlobals());

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    setItem: vi.fn((k: string, v: string) => void m.set(k, v)),
    getItem: (k: string) => m.get(k) ?? null,
    removeItem: (k: string) => void m.delete(k),
  };
}

const NOW = Date.parse('2026-11-13T12:00:00Z');
const quote = (over: Partial<QuoteResponse['quote']> = {}): QuoteResponse => ({
  quote: { depositAddress: 'abc123', amountIn: '3080000', minAmountOut: '3000000', amountOut: '3000000', deadline: '2026-11-16T12:00:00Z', ...over },
});

describe('a reload during funding keeps the deposit address (QA-10)', () => {
  test('the stored quote comes back after a remount and is reused instead of asking 1Click again', () => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    const key = quoteKey('mainnet', '2', 'bidder.near');
    saveQuote(key, quote());
    const back = reusableQuote(loadQuote(key), 3_080_000n, NOW);
    expect(back?.quote.depositAddress).toBe('abc123');
  });
  test('an expired quote, or one that covers less than the deposit now needed, is not reused', () => {
    expect(reusableQuote(quote({ deadline: '2026-11-13T11:59:59Z' }), 3_080_000n, NOW)).toBeNull();
    expect(reusableQuote(quote(), 4_000_000n, NOW)).toBeNull();
    expect(reusableQuote(quote({ depositAddress: undefined }), 1n, NOW)).toBeNull();
    expect(reusableQuote(null, 1n, NOW)).toBeNull();
  });
  test('a quote whose swap ended is cleared and never paid into again', () => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    const key = quoteKey('mainnet', '2', 'bidder.near');
    saveQuote(key, quote());
    clearQuote(key);
    expect(loadQuote(key)).toBeNull();
  });
  test('quotes are kept per network, sale and account', () => {
    expect(new Set([quoteKey('mainnet', '2', 'a'), quoteKey('testnet', '2', 'a'), quoteKey('mainnet', '3', 'a'), quoteKey('mainnet', '2', 'b')]).size).toBe(4);
  });
  test('only the quote is stored: no price, size, salt or ciphertext field exists in it', () => {
    const store = memoryStorage();
    vi.stubGlobal('sessionStorage', store);
    saveQuote('k', quote());
    const written = store.setItem.mock.calls.map((c) => c[1]).join('');
    expect(written).not.toMatch(/"(ct|cm|salt|p|q)"/);
  });
  test('blocked or throwing storage never breaks the page', () => {
    vi.stubGlobal('sessionStorage', {
      setItem: () => {
        throw new Error('quota');
      },
      getItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => saveQuote('k', quote())).not.toThrow();
    expect(loadQuote('k')).toBeNull();
    expect(() => clearQuote('k')).not.toThrow();
  });
});

describe('leaving the page loses work (QA-10)', () => {
  test('funding with a quote, signing and relaying warn; the empty bid form and the result do not', () => {
    expect(shouldWarnOnUnload('fund', true, null)).toBe(true);
    expect(shouldWarnOnUnload('sign', false, null)).toBe(true);
    expect(shouldWarnOnUnload('relay', false, 'relay')).toBe(true);
    expect(shouldWarnOnUnload('bid', false, null)).toBe(false);
    expect(shouldWarnOnUnload('wallet', false, null)).toBe(false);
    expect(shouldWarnOnUnload('done', true, null)).toBe(false);
  });
});
