import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOKEN, forwardQuoteBody, hashesOf, pollStatus, returnQuoteBody } from "../scripts/lib/oneclick.js";
import { main, type S5Env } from "../scripts/s5-return.js";

const EVM = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const NOW = Date.parse("2026-11-10T12:00:00Z");
const DEADLINE = new Date(NOW + 30 * 60_000).toISOString();

describe("1Click quote bodies", () => {
  it("forward: Base USDC to the Intents account, field by field", () => {
    expect(forwardQuoteBody({ evm: EVM, amount: 3_000_000n, dry: false, nowMs: NOW })).toEqual({
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      depositType: "ORIGIN_CHAIN",
      destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      amount: "3000000",
      refundTo: EVM,
      refundType: "ORIGIN_CHAIN",
      recipient: EVM.toLowerCase(), // A11: the Intents account id is the lowercase address
      recipientType: "INTENTS",
      deadline: DEADLINE,
    });
  });
  it("return: Intents USDC to Base USDC, refund inside Intents", () => {
    expect(returnQuoteBody({ evm: EVM, amount: 1_000_000n, dry: false, nowMs: NOW })).toEqual({
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: TOKEN.usdcNear,
      depositType: "INTENTS",
      destinationAsset: TOKEN.usdcBase,
      amount: "1000000",
      refundTo: EVM.toLowerCase(),
      refundType: "INTENTS",
      recipient: EVM,
      recipientType: "DESTINATION_CHAIN",
      deadline: DEADLINE,
    });
  });
  it("rejects an address that is not 0x + 40 hex", () => {
    expect(() => forwardQuoteBody({ evm: "0x123", amount: 1n, dry: true })).toThrow(/--evm/);
    expect(() => returnQuoteBody({ evm: "tenderseal.near", amount: 1n, dry: true })).toThrow(/--evm/);
  });
  it("hashesOf reads strings and {hash} objects", () => {
    expect(hashesOf(["a", { hash: "b", explorerUrl: "x" }, {}, 3, ""])).toEqual(["a", "b"]);
  });
});

const quoteJson = (dry: boolean, amountIn: string) => ({
  quote: {
    ...(dry ? {} : { depositAddress: "DEPOSIT-ADDR", deadline: DEADLINE }),
    amountIn, amountInFormatted: "3.0", amountOut: "2999394", amountOutFormatted: "2.999394", minAmountOut: "2969400", timeEstimate: 35,
  },
});

function fakeS5(o: { statuses?: any[]; balances?: bigint[]; signer?: string | null; submitFails?: boolean } = {}) {
  const requests: { method: string; url: string; body?: any }[] = [];
  const statuses = [...(o.statuses ?? [])];
  const balances = [...(o.balances ?? [0n])];
  const recorded: any[] = [];
  const files = new Map<string, unknown>();
  const f = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method: init?.method ?? "GET", url, body });
    const respond = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
    if (url.endsWith("/v0/quote")) return respond(quoteJson(body.dry, body.amount));
    if (url.includes("/v0/status")) return respond(statuses.length > 1 ? statuses.shift() : statuses[0]);
    if (url.endsWith("/v0/deposit/submit")) return o.submitFails ? respond({ message: "unknown tx" }, 400) : respond({});
    return respond({}, 404);
  }) as typeof fetch;
  const env: S5Env = {
    fetch: f,
    balance: async () => (balances.length > 1 ? (balances.shift() as bigint) : (balances[0] as bigint)),
    currentSalt: async () => "252812b3",
    nowMs: async () => NOW,
    sleep: async () => {},
    signerOf: async () => (o.signer === undefined ? "1click-relayer.near" : o.signer),
    record: async (row) => void recorded.push(row),
    writeJson: (file, data) => void files.set(file, data),
    readJson: (file) => (files.has(file) ? files.get(file) : null),
  };
  return { env, requests, recorded, files };
}

