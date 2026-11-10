import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromBase64 } from "@tender/intents";
import { APP_PK_JSON } from "@tender/seal";
import { eoaCkdStep, flipSalt, garbageBid, main, resolveMode, type AttackEnv } from "../scripts/attack-bids.js";
import type { BidView } from "../scripts/lib/views.js";
import { bidView, configView, saleView } from "./helpers/views.js";

const CONTRACT = "v1.tenderseal.near";
const bid = (idx: number): BidView => bidView({ idx, bidder: `bidder${idx}.near`, ct: Buffer.alloc(160, idx + 1).toString("base64"), cm: String(idx + 1).repeat(64).slice(0, 64) });

function env(over: Partial<AttackEnv> = {}, mode = "identity"): (c: unknown) => AttackEnv {
  return () => ({
    config: async () => configView({ app_pk_mode: mode }),
    sale: async (id) => saleView({ id, path: "tender/2/00112233445566778899aabbccddeeff", lot_exp: 3, reserve: "1", bids: 2 }),
    bids: async () => [bid(0), bid(1), bid(2)],
    ...over,
  });
}

async function run(args: string[], e = env(), extra: { salesDir?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "atk-"));
  const code = await main(args, { env: e, io: { out: (l) => out.push(l), err: (l) => err.push(l) }, bidsDir: dir, ...extra });
  return { code, out: out.join("\n"), err: err.join("\n"), dir };
}

