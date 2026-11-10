import { renderToString } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import sale1f from '../__fixtures__/views/sale-1-finalized.json';
import { ResultTable } from '../components/ResultTable';
import { revealedWithoutCiphertext, type DecryptResult } from '../lib/decrypt';
import { parseBid, parseResult, parseSale } from '../lib/views';

// CRYPTO-02: a revealed bid whose ciphertext does not open to the revealed bid is marked, as `pnpm verify` warns about it.

const sale = parseSale(sale1f);
const revealed = (idx: number, p: string, q: string) =>
  parseBid({ idx, bidder: `bidder${idx}.near`, escrow: '5000000', ct: '', cm: '', block: '1', ns: '1', state: 'Revealed', p, q, alloc: '0', spend: '0', penalty: '0', penalty_share: '0', paid: { usdc: '1', tokens: '0', ok: true } });
const bids = [revealed(0, '3600000', '3000000'), revealed(1, '3600000', '3000000'), revealed(2, '3600000', '3000000')];
const result = parseResult({ p_star: '3600000', sold: '1', seller_usdc: '1', seller_tokens_back: '0', token_dust: '0', penalty_pool: '0', block: '2', ns: '2', cancelled: false })!;
const text = (html: string) => html.replace(/<!-- -->/g, '');
const decrypted: DecryptResult = {
  keyOk: true,
  rows: [
    { idx: 0, status: 'ok', p: 3_600_000n, q: 3_000_000n, salt: '00'.repeat(16) }, // opens to what was revealed
    { idx: 1, status: 'invalid_ct' }, // garbage ciphertext, revealed from the opening alone
    { idx: 2, status: 'ok', p: 3_600_000n, q: 2_000_000n, salt: '00'.repeat(16) }, // a different price and size sealed
  ],
};
const render = (d: DecryptResult | null) => text(renderToString(<ResultTable sale={sale} bids={bids} result={result} recomputed={null} decrypted={d} />));

describe('revealedWithoutCiphertext', () => {
  test('only a Revealed bid whose row does not open to its p and q', () => {
    expect(revealedWithoutCiphertext(bids[0]!, decrypted.rows[0])).toBe(false);
    expect(revealedWithoutCiphertext(bids[1]!, decrypted.rows[1])).toBe(true);
    expect(revealedWithoutCiphertext(bids[2]!, decrypted.rows[2])).toBe(true);
    expect(revealedWithoutCiphertext(bids[1]!, undefined)).toBe(false);
    expect(revealedWithoutCiphertext({ ...bids[1]!, state: 'Penalized' }, decrypted.rows[1])).toBe(false);
  });
});

describe('Result table (CRYPTO-02)', () => {
  test('marks the bids 1 and 2 and explains the last look; bid 0 stays unmarked', () => {
    const html = render(decrypted);
    expect(html.split('ciphertext does not open to the revealed bid').length - 1).toBe(2);
    expect(html).toContain('Bids #1, #2 were revealed from the opening alone');
    expect(html).toContain('a last look');
  });
  test('nothing is marked before the visitor decrypts, or when the key check failed', () => {
    expect(render(null)).not.toContain('does not open');
    expect(render({ keyOk: false, rows: [] })).not.toContain('does not open');
  });
});