async function run(args: string[], fx: ReturnType<typeof fakeS5>, dirs = { evidenceDir: mkdtempSync(join(tmpdir(), "s5e-")), stateDir: mkdtempSync(join(tmpdir(), "s5s-")) }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { env: () => fx.env, io: { out: (l) => out.push(l), err: (l) => err.push(l) }, ...dirs });
  return { code, out: out.join("\n"), err: err.join("\n"), ...dirs };
}

describe("s5-return quote", () => {
  it("--dry-quote sends a dry:true request and prints no deposit address", async () => {
    const fx = fakeS5();
    const r = await run(["--leg", "forward", "--evm", EVM, "--amount", "3", "--dry-quote"], fx);
    expect(r.code).toBe(0);
    expect(fx.requests).toHaveLength(1);
    expect(fx.requests[0]?.body.dry).toBe(true);
    expect(r.out).not.toContain("depositAddress");
    expect(readdirSync(r.stateDir)).toEqual([]);
  });

  it("forward without --dry-quote asks dry:false, prints the deposit address and saves the balance before", async () => {
    const fx = fakeS5({ balances: [123_000n] });
    const r = await run(["--leg", "forward", "--evm", EVM, "--amount", "3"], fx);
    expect(r.code).toBe(0);
    expect(fx.requests[0]?.body).toMatchObject({ dry: false, depositType: "ORIGIN_CHAIN", amount: "3000000", recipient: EVM.toLowerCase() });
    expect(r.out).toContain("depositAddress: DEPOSIT-ADDR");
    expect(r.out).toContain("EXACTLY 3 USDC");
    const saved = JSON.parse(readFileSync(join(r.stateDir, "s5-forward-DEPOSIT-ADDR.json"), "utf8"));
    expect(saved).toMatchObject({ leg: "forward", evm: EVM.toLowerCase(), before: "123000" });
  });

  it("return prints the Transfer to sign: receiver is the deposit address, no msg", async () => {
    const fx = fakeS5({ balances: [3_000_000n] });
    const r = await run(["--leg", "return", "--evm", EVM, "--amount", "1"], fx);
    expect(r.code).toBe(0);
    const line = r.out.split("\n").find((l) => l.startsWith("Transfer to sign"))!;
    const t = JSON.parse(line.slice(line.indexOf("{")));
    expect(t).toEqual({ intent: "transfer", receiver_id: "DEPOSIT-ADDR", tokens: { [TOKEN.usdcNear]: "1000000" } });
    expect(r.out).toContain(`signed by ${EVM.toLowerCase()}`);
  });

  it("is refused on testnet and without a leg", async () => {
    expect((await run(["--leg", "forward", "--evm", EVM, "--amount", "3", "--network", "testnet"], fakeS5())).code).toBe(2);
    expect((await run(["--evm", EVM, "--amount", "3"], fakeS5())).code).toBe(2);
  });
});

