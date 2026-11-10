import { describe, expect, it } from "vitest";
import { TOKEN, swapQuoteBody } from "../scripts/lib/oneclick.js";
import { dryQuoteLine, main, planFunding, type FundingState, type SwapEnv } from "../scripts/swap-intents.js";
import { addBal, bal, fakeBase, firstIntent, sent, setBal, type FakeBase } from "./helpers/transfer-env.js";

const SIGNER = "tenderseal.near";
const WNEAR_AMOUNT = "1200000000000000000000000";
const NOW = Date.parse("2026-11-10T12:00:00Z");
const ONE_NEAR = 10n ** 24n;

const TOKENS = [
  { assetId: TOKEN.wnear, symbol: "wNEAR", decimals: 24 },
  { assetId: TOKEN.jambo, symbol: "JAMBO", decimals: 18 },
  { assetId: TOKEN.usdcNear, symbol: "USDC", decimals: 6 },
];

describe("swap quote body (H-JAMBO)", () => {
  it("INTENTS to INTENTS inside the signer's account, 1 % slippage", () => {
    expect(swapQuoteBody({ from: TOKEN.wnear, to: TOKEN.jambo, amount: 1_200_000_000_000_000_000_000_000n, account: SIGNER, dry: false, nowMs: NOW })).toEqual({
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: "nep141:wrap.near",
      depositType: "INTENTS",
      destinationAsset: "nep141:jambo-1679.meme-cooking.near",
      amount: WNEAR_AMOUNT,
      refundTo: SIGNER,
      refundType: "INTENTS",
      recipient: SIGNER,
      recipientType: "INTENTS",
      deadline: new Date(NOW + 30 * 60_000).toISOString(),
    });
  });
});

describe("planFunding", () => {
  const o = { signer: SIGNER, intents: "intents.near", from: TOKEN.wnear, wrap: "wrap.near", need: 1_200_000_000_000_000_000_000_000n, network: "mainnet" as const };
  const empty: FundingState = { intentsBalance: 0n, wrapFt: 0n, wrapRegistered: true, nativeBalance: 5n * ONE_NEAR };

  it("no steps when Intents already holds enough", () => {
    expect(planFunding(o, { ...empty, intentsBalance: o.need }).steps).toEqual([]);
  });
  it("near_deposit then ft_transfer_call with msg \"\" for the missing amount", () => {
    const p = planFunding(o, empty);
    expect(p.steps.map((s) => s.method)).toEqual(["near_deposit", "ft_transfer_call"]);
    expect(p.steps[0]).toMatchObject({ deposit: "1.2 NEAR", gasTgas: 30 });
    expect(p.steps[1]).toMatchObject({ receiver: "wrap.near", args: { receiver_id: "intents.near", amount: WNEAR_AMOUNT, msg: "" }, deposit: "1 yoctoNEAR", gasTgas: 100 });
    expect(p.problems).toEqual([]);
  });
  it("wraps only what the account does not already hold as wNEAR, and registers storage first when needed", () => {
    const p = planFunding(o, { ...empty, wrapFt: 200_000_000_000_000_000_000_000n, wrapRegistered: false, intentsBalance: 0n });
    expect(p.steps.map((s) => s.method)).toEqual(["storage_deposit", "near_deposit", "ft_transfer_call"]);
    expect(p.steps[1]?.deposit).toBe("1 NEAR");
  });
  it("blocks when the account cannot cover the wrap plus gas, or does not exist", () => {
    expect(planFunding(o, { ...empty, nativeBalance: 1_400_000_000_000_000_000_000_000n }).problems.join()).toMatch(/needs more/);
    expect(planFunding(o, { ...empty, nativeBalance: null }).problems.join()).toMatch(/G-ACCT/);
  });
  it("only wNEAR can be made on the spot", () => {
    const p = planFunding({ ...o, from: TOKEN.usdcNear }, empty);
    expect(p.steps).toEqual([]);
    expect(p.problems.join()).toMatch(/deposit it first/);
  });
});

describe("dryQuoteLine", () => {
  it("prints symbols, whole units and the minimum", () => {
    const q = { quote: { amountIn: WNEAR_AMOUNT, amountOut: "22477457870595625429026", minAmountOut: "22252683291889669174735", timeEstimate: 12 } };
    expect(dryQuoteLine(q, TOKENS[0]!, TOKENS[1]!, 1_200_000_000_000_000_000_000_000n)).toBe("dry quote: 1.2 wNEAR → ~22477 JAMBO (min ~22252), ~12 s");
  });
});

