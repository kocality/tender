// verify --rebuild: rebuild the deployed contract in Docker from the commit its NEP-330 metadata names and compare
// code hashes. The commit comes from contract_source_metadata, never from the local HEAD (P-10).
// `cargo near build reproducible-wasm` clones the crate's repo itself; the "HEAD pushed to remote" check only runs
// when deploying, so no extra flag is needed here.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RebuildResult } from './verify-sale.js';
import type { SourceMetadata } from './views.js';
import { codeHashB58 } from './wasm.js';

export const CARGO_NEAR_VERSION = '0.23.0';

export type Runner = (cmd: string, args: string[], cwd?: string) => { status: number | null; stdout: string; stderr: string };

const realRun: Runner = (cmd, args, cwd) => {
  // Build logs go to stderr so stdout stays the report.
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? r.error.message : '') };
};

/** `git+https://github.com/o/r?rev=<sha>` → the sha. */
export function snapshotRev(snapshot: string): string | null {
  return /[?&]rev=([0-9a-f]{7,40})\b/.exec(snapshot)?.[1] ?? null;
}

export async function rebuildFromMetadata(
  meta: SourceMetadata,
  { repo, run = realRun, log = (l: string) => console.error(l) }: { repo: string; run?: Runner; log?: (l: string) => void },
): Promise<RebuildResult> {
  const rev = snapshotRev(meta.build_info?.source_code_snapshot ?? '');
  if (!rev) return { kind: 'unavailable', reason: `no git rev in source_code_snapshot "${meta.build_info?.source_code_snapshot ?? ''}"` };
  const docker = run('docker', ['--version']);
  if (docker.status !== 0) return { kind: 'unavailable', reason: 'docker not found (install Docker, then run again with --rebuild)' };
  const cn = run('cargo', ['near', '--version']);
  if (cn.status !== 0 || !cn.stdout.includes(CARGO_NEAR_VERSION)) {
    return { kind: 'unavailable', reason: `cargo-near ${CARGO_NEAR_VERSION} not found (got "${(cn.stdout || cn.stderr).trim().slice(0, 60)}")` };
  }

  const dir = mkdtempSync(join(tmpdir(), `tender-rebuild-${rev.slice(0, 8)}-`));
  const src = join(dir, 'src');
  const out = join(dir, 'out');
  log(`rebuilding ${rev.slice(0, 12)} in Docker (linux/amd64; ~10 min on Apple Silicon) in ${dir}`);
  const clone = run('git', ['clone', '--quiet', repo, src]);
  if (clone.status !== 0) return { kind: 'unavailable', reason: `git clone ${repo} failed: ${clone.stderr.trim().slice(0, 120)}` };
  const co = run('git', ['-C', src, 'checkout', '--quiet', rev]);
  if (co.status !== 0) return { kind: 'unavailable', reason: `commit ${rev} is not in ${repo} (git fetch it first)` };
  const crate = join(src, meta.build_info?.contract_path || 'contract');
  const b = run('cargo', ['near', 'build', 'reproducible-wasm', '--out-dir', out], crate);
  log(b.stderr.trim().split('\n').slice(-5).join('\n'));
  if (b.status !== 0) return { kind: 'unavailable', reason: `cargo near build reproducible-wasm failed (exit ${b.status}); see the log above` };
  const wasm = existsSync(out) ? readdirSync(out).find((f) => f.endsWith('.wasm')) : undefined;
  if (!wasm) return { kind: 'unavailable', reason: `no .wasm in ${out}` };
  return { kind: 'hash', codeHash: codeHashB58(readFileSync(join(out, wasm))), rev };
}
