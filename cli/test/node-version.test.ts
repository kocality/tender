import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const cliDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A preload that makes this Node report version 18.20.8, the way a judge's Node 18 would. */
function fakeNode18(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'node18-')), 'fake.mjs');
  writeFileSync(file, "Object.defineProperty(process.versions, 'node', { value: '18.20.8' });\n");
  return pathToFileURL(file).href;
}

describe('Node version guard (CI-06)', () => {
  const preload = fakeNode18();
  for (const entry of ['verify', 'seal-try', 'seal-bid', 'demo-local']) {
    it(`${entry} on Node 18 exits 1 with the install hint before anything else runs`, () => {
      const r = spawnSync(process.execPath, ['--import', preload, '--import', 'tsx', `src/${entry}.ts`, '--help'], { cwd: cliDir, encoding: 'utf8' });
      expect(r.stderr.trim()).toBe('Tender needs Node 20 or newer (found v18.20.8). Install Node 24.22.2 (see .nvmrc).');
      expect(r.stdout).toBe('');
      expect(r.status).toBe(1);
    });
  }

  it('Node 20 and newer pass the guard (--help prints the usage, exit 0)', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/demo-local.ts', '--help'], { cwd: cliDir, encoding: 'utf8' });
    expect(r.stdout).toMatch(/^usage: pnpm demo:local/);
    expect(r.status).toBe(0);
  });
});