describe("s5-return --watch", () => {
  const forwardDone = {
    status: "SUCCESS",
    swapDetails: { nearTxHashes: ["NEARTX1", "NEARTX2"], originChainTxHashes: [{ hash: "0xbase", explorerUrl: "x" }], destinationChainTxHashes: [], amountOut: "2999394" },
  };

  it("forward: polls through the intermediate states, saves the status JSON and records spike/deposit", async () => {
    const fx = fakeS5({ statuses: [{ status: "PENDING_DEPOSIT" }, { status: "PROCESSING" }, forwardDone], balances: [2_999_394n] });
    const dirs = { evidenceDir: mkdtempSync(join(tmpdir(), "s5e-")), stateDir: mkdtempSync(join(tmpdir(), "s5s-")) };
    // the quote step saved the balance before
    await run(["--leg", "forward", "--evm", EVM, "--amount", "3"], fakeS5({ balances: [0n] }), dirs);
    const saved = JSON.parse(readFileSync(join(dirs.stateDir, "s5-forward-DEPOSIT-ADDR.json"), "utf8"));
    fx.env.readJson = (file) => (file.endsWith("s5-forward-DEPOSIT-ADDR.json") ? saved : null);

    const r = await run(["--watch", "DEPOSIT-ADDR", "--leg", "forward", "--origin-tx", "0xbase"], fx, dirs);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/status: PENDING_DEPOSIT\nstatus: PROCESSING\nstatus: SUCCESS/);
    expect(fx.requests.some((q) => q.url.endsWith("/v0/deposit/submit") && q.body.txHash === "0xbase" && q.body.depositAddress === "DEPOSIT-ADDR")).toBe(true);
    expect(fx.files.get(join(dirs.evidenceDir, "spikes", "s5-forward.json"))).toEqual(forwardDone);
    expect(fx.recorded).toEqual([
      { step: "deposit", txHash: "NEARTX1", signer: "1click-relayer.near", oneclick: "DEPOSIT-ADDR", originTx: "0xbase", destTx: "NEARTX1", note: "S5 forward" },
    ]);
    expect(r.out).toContain("delta 2.999394");
  });

  it("return: the NEAR tx is the origin, the Base tx the destination, --signer skips the lookup", async () => {
    const done = { status: "SUCCESS", swapDetails: { nearTxHashes: ["RELAYTX"], originChainTxHashes: [], destinationChainTxHashes: [{ hash: "0xbasescan" }] } };
    const fx = fakeS5({ statuses: [done], signer: null });
    const r = await run(["--watch", "ADDR2", "--leg", "return", "--near-tx", "RELAYTX", "--signer", "relayer.tenderseal.near"], fx);
    expect(r.code).toBe(0);
    expect(fx.recorded).toEqual([
      { step: "withdraw", txHash: "RELAYTX", signer: "relayer.tenderseal.near", oneclick: "ADDR2", originTx: "RELAYTX", destTx: "0xbasescan", note: "S5 return" },
    ]);
  });

  it("an unknown signer prints the exact record.ts command instead of guessing", async () => {
    const fx = fakeS5({ statuses: [forwardDone], signer: null });
    const r = await run(["--watch", "ADDR3", "--leg", "forward"], fx);
    expect(r.code).toBe(0);
    expect(fx.recorded).toEqual([]);
    expect(r.err).toMatch(/record\.ts --sale spike --step deposit --tx NEARTX1 --signer <signer> --chain base --oneclick ADDR3/);
  });

  it("REFUNDED ends with exit 1, writes no evidence file and records nothing", async () => {
    const fx = fakeS5({ statuses: [{ status: "PROCESSING" }, { status: "REFUNDED", swapDetails: { refundReason: "PARTIAL_DEPOSIT" } }] });
    const r = await run(["--watch", "ADDR4", "--leg", "forward"], fx);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/REFUNDED/);
    expect(fx.files.size).toBe(0);
    expect(fx.recorded).toEqual([]);
    expect(existsSync(join(r.evidenceDir, "spikes"))).toBe(false);
  });

  it("a failing deposit/submit only warns", async () => {
    const fx = fakeS5({ statuses: [forwardDone], submitFails: true });
    const r = await run(["--watch", "ADDR5", "--leg", "forward", "--origin-tx", "0xbad"], fx);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/WARN deposit\/submit failed/);
  });
});

describe("pollStatus", () => {
  it("keeps waiting on a 404 and stops at a terminal state", async () => {
    let n = 0;
    const f = (async () => (++n < 3 ? new Response("{}", { status: 404 }) : new Response(JSON.stringify({ status: "SUCCESS" })))) as typeof fetch;
    const body = await pollStatus("X", { fetch: f, sleep: async () => {} });
    expect(body.status).toBe("SUCCESS");
    expect(n).toBe(3);
  });
  it("times out", async () => {
    let t = 0;
    const f = (async () => new Response(JSON.stringify({ status: "PENDING_DEPOSIT" }))) as typeof fetch;
    await expect(pollStatus("X", { fetch: f, sleep: async () => void (t += 60_000), now: () => t, timeoutMs: 120_000 })).rejects.toThrow(/timed out/);
  });
});
