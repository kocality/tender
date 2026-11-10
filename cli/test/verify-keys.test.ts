import { describe, expect, it } from 'vitest';
import { type World, buildWorld, demoSaleInputs } from '../src/lib/sim.js';
import { fakeHttp, runVerify } from './verify-helpers.js';

const UTC = '\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ';

/** The twin close: sale 1 opened and finalized, sale 0 cancelled with its key never requested. */
function twin(): World {
  const w = buildWorld({ state: 'Finalized', saleId: 1n });
  const c = buildWorld({ state: 'Cancelled', saleId: 0n, bids: [demoSaleInputs().bids[0]!] });
  w.more = [{ sale: c.sale, bids: c.bids, result: c.result }];
  w.config.sales = '2';
  return w;
}

const keys = (w: World, http = fakeHttp(w, { receipts: w.keyLog.length })) => runVerify(w, { args: ['--keys'], http });

describe('verify --keys', () => {
  it('twin world (sale 1 ok, sale 0 cancelled 0 requests) prints the 6 target lines', async () => {
    const w = twin();
    const r = await keys(w);
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(/^Tender verify · keys · v1\.tenderseal\.near · mainnet · block 224000000 /);
    const body = r.out.slice(2);
    expect(body).toHaveLength(6);
    expect(body[0]).toBe('v1.signer 3.18.0 · threshold 11 of 16 (live) · domain 2 key = repo constant');
    expect(body[1]).toBe('key log (contract state): 1 request');
    expect(body[2]).toMatch(new RegExp(`^  sale 1   ${UTC}   ok      block 223900000$`));
    expect(body[3]).toMatch(
      new RegExp(`^  sale 0   0 requests · Cancelled ${UTC} · never requested \\(sealed unless the MPC threshold colludes\\) · open\\(\\) unreachable \\(terminal state\\)$`),
    );
    expect(body[4]).toBe('NearBlocks: receipts v1.tenderseal.near → v1.signer.request_app_private_key = 1 (match)');
    expect(body[5]).toBe('sale 0: 1 sealed bid · tried every released key: 0 decrypt');
    expect(r.out.join('\n')).not.toMatch(/sealed forever/i);
  });

  it('retry world (Err then Ok) prints 2 entries for one sale and passes', async () => {
    const w = twin();
    const ok = w.keyLog[0]!;
    w.keyLog = [{ i: '0', sale: '1', block: '223899990', ns: String(BigInt(ok.ns) - 60_000_000_000n), outcome: 'Err', resolved_block: '223899995' }, { ...ok, i: '1' }];
    w.sale.key_requests = 2;
    w.config.key_log_len = '2';
    const r = await keys(w);
    expect(r.code).toBe(0);
    expect(r.out).toContain('key log (contract state): 2 requests');
    expect(r.out.filter((l) => /^ {2}sale 1 {3}/.test(l)).map((l) => l.split(/\s+/)[4])).toEqual(['err', 'ok']);
  });

  it('cancelled after 1 request prints "may be decryptable"', async () => {
    const w = twin();
    const c = w.more[0]!.sale;
    c.key_requests = 1;
    w.keyLog = [{ i: '0', sale: '0', block: '223899000', ns: c.close_ns, outcome: 'Err', resolved_block: '223899004' }, { ...w.keyLog[0]!, i: '1' }];
    w.config.key_log_len = '2';
    const r = await keys(w);
    expect(r.out).toContain('  sale 0   cancelled after 1 requests: may be decryptable');
    expect(r.out.join('\n')).not.toContain('never requested');
    expect(r.code).toBe(0);
  });

  it('NearBlocks mismatch → WARN, exit 0; NearBlocks down → WARN, exit 0', async () => {
    const w = twin();
    let r = await keys(w, fakeHttp(w, { receipts: 0 }));
    expect(r.out).toContain('NearBlocks: receipts v1.tenderseal.near → v1.signer.request_app_private_key = 0 (WARN: key log has 1; indexing lag? run again in 10 min)');
    expect(r.code).toBe(0);
    r = await keys(w, fakeHttp(w));
    expect(r.out.find((l) => l.startsWith('NearBlocks'))).toMatch(/unavailable \(WARN: NearBlocks HTTP 429/);
    expect(r.code).toBe(0);
  });

  it('ledger count ≠ key_requests → exit 1', async () => {
    const w = twin();
    w.sale.key_requests = 2;
    const r = await keys(w);
    expect(r.out).toContain('ledger mismatch: sale 1: 1 ledger entries ≠ key_requests 2');
    expect(r.code).toBe(1);
  });

  it('a released key that opens a never-requested sale\'s bid → exit 1', async () => {
    const w = twin();
    w.more[0]!.bids[0]!.ct = w.bids[0]!.ct; // sealed to sale 1's identity
    const r = await keys(w);
    expect(r.out).toContain('sale 0: 1 sealed bid · tried every released key: 1 decrypt');
    expect(r.code).toBe(1);
  });

  it('Open sale with 0 requests prints its close time', async () => {
    const w = buildWorld({ state: 'Open', saleId: 3n });
    const r = await keys(w);
    expect(r.out).toContain('key log (contract state): 0 requests');
    expect(r.out.find((l) => l.startsWith('  sale 3'))).toMatch(new RegExp(`^  sale 3   0 requests · Open · closes ${UTC}$`));
    expect(r.code).toBe(0);
  });
});
