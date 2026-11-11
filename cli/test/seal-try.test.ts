import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appId, simulateCkdResponse } from '@tender/seal';
import { describe, expect, it } from 'vitest';
import { main } from '../src/seal-try.js';
import { buildWorld, fakeRpc, simulateMpc, type World } from '../src/lib/sim.js';

function run(world: World, extra: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (l: string) => void out.push(l), err: (l: string) => void err.push(l) };
  return main(['--sale', world.sale.id, '--contract', world.contract, '--rpc', 'https://fake.rpc', ...extra], io, { fetchImpl: fakeRpc(world) }).then(
    (code) => ({ code, out, err }),
  );
}

describe('seal:try', () => {
  it('keyless: V8 line exactly', async () => {
    const w = buildWorld({ state: 'Open', saleId: 2n });
    const r = await run(w);
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(/^sale 2 · v1\.tenderseal\.near · state Open · closes \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(r.out[1]).toBe(
      `identity: app_id = sha3_256("near-mpc v0.1.0 app_id derivation:v1.tenderseal.near,${w.sale.path}") = ${Buffer.from(appId(w.contract, w.sale.path)).toString('hex')}`,
    );
    expect(r.out[2]).toMatch(/^sealed a test message to this identity: ct \S{16}… \(160 B\)$/);
    expect(r.out.at(-1)).toBe('sealed: no key has been requested for sale 2 (key_requests = 0)');
  });

  it('Cancelled with 0 key requests prints the never-requested label', async () => {
    const w = buildWorld({ state: 'Cancelled' });
    const r = await run(w);
    expect(r.out).toContain('Cancelled · 0 key requests · never requested (sealed unless the MPC threshold colludes)');
    expect(r.out.at(-1)).toBe('sealed: no key has been requested for sale 1 (key_requests = 0)');
  });

  it('requested but not released', async () => {
    const w = buildWorld({ state: 'Open' });
    w.sale.key_requests = 1;
    w.keyLog = [{ i: '0', sale: w.sale.id, block: '1', ns: '1', outcome: 'Err', resolved_block: '2' }];
    const r = await run(w);
    expect(r.out.at(-1)).toBe('sealed: 1 key request(s) made, no key released yet (last outcome: Err)');
  });

  for (const mode of ['identity', 'generator', 'plain'] as const) {
    it(`keyed (${mode}): test message decrypts: OK`, async () => {
      const w = buildWorld({ state: 'Keyed', mode });
      const r = await run(w);
      expect(r.code).toBe(0);
      expect(r.out.at(-1)).toMatch(/^key released at block 223900006 \(\d{4}-.*Z\) · checkKey true · test message decrypts: OK$/);
    });
  }

  it('--try-key: an EOA key for the same path is real but the wrong identity', async () => {
    const w = buildWorld({ state: 'Open', saleId: 2n, mode: 'generator' });
    const sim = simulateMpc({ contract: w.contract, path: w.sale.path, mode: 'generator' });
    const response = simulateCkdResponse(sim.mskHex, w.mpk, appId('tenderseal.near', w.sale.path), 'generator');
    const dir = mkdtempSync(join(tmpdir(), 'seal-try-'));
    const file = join(dir, 'eoa-ckd-2.json');
    writeFileSync(file, JSON.stringify({ gate: 'attack-eoa-ckd', caller: 'tenderseal.near', path: w.sale.path, tx_hash: 'AbC', response }));
    const r = await run(w, ['--try-key', file]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`try-key: CKD response from ${file} (tx AbC, caller tenderseal.near, path ${w.sale.path})`);
    expect(r.out).toContain('  checkKey vs app_id(tenderseal.near, path): true      (a real MPC key)');
    expect(r.out).toContain('  checkKey vs app_id(v1.tenderseal.near, path): false');
    expect(r.out).toContain(`  bids decrypted with it: 0/${w.bids.length}`);
    expect(r.out.at(-1)).toBe('wrong identity: this key was derived for tenderseal.near, not v1.tenderseal.near');
  });

  it('--try-key with a bare {big_y,big_c} needs --caller', async () => {
    const w = buildWorld({ state: 'Open' });
    const sim = simulateMpc({ contract: w.contract, path: w.sale.path, mode: w.mode });
    const file = join(mkdtempSync(join(tmpdir(), 'seal-try-')), 'bare.json');
    writeFileSync(file, JSON.stringify(simulateCkdResponse(sim.mskHex, w.mpk, appId('tenderseal.near', w.sale.path), w.mode)));
    await expect(run(w, ['--try-key', file])).rejects.toMatchObject({ exitCode: 2 });
    const r = await run(w, ['--try-key', file, '--caller', 'tenderseal.near']);
    expect(r.out.at(-1)).toBe('wrong identity: this key was derived for tenderseal.near, not v1.tenderseal.near');
  });

  for (const flag of ['--try-key-tx', '--print-eoa-ckd-command']) {
    it(`${flag} does not exist (usage, exit 2)`, async () => {
      const w = buildWorld({ state: 'Open' });
      await expect(run(w, [flag, 'x'])).rejects.toMatchObject({ exitCode: 2 });
    });
  }
});
