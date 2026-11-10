// node:util parseArgs with the flags every command shares. No dependency.
import { type ParseArgsOptionsConfig, parseArgs } from 'node:util';

export const COMMON_OPTIONS = {
  network: { type: 'string' },
  contract: { type: 'string' },
  rpc: { type: 'string' },
  'archival-rpc': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsOptionsConfig;

export const COMMON_USAGE = '  [--network mainnet|testnet] [--contract <id>] [--rpc <url>] [--archival-rpc <url>] [--help]';

/** Bad command line: print usage, exit 2. */
export class UsageError extends Error {
  readonly exitCode = 2;
}

/** `withNetwork: false` for offline commands (only --help is shared). */
export function parseCli<T extends ParseArgsOptionsConfig>(argv: string[], options: T, withNetwork = true) {
  const common = withNetwork ? COMMON_OPTIONS : { help: COMMON_OPTIONS.help };
  try {
    return parseArgs({ args: argv, options: { ...(common as typeof COMMON_OPTIONS), ...options }, strict: true, allowPositionals: false }).values;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const consoleIo: Io = { out: (l) => console.log(l), err: (l) => console.error(l) };

/** Runs a command's main with the usage/exit-code convention (2 = usage, 1 = failure). */
export async function runMain(main: (argv: string[], io: Io) => Promise<number>, usage: string): Promise<void> {
  try {
    process.exitCode = await main(process.argv.slice(2), consoleIo);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n${usage}`);
      process.exitCode = 2;
      return;
    }
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
