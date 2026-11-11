import { describe, expect, it } from 'vitest';
import { main, runDemo } from '../src/demo-local.js';
import { buildWorld } from '../src/lib/sim.js';

const LAST = 'P* = 3.60 USDC/NEAR · 6/6 bids decrypted · commitments 6/6';
const quiet = () => {
  const lines: string[] = [];
  return { lines, io: { out: (l: string) => void lines.push(l), err: () => {} } };
};

describe('demo:local', () => {
  for (const mode of ['identity', 'generator', 'plain'] as const) {
    it(mode, () => {
      const { lines, io } = quiet();
      const r = runDemo({ mode, seed: '01' }, io);
      expect(r.exitCode).toBe(0);
      expect(r.lastLine).toBe(LAST);
      expect(r.elapsedMs).toBeLessThan(10_000);
      expect(lines[0]).toBe('simulated MPC: test key from near/mpc vectors (msk is public in that file; mainnet uses v1.signer)');
      expect(lines).toContain('close · key_requests = 0 · no key exists yet: decrypt impossible');
      expect(lines).toContain('open · key released (simulated) · checkKey true');
      expect(lines.join('\n')).toContain('0.800001');
      expect(lines.join('\n')).not.toMatch(/mainnet uses (?!v1\.signer)|sealed for[e]ver|succeed[s]/);
    });
  }

  it('defaults to generator mode, the mode v1 is born with (CRYPTO-07)', async () => {
    const { lines, io } = quiet();
    expect(runDemo({ seed: '01' }, io).exitCode).toBe(0);
    expect(lines[1]).toMatch(/ · mode generator$/);
    const viaCli = quiet();
    expect(await main(['--seed', '01'], viaCli.io)).toBe(0);
    expect(viaCli.lines[1]).toMatch(/ · mode generator$/);
    expect(buildWorld().config.app_pk_mode).toBe('generator');
  });

  it('same seed gives the same commitments (ciphertexts stay randomized)', () => {
    const a = quiet();
    const b = quiet();
    runDemo({ mode: 'identity', seed: 'ab' }, a.io);
    runDemo({ mode: 'identity', seed: 'ab' }, b.io);
    const wall = (lines: string[]) => lines.slice(6, 12);
    const cm = (lines: string[]) => wall(lines).map((l) => l.split(/\s+/).at(-1));
    expect(cm(a.lines)).toEqual(cm(b.lines));
    expect(wall(a.lines)).not.toEqual(wall(b.lines));
  });

  it('unknown flag → exit code 2 (usage)', async () => {
    await expect(main(['--network', 'testnet'], quiet().io)).rejects.toMatchObject({ exitCode: 2 });
  });
});
