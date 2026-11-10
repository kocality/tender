import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Bid files hold plaintext prices and salts of sales that are still open. They live in a gitignored local
// directory and are never staged. The path is assembled from segments so no committed file spells it out.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function bidsDir(): string {
  return join(ROOT, "docs", "internal", "bids");
}

/** 20261110T081500Z, safe in file names. */
export function utcStamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Writes JSON with mode 600 (directory 700) and returns the path. */
export function writeBidFile(dir: string, name: string, data: unknown): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(data, null, 1) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

export interface Io {
  out(line: string): void;
  err(line: string): void;
}
export const consoleIo: Io = { out: (l) => console.log(l), err: (l) => console.error(l) };
