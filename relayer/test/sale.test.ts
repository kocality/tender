import { describe, expect, it } from "vitest";
import { closeNs, loadSpec, parseDecimal, planSale, reserveFromPrice, type SaleOpts, type SaleState } from "../scripts/sale.js";

const NOW = Date.parse("2026-11-10T08:00:00Z");
const opts = (over: Partial<SaleOpts> = {}): SaleOpts => ({
  network: "mainnet", contract: "v1.tenderseal.near", seller: "tenderseal.near", intents: "intents.near", wrap: "wrap.near",
  fallback: false, allowIdMismatch: false, ...over,
});
const state = (over: Partial<SaleState> = {}): SaleState => ({
  nowMs: NOW, nextId: "1", intentsBalance: 0n, wrapFtBalance: 0n, wrapRegistered: true, ...over,
});

describe("close_ns", () => {
  it("fixed UTC times match the cards", () => {
    expect(closeNs(loadSpec("0"), NOW, false)).toBe(1794542400000000000n);
    expect(closeNs(loadSpec("1"), NOW, false)).toBe(1794542400000000000n);
    expect(closeNs(loadSpec("0"), NOW, true)).toBe(1794628800000000000n);
    expect(closeNs(loadSpec("2"), NOW, false)).toBe(1794916800000000000n);
    expect(closeNs(loadSpec("3"), NOW, false)).toBe(1794564000000000000n);
  });
  it("R is relative to now", () => {
    expect(closeNs(loadSpec("R"), NOW, false)).toBe((BigInt(NOW) + 1_200_000n) * 1_000_000n);
  });
  it("--close fallback needs a utc_fallback", () => {
    expect(() => closeNs(loadSpec("3"), NOW, true)).toThrow(/no utc_fallback/);
  });
});

describe("reserve auto (string math)", () => {
  it("0.000193 per token, lot_exp 3 -> 173700", () => expect(reserveFromPrice("0.000193", 3)).toBe(173700n));
  it("floors long prices without floats", () => expect(reserveFromPrice("0.00019385281604366526", 3)).toBe(174467n));
  it("exponent notation is read exactly", () => {
    expect(parseDecimal("1.5e-7")).toEqual({ digits: 15n, scale: 8 });
    expect(parseDecimal("2e3")).toEqual({ digits: 2000n, scale: 0 });
    expect(() => parseDecimal("abc")).toThrow();
  });
});

