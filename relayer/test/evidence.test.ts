import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  explorerUrl, upsertGateRow, upsertMainnetRow, validateGateRow, validateMainnetRow,
  type GateRow, type MainnetRow,
} from "../scripts/lib/evidence.js";

const HASH = "353gaj2sj4D6u7t1iciJaV467zwFioQdVasenWND6qnJ";
const row = (): MainnetRow => ({ sale: "ops", step: "fund", tx_hash: HASH, block: 223833424, explorer_url: explorerUrl("mainnet", HASH) });
const gate = (): GateRow => ({ gate: "S3b", date_utc: "2026-11-10T06:00:00.000Z", result: "PASS", chosen_path: "direct", tx_hashes: [HASH], blocks: {}, notes: "" });

describe("evidence rows", () => {
  it("accepts a valid row", () => expect(validateMainnetRow(row())).toEqual([]));
  it("reports a missing tx_hash", () => {
    const { tx_hash: _omit, ...rest } = row();
    expect(validateMainnetRow(rest).join(" ")).toMatch(/tx_hash is missing/);
  });
  it("rejects a string block", () => {
    expect(validateMainnetRow({ ...row(), block: "223833424" }).join(" ")).toMatch(/block must be/);
  });
  it("rejects unknown sale and step", () => {
    expect(validateMainnetRow({ ...row(), sale: "9", step: "nope" })).toHaveLength(2);
  });
  it("validates gate rows", () => {
    expect(validateGateRow(gate())).toEqual([]);
    expect(validateGateRow({ ...gate(), result: "MAYBE" }).join(" ")).toMatch(/result/);
  });
  it("explorerUrl picks the testnet domain", () => {
    expect(explorerUrl("testnet", "abc")).toBe("https://testnet.nearblocks.io/txns/abc");
    expect(explorerUrl("mainnet", "abc")).toBe("https://nearblocks.io/txns/abc");
  });
});

describe("upsert", () => {
  const file = () => join(mkdtempSync(join(tmpdir(), "tender-ev-")), "mainnet.json");
  it("adds then updates the same (tx_hash, step)", () => {
    const f = file();
    expect(upsertMainnetRow(f, row())).toBe("added");
    expect(upsertMainnetRow(f, { ...row(), note: "again" })).toBe("updated");
    const rows = JSON.parse(readFileSync(f, "utf8"));
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("again");
    expect(readFileSync(f, "utf8").endsWith("]\n")).toBe(true);
  });
  it("keeps order and treats a different step as a new row", () => {
    const f = file();
    upsertMainnetRow(f, row());
    expect(upsertMainnetRow(f, { ...row(), step: "deposit" })).toBe("added");
    expect(JSON.parse(readFileSync(f, "utf8")).map((r: MainnetRow) => r.step)).toEqual(["fund", "deposit"]);
  });
  it("refuses an invalid row", () => {
    expect(() => upsertMainnetRow(file(), { ...row(), block: "x" as unknown as number })).toThrow(/invalid mainnet row/);
  });
  it("gate rows are keyed by gate", () => {
    const f = file();
    expect(upsertGateRow(f, gate())).toBe("added");
    expect(upsertGateRow(f, { ...gate(), result: "ALT" })).toBe("updated");
    expect(JSON.parse(readFileSync(f, "utf8"))).toHaveLength(1);
  });
});
