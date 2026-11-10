import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { b58encode, fromHex } from "@tender/intents";
import { appId, sealBid, simulateCkdResponse, type AppPkMode } from "@tender/seal";
import { decide, sealCrypto } from "../src/keeper.js";
import { bidView, saleView } from "./helpers/views.js";

// Real ciphertexts and a simulated MPC key (the public near/mpc test vectors), no network.
const vectors = (JSON.parse(readFileSync(new URL("../../fixtures/ckd_test_vectors.json", import.meta.url), "utf8")) as { vectors: { msk: string; pk: string }[] }).vectors;
const v0 = vectors[0]!;
const mpk = `bls12381g2:${b58encode(fromHex(v0.pk))}`;
const contract = "v1.tenderseal.near";
const path = "tender/2/00112233445566778899aabbccddeeff";
const NOW = 1_794_916_800_000_000_000n;
const bidders = ["0x0000000000000000000000000000000000001111", "bidder.tenderseal.near", "5d3f0d9f1c0a2b7e8a4c6e1f3b5d7a9c1e3f5a7b9d1c3e5f7a9b1d3f5c7e9a1b"];
const prices = [
  { p: 3_000_000n, q: 1_000_000n, B: 3_000_000n },
  { p: 3_600_000n, q: 2_000_000n, B: 8_000_000n },
  { p: 4_000_000n, q: 500_000n, B: 5_000_000n },
];

function setup(mode: AppPkMode, msk = v0.msk) {
  const key = simulateCkdResponse(msk, mpk, appId(contract, path), mode);
  const bids = prices.map((x, i) => {
    const s = sealBid({ mpk, contract, path, sale: 2n, bidder: bidders[i]!, B: x.B, p: x.p, q: x.q });
    return bidView({ idx: i, bidder: bidders[i]!, escrow: x.B.toString(), ct: s.ct_b64, cm: s.cm_hex });
  });
  const sale = saleView({ state: "Keyed", path, key: { ...key, block: "1", ns: "1" }, bids: 3, bidders: 3, reveal_deadline_ns: (NOW + 86_400_000_000_000n).toString(), payouts_total: 4 });
  return { sale, bids };
}

describe.each(["identity", "generator", "plain"] as const)("decide on real ciphertexts, %s mode", (mode) => {
  it("reveals 3 of 3 items with the plaintext price and size", () => {
    const { sale, bids } = setup(mode);
    const [a] = decide(sale, bids, NOW, sealCrypto, { contractId: contract, mpkG2: mpk, mode });
    expect(a?.kind).toBe("reveal");
    if (a?.kind !== "reveal") return;
    expect(a.items.map((i) => [i.idx, i.p, i.q])).toEqual(prices.map((x, i) => [i, x.p.toString(), x.q.toString()]));
    for (const i of a.items) expect(i.salt).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("decide on real data: bad cases", () => {
  it("a copied ct+cm under another bidder and a random ct are not revealed", () => {
    const { sale, bids } = setup("identity");
    const copy = bidView({ ...bids[0]!, idx: 3, bidder: "copycat.near" });
    const garbage = bidView({ idx: 4, bidder: "mallory.near", ct: Buffer.alloc(160, 7).toString("base64"), cm: "00".repeat(32) });
    const [a] = decide({ ...sale, bids: 5 }, [...bids, copy, garbage], NOW, sealCrypto, { contractId: contract, mpkG2: mpk, mode: "identity" });
    expect(a?.kind === "reveal" ? a.items.map((i) => i.idx) : null).toEqual([0, 1, 2]);
  });
  it("a key made with another master secret stops with FAIL checkKey", () => {
    const { sale, bids } = setup("identity", vectors[1]!.msk);
    const [a] = decide(sale, bids, NOW, sealCrypto, { contractId: contract, mpkG2: mpk, mode: "identity" });
    expect(a).toMatchObject({ kind: "stop" });
    expect(a?.kind === "stop" && a.reason).toContain("FAIL checkKey");
  });
  it("a key for another sale path stops", () => {
    const { sale, bids } = setup("generator");
    const [a] = decide({ ...sale, path: "tender/3/00112233445566778899aabbccddeeff" }, bids, NOW, sealCrypto, { contractId: contract, mpkG2: mpk, mode: "generator" });
    expect(a).toMatchObject({ kind: "stop" });
  });
});