describe("planSale", () => {
  it("sale #1: id check, wrap steps, create msg in C5 order with typed fields", () => {
    const p = planSale(loadSpec("1"), opts(), state());
    expect(p.problems).toEqual([]);
    expect(p.steps.map((s) => s.method)).toEqual(["near_deposit", "ft_transfer_call", "mt_transfer_call"]);
    expect(p.steps[0]?.deposit).toBe("3 NEAR");
    expect(p.steps[1]?.args).toEqual({ receiver_id: "intents.near", amount: "3000000000000000000000000", msg: "" });
    const last = p.steps.at(-1)!;
    expect(last.deposit).toBe("1 yoctoNEAR");
    expect(last.gasTgas).toBe(100);
    const msg = JSON.parse((last.args as any).msg);
    expect(Object.keys(msg)).toEqual(["op", "close_ns", "reveal_secs", "reserve", "min_escrow", "min_bidders", "quote_token", "max_bids", "decimals", "lot_exp"]);
    expect(msg.close_ns).toBe("1794542400000000000");
    expect(typeof msg.reserve).toBe("string");
    for (const k of ["min_bidders", "max_bids", "decimals", "lot_exp"]) expect(typeof msg[k]).toBe("number");
    expect((last.args as any).approval).toBeNull();
  });
  it("an unregistered seller gets storage_deposit first (near_deposit would otherwise mint 0.00125 short)", () => {
    const p = planSale(loadSpec("1"), opts(), state({ wrapRegistered: false }));
    expect(p.steps.map((s) => s.method)).toEqual(["storage_deposit", "near_deposit", "ft_transfer_call", "mt_transfer_call"]);
    expect(p.steps[0]?.deposit).toBe("0.00125 NEAR");
  });
  it("wrap steps are skipped when the Intents balance covers the amount", () => {
    const p = planSale(loadSpec("1"), opts(), state({ intentsBalance: 3_000_000_000_000_000_000_000_000n }));
    expect(p.steps.map((s) => s.method)).toEqual(["mt_transfer_call"]);
  });
  it("only the shortfall is wrapped and an existing wNEAR token balance is used first", () => {
    const p = planSale(loadSpec("1"), opts(), state({ intentsBalance: 1_000_000_000_000_000_000_000_000n, wrapFtBalance: 500_000_000_000_000_000_000_000n }));
    expect(p.steps[0]?.deposit).toBe("1.5 NEAR");
    expect((p.steps[1]?.args as any).amount).toBe("2000000000000000000000000");
  });
  it("id mismatch is blocked unless --allow-id-mismatch (M16)", () => {
    expect(planSale(loadSpec("1"), opts(), state({ nextId: "0" })).problems[0]).toMatch(/next sale id on v1\.tenderseal\.near is 0 but sale 1 is id 1/);
    expect(planSale(loadSpec("1"), opts({ allowIdMismatch: true }), state({ nextId: "0" })).problems).toEqual([]);
  });
  it("under --allow-id-mismatch the created sale is looked up at the contract's next id", () => {
    expect(planSale(loadSpec("1"), opts({ allowIdMismatch: true }), state({ nextId: "4" })).saleId).toBe("4");
    expect(planSale(loadSpec("1"), opts(), state({ nextId: "1" })).saleId).toBe("1");
    expect(planSale(loadSpec("1"), opts({ allowIdMismatch: true }), state({ nextId: null })).saleId).toBe("1");
  });
  it("a contract that does not exist yet skips the id check with the card's note", () => {
    const p = planSale(loadSpec("1"), opts(), state({ nextId: null }));
    expect(p.problems).toEqual([]);
    expect(p.notes[0]).toBe("next sale id: account v1.tenderseal.near does not exist yet (dry-run continues with id check skipped)");
  });
  it("decimals + lot_exp outside 20..26 is blocked before sending (contract refund decimals_plus_lot_exp)", () => {
    const low = loadSpec("1");
    low.msg.decimals = 19;
    expect(planSale(low, opts(), state()).problems.join()).toMatch(/decimals \+ lot_exp is 19, create needs 20 to 26/);
    const high = loadSpec("1");
    high.msg.lot_exp = 3;
    expect(planSale(high, opts(), state()).problems.join()).toMatch(/is 27/);
  });
  it("close closer than 300 s is blocked (C6)", () => {
    const spec = loadSpec("R");
    spec.close = { relative_secs: 299 };
    expect(planSale(spec, opts({ contract: "rehearsal.tenderseal.near" }), state({ nextId: "0" })).problems[0]).toMatch(/less than 300 s/);
  });
  it("close farther than 30 days is blocked (C6)", () => {
    expect(planSale(loadSpec("1"), opts(), state({ nowMs: Date.parse("2026-09-01T00:00:00Z") })).problems.join()).toMatch(/more than 30 days/);
  });
  it("sale #2 with no JAMBO says run H-JAMBO first; with JAMBO it uses the whole balance and the live reserve", () => {
    const none = planSale(loadSpec("2"), opts(), state({ nextId: "2", price: { price: "0.000193", updatedAt: "2026-11-10T08:00:00Z" } }));
    expect(none.problems.join()).toMatch(/run H-JAMBO first/);
    const have = planSale(loadSpec("2"), opts(), state({ nextId: "2", intentsBalance: 22450_000000000000000000n, price: { price: "0.000193", updatedAt: "2026-11-10T08:00:00Z" } }));
    expect(have.problems).toEqual([]);
    expect(have.steps.map((s) => s.method)).toEqual(["mt_transfer_call"]);
    expect((have.steps[0]?.args as any).amount).toBe("22450000000000000000000");
    expect(JSON.parse((have.steps[0]?.args as any).msg).reserve).toBe("173700");
    expect(have.notes.join("\n")).toContain("reserve auto: JAMBO $0.000193 at 2026-11-10T08:00:00Z → 0.9 × … = 173700 micro-USDC per 1000 JAMBO");
  });
  it("auto reserve without a price is blocked unless --reserve is given", () => {
    expect(planSale(loadSpec("2"), opts(), state({ nextId: "2", intentsBalance: 1n })).problems.join()).toMatch(/--reserve/);
    expect(JSON.parse((planSale(loadSpec("2"), opts({ reserveOverride: "170000" }), state({ nextId: "2", intentsBalance: 1n })).steps[0]?.args as any).msg).reserve).toBe("170000");
  });
  it("testnet copies: wrap, quote token and Intents ids are replaced", () => {
    const p = planSale(loadSpec("R"), opts({ network: "testnet", contract: "v1.tender-aaaaaa.testnet", seller: "tender-aaaaaa.testnet", intents: "intents-aaaaaa.testnet", wrap: "wrap.testnet", quoteToken: "nep141:usdc-aaaaaa.testnet" }), state({ nextId: "0" }));
    expect(p.tokenId).toBe("nep141:wrap.testnet");
    expect(p.steps.every((s) => s.signer === "tender-aaaaaa.testnet")).toBe(true);
    expect((p.createMsg as any).quote_token).toBe("nep141:usdc-aaaaaa.testnet");
    expect(p.steps.at(-1)?.receiver).toBe("intents-aaaaaa.testnet");
  });
});

describe("sales specs on disk", () => {
  it("amounts, ids and wrap_near agree for all five sales", () => {
    for (const [tag, id] of [["R", "0"], ["0", "0"], ["1", "1"], ["2", "2"], ["3", "3"]] as const) {
      const s = loadSpec(tag);
      expect(s.id).toBe(id);
      expect(s.tag).toBe(tag);
      expect(JSON.stringify(s)).not.toMatch(/salt|ciphertext|"ct"/);
      const p = planSale(s, opts({ contract: s.contract }), state({ nextId: id, intentsBalance: tag === "2" ? 1n : 0n, price: { price: "0.0002", updatedAt: "x" } }));
      expect(p.problems.filter((x) => !/less than 300 s|more than 30 days/.test(x))).toEqual([]);
    }
  });
});
