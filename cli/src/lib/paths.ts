import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root: the first ancestor with pnpm-workspace.yaml (pnpm runs scripts with cwd = cli/). */
export function repoRoot(start: string = dirname(fileURLToPath(import.meta.url))): string {
  for (let d = resolve(start); ; d = dirname(d)) {
    if (existsSync(join(d, 'pnpm-workspace.yaml'))) return d;
    if (dirname(d) === d) throw new Error(`pnpm-workspace.yaml not found above ${start}`);
  }
}

/** A path the user typed, relative to where they ran pnpm (INIT_CWD), not to cli/. */
export function userPath(p: string): string {
  return resolve(process.env.INIT_CWD ?? process.cwd(), p);
}

export function fixturePath(rel: string): string {
  return join(repoRoot(), 'fixtures', rel);
}

/**
 * fixtures/clearing/demo-sale-1.json (WS1). Until WS1 commits it, the temporary copy in
 * packages/clearing/test-fixtures.
 */
export function demoSaleFixturePath(): string {
  const shared = fixturePath('clearing/demo-sale-1.json');
  if (existsSync(shared)) return shared;
  return join(repoRoot(), 'packages/clearing/test-fixtures/demo-sale-1.local.json');
}
