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

/** The demo sale's golden clearing vector, shared with the contract tests. */
export function demoSaleFixturePath(): string {
  return fixturePath('clearing/demo-sale-1.json');
}
