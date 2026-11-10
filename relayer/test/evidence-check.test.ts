import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DUE, EXPECTED, checkEvidence, scanSecrets } from "../scripts/evidence-check.js";
import type { MainnetRow } from "../scripts/lib/evidence.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tender-evidence-"));
  mkdirSync(join(dir, "rpc"));
  mkdirSync(join(dir, "oneclick"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const H = (n: number) => String(n).repeat(44).slice(0, 44).replace(/0/g, "A"); // base58-looking hash, distinct per n
const row = (over: Partial<MainnetRow> & { n: number }): MainnetRow => {
  const { n, ...rest } = over;
  return {
    sale: "lock", step: "birth", tx_hash: H(n), block: 100 + n, explorer_url: `https://nearblocks.io/txns/${H(n)}`,
    network: "mainnet", signer_id: "tenderseal.near", outcome: "success", snapshot: `evidence/rpc/${H(n)}.json`, snapshot_source: "rpc", ...rest,
  };
};
const write = (rows: MainnetRow[], snapshots = true) => {
  writeFileSync(join(dir, "mainnet.json"), JSON.stringify(rows));
  if (snapshots) for (const r of rows) writeFileSync(join(dir, "rpc", `${r.tx_hash}.json`), JSON.stringify({ _meta: { label: "snapshot, not live" }, result: {} }));
};
const offline = (extra: object = {}) => checkEvidence({ offline: true, evidenceDir: dir, ...extra });

describe("evidence-check", () => {
  it("a complete lock row passes, the other sales are reported MISSING", async () => {
    write([row({ n: 1 })]);
    const r = await offline({ until: new Date("2026-11-12T09:00:00Z") });
    expect(r.rows).toBe(1);
    expect(r.problems).toEqual([]);
    expect(r.missing).toEqual(expect.arrayContaining(["MISSING R/birth ×1", "MISSING R/bid ×2"]));
    expect(r.missing.some((m) => m.startsWith("MISSING lock/"))).toBe(false);
  });

  it("a missing snapshot is a problem", async () => {
    write([row({ n: 2 })], false);
    expect((await offline()).problems.join("\n")).toMatch(/rpc\/2.*is missing/);
  });

  it("a snapshot without the label is a problem", async () => {
    write([row({ n: 3 })]);
    writeFileSync(join(dir, "rpc", `${H(3)}.json`), JSON.stringify({ result: {} }));
    expect((await offline()).problems.join("\n")).toMatch(/lacks _meta\.label/);
  });

  it("cross-chain rows need both legs, the NEAR hashes and the 1Click status file", async () => {
    write([row({ n: 4, sale: "1", step: "deposit", chain: "base", deposit_address: "0xabc", origin_tx: "0xdef", near_tx_hashes: [] })]);
    const p = (await offline()).problems.join("\n");
    expect(p).toMatch(/near_tx_hashes is empty/);
    expect(p).toMatch(/destination_tx is empty/);
    expect(p).toMatch(/oneclick\/0xabc\.json is missing/);
    write([row({ n: 5, sale: "1", step: "deposit", chain: "base", deposit_address: "0xabc", origin_tx: "0xdef", near_tx_hashes: [H(9)], destination_tx: "0x123" })]);
    writeFileSync(join(dir, "oneclick", "0xabc.json"), "{}");
    expect((await offline()).problems).toEqual([]);
  });

  it("a NEAR-native deposit (no 1Click) is not held to the cross-chain rules", async () => {
    write([row({ n: 6, sale: "ops", step: "deposit", chain: "near" })]);
    expect((await offline()).problems).toEqual([]);
  });

  it("expected failure but recorded success is a problem; recorded failure passes", async () => {
    write([row({ n: 7, sale: "0", step: "attack-early-open", expected: "failure", outcome: "success" })]);
    expect((await offline()).problems.join("\n")).toMatch(/expected a failing transaction/);
    write([row({ n: 8, sale: "0", step: "attack-early-open", expected: "failure", outcome: "failure" })]);
    expect((await offline()).problems).toEqual([]);
  });

  it("counts EXPECTED per step and reports the shortfall", async () => {
    write([row({ n: 10, sale: "1", step: "bid" }), row({ n: 11, sale: "1", step: "bid" })]);
    const r = await offline();
    expect(r.missing).toContain("MISSING 1/bid ×4");
    expect(r.missing).toContain("MISSING 1/create ×1");
    expect(EXPECTED["1"].filter((s) => s === "bid")).toHaveLength(6);
    for (const sale of Object.keys(EXPECTED) as Array<keyof typeof EXPECTED>) expect(DUE[sale]).toHaveLength(EXPECTED[sale].length);
  });

  it("--until drops steps that are not due yet (sale #3 finalize on Sat 04:00Z)", async () => {
    write([]);
    const early = await offline({ until: new Date("2026-11-14T04:00:00Z") });
    expect(early.missing).not.toContain("MISSING 3/finalize ×1");
    expect(early.missing).toContain("MISSING 3/reveal ×1");
    expect((await offline()).missing).toContain("MISSING 3/finalize ×1");
    expect((await offline({ until: new Date("2026-11-10T00:00:00Z") })).missing).toEqual([]);
  });

  it("a recorded outcome that differs from the chain is a problem (live lookup)", async () => {
    write([row({ n: 12 })]);
    const r = await checkEvidence({ offline: false, evidenceDir: dir, lookup: async () => "failure" });
    expect(r.problems.join("\n")).toMatch(/recorded outcome success but the chain says failure/);
    const gone = await checkEvidence({ offline: false, evidenceDir: dir, lookup: async () => null });
    expect(gone.problems.join("\n")).toMatch(/not found on any RPC/);
  });

  it("secret shapes anywhere under evidence/ are problems; transaction signatures are not", async () => {
    write([]);
    const key58 = "5".repeat(88).replace(/5/g, (_, i: number) => "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[i % 58] as string);
    writeFileSync(join(dir, "oneclick", "leak.json"), JSON.stringify({ ok: 1 }) + "\n" + `{"private_key": "x"}\n`);
    writeFileSync(join(dir, "oneclick", "shape.json"), `{"k": "ed25519:${key58}"}\n`);
    writeFileSync(join(dir, "oneclick", "sig.json"), `{\n  "signature": "ed25519:${key58}"\n}\n`);
    const found = scanSecrets(dir);
    expect(found.join("\n")).toMatch(/oneclick\/leak\.json:2 .*private_key/);
    expect(found.join("\n")).toMatch(/oneclick\/shape\.json:1 .*secret key shape/);
    expect(found.join("\n")).not.toMatch(/sig\.json/);
    const r = await offline();
    expect(r.problems.filter((p) => p.startsWith("secret scan:"))).toHaveLength(2);
  });

  it("a method name like request_app_private_key is not a secret", async () => {
    write([]);
    writeFileSync(join(dir, "oneclick", "m.json"), `{"method_name": "request_app_private_key"}\n`);
    expect(scanSecrets(dir)).toEqual([]);
  });
});
