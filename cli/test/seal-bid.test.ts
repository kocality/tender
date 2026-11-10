import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeVersionedNonce } from '@tender/intents';
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
    expect(Object.keys(j)).toEqual(['sale', 'contract', 'network', 'signer', 'ct', 'cm', 'escrow', 'origin', 'msg', 'payload']);
    expect(j).toMatchObject({ sale: '1', contract: 'v1.tenderseal.near', network: 'mainnet', signer: EVM, escrow: '5000000', origin: 'base' });
    expect(r.out[0]).not.toMatch(/"(salt|p|q)"/);
    expect(JSON.parse(j.msg!)).toEqual({ op: 'bid', sale: '1', ct: j.ct, cm: j.cm, origin: 'base' });
    expect(new TextEncoder().encode(j.msg!).length).toBeLessThanOrEqual(512);
    expect(r.err).toContain('p = 3900000 micro-USDC per 1 NEAR · q = 4000000 micro-USDC · escrow = 5000000 micro-USDC');

    const files = readdirSync(bidsDir);
    expect(files).toEqual([`mainnet-v1.tenderseal.near-sale1-${EVM}-${j.cm!.slice(0, 8)}.json`]);
    const file = join(bidsDir, files[0]!);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const secret = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(secret)).toEqual(['sale', 'contract', 'network', 'signer', 'ct', 'cm', 'escrow', 'origin', 'p', 'q', 'salt']);
    expect(secret).toMatchObject({ p: '3900000', q: '4000000', ct: j.ct, cm: j.cm });
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

  it('NEAR signer gets the nep413 message', async () => {
    const r = await run(['--sale', '1', '--price', '3.5', '--size', '1', '--escrow', '1', '--signer', 'bidder.tenderseal.near', '--origin', 'near']);
    const j = JSON.parse(r.out[0]!) as { payload: string };
    expect(Object.keys(JSON.parse(j.payload) as object)).toEqual(['deadline', 'intents', 'signer_id']);
  });

  it('--no-payload → payload null; --salt is used as given', async () => {
    const r = await run([...BID, '--no-payload', '--salt', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']);
    expect(JSON.parse(r.out[0]!).payload).toBeNull();
    const file = join(bidsDir, readdirSync(bidsDir)[0]!);
    expect(JSON.parse(readFileSync(file, 'utf8')).salt).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
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
  });

  it('missing required flag or unknown flag → usage (exit 2)', async () => {
    await expect(run(['--sale', '1'])).rejects.toMatchObject({ exitCode: 2 });
    await expect(run([...BID, '--secret'])).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe('normalizeSigner', () => {
  it('kinds', () => {
    expect(normalizeSigner('0xAbC0000000000000000000000000000000000001')).toEqual({ signer: '0xabc0000000000000000000000000000000000001', kind: 'evm', changed: true });
    expect(normalizeSigner('2c9d89ca154fc30f64726378a173008291b1ffe92f0eb617bb376b8de3043307').kind).toBe('implicit');
    expect(normalizeSigner('bidder1-abc123.testnet')).toMatchObject({ kind: 'near', changed: false });
  });
});
