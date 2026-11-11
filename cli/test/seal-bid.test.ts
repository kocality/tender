import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bidNonce, decodeVersionedNonce, solanaSignerId, toBase64 } from '@tender/intents';
import bs58 from 'bs58';
import { MPC_DOMAIN2_PK, decryptBids } from '@tender/seal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, normalizeSigner } from '../src/seal-bid.js';
import { buildWorld, fakeRpc, SIM_USDC, type World } from '../src/lib/sim.js';

const EVM = '0xef3483ed23d94db653024753e5b9a5362e94e722';
let world: World;
let bidsDir: string;

beforeEach(() => {
  world = buildWorld({ state: 'Open' });
  bidsDir = mkdtempSync(join(tmpdir(), 'seal-bid-'));
  vi.stubGlobal('fetch', fakeRpc(world)); // @tender/intents currentSalt uses global fetch
});
afterEach(() => vi.unstubAllGlobals());

async function run(args: string[], expectedMpk: string = world.mpk) {
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (l: string) => void out.push(l), err: (l: string) => void err.push(l) };
  const code = await main(['--contract', world.contract, '--rpc', 'https://fake.rpc', ...args], io, {
    fetchImpl: fakeRpc(world),
    bidsDir,
    expectedMpk,
  });
  return { code, out, err };
}

const BID = ['--sale', '1', '--price', '3.9', '--size', '4', '--escrow', '5', '--signer', EVM, '--origin', 'base'];

