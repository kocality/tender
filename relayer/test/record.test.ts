import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordTx, extractCkd } from "../scripts/record.js";
import { rpcHooks } from "../scripts/lib/rpc.js";

const HASH = "353gaj2sj4D6u7t1iciJaV467zwFioQdVasenWND6qnJ";
const b64 = (s: string) => Buffer.from(s).toString("base64");
const ckdResponse = JSON.stringify({ big_y: "bls12381g1:Y", big_c: "bls12381g1:C" });

function txResult(status: object) {
  return {
    status,
    transaction: { signer_id: "alice.near", receiver_id: "bob.near" },
    transaction_outcome: { block_hash: "BLK0" },
    receipts_outcome: [
      { block_hash: "BLK1", outcome: { executor_id: "v1.signer", logs: ['request_app_private_key: predecessor=AccountId("alice.near") derivation_path: "tender-spike/s1/identity/1"'], status: { SuccessReceiptId: "x" } } },
      { block_hash: "BLK2", outcome: { executor_id: "v1.signer", logs: [], status: { SuccessValue: b64(ckdResponse) } } },
    ],
  };
}

function stubRpc(result: object) {
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body);
    if (method === "EXPERIMENTAL_tx_status") return new Response(JSON.stringify({ result }));
    if (method === "block") return new Response(JSON.stringify({ result: { header: { height: { BLK0: 100, BLK1: 101, BLK2: 103 }[params.block_id as string] } } }));
    return new Response(JSON.stringify({ error: { name: "X", cause: { name: "UNEXPECTED" } } }));
  });
}

beforeEach(() => void vi.spyOn(rpcHooks, "sleep").mockResolvedValue(undefined));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("extractCkd", () => {
  it("finds caller, path, response and the request/response receipts", () => {
    const out = extractCkd(txResult({ SuccessValue: b64(ckdResponse) }), "v1.signer");
    expect(out).toMatchObject({ caller: "alice.near", path: "tender-spike/s1/identity/1", requestBlockHash: "BLK1", responseBlockHash: "BLK2" });
    expect(out?.response).toEqual({ big_y: "bls12381g1:Y", big_c: "bls12381g1:C" });
  });
  it("returns null when the MPC was not called", () => {
    expect(extractCkd(txResult({ SuccessValue: "" }), "other.signer")).toBeNull();
  });
});

describe("recordTx", () => {
  it("writes the snapshot and the row, expected failure vs success warns", async () => {
    stubRpc(txResult({ SuccessValue: "" }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "tender-rec-"));
    const row = await recordTx({ network: "mainnet", sale: "ops", step: "fund", txHash: HASH, signer: "alice.near", expect: "failure", evidenceDir: dir });
    expect(row).toMatchObject({ block: 100, outcome: "success", expected: "failure", snapshot_source: "rpc", signer_id: "alice.near" });
    expect(row.note).toMatch(/WARN expected failure but got success/);
    const rows = JSON.parse(readFileSync(join(dir, "mainnet.json"), "utf8"));
    expect(rows).toHaveLength(1);
    const snap = JSON.parse(readFileSync(join(dir, "rpc", `${HASH}.json`), "utf8"));
    expect(snap._meta.label).toBe("snapshot, not live");
    expect(snap.result.status).toEqual({ SuccessValue: "" });
  });
  it("--dry-run writes nothing", async () => {
    stubRpc(txResult({ Failure: { ActionError: {} } }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "tender-rec-"));
    const row = await recordTx({ network: "mainnet", sale: "3", step: "attack-wrong-cm", txHash: HASH, signer: "alice.near", expect: "failure", dryRun: true, evidenceDir: dir });
    expect(row.outcome).toBe("failure");
    expect(row.note).toBeUndefined();
    expect(() => readFileSync(join(dir, "mainnet.json"))).toThrow();
  });
  it("saves the EOA CKD response in the seal:try format", async () => {
    stubRpc(txResult({ SuccessValue: b64(ckdResponse) }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "tender-rec-"));
    const out = join(dir, "eoa-ckd.json");
    await recordTx({ network: "mainnet", sale: "2", step: "attack-eoa-ckd", txHash: HASH, signer: "alice.near", saveResult: out, evidenceDir: dir });
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
      gate: "M15", network: "mainnet", mpc: "v1.signer", caller: "alice.near", path: "tender-spike/s1/identity/1",
      response: { big_y: "bls12381g1:Y", big_c: "bls12381g1:C" }, tx_hash: HASH, blocks: { tx: 100, request: 101, response: 103 },
    });
  });
});