describe("garbage", () => {
  it("random 160 B ciphertext (base64 standard, padded) and 32 B commitment (64 lowercase hex)", async () => {
    const r = await run(["garbage", "--sale", "3", "--escrow", "1", "--origin", "base"]);
    expect(r.code).toBe(0);
    const file = join(r.dir, "3-garbage.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const j = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(j)).toEqual(["sale", "ct", "cm", "escrow", "origin"]);
    expect(j.sale).toBe("3");
    expect(j.escrow).toBe("1000000");
    expect(j.origin).toBe("base");
    expect(j.ct).toHaveLength(216);
    expect(j.ct.endsWith("==")).toBe(true);
    expect(fromBase64(j.ct)).toHaveLength(160);
    expect(j.cm).toMatch(/^[0-9a-f]{64}$/);
  });

  it("two runs differ", () => {
    expect(garbageBid("3", 1_000_000n, "base").ct).not.toBe(garbageBid("3", 1_000_000n, "base").ct);
  });

  it("refuses an escrow below 1 USDC and a missing origin", async () => {
    expect((await run(["garbage", "--sale", "3", "--escrow", "0.5", "--origin", "base"])).code).toBe(1);
    expect((await run(["garbage", "--sale", "3", "--escrow", "1"])).code).toBe(1);
  });
});

describe("copy", () => {
  it("takes ct and cm of the source bid byte for byte", async () => {
    const r = await run(["copy", "--sale", "3", "--from-idx", "1", "--escrow", "1", "--origin", "sol"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(readFileSync(join(r.dir, "3-copy.json"), "utf8"));
    expect(j).toEqual({ sale: "3", ct: bid(1).ct, cm: bid(1).cm, escrow: "1000000", origin: "sol" });
  });

  it("unknown index is an error", async () => {
    const r = await run(["copy", "--sale", "3", "--from-idx", "9", "--escrow", "1", "--origin", "sol"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no bid with idx 9/);
  });
});

describe("wrong-cm", () => {
  const keyed = env({ sale: async (id) => saleView({ id, state: "Keyed" }) });
  const sealed = (over: Record<string, unknown> = {}) => {
    const file = join(mkdtempSync(join(tmpdir(), "wcm-")), "b.json");
    writeFileSync(file, JSON.stringify({ sale: "3", p: "3500000", q: "1000000", salt: "00112233445566778899aabbccddeeff", cm: "ab".repeat(32), ...over }));
    return file;
  };

  it("flips exactly one bit of the salt and leaves cm alone", async () => {
    const r = await run(["wrong-cm", "--sale", "3", "--idx", "0", "--sealed", sealed()], keyed);
    expect(r.code).toBe(0);
    const args = JSON.parse(/json-args '([^']+)'/.exec(r.out)![1] as string);
    expect(args).toEqual({ sale: "3", items: [{ idx: 0, p: "3500000", q: "1000000", salt: "01112233445566778899aabbccddeeff" }] });
    expect(r.out).toContain("method=reveal");
    expect(r.out).toContain("gas=100 Tgas");
    expect(r.out).not.toContain("abab"); // cm is not part of reveal and is not recomputed
  });

  it("flipSalt changes only the lowest bit of the first byte", () => {
    const a = "ff112233445566778899aabbccddeeff";
    const b = flipSalt(a);
    expect(b).toBe("fe112233445566778899aabbccddeeff");
    expect(flipSalt(b)).toBe(a);
    expect(() => flipSalt("abc")).toThrow();
  });

  it("refuses a file of another sale", async () => {
    const r = await run(["wrong-cm", "--sale", "3", "--idx", "0", "--sealed", sealed({ sale: "2" })], keyed);
    expect(r.code).toBe(1);
  });

  it("while the sale is Open (bids still accepted) it prints no reveal: the call would publish p and q before the key", async () => {
    const open = env({ sale: async (id) => saleView({ id, state: "Open" }) });
    const r = await run(["wrong-cm", "--sale", "3", "--idx", "0", "--sealed", sealed()], open);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/is Open, not Keyed/);
    expect(r.out).not.toContain("near contract call-function");
    expect(r.out).not.toContain("3500000");
    expect(r.err).not.toContain("3500000");
  });
});

describe("early-open", () => {
  it("prints the open call", async () => {
    const r = await run(["early-open", "--sale", "2"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("near contract call-function as-transaction v1.tenderseal.near open json-args '{\"sale\":\"2\"}'");
    expect(r.out).toContain("sign-as tenderseal.near");
  });
});

describe("eoa-ckd", () => {
  // Exact constants of the card
  const IDENTITY = `{"AppPublicKeyPV":{"pk1":"bls12381g1:83VnBdpeT9ioHuUTBD2zcitXg7JqNiebUs5yxDaYaLgZYDLLk2gayHrJKNyRt4vBQB","pk2":"bls12381g2:2995BcogDeU9PQxbssLWhG9J76ubezYVpjbceWnwcmRs9ypA2vYDikf8mpuzankQX6WMsDockieKarmDerS2xTPzR1dktiHiGkjvPpRYpDip6unu4WgtPqeCPtxqppMzuGwy"}}`;
  const GENERATOR = `{"AppPublicKeyPV":{"pk1":"bls12381g1:6aGxBiDyBZxEL9RKJz8W2h7VQUUKv9BPqHbC2DNWKExVRM7GWtLk6mTQBYXbpgRHwp","pk2":"bls12381g2:swVJmkrgSeVKhyDHqRXbDhToeQtR2JPTTnD6fp9Jty9jfLDqDh7sAhgbHBZTfXDFh3kvZxMCwe5w4R7FXbHNt6PUkyJEsuvJ8bsqFocwyuygsJMpjaFYB8914BoaiNFsUiK"}}`;
  const PLAIN = `{"AppPublicKey":"bls12381g1:6aGxBiDyBZxEL9RKJz8W2h7VQUUKv9BPqHbC2DNWKExVRM7GWtLk6mTQBYXbpgRHwp"}`;

  it("the three app_public_key JSONs are the card's constants", () => {
    expect(JSON.stringify(APP_PK_JSON.identity)).toBe(IDENTITY);
    expect(JSON.stringify(APP_PK_JSON.generator)).toBe(GENERATOR);
    expect(JSON.stringify(APP_PK_JSON.plain)).toBe(PLAIN);
  });

  it.each([["identity", IDENTITY], ["generator", GENERATOR], ["plain", PLAIN]] as const)("%s", (mode, json) => {
    const s = eoaCkdStep({ signer: "tenderseal.near", mpc: "v1.signer", path: "tender/v1/2", mode, domainId: 2, network: "mainnet" });
    expect(s.receiver).toBe("v1.signer");
    expect(s.method).toBe("request_app_private_key");
    expect(s.deposit).toBe("1 yoctoNEAR");
    expect(JSON.stringify((s.args as any).request.app_public_key)).toBe(json);
    expect((s.args as any).request.derivation_path).toBe("tender/v1/2");
    expect((s.args as any).request.domain_id).toBe(2);
  });

  it("reads the path from get_sale and the mode from the init file and the chain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sales-"));
    writeFileSync(join(dir, "v1-init.json"), JSON.stringify({ app_pk_mode: "generator" }));
    const r = await run(["eoa-ckd", "--sale", "2"], env({}, "generator"), { salesDir: dir });
    expect(r.code).toBe(0);
    expect(r.out).toContain("tender/2/00112233445566778899aabbccddeeff");
    expect(r.out).toContain("AppPublicKeyPV");
    expect(r.out).toContain(`"pk1":"bls12381g1:6aGxBiDy`);
    expect(r.out).toContain("sign-as tenderseal.near");
  });

  it("a placeholder in the init file needs --mode; a clash is an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sales-"));
    writeFileSync(join(dir, "v1-init.json"), JSON.stringify({ app_pk_mode: "<identity|generator|plain>" }));
    const e = env({}, "<unknown>");
    expect((await run(["eoa-ckd", "--sale", "2"], e, { salesDir: dir })).err).toMatch(/not decided yet/);
    expect((await run(["eoa-ckd", "--sale", "2", "--mode", "plain"], e, { salesDir: dir })).code).toBe(0);
    expect((await run(["eoa-ckd", "--sale", "2", "--mode", "plain"], env({}, "identity"), { salesDir: dir })).err).toMatch(/disagrees/);
  });

  it("resolveMode", () => {
    expect(resolveMode({ file: "identity" })).toBe("identity");
    expect(() => resolveMode({ file: "identity", flag: "plain" })).toThrow(/disagrees/);
    expect(() => resolveMode({ flag: "nope" })).toThrow(/--mode/);
    expect(() => resolveMode({ file: "<x>" })).toThrow(/not decided/);
  });
});

describe("usage", () => {
  it("unknown subcommand and missing --sale exit 2", async () => {
    expect((await run(["bogus", "--sale", "1"])).code).toBe(2);
    expect((await run(["garbage"])).code).toBe(2);
  });
});
