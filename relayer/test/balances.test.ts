import { describe, expect, it } from "vitest";
import {
  addAddress, evaluate, normalizeEvm, planTopup, resolveHolder, solToIntentsAccount, type Accounts, type Target,
} from "../scripts/balances.js";

const accounts: Accounts = {
  updated_utc: null,
  near: { team: "tenderseal.near", bidder: "bidder.tenderseal.near" },
  evm: { "EVM-1": { address: "0xAbCdEf0123456789abcdef0123456789ABCDEF01", chain: "base" } },
  sol: { "SOL-1": { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", intents_account: null }, "SOL-2": { address: null, intents_account: null } },
};

describe("addresses", () => {
  it("Solana base58 -> 64 lowercase hex (known vectors)", () => {
    expect(solToIntentsAccount("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe("c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61");
    expect(solToIntentsAccount("11111111111111111111111111111111")).toBe("0".repeat(64));
    expect(() => solToIntentsAccount("1111")).toThrow(/not a Solana address/);
  });
  it("EVM addresses are lower-cased and validated", () => {
    expect(normalizeEvm("0xAbCdEf0123456789abcdef0123456789ABCDEF01")).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
    expect(() => normalizeEvm("0x1234")).toThrow();
  });
  it("holders resolve to the account Intents sees", () => {
    expect(resolveHolder(accounts, "team").intents).toBe("tenderseal.near");
    expect(resolveHolder(accounts, "EVM-1").intents).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
    expect(resolveHolder(accounts, "SOL-1").intents).toBe("c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61");
    expect(resolveHolder(accounts, "SOL-2")).toEqual({});
    expect(() => resolveHolder(accounts, "nobody")).toThrow(/unknown holder/);
  });
  it("--add fills team-accounts without touching the input", () => {
    const out = addAddress({ ...accounts, evm: { "EVM-2": { address: null, chain: "arb" } } }, "EVM-2", "0xAbCdEf0123456789abcdef0123456789ABCDEF01", "2026-11-10T00:00:00Z");
    expect(out.evm["EVM-2"]?.address).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
    expect(out.updated_utc).toBe("2026-11-10T00:00:00Z");
    const sol = addAddress(accounts, "SOL-2", "11111111111111111111111111111111");
    expect(sol.sol["SOL-2"]?.intents_account).toBe("0".repeat(64));
    expect(accounts.sol["SOL-2"]?.address).toBeNull();
    expect(() => addAddress(accounts, "EVM-9", "0x00")).toThrow(/unknown wallet/);
  });
});

const t = (id: string, ...any: Target["any"]): Target => ({ id, label: id, any });
const usdcIntents = (holder: string, min: string) => ({ holder, venue: "intents" as const, asset: "USDC" as const, min });

describe("evaluate", () => {
  it("PASS at the boundary, LOW one unit below, LOW when the balance is unknown", () => {
    const target = t("x", usdcIntents("bidder", "2"));
    expect(evaluate(target, new Map([["bidder|intents|USDC", 2_000_000n]])).status).toBe("PASS");
    const low = evaluate(target, new Map([["bidder|intents|USDC", 1_999_999n]]));
    expect(low.status).toBe("LOW");
    expect(low.detail).toContain("have 1.999999 USDC, need 2 USDC");
    expect(evaluate(target, new Map([["bidder|intents|USDC", null]])).status).toBe("LOW");
  });
  it("any alternative is enough", () => {
    const target = t("y", usdcIntents("EVM-1", "1"), { holder: "EVM-1", venue: "base", asset: "USDC", min: "0.96" });
    expect(evaluate(target, new Map([["EVM-1|intents|USDC", 0n], ["EVM-1|base|USDC", 960_000n]])).status).toBe("PASS");
  });
  it("NEAR and 24-decimal amounts compare as bigint", () => {
    const target = t("n", { holder: "team", venue: "near", asset: "NEAR", min: "0.1" });
    expect(evaluate(target, new Map([["team|near|NEAR", 100000000000000000000000n]])).status).toBe("PASS");
    expect(evaluate(target, new Map([["team|near|NEAR", 99999999999999999999999n]])).status).toBe("LOW");
  });
});

describe("planTopup (H-TOPUP)", () => {
  const sale2 = [t("a", usdcIntents("bidder", "2")), t("b", usdcIntents("SOL-1", "2"))];
  const sale3 = [t("c", usdcIntents("bidder", "1"))];
  it("sums needs per recipient, adds 0.1 USDC, prints ft_transfer_call with the recipient as msg, sends nothing", () => {
    const bal = new Map<string, bigint | null>([["bidder|intents|USDC", 500_000n], ["SOL-1|intents|USDC", 2_000_000n]]);
    const lines = planTopup([sale2, sale3], bal, accounts, "mainnet");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ holder: "bidder", deficit: 2_500_000n, amount: 2_600_000n, recipient: "bidder.tenderseal.near" });
    expect(lines[0]?.command).toContain(`ft_transfer_call json-args '{"receiver_id":"intents.near","amount":"2600000","msg":"bidder.tenderseal.near"}'`);
    expect(lines[0]?.command).toContain("attached-deposit '1 yoctoNEAR'");
    expect(lines[0]?.command).toContain("sign-as tenderseal.near");
  });
  it("is empty when nothing is LOW", () => {
    const bal = new Map<string, bigint | null>([["bidder|intents|USDC", 3_000_000n], ["SOL-1|intents|USDC", 2_000_000n]]);
    expect(planTopup([sale2, sale3], bal, accounts, "mainnet")).toEqual([]);
  });
  it("an unset wallet address produces a comment, not a command", () => {
    const l = planTopup([[t("d", usdcIntents("SOL-2", "1"))]], new Map(), accounts, "mainnet");
    expect(l[0]?.command).toMatch(/^# SOL-2: address not set/);
  });
});