function world(o: { wnearIntents?: bigint; usdcIntents?: bigint; native?: bigint | null; amountIn?: string; statuses?: any[]; withKey?: boolean; registered?: boolean; simulateFailsAt?: number } = {}) {
  const b: FakeBase = fakeBase({ withKey: o.withKey, registered: o.registered });
  setBal(b, SIGNER, TOKEN.wnear, o.wnearIntents ?? 0n);
  setBal(b, SIGNER, TOKEN.usdcNear, o.usdcIntents ?? 0n);
  const requests: { url: string; body?: any }[] = [];
  const statuses = [...(o.statuses ?? [{ status: "PROCESSING" }, { status: "SUCCESS", swapDetails: { nearTxHashes: ["N1"] } }])];
  const f = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, body });
    const respond = (x: unknown) => new Response(JSON.stringify(x));
    if (url.endsWith("/v0/quote")) {
      return respond({ quote: { ...(body.dry ? {} : { depositAddress: "swap-deposit-address", deadline: "2026-11-10T12:30:00.000Z" }), amountIn: o.amountIn ?? body.amount, amountOut: "22477457870595625429026", minAmountOut: "22252683291889669174735", timeEstimate: 12 } });
    }
    if (url.includes("/v0/status")) return respond(statuses.length > 1 ? statuses.shift() : statuses[0]);
    return respond({});
  }) as typeof fetch;
  b.hooks.call = (step) => {
    if (step.method === "ft_transfer_call") addBal(b, SIGNER, TOKEN.wnear, BigInt((step.args as any).amount));
    return sent(`CALL-${step.method}`);
  };
  b.hooks.execute = (_s, mp) => {
    const it = firstIntent(mp);
    if (it.receiver_id === "swap-deposit-address") {
      addBal(b, SIGNER, TOKEN.wnear, -BigInt(it.tokens[TOKEN.wnear]));
      addBal(b, SIGNER, TOKEN.jambo, 22_477_457_870_595_625_429_026n);
    } else addBal(b, SIGNER, TOKEN.usdcNear, -BigInt(it.tokens[TOKEN.usdcNear]));
    return sent("EXEC-1");
  };
  if (o.simulateFailsAt !== undefined) {
    let n = 0;
    b.hooks.simulate = () => (n++ >= (o.simulateFailsAt as number) ? { ok: false, kind: "insufficient_balance", message: "insufficient balance or overflow" } : { ok: true });
  }
  const env: SwapEnv = {
    ...b.env,
    fetch: f,
    tokens: async () => TOKENS,
    nativeBalance: async () => (o.native === undefined ? 5n * ONE_NEAR : o.native),
    ftState: async () => ({ registered: true, ft: 0n }),
  };
  return { b, env, requests };
}

async function run(args: string[], w: ReturnType<typeof world>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { env: () => w.env, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const SWAP = ["--from", TOKEN.wnear, "--to", TOKEN.jambo, "--amount", "1.2"];

describe("swap-intents swap", () => {
  it("dry-run: dry quote line, funding lines, DRY-RUN block, only a dry:true quote, nothing sent", async () => {
    const w = world();
    const r = await run(SWAP, w);
    expect(r.code).toBe(0);
    expect(r.out).toContain("dry quote: 1.2 wNEAR → ~22477 JAMBO (min ~22252), ~12 s");
    expect(r.out).toContain("DRY-RUN · nothing sent · re-run with --yes to send");
    expect(r.out).toMatch(/\[1\/3\] signer=tenderseal\.near receiver=wrap\.near method=near_deposit deposit=1\.2 NEAR gas=30 Tgas/);
    expect(r.out).toMatch(/\[3\/3\] .*method=execute_intents/);
    expect(w.requests.map((q) => q.body?.dry)).toEqual([true]);
    expect(w.b.log).toEqual([]);
  });

  it("--yes: funds, quotes for real, signs a Transfer to the deposit address (yocto amount, no msg), simulates, executes, records", async () => {
    const w = world();
    const r = await run([...SWAP, "--yes"], w);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(w.b.log).toEqual(["call near_deposit", "call ft_transfer_call", "executeIntents"]);
    expect(w.requests.filter((q) => q.url.endsWith("/v0/quote")).map((q) => q.body.dry)).toEqual([true, false]);
    expect(w.b.sentIntents).toHaveLength(1);
    const it = firstIntent(w.b.sentIntents[0]!);
    expect(it).toEqual({ intent: "transfer", receiver_id: "swap-deposit-address", tokens: { [TOKEN.wnear]: WNEAR_AMOUNT } });
    expect(it.msg).toBeUndefined();
    expect(w.b.simulated).toHaveLength(1);
    expect(w.b.recorded.at(-1)).toMatchObject({ sale: "ops", step: "swap", txHash: "EXEC-1", signer: SIGNER, oneclick: "swap-deposit-address" });
    expect(r.out).toMatch(/SUCCESS · tenderseal\.near JAMBO in Intents: ~22477/);
  });

  it("an Intents balance that already covers the swap needs no funding steps", async () => {
    const w = world({ wnearIntents: 2n * ONE_NEAR });
    const r = await run([...SWAP, "--yes"], w);
    expect(r.code).toBe(0);
    expect(w.b.log).toEqual(["executeIntents"]);
  });

  it("refuses to sign when the quote asks for a different amount", async () => {
    const w = world({ wnearIntents: 2n * ONE_NEAR, amountIn: "1300000000000000000000000" });
    const r = await run([...SWAP, "--yes"], w);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/refusing to sign/);
    expect(w.b.sentIntents).toEqual([]);
  });

  it("a failing simulate_intents sends nothing: before the quote (placeholder) or after it", async () => {
    const early = world({ wnearIntents: 2n * ONE_NEAR, simulateFailsAt: 0 });
    const r0 = await run([...SWAP, "--yes"], early);
    expect(r0.code).toBe(2);
    expect(r0.out).toMatch(/BLOCKED: simulate_intents failed/);
    expect(early.requests.map((q) => q.body?.dry)).toEqual([true]);
    const late = world({ wnearIntents: 2n * ONE_NEAR, simulateFailsAt: 1 });
    const r1 = await run([...SWAP, "--yes"], late);
    expect(r1.code).toBe(1);
    expect(r1.err).toMatch(/simulate_intents failed \(insufficient_balance\)/);
    expect(late.b.sentIntents).toEqual([]);
  });

  it("a REFUNDED swap fails after the send and is recorded without the 1Click link", async () => {
    const w = world({ wnearIntents: 2n * ONE_NEAR, statuses: [{ status: "REFUNDED" }] });
    const r = await run([...SWAP, "--yes"], w);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/REFUNDED/);
    expect(w.b.recorded.at(-1)).toMatchObject({ step: "swap", oneclick: undefined });
  });

  it("an unregistered key blocks a real send with the H-INTENTS-KEYS hint", async () => {
    const w = world({ registered: false, wnearIntents: 2n * ONE_NEAR });
    const r = await run([...SWAP, "--yes"], w);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/BLOCKED: run H-INTENTS-KEYS for tenderseal\.near/);
    expect(w.b.log).toEqual([]);
  });

  it("no key is only a note in a dry-run", async () => {
    const w = world({ withKey: false, wnearIntents: 2n * ONE_NEAR });
    expect((await run(SWAP, w)).code).toBe(0);
    expect((await run([...SWAP, "--yes"], world({ withKey: false, wnearIntents: 2n * ONE_NEAR }))).code).toBe(2);
  });

  it("the swap is mainnet only", async () => {
    expect((await run([...SWAP, "--network", "testnet"], world())).code).toBe(2);
  });
});

