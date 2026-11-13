import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { closeNs, loadSpec, parseDecimal, planSale, reserveFromPrice, type SaleOpts, type SaleState } from "../scripts/sale.js";
import { saleView } from "./helpers/views.js";

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
    // #0 and #1 get tonight's close written into the spec right before the creates (runbook step 5), so they are read from the spec
    const ns = (utc?: string) => BigInt(Date.parse(utc as string)) * 1_000_000n;
    for (const tag of ["0", "1"]) {
      const spec = loadSpec(tag);
      expect(closeNs(spec, NOW, false)).toBe(ns(spec.close.utc));
      expect(closeNs(spec, NOW, true)).toBe(ns(spec.close.utc_fallback));
      expect(closeNs(spec, NOW, true) > closeNs(spec, NOW, false)).toBe(true);
    }
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
    expect(msg.close_ns).toBe(String(BigInt(Date.parse(loadSpec("1").close.utc as string)) * 1_000_000n));
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

describe("sale decimals against ft_metadata (X12-03)", () => {
  const plan = (decimals: SaleState["decimals"], o: Partial<SaleOpts> = {}, tag = "2") =>
    planSale(loadSpec(tag), opts(o), state({ nextId: tag, intentsBalance: 1n, price: { price: "0.0002", updatedAt: "x" }, decimals }));
  it("the declared decimals equal the token's: no problem; wrong by 10^k: blocked with both numbers", () => {
    expect(plan({ token: 18, quote: 6 }).problems).toEqual([]);
    expect(plan({ token: 6, quote: 6 }).problems.join()).toMatch(/jambo-1679\.meme-cooking\.near has decimals 6 in ft_metadata but the sale says 18/);
  });
  it("a quote token that is not 6 decimals is blocked (every price is in micro-USDC)", () => {
    expect(plan({ token: 18, quote: 18 }).problems.join()).toMatch(/quote token .* has decimals 18 in ft_metadata but the sale says 6/);
  });
  it("an unreadable ft_metadata blocks on mainnet and is a note on a testnet copy", () => {
    expect(plan({ token: null, quote: 6 }).problems.join()).toMatch(/cannot read ft_metadata of jambo-1679\.meme-cooking\.near/);
    const t = plan({ token: null, quote: null }, { network: "testnet", contract: "v1.tender-aaaaaa.testnet", seller: "tender-aaaaaa.testnet", intents: "intents-aaaaaa.testnet", wrap: "wrap.testnet" }, "R");
    expect(t.problems.filter((x) => /ft_metadata/.test(x))).toEqual([]);
    expect(t.notes.join()).toMatch(/cannot read ft_metadata/);
  });
  it("without a reading the plan is unchanged (unit callers)", () => expect(plan(undefined).problems.filter((x) => /ft_metadata/.test(x))).toEqual([]));
});