describe('seal:bid', () => {
  it('stdout is one public JSON object; the secret file holds p, q, salt (0600)', async () => {
    const r = await run(BID);
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(1);
    const j = JSON.parse(r.out[0]!) as Record<string, string | null>;
    expect(Object.keys(j)).toEqual(['sale', 'contract', 'network', 'signer', 'ct', 'cm', 'escrow', 'origin', 'seq', 'intents_salt', 'nonce', 'msg', 'payload']);
    expect(j).toMatchObject({ sale: '1', contract: 'v1.tenderseal.near', network: 'mainnet', signer: EVM, escrow: '5000000', origin: 'base', seq: 0, intents_salt: '252812b3' });
    expect(r.out[0]).not.toMatch(/"(salt|p|q)"/);
    expect(JSON.parse(j.msg!)).toEqual({ op: 'bid', sale: '1', ct: j.ct, cm: j.cm, origin: 'base', seq: 0 });
    expect(new TextEncoder().encode(j.msg!).length).toBeLessThanOrEqual(512);
    expect(r.err).toContain('p = 3900000 micro-USDC per 1 NEAR · q = 4000000 micro-USDC · escrow = 5000000 micro-USDC');

    const files = readdirSync(bidsDir);
    expect(files).toEqual([`mainnet-v1.tenderseal.near-sale1-${EVM}-${j.cm!.slice(0, 8)}.json`]);
    const file = join(bidsDir, files[0]!);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const secret = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(secret)).toEqual(['sale', 'contract', 'network', 'signer', 'ct', 'cm', 'escrow', 'origin', 'seq', 'intents_salt', 'nonce', 'p', 'q', 'salt']);
    expect(secret).toMatchObject({ p: '3900000', q: '4000000', ct: j.ct, cm: j.cm, seq: 0, intents_salt: '252812b3', nonce: j.nonce });
    expect(secret.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(r.out[0]).not.toContain(secret.salt as string);

    const [d] = decryptBids({ S: world.S, contract: world.contract, path: world.sale.path, sale: 1n, bids: [{ idx: 0, bidder: EVM, B: 5_000_000n, ct: j.ct!, cm: j.cm! }] });
    expect(d).toMatchObject({ ok: true, cmOk: true, p: 3_900_000n, q: 4_000_000n, salt_hex: secret.salt });
  });

  it('builds the unsigned erc191 payload: transfer of B to the contract with the bid msg', async () => {
    const r = await run(BID);
    const j = JSON.parse(r.out[0]!) as { payload: string; msg: string };
    const p = JSON.parse(j.payload) as { signer_id: string; verifying_contract: string; deadline: string; nonce: string; intents: unknown[] };
    expect(p.signer_id).toBe(EVM);
    expect(p.verifying_contract).toBe('intents.near');
    expect(p.intents).toEqual([{ intent: 'transfer', receiver_id: 'v1.tenderseal.near', tokens: { [SIM_USDC]: '5000000' }, msg: j.msg, min_gas: '30000000000000' }]);
    expect(decodeVersionedNonce(p.nonce).saltHex).toBe('252812b3');
    expect(r.err.some((l) => /^sign within 10 minutes \(deadline \d{4}-.*Z\)$/.test(l))).toBe(true);
  });

  it('the payload nonce is the bid nonce of this sealed bid: a re-run or a paste of the same bid has the same nonce (DOUBLE-PLAN rows 5-6)', async () => {
    const fixed = [...BID, '--unsafe-fixed-salt', '--salt', 'aa'.repeat(16)];
    const a = await run(fixed);
    world.block.timestamp_ns += 11n * 60n * 1_000_000_000n; // 11 minutes later: another payload deadline
    const b = await run(fixed);
    const ja = JSON.parse(a.out[0]!) as { cm: string; nonce: string; payload: string };
    const jb = JSON.parse(b.out[0]!) as { cm: string; nonce: string; payload: string };
    const pa = JSON.parse(ja.payload) as { nonce: string; deadline: string };
    const pb = JSON.parse(jb.payload) as { nonce: string; deadline: string };
    expect(jb.cm).toBe(ja.cm);
    expect(pb.deadline).not.toBe(pa.deadline);
    expect(pb.nonce).toBe(pa.nonce);
    expect(ja.nonce).toBe(pa.nonce);
    const want = bidNonce({ saltHex: '252812b3', closeNs: BigInt(world.sale.close_ns), contract: world.contract, sale: 1n, signer: EVM, cm: ja.cm });
    expect(pa.nonce).toBe(toBase64(want));
    // the nonce deadline is close - 60 s; the payload deadline never passes it
    const closeMs = Number(BigInt(world.sale.close_ns) / 1_000_000n);
    expect(decodeVersionedNonce(pa.nonce).deadlineNs).toBe(BigInt(Math.floor((closeMs - 60_000) / 1000) * 1000) * 1_000_000n);
    expect(Date.parse(pb.deadline) * 1e6).toBeLessThanOrEqual(Number(decodeVersionedNonce(pb.nonce).deadlineNs));
    expect(a.err).toContain('sign and relay this payload OR paste this JSON in the app: both are the same bid (one nonce), only one can run');
  });

  it("seq = the signer's stored bids in this sale, named in a warning; --seq overrides it (DOUBLE-PLAN D1)", async () => {
    const near = ['--sale', '1', '--price', '3.5', '--size', '1', '--escrow', '1', '--signer', 'bidder.tenderseal.near', '--origin', 'near'];
    const mine = world.bids.filter((x) => x.bidder === 'bidder.tenderseal.near').map((x) => `#${x.idx}`);
    expect(mine).toHaveLength(1);
    const r = await run(near);
    const j = JSON.parse(r.out[0]!) as { seq: number; msg: string };
    expect(j.seq).toBe(1);
    expect(JSON.parse(j.msg).seq).toBe(1);
    expect(r.err).toContain(`warning: bidder.tenderseal.near already has 1 bid in sale 1 (${mine[0]}): this seals an additional bid (seq 1)`);
    const o = await run([...near, '--seq', '0']);
    expect(JSON.parse(o.out[0]!).seq).toBe(0);
    expect(o.err.some((l) => l.includes('--seq 0 ≠ 1 stored bid'))).toBe(true);
    await expect(run([...near, '--seq', '-1'])).rejects.toMatchObject({ exitCode: 2 });
    await expect(run([...near, '--seq', '65536'])).rejects.toMatchObject({ exitCode: 2 });
  });

  it('--no-payload still pins seq, intents_salt and the nonce in the file', async () => {
    const r = await run([...BID, '--no-payload']);
    const j = JSON.parse(r.out[0]!) as { payload: null; seq: number; intents_salt: string; nonce: string };
    expect(j.payload).toBeNull();
    expect(j).toMatchObject({ seq: 0, intents_salt: '252812b3' });
    expect(decodeVersionedNonce(j.nonce).saltHex).toBe('252812b3');
  });

  it('NEAR signer gets the nep413 message', async () => {
    const r = await run(['--sale', '1', '--price', '3.5', '--size', '1', '--escrow', '1', '--signer', 'bidder.tenderseal.near', '--origin', 'near']);
    const j = JSON.parse(r.out[0]!) as { payload: string };
    expect(Object.keys(JSON.parse(j.payload) as object)).toEqual(['deadline', 'intents', 'signer_id']);
  });

  it('--no-payload → payload null; --salt is used as given only with --unsafe-fixed-salt, with a warning', async () => {
    const r = await run([...BID, '--no-payload', '--unsafe-fixed-salt', '--salt', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']);
    expect(JSON.parse(r.out[0]!).payload).toBeNull();
    const file = join(bidsDir, readdirSync(bidsDir)[0]!);
    expect(JSON.parse(readFileSync(file, 'utf8')).salt).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(r.err.some((l) => l.startsWith('warning: --unsafe-fixed-salt'))).toBe(true);
  });

  it('--salt without --unsafe-fixed-salt → usage error (exit 2), nothing sealed (X12P-05)', async () => {
    await expect(run([...BID, '--salt', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('--unsafe-fixed-salt') });
    expect(readdirSync(bidsDir)).toEqual([]);
  });

  it('the deadline comes from chain time, not the local clock (X12-01)', async () => {
    const chainMs = Number(world.block.timestamp_ns / 1_000_000n);
    const spy = vi.spyOn(Date, 'now').mockReturnValue(chainMs - 15 * 60_000); // local clock 15 min slow
    try {
      const r = await run(BID);
      const p = JSON.parse((JSON.parse(r.out[0]!) as { payload: string }).payload) as { deadline: string; nonce: string };
      expect(p.deadline).toBe(new Date(chainMs + 600_000).toISOString());
      // the nonce deadline is the sale's close − 60 s (bid nonce), never the local clock
      expect(decodeVersionedNonce(p.nonce).deadlineNs).toBe(BigInt(world.sale.close_ns) - 60_000_000_000n);
    } finally {
      spy.mockRestore();
    }
  });

  it('a 64-hex signer with --origin near gets the nep413 message; without it the raw_ed25519 payload (X12A-05)', async () => {
    const hex = '2c9d89ca154fc30f64726378a173008291b1ffe92f0eb617bb376b8de3043307';
    const near = await run(['--sale', '1', '--price', '3.5', '--size', '1', '--escrow', '1', '--signer', hex, '--origin', 'near']);
    expect(Object.keys(JSON.parse((JSON.parse(near.out[0]!) as { payload: string }).payload) as object)).toEqual(['deadline', 'intents', 'signer_id']);
    expect(near.err.some((l) => l.startsWith('nep413: '))).toBe(true);
    const sol = await run(['--sale', '1', '--price', '3.5', '--size', '1', '--escrow', '1', '--signer', hex, '--origin', 'sol']);
    expect(sol.err).toContain('raw_ed25519: sign the payload string as is');
  });

  it('0xEF34… is lowercased with a warning', async () => {
    const r = await run(['--sale', '1', '--price', '3.9', '--size', '4', '--escrow', '5', '--signer', EVM.toUpperCase().replace('0X', '0x')]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out[0]!).signer).toBe(EVM);
    expect(r.err.some((l) => l.startsWith(`warning: signer lowercased to ${EVM}`))).toBe(true);
  });

  it('closed sale → exit 1', async () => {
    world.sale.close_ns = (world.block.timestamp_ns - 1n).toString();
    const r = await run(BID);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('sale closed');
    expect(r.out).toEqual([]);
  });

  it('deadline capped 1 min before close; full, capped or in-flight sale → exit 1, nothing sealed (X12P-02)', async () => {
    const chainMs = Number(world.block.timestamp_ns / 1_000_000n);
    world.sale.close_ns = String(BigInt(chainMs + 300_000) * 1_000_000n); // closes in 5 min
    const r = await run(BID);
    expect(JSON.parse((JSON.parse(r.out[0]!) as { payload: string }).payload).deadline).toBe(new Date(chainMs + 240_000).toISOString());
    world.sale.close_ns = String(BigInt(chainMs + 59_000) * 1_000_000n);
    expect((await run(BID)).err.join()).toContain('closing within a minute');
    world.sale.close_ns = String(BigInt(chainMs + 86_400_000) * 1_000_000n);
    const before = readdirSync(bidsDir).length;
    world.sale.bids = world.sale.max_bids;
    expect((await run(BID)).err.join()).toContain('sale is full');
    world.sale.bids = 0;
    world.sale.escrow_total = String(1_000_000_000_000n - 4_999_999n);
    expect((await run(BID)).err.join()).toContain('escrow cap');
    world.sale.escrow_total = '0';
    world.sale.in_flight = true;
    const f = await run(BID);
    expect([f.code, f.err.join().includes('in flight')]).toEqual([1, true]);
    expect(readdirSync(bidsDir).length).toBe(before);
  });

  it('MPC key mismatch → exit 1, nothing sealed', async () => {
    const r = await run(BID, MPC_DOMAIN2_PK.mainnet);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('MPC key mismatch');
    expect(readdirSync(bidsDir)).toEqual([]);
  });

  it('--price 3.9999999 → error (7 decimals); other input checks', async () => {
    const bad = async (patch: Record<string, string>) => {
      const a = [...BID];
      for (const [k, v] of Object.entries(patch)) a[a.indexOf(`--${k}`) + 1] = v;
      return run(a);
    };
    expect((await bad({ price: '3.9999999' })).err.join()).toContain('more than 6 decimal places');
    expect((await bad({ price: '3.9999999' })).code).toBe(1);
    expect((await bad({ escrow: '0.5', size: '0.5' })).code).toBe(1);
    expect((await bad({ size: '6' })).code).toBe(1);
    expect((await bad({ signer: 'Not An Account' })).code).toBe(1);
    const below = await bad({ price: '2.5' });
    expect(below.code).toBe(0);
    expect(below.err.some((l) => l.includes('below reserve'))).toBe(true);
    expect(below.err.some((l) => l.includes('refunded in full once it is revealed'))).toBe(true); // SC-06
  });

  it('missing required flag or unknown flag → usage (exit 2)', async () => {
    await expect(run(['--sale', '1'])).rejects.toMatchObject({ exitCode: 2 });
    await expect(run([...BID, '--secret'])).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe('normalizeSigner', () => {
  it('a Solana address is refused with its 64-hex Intents id; other uppercase input is refused, not lowercased (X12A-05)', () => {
    const sol = '4GzZcvCFqpXRZtWHFoMqvMZtzKcm4YtuRHiQk4hK6rQr';
    const hex = solanaSignerId(bs58.decode(sol));
    expect(hex).toMatch(/^30abdbe2[0-9a-f]{56}$/);
    expect(() => normalizeSigner(sol)).toThrow(`its NEAR Intents account is ${hex}`);
    expect(() => normalizeSigner('Bidder.TenderSeal.near')).toThrow('is not an EVM address');
    expect(() => normalizeSigner('2C9D89CA154FC30F64726378A173008291B1FFE92F0EB617BB376B8DE3043307')).toThrow();
  });

  it('kinds', () => {
    expect(normalizeSigner('0xAbC0000000000000000000000000000000000001')).toEqual({ signer: '0xabc0000000000000000000000000000000000001', kind: 'evm', changed: true });
    expect(normalizeSigner('2c9d89ca154fc30f64726378a173008291b1ffe92f0eb617bb376b8de3043307').kind).toBe('implicit');
    expect(normalizeSigner('bidder1-abc123.testnet')).toMatchObject({ kind: 'near', changed: false });
  });
});
