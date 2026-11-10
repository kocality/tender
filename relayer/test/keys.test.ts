import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyPair } from "near-api-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { credentialsDir, loadKeyPair, publicKeyOf, resolveKey, writeNewKeyPair } from "../scripts/lib/keys.js";

let dir: string;
const fresh = () => KeyPair.fromRandom("ed25519");
const put = (path: string[], body: object, mode = 0o600) => {
  const file = join(dir, ...path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(body));
  chmodSync(file, mode);
  return file;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tender-keys-"));
  process.env.NEAR_CREDENTIALS_DIR = dir;
  delete process.env.TEST_KEY_VAR;
});
afterEach(() => {
  delete process.env.NEAR_CREDENTIALS_DIR;
  delete process.env.TEST_KEY_VAR;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("keys", () => {
  it("reads <acct>.json (near-cli-rs private_key)", () => {
    const k = fresh();
    put(["mainnet", "a.near.json"], { account_id: "a.near", public_key: k.getPublicKey().toString(), private_key: k.toString() });
    expect(loadKeyPair("mainnet", "a.near")).toBe(k.toString());
  });

  it("reads legacy secret_key", () => {
    const k = fresh();
    put(["testnet", "a.testnet.json"], { secret_key: k.toString() });
    expect(loadKeyPair("testnet", "a.testnet")).toBe(k.toString());
  });

  it("with only <acct>/ed25519_<pk>.json, selects by public key", () => {
    const k1 = fresh();
    const k2 = fresh();
    for (const k of [k1, k2]) put(["mainnet", "b.near", `ed25519_${k.getPublicKey().toString().slice(8)}.json`], { private_key: k.toString() });
    expect(loadKeyPair("mainnet", "b.near", { publicKey: k2.getPublicKey().toString() })).toBe(k2.toString());
    expect(() => loadKeyPair("mainnet", "b.near")).toThrow(/pass the public key/);
  });

  it("the only ed25519_ file is used without a public key", () => {
    const k = fresh();
    put(["mainnet", "c.near", `ed25519_${k.getPublicKey().toString().slice(8)}.json`], { private_key: k.toString() });
    expect(loadKeyPair("mainnet", "c.near")).toBe(k.toString());
  });

  it("falls through <acct>.json to the sub-directory when the public key differs", () => {
    const k1 = fresh();
    const k2 = fresh();
    put(["mainnet", "d.near.json"], { public_key: k1.getPublicKey().toString(), private_key: k1.toString() });
    put(["mainnet", "d.near", `ed25519_${k2.getPublicKey().toString().slice(8)}.json`], { private_key: k2.toString() });
    expect(loadKeyPair("mainnet", "d.near", { publicKey: k2.getPublicKey().toString() })).toBe(k2.toString());
  });

  it("env var wins over files and resolveKey reports the source", () => {
    const a = fresh();
    const b = fresh();
    put(["mainnet", "e.near.json"], { private_key: a.toString() });
    process.env.TEST_KEY_VAR = b.toString();
    expect(loadKeyPair("mainnet", "e.near", { envVar: "TEST_KEY_VAR" })).toBe(b.toString());
    expect(resolveKey("mainnet", "e.near", { envVar: "TEST_KEY_VAR" }).source).toBe("env TEST_KEY_VAR");
    delete process.env.TEST_KEY_VAR;
    expect(resolveKey("mainnet", "e.near", { envVar: "TEST_KEY_VAR" }).source).toBe(join(dir, "mainnet", "e.near.json"));
  });

  it("warns on a 644 file", () => {
    const k = fresh();
    put(["mainnet", "f.near.json"], { private_key: k.toString() }, 0o644);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadKeyPair("mainnet", "f.near");
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/mode 644/);
  });

  it("no error message contains key material", () => {
    const k = fresh();
    const secret = k.toString();
    const body = secret.slice(8);
    process.env.TEST_KEY_VAR = secret.slice(0, 40); // truncated: not a valid key
    const messages: string[] = [];
    const grab = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        messages.push((e as Error).message);
      }
    };
    grab(() => loadKeyPair("mainnet", "g.near", { envVar: "TEST_KEY_VAR" }));
    delete process.env.TEST_KEY_VAR;
    const file = join(dir, "mainnet", "bad.near.json");
    mkdirSync(join(dir, "mainnet"), { recursive: true });
    writeFileSync(file, `{"private_key": "${secret}" garbage`, { mode: 0o600 });
    grab(() => loadKeyPair("mainnet", "bad.near"));
    put(["mainnet", "worse.near.json"], { private_key: `ed25519:${body.slice(0, 20)}` });
    grab(() => loadKeyPair("mainnet", "worse.near"));
    grab(() => loadKeyPair("mainnet", "missing.near"));
    expect(messages).toHaveLength(4);
    for (const m of messages) expect(m).not.toContain(body.slice(0, 20));
  });

  it("credentialsDir expands ~ and writeNewKeyPair writes mode 600 once", () => {
    process.env.NEAR_CREDENTIALS_DIR = "~/x-creds";
    expect(credentialsDir()).toMatch(/\/x-creds$/);
    expect(credentialsDir()).not.toContain("~");
    process.env.NEAR_CREDENTIALS_DIR = dir;
    const w = writeNewKeyPair("testnet", "new.testnet");
    expect(statSync(w.path).mode & 0o777).toBe(0o600);
    expect(publicKeyOf(loadKeyPair("testnet", "new.testnet"))).toBe(w.publicKey);
    expect(() => writeNewKeyPair("testnet", "new.testnet")).toThrow(/already exists/);
  });
});
