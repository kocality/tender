import { describe, expect, it } from "vitest";
import { evaluate, type Snapshot } from "../scripts/watch.js";
import { saleView } from "./helpers/views.js";

const CLOSE = Date.parse("2026-11-17T12:00:00Z");
const ok = (over: Partial<Snapshot> = {}): Snapshot => ({
  relay: { status: 200, health: { allowance: "499000000000000000000000", balance: "499000000000000000000000" } },
  app: { status: 200 },
  sale: saleView({ close_ns: (BigInt(CLOSE) * 1_000_000n).toString() }),
  ...over,
});

describe("watch evaluate (OPS-07)", () => {
  it("a healthy relay, a live app and sale 2 before its close is fine", () => expect(evaluate(ok(), CLOSE - 3600_000)).toEqual([]));
  it("relay allowance or balance at 0.30 NEAR is a problem; 0.36 is not", () => {
    expect(evaluate(ok({ relay: { status: 200, health: { allowance: "300000000000000000000000" } } }), CLOSE)).toEqual([expect.stringContaining("allowance 0.3 NEAR is below 0.35")]);
    expect(evaluate(ok({ relay: { status: 200, health: { allowance: "500000000000000000000000", balance: "300000000000000000000000" } } }), CLOSE)).toEqual([expect.stringContaining("balance 0.3 NEAR is below 0.35")]);
    expect(evaluate(ok({ relay: { status: 200, health: { allowance: "360000000000000000000000", balance: "360000000000000000000000" } } }), CLOSE)).toEqual([]);
  });
  it("an unreadable relay RPC (unknown) is not an allowance alarm; a relay that does not answer, or a missing URL, is", () => {
    expect(evaluate(ok({ relay: { status: 200, health: { unknown: true, allowance: null } } }), CLOSE)).toEqual([]);
    expect(evaluate(ok({ relay: { error: "timeout" } }), CLOSE)).toEqual(["relay does not answer: timeout"]);
    expect(evaluate(ok({ relay: { status: 502 } }), CLOSE)[0]).toMatch(/502/);
    expect(evaluate(ok({ relay: null }), CLOSE)[0]).toMatch(/RELAY_URL/);
  });
  it("the app must answer 200", () => {
    expect(evaluate(ok({ app: { status: 404 } }), CLOSE)).toEqual(["app answered 404"]);
    expect(evaluate(ok({ app: null }), CLOSE)[0]).toMatch(/APP_URL/);
  });
  it("sale 2 still Open at 11-17 13:00Z is a problem; at 12:20Z it is not (the keeper ticks every 10 minutes)", () => {
    expect(evaluate(ok(), Date.parse("2026-11-17T13:00:00Z"))).toEqual([expect.stringContaining("still Open 60 minutes after its close")]);
    expect(evaluate(ok(), Date.parse("2026-11-17T12:20:00Z"))).toEqual([]);
  });
  it("Keyed an hour past the reveal deadline is a problem", () => {
    const deadline = CLOSE + 86_400_000;
    const sale = saleView({ state: "Keyed", reveal_deadline_ns: (BigInt(deadline) * 1_000_000n).toString(), close_ns: (BigInt(CLOSE) * 1_000_000n).toString() });
    expect(evaluate(ok({ sale }), deadline + 30 * 60_000)).toEqual([]);
    expect(evaluate(ok({ sale }), deadline + 61 * 60_000)).toEqual([expect.stringContaining("Keyed more than 1 hour after")]);
  });
  it("Finalized and fully paid is fine, with a payout missing it is a problem; a sale that does not exist yet is fine", () => {
    expect(evaluate(ok({ sale: saleView({ state: "Finalized", payouts_done: 4, payouts_total: 4 }) }), CLOSE + 3 * 86_400_000)).toEqual([]);
    expect(evaluate(ok({ sale: saleView({ state: "Finalized", payouts_done: 3, payouts_total: 4 }) }), CLOSE + 3 * 86_400_000)).toEqual([expect.stringContaining("3/4 payouts")]);
    expect(evaluate(ok({ sale: saleView({ state: "Cancelled", payouts_done: 0, payouts_total: 3 }) }), CLOSE + 3 * 86_400_000)).toEqual([expect.stringContaining("Cancelled with 0/3")]);
    expect(evaluate(ok({ sale: null }), CLOSE)).toEqual([]);
  });
});
