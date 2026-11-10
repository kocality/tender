import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { KeyPair } from "near-api-js";
import type { Network } from "./rpc.js";

// The only place that reads private keys. A key is never printed, logged or put in an error message.

export type KeyPairString = `ed25519:${string}`;

export function credentialsDir(): string {
  const dir = process.env.NEAR_CREDENTIALS_DIR || "~/.near-credentials";
  return dir === "~" || dir.startsWith("~/") ? join(homedir(), dir.slice(1)) : dir;
}

const isKey = (v: unknown): v is KeyPairString => typeof v === "string" && /^ed25519:[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(v);

export function publicKeyOf(secret: KeyPairString): string {
  return KeyPair.fromString(secret).getPublicKey().toString();
}

function warnIfOpen(file: string): void {
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) console.warn(`WARN ${file} has mode ${mode.toString(8)}, expected 600 (chmod 600 it)`);
}

function readKeyFile(file: string): { privateKey: KeyPairString; publicKey?: string } {
  warnIfOpen(file);
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON`); // never include the parser message: it can quote file content
  }
  const sk = json.private_key ?? json.secret_key; // near-cli-rs / legacy near-cli
  if (!isKey(sk)) throw new Error(`${file} has no ed25519 "private_key" or "secret_key"`);
  return { privateKey: sk, publicKey: typeof json.public_key === "string" ? json.public_key : undefined };
}

/**
 * Order: env var (opts.envVar, e.g. KEEPER_PRIVATE_KEY) -> <dir>/<net>/<acct>.json
 * -> <dir>/<net>/<acct>/ed25519_<pk>.json (when opts.publicKey is given, or when it is the only file).
 */
export function loadKeyPair(network: Network, accountId: string, opts: { publicKey?: string; envVar?: string } = {}): KeyPairString {
  return resolveKey(network, accountId, opts).privateKey;
}

/** Same lookup as loadKeyPair, plus where the key came from (an env var name or a file path; never the key). */
export function resolveKey(
  network: Network,
  accountId: string,
  opts: { publicKey?: string; envVar?: string } = {},
): { privateKey: KeyPairString; source: string } {
  if (opts.envVar) {
    const v = process.env[opts.envVar];
    if (v) {
      if (!isKey(v)) throw new Error(`${opts.envVar} is set but is not an "ed25519:<base58>" secret key`);
      return { privateKey: v, source: `env ${opts.envVar}` };
    }
  }
  const dir = credentialsDir();
  const main = join(dir, network, `${accountId}.json`);
  if (existsSync(main)) {
    const k = readKeyFile(main);
    if (!opts.publicKey || k.publicKey === opts.publicKey || publicKeyOf(k.privateKey) === opts.publicKey) return { privateKey: k.privateKey, source: main };
  }
  const sub = join(dir, network, accountId);
  if (existsSync(sub) && statSync(sub).isDirectory()) {
    const files = readdirSync(sub).filter((f) => /^ed25519_.+\.json$/.test(f)).sort();
    if (opts.publicKey) {
      const want = `ed25519_${opts.publicKey.replace(/^ed25519:/, "")}.json`;
      if (files.includes(want)) return { privateKey: readKeyFile(join(sub, want)).privateKey, source: join(sub, want) };
    } else if (files.length === 1) {
      const file = join(sub, files[0] as string);
      return { privateKey: readKeyFile(file).privateKey, source: file };
    } else if (files.length > 1) {
      throw new Error(`${sub} has ${files.length} keys; pass the public key to choose one: ${files.map((f) => f.slice(8, -5)).join(", ")}`);
    }
  }
  throw new Error(
    `no key for ${accountId} on ${network}${opts.publicKey ? ` with public key ${opts.publicKey}` : ""} (looked in ${main}, ${sub}${opts.envVar ? `, env ${opts.envVar}` : ""})`,
  );
}

/** Used only by birth.ts --add-full-access-key generate: writes <dir>/<net>/<acct>.json with mode 600; refuses to overwrite. */
export function writeNewKeyPair(network: Network, accountId: string): { publicKey: string; path: string } {
  const path = join(credentialsDir(), network, `${accountId}.json`);
  if (existsSync(path)) throw new Error(`${path} already exists; refusing to overwrite a key file`);
  const kp = KeyPair.fromRandom("ed25519");
  const publicKey = kp.getPublicKey().toString();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ account_id: accountId, public_key: publicKey, private_key: kp.toString() }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return { publicKey, path };
}
