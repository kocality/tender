import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fetchKeyReceipts } from '../../src/lib/nearblocks.js';
import { fetchStatus } from '../../src/lib/oneclick.js';

const fixture = (f: string) => readFileSync(new URL(`../fixtures/rpc/${f}`, import.meta.url), 'utf8');
const respond = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;

describe('fetchKeyReceipts', () => {
  it('filters predecessor → mpc receipts and flags truncation', async () => {
    const r = await fetchKeyReceipts({ base: 'https://api.nearblocks.io', account: 'ckd-auth.logunov.near', mpc: 'v1.signer', fetchImpl: respond(fixture('nearblocks-logunov.json')) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.count).toBe(2);
    expect(r.truncated).toBe(true);
    expect(r.receipts[0]).toMatchObject({ receipt_id: 'HjcyuuRpShixKDUh9TiXxMdbRp3CDUJg71TDgBJ1rquY', block_height: '223825219' });
  });

  it('drops receipts to another receiver', async () => {
    const r = await fetchKeyReceipts({ base: 'x', account: 'ckd-auth.logunov.near', mpc: 'v1.signer-prod.testnet', fetchImpl: respond(fixture('nearblocks-logunov.json')) });
    expect(r).toMatchObject({ ok: true, count: 0 });
  });

  it('returns warn on 429 without throwing', async () => {
    const r = await fetchKeyReceipts({ base: 'x', account: 'a.near', mpc: 'v1.signer', fetchImpl: respond('{"message":"rate limited"}', 429) });
    expect(r).toEqual({ ok: false, warn: 'NearBlocks HTTP 429' });
  });

  it('returns warn on a v3 error body and on network failure', async () => {
    const e = await fetchKeyReceipts({ base: 'x', account: 'a.near', mpc: 'v1.signer', fetchImpl: respond('{"data":null,"errors":[{"message":"bad cursor","path":"cursor"}]}') });
    expect(e).toEqual({ ok: false, warn: 'NearBlocks error: bad cursor' });
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await fetchKeyReceipts({ base: 'x', account: 'a.near', mpc: 'v1.signer', fetchImpl: down })).toEqual({ ok: false, warn: 'NearBlocks unreachable: fetch failed' });
  });

  it('sends the Bearer key only when given', async () => {
    const seen: (Record<string, string> | undefined)[] = [];
    const f = (async (_u: string, init: { headers?: Record<string, string> }) => {
      seen.push(init.headers);
      return new Response('{"data":[],"meta":{}}');
    }) as unknown as typeof fetch;
    await fetchKeyReceipts({ base: 'x', account: 'a.near', mpc: 'v1.signer', fetchImpl: f });
    await fetchKeyReceipts({ base: 'x', account: 'a.near', mpc: 'v1.signer', apiKey: 'k', fetchImpl: f });
    expect(seen).toEqual([{}, { Authorization: 'Bearer k' }]);
  });
});

describe('1Click fetchStatus', () => {
  it('404 → warn', async () => {
    expect(await fetchStatus('0x0000000000000000000000000000000000000000', { fetchImpl: respond(fixture('oneclick-404.json'), 404) })).toEqual({ warn: 'deposit address not found' });
  });
  it('status', async () => {
    expect(await fetchStatus('abc', { fetchImpl: respond('{"status":"SUCCESS"}') })).toEqual({ status: 'SUCCESS' });
  });
});