describe("swap-intents --transfer-to (H-TOPUP)", () => {
  const TOPUP = ["--transfer-to", "bidder.tenderseal.near", "--token", TOKEN.usdcNear, "--amount", "5.2"];

  it("dry-run simulates one nep413 transfer intent with receiver_id exactly the account", async () => {
    const w = world({ usdcIntents: 6_000_000n });
    const r = await run(TOPUP, w);
    expect(r.code).toBe(0);
    expect(r.out).toContain("simulate_intents: ok");
    expect(w.b.simulated).toHaveLength(1);
    expect(firstIntent(w.b.simulated[0]!)).toEqual({ intent: "transfer", receiver_id: "bidder.tenderseal.near", tokens: { [TOKEN.usdcNear]: "5200000" } });
    expect(w.b.sentIntents).toEqual([]);
  });

  it("--yes sends it with execute_intents and records ops/fund", async () => {
    const w = world({ usdcIntents: 6_000_000n });
    const r = await run([...TOPUP, "--yes"], w);
    expect(r.code).toBe(0);
    expect(w.b.sentIntents).toHaveLength(1);
    expect(firstIntent(w.b.sentIntents[0]!).intent).toBe("transfer");
    expect(firstIntent(w.b.sentIntents[0]!).receiver_id).toBe("bidder.tenderseal.near");
    expect(w.b.recorded).toEqual([expect.objectContaining({ sale: "ops", step: "fund", txHash: "EXEC-1" })]);
    expect(bal(w.b, SIGNER, TOKEN.usdcNear)).toBe(800_000n);
  });

  it("a Solana implicit account (64 hex) is accepted; a bad account and a missing balance are not", async () => {
    const hex = "c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e087c84a8ed4d85d2d29";
    const ok = world({ usdcIntents: 6_000_000n });
    expect((await run(["--transfer-to", hex, "--token", TOKEN.usdcNear, "--amount", "1"], ok)).code).toBe(0);
    expect(firstIntent(ok.b.simulated[0]!).receiver_id).toBe(hex);
    expect((await run(["--transfer-to", "Not An Account", "--token", TOKEN.usdcNear, "--amount", "1"], world({ usdcIntents: 6_000_000n }))).code).toBe(1);
    const poor = await run(TOPUP, world({ usdcIntents: 1_000_000n }));
    expect(poor.code).toBe(1);
    expect(poor.out).toMatch(/BLOCKED: .*needs 5200000/);
  });
});