describe("sales/README.md states the rules the script enforces (X12-05, X12A-01, X12-03)", () => {
  const readme = readFileSync(new URL("../../sales/README.md", import.meta.url), "utf8");
  it("decimals + lot_exp is 20 to 26 with the price ceiling of low-decimal tokens, not only <= 26", () => {
    expect(readme).toMatch(/decimals \+ lot_exp <= 26/);
    expect(readme).toMatch(/20 <= decimals \+ lot_exp/);
    expect(readme).toMatch(/0\.18 USDC/);
  });
  it("--again and the Open-twin refusal are explained; v1 runs generator (CRYPTO-07)", () => {
    expect(readme).toMatch(/--again/);
    expect(readme).toMatch(/identical to one still Open/);
    expect(readme).toMatch(/v1 runs `generator`/);
    expect(readme).not.toMatch(/so the files carry `identity`/);
  });
  it("sale 0's min_escrow above the escrow cap is explained, and the ft_metadata check is named", () => {
    expect(readme).toMatch(/1000000000001/);
    expect(readme).toMatch(/ft_metadata/);
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

describe("twin sale 0 stays unopenable (X12A-01)", () => {
  const cap = BigInt(/MAX_ESCROW_TOTAL: u128 = ([\d_]+);/.exec(readFileSync(new URL("../../contract/src/sale.rs", import.meta.url), "utf8"))![1]!.replaceAll("_", ""));
  it("the cap read from the contract is 10^12 micro-USDC", () => expect(cap).toBe(1_000_000_000_000n));
  it("sale 0 asks for more escrow than the contract ever accepts, so nobody can fund it open; the sales that must open ask for less", () => {
    expect(BigInt(loadSpec("0").msg.min_escrow)).toBeGreaterThan(cap);
    for (const tag of ["R", "1", "2", "3"]) expect(BigInt(loadSpec(tag).msg.min_escrow)).toBeLessThanOrEqual(cap);
  });
  it("the dry-run says so", () => {
    expect(planSale(loadSpec("0"), opts(), state({ nextId: "0" })).notes.join("\n")).toMatch(/min_escrow 1000000000001 is above the contract's per-sale escrow cap 1000000000000: this sale can never open/);
    expect(planSale(loadSpec("1"), opts(), state()).notes.join("\n")).not.toMatch(/escrow cap/);
  });
});

describe("a sale identical to an Open one is refused unless --again (double map vector 23)", () => {
  // what sale #1 asks for, as the contract stores it after a create whose answer was lost
  const stored = (over: Record<string, unknown> = {}) => {
    const spec = loadSpec("1");
    const created = planSale(spec, opts(), state()).createMsg as Record<string, unknown>;
    return saleView({
      id: "1", seller: spec.seller, token: "nep141:wrap.near", supply: spec.amount, decimals: spec.msg.decimals, lot_exp: spec.msg.lot_exp, reserve: String(created.reserve),
      min_escrow: spec.msg.min_escrow, min_bidders: spec.msg.min_bidders, max_bids: spec.msg.max_bids, quote_token: spec.msg.quote_token, close_ns: String(created.close_ns),
      reveal_secs: spec.msg.reveal_secs, ...over,
    });
  };
  const plan = (existing: ReturnType<typeof stored>[], o: Partial<SaleOpts> = {}) =>
    planSale(loadSpec("1"), opts(o), state({ nextId: "1", existing }));
  it("an Open sale with the same seller, token, supply, close and terms blocks the create and names its id", () => {
    const p = plan([stored()]);
    expect(p.problems.join()).toMatch(/sale 1 on v1\.tenderseal\.near is already Open with the same seller, token, supply, close and terms; pass --again to create another/);
  });
  it("--again goes ahead and says so", () => {
    const p = plan([stored()], { again: true });
    expect(p.problems).toEqual([]);
    expect(p.notes.join("\n")).toMatch(/--again: sale 1 is already Open with the same terms/);
  });
  it("a Keyed, Finalized or Cancelled twin does not block (a cancelled sale may be created again)", () => {
    for (const state of ["Cancelled", "Finalized", "Keyed"] as const) expect(plan([stored({ state })]).problems).toEqual([]);
  });
  it("any different term (close, supply, seller, reserve) is a different sale", () => {
    for (const over of [{ close_ns: "1794542400000000001" }, { supply: "1" }, { seller: "other.near" }, { reserve: "1" }]) expect(plan([stored(over)]).problems).toEqual([]);
  });
  it("a relative close (rehearsal) is compared without its close time, which moves with every run", () => {
    const spec = loadSpec("R");
    const twin = saleView({
      id: "0", seller: spec.seller, token: "nep141:wrap.near", supply: spec.amount, decimals: spec.msg.decimals, lot_exp: spec.msg.lot_exp, reserve: spec.msg.reserve,
      min_escrow: spec.msg.min_escrow, min_bidders: spec.msg.min_bidders, max_bids: spec.msg.max_bids, quote_token: spec.msg.quote_token, close_ns: "1", reveal_secs: spec.msg.reveal_secs,
    });
    expect(planSale(spec, opts({ contract: "rehearsal.tenderseal.near" }), state({ nextId: "0", existing: [twin] })).problems.join()).toMatch(/already Open with the same/);
  });
  it("the seller compared is the one that signs (--seller), not the spec's (testnet sales 3 and 4 on rc3 were such a pair)", () => {
    const o = { network: "testnet" as const, contract: "v1.tsr-aaaaaa.testnet", seller: "tsr-aaaaaa.testnet", intents: "intents-aaaaaa.testnet", wrap: "wrap.testnet", quoteToken: "nep141:usdc-aaaaaa.testnet" };
    const spec = loadSpec("1");
    const created = planSale(spec, opts(o), state()).createMsg as Record<string, unknown>;
    const twin = saleView({
      id: "1", seller: o.seller, token: "nep141:wrap.testnet", supply: spec.amount, decimals: spec.msg.decimals, lot_exp: spec.msg.lot_exp, reserve: String(created.reserve),
      min_escrow: spec.msg.min_escrow, min_bidders: spec.msg.min_bidders, max_bids: spec.msg.max_bids, quote_token: o.quoteToken, close_ns: String(created.close_ns), reveal_secs: spec.msg.reveal_secs,
    });
    expect(planSale(spec, opts(o), state({ nextId: "2", existing: [twin] })).problems.join()).toMatch(/sale 1 on v1\.tsr-aaaaaa\.testnet is already Open with the same/);
  });
  it("no reading of the existing sales (unit callers) changes nothing", () => expect(planSale(loadSpec("1"), opts(), state()).problems).toEqual([]));
});
