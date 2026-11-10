import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Runner, rebuildFromMetadata, snapshotRev } from '../src/lib/rebuild.js';
import { codeHashB58 } from '../src/lib/wasm.js';
import { GOOD_WASM } from './verify-helpers.js';

const REV = '0123456789abcdef0123456789abcdef01234567';
const meta = { build_info: { source_code_snapshot: `git+https://github.com/o/tender?rev=${REV}`, contract_path: 'contract' } };

/** Answers every tool call; `cargo near build` writes GOOD_WASM to --out-dir. */
function fakeRunner(over: Partial<Record<string, number>> = {}): { run: Runner; calls: string[] } {
  const calls: string[] = [];
  const run: Runner = (cmd, args, cwd) => {
    const line = [cmd, ...args].join(' ');
    calls.push(cwd ? `${line} @${cwd.split('/').slice(-2).join('/')}` : line);
    const key = Object.keys(over).find((k) => line.startsWith(k));
    if (key) return { status: over[key]!, stdout: '', stderr: 'boom' };
    if (line === 'cargo near --version') return { status: 0, stdout: 'cargo-near-near 0.23.0', stderr: '' };
    if (line.startsWith('cargo near build reproducible-wasm')) {
      const out = args[args.indexOf('--out-dir') + 1]!;
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'tender.wasm'), GOOD_WASM);
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

describe('rebuild', () => {
  it('reads the rev from the NEP-330 snapshot', () => {
    expect(snapshotRev(meta.build_info.source_code_snapshot)).toBe(REV);
    expect(snapshotRev('git+https://github.com/o/tender')).toBeNull();
  });

  it('clones, checks out the metadata rev (not HEAD) and hashes the Docker build', async () => {
    const { run, calls } = fakeRunner();
    const r = await rebuildFromMetadata(meta, { repo: '/repo', run, log: () => {} });
    expect(r).toEqual({ kind: 'hash', codeHash: codeHashB58(GOOD_WASM), rev: REV });
    expect(calls.some((c) => c.startsWith('git clone --quiet /repo '))).toBe(true);
    expect(calls.some((c) => c.endsWith(`checkout --quiet ${REV}`))).toBe(true);
    expect(calls.find((c) => c.startsWith('cargo near build'))).toMatch(/reproducible-wasm --out-dir \S+ @src\/contract$/);
  });

  it('missing docker, wrong cargo-near or an unknown commit → unavailable (verify prints WARN)', async () => {
    expect((await rebuildFromMetadata(meta, { repo: '/r', run: fakeRunner({ 'docker --version': 127 }).run, log: () => {} })).kind).toBe('unavailable');
    expect((await rebuildFromMetadata(meta, { repo: '/r', run: fakeRunner({ 'cargo near --version': 1 }).run, log: () => {} })).kind).toBe('unavailable');
    const co = await rebuildFromMetadata(meta, { repo: '/r', run: fakeRunner({ 'git -C': 128 }).run, log: () => {} });
    expect(co).toEqual({ kind: 'unavailable', reason: `commit ${REV} is not in /r (git fetch it first)` });
    expect((await rebuildFromMetadata({ build_info: {} }, { repo: '/r', run: fakeRunner().run, log: () => {} })).kind).toBe('unavailable');
  });
});
