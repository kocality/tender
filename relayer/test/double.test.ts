import { readFileSync } from "node:fs";
import { KeyPair } from "near-api-js";
import { InvalidNonceError } from "near-api-js/rpc-errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NonceAwareFailoverProvider, RPCS, makeAccount, makeProvider, recordSigned } from "../src/near.js";
import { sendStep } from "../scripts/lib/send.js";
import { createRelayHandler, nearDepsFromEnv, sendExecute, validateBody, type RelayConfig, type RelayDeps } from "../src/relay.js";
import { SlidingWindowLimiter } from "../src/rate-limit.js";

// DOUBLE-PLAN layer 3: the relayer answers 202 execute_unknown for a send that may have landed, and refuses a bid the
// chain already shows stored (the contract and intents.near still decide; this saves gas).

const NOW = Date.parse("2026-11-10T08:00:00Z");
const cfg: RelayConfig = { intentsId: "intents.near", tenderId: "v1.tenderseal.near", allowedOrigins: [], maxSigned: 4, maxBodyBytes: 16384, minAllowanceYocto: 310_000_000_000_000_000_000_000n };
const CM = "ab".repeat(32);
const OTHER = "cd".repeat(32);

const bidMsg = (over: Record<string, unknown> = {}) => JSON.stringify({ op: "bid", sale: "2", ct: "x", cm: CM, origin: "near", ...over });
const signedBid = (msgOver: Record<string, unknown> = {}, signer = "0xabc", deadline = "2026-11-10T08:10:00.000Z") => ({
  standard: "raw_ed25519",
  payload: JSON.stringify({
    signer_id: signer, verifying_contract: "intents.near", deadline, nonce: "AAAA",
    intents: [{ intent: "transfer", receiver_id: "v1.tenderseal.near", tokens: { x: "1" }, msg: bidMsg(msgOver), min_gas: "30000000000000" }],
  }),
  public_key: "ed25519:x", signature: "ed25519:y",
});
const body = (...signed: unknown[]) => JSON.stringify({ signed });
const post = (b: string) => new Request("http://localhost/relay", { method: "POST", body: b });

let exec: RelayDeps["execute"];
let bidsOf: (sale: string, signer: string) => Promise<{ cm: string }[]>;
let deps: RelayDeps;
const make = () => createRelayHandler(cfg, deps);

beforeEach(() => {
  exec = vi.fn(async () => ({ txHash: "HASH1", ok: true }));
  bidsOf = vi.fn(async () => []);
  deps = {
    simulate: vi.fn(async () => ({ ok: true }) as const), execute: (s) => exec(s), now: () => NOW, limiter: new SlidingWindowLimiter(20, 60_000), log: () => {},
    health: async () => ({ relayer: "relayer.tenderseal.near", allowance: null, node: "v24", network: "mainnet", intents: "intents.near" }),
    relayerId: "relayer.tenderseal.near",
    bidsOf: (sale, signer) => bidsOf(sale, signer),
  };
});

describe("202 execute_unknown: a send that may have landed is never 'retry' (vector 1, 2)", () => {
  it("a send signed and handed to an RPC whose answer was lost: 202 with every hash, the sender and the payload deadline, no retry flag", async () => {
    exec = vi.fn(async () => ({ txHash: "", ok: false, error: "timeout", sent: ["HA", "HB"] }));
    const r = await make()(post(body(signedBid())));
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ status: "execute_unknown", txHashes: ["HA", "HB"], sender: "relayer.tenderseal.near", until: "2026-11-10T08:10:00.000Z", detail: "timeout" });
  });
  it("until is the latest payload deadline of the body", async () => {
    exec = vi.fn(async () => ({ txHash: "", ok: false, error: "x", sent: ["HA"] }));
    const r = await make()(post(body(signedBid({}, "0xabc", "2026-11-10T08:05:00.000Z"), signedBid({ sale: "3" }, "0xabc", "2026-11-10T08:12:00.000Z"))));
    expect((await r.json()).until).toBe("2026-11-10T08:12:00.000Z");
  });
  it("nothing was signed (no key, no provider answered before signing): still 503 retry", async () => {
    exec = vi.fn(async () => ({ txHash: "", ok: false, error: "relayer key is not configured", sent: [] }));
    const r = await make()(post(body(signedBid())));
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: "execute_unavailable", retry: true });
    exec = vi.fn(async () => ({ txHash: "", ok: false, error: "no key" }));
    expect((await make()(post(body(signedBid({ sale: "9" }))))).status).toBe(503);
  });
  it("a 202 is not remembered as failed: the same body is tried again (the Intents nonce lets it run once)", async () => {
    exec = vi.fn(async () => ({ txHash: "", ok: false, error: "x", sent: ["HA"] }));
    const h = make();
    const b = body(signedBid());
    expect((await h(post(b))).status).toBe(202);
    expect((await h(post(b))).status).toBe(202);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  describe("sendExecute records the hash of every transaction it signs", () => {
    const counters = { send: 0 };
    let chainNonce: bigint;
    let viewCalls: number;
    let afterNonce: () => never | { status: object; transaction: { hash: string }; transaction_outcome: object; receipts_outcome: unknown[] };
    const fake = (name: string) => ({
      name,
      async viewAccessKey() { viewCalls++; return { nonce: viewCalls === 1 ? 90n : chainNonce, permission: "FullAccess" }; },
      async viewBlock() { return { header: { hash: "11111111111111111111111111111111" } }; },
      async sendTransactionUntil(stx: any) {
        counters.send++;
        if (stx.transaction.nonce <= chainNonce) throw new InvalidNonceError(chainNonce as never, stx.transaction.nonce as never, "", "");
        return afterNonce();
      },
    });
    beforeEach(() => {
      counters.send = 0;
      viewCalls = 0;
      chainNonce = 100n;
      vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());
    const account = () => makeAccount("relayer.tenderseal.near", KeyPair.fromRandom("ed25519").toString() as `ed25519:${string}`, "mainnet", undefined, new NonceAwareFailoverProvider([fake("one"), fake("two")] as never));

    it("InvalidNonce, then a timeout: both signed transactions are listed, as 32-byte base58 hashes", async () => {
      afterNonce = () => { throw new Error("socket timeout"); };
      const out = await sendExecute(account(), "intents.near", [{}]);
      expect(out.ok).toBe(false);
      expect(out.txHash).toBe("");
      expect(out.sent).toHaveLength(2);
      expect(new Set(out.sent).size).toBe(2);
      for (const h of out.sent ?? []) expect(h).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    });
    it("a send that succeeds lists the hashes it signed and its own hash is the last one", async () => {
      afterNonce = () => ({ status: { SuccessValue: "" }, transaction: { hash: "TXOK" }, transaction_outcome: {}, receipts_outcome: [] });
      const out = await sendExecute(account(), "intents.near", [{}]);
      expect(out).toMatchObject({ txHash: "TXOK", ok: true });
      expect(out.sent).toHaveLength(2);
    });
  });
});

describe("scripts that send a transaction themselves can still name it when the answer is lost (vector 6)", () => {
  it("sendStep with a recording signer: a send that throws after signing leaves its hash behind", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = new NonceAwareFailoverProvider([{
      async viewAccessKey() { return { nonce: 5n, permission: "FullAccess" }; },
      async viewBlock() { return { header: { hash: "11111111111111111111111111111111" } }; },
      async sendTransactionUntil() { throw new Error("socket timeout"); },
    }] as never);
    const account = makeAccount("bidder.tenderseal.near", KeyPair.fromRandom("ed25519").toString() as `ed25519:${string}`, "mainnet", undefined, provider);
    const rec = recordSigned(account);
    const step = { signer: "bidder.tenderseal.near", receiver: "intents.near", method: "execute_intents", args: { signed: [] }, deposit: "0 NEAR", gasTgas: 300, network: "mainnet" as const };
    await expect(sendStep(account, step, undefined, rec.signer)).rejects.toThrow();
    expect(rec.hashes).toHaveLength(1);
    expect(rec.hashes[0]).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    vi.restoreAllMocks();
  });
});

describe("a bid the chain already shows stored is refused before anything is sent (vector 5, 6)", () => {
  it("the same cm already stored for this signer: 409 already_stored with its place; simulate ran, execute never", async () => {
    bidsOf = vi.fn(async () => [{ cm: OTHER }, { cm: CM }]);
    const r = await make()(post(body(signedBid())));
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "already_stored", sale: "2", n: 2 });
    expect(bidsOf).toHaveBeenCalledWith("2", "0xabc");
    expect(exec).not.toHaveBeenCalled();
  });
  it("seq 0 while the signer already has a bid with another cm: 409 bid_seq, nothing sent", async () => {
    bidsOf = vi.fn(async () => [{ cm: OTHER }]);
    const r = await make()(post(body(signedBid({ seq: 0 }))));
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "bid_seq", sale: "2", have: 1, seq: 0 });
    expect(exec).not.toHaveBeenCalled();
  });
  it("seq equal to the signer's rows, or ahead of this view, or no seq at all: executes", async () => {
    bidsOf = vi.fn(async () => [{ cm: OTHER }]);
    for (const [i, over] of [{ seq: 1 }, { seq: 5 }, {}].entries()) {
      expect((await make()(post(body(signedBid({ ...over, sale: String(10 + i) }))))).status).toBe(200);
    }
    expect(exec).toHaveBeenCalledTimes(3);
  });
  it("a failed or missing read refuses nothing: the contract decides", async () => {
    bidsOf = vi.fn(async () => { throw new Error("HTTP 429"); });
    expect((await make()(post(body(signedBid())))).status).toBe(200);
    deps.bidsOf = undefined;
    expect((await make()(post(body(signedBid({ sale: "7" }))))).status).toBe(200);
  });
  it("only bids are read: a self-reveal never touches get_bids", async () => {
    const reveal = { ...signedBid(), payload: JSON.stringify({ ...JSON.parse(signedBid().payload), intents: [{ intent: "transfer", receiver_id: "v1.tenderseal.near", tokens: { x: "1" }, msg: '{"op":"reveal","sale":"2","items":[]}', min_gas: "30000000000000" }] }) };
    expect((await make()(post(body(reveal)))).status).toBe(200);
    expect(bidsOf).not.toHaveBeenCalled();
  });
  it("validateBody hands the bids (signer, sale, cm, seq) to the handler", () => {
    const v = validateBody(body(signedBid({ seq: 3 })), cfg, NOW) as { ok: boolean; bids?: unknown[] };
    expect(v.bids).toEqual([{ signer: "0xabc", sale: "2", cm: CM, seq: 3 }]);
  });
  it("a refusal does not mark the signer busy: the next bid of the same signer goes through", async () => {
    bidsOf = vi.fn(async () => [{ cm: CM }]);
    const h = make();
    expect((await h(post(body(signedBid())))).status).toBe(409);
    expect((await h(post(body(signedBid({ cm: OTHER }))))).status).toBe(200);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  describe("bidsOf in the live deps reads get_bids at final and keeps only this signer's rows", () => {
    const rows = [{ bidder: "0xabc", cm: CM }, { bidder: "0xdef", cm: OTHER }, { bidder: "0xabc", cm: "ee".repeat(32) }];
    afterEach(() => vi.unstubAllGlobals());
    it("one page of 64, from 0", async () => {
      const seen: any[] = [];
      vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
        const b = JSON.parse(init.body);
        seen.push(b.params);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: "tender", result: { result: [...Buffer.from(JSON.stringify(rows))], logs: [] } }));
      });
      const { deps: d } = nearDepsFromEnv({ NEAR_RPC_URL: "https://rpc.one" });
      expect(await d.bidsOf!("2", "0xabc")).toEqual([rows[0], rows[2]]);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ request_type: "call_function", finality: "final", account_id: "v1.tenderseal.near", method_name: "get_bids" });
      expect(JSON.parse(Buffer.from(seen[0].args_base64, "base64").toString())).toEqual({ id: "2", from: 0, limit: 64 });
      expect(d.relayerId).toBe("relayer.tenderseal.near");
    });
  });
});

describe("RPC lists (OPS-04)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const registrable = (u: string) => new URL(u).hostname.split(".").slice(-2).join(".");

  it("the testnet list is fastnear, dRPC, Intear: three different providers, none of them near.org", () => {
    expect(RPCS.testnet).toEqual(["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org", "https://testnet-rpc.intea.rs"]);
    for (const net of ["mainnet", "testnet"] as const) {
      expect(new Set(RPCS[net].map(registrable)).size).toBe(3);
      expect(RPCS[net].filter((u) => /\/\/rpc\.(mainnet|testnet)\.near\.org/.test(u))).toEqual([]);
    }
  });
  const stubAll429 = () => {
    const seen: Array<{ url: string; type: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      seen.push({ url, type: JSON.parse(init.body).params?.request_type });
      return new Response("slow down", { status: 429 });
    });
    return seen;
  };
  it("NEAR_RPC_URL repeated in NEAR_RPC_FALLBACKS or the defaults is asked once per request", async () => {
    const seen = stubAll429();
    const PK = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    const { deps: d } = nearDepsFromEnv({ RELAYER_PUBLIC_KEY: PK, NEAR_RPC_URL: "https://free.rpc.fastnear.com", NEAR_RPC_FALLBACKS: "https://near.drpc.org, https://free.rpc.fastnear.com" });
    await d.health();
    expect(seen.filter((x) => x.type === "view_account").map((x) => x.url)).toEqual(["https://free.rpc.fastnear.com", "https://near.drpc.org", "https://rpc.shitzuapes.xyz"]);
  });
  it("the testnet runtime list has no repeated provider either", async () => {
    const seen = stubAll429();
    const PK = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    const { deps: d } = nearDepsFromEnv({ RELAYER_PUBLIC_KEY: PK, NEAR_NETWORK: "testnet", INTENTS_CONTRACT_ID: "i.testnet", TENDER_CONTRACT_ID: "t.testnet" });
    await d.health();
    expect(seen.filter((x) => x.type === "view_account").map((x) => x.url)).toEqual(RPCS.testnet);
  });
  it("a 503 from the first provider fails over in seconds, not after twelve backed-off attempts", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      vi.stubGlobal("fetch", async () => {
        calls++;
        return new Response("unavailable", { status: 503 });
      });
      const provider = makeProvider("mainnet", ["https://one.example"]);
      const done = provider.viewBlock({ finality: "final" }).catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      await done;
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("keeper rules are written down where the operator reads them (vectors 18, 21)", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const keeperSrc = readFileSync(new URL("../src/keeper.ts", import.meta.url), "utf8");
  it("a payout that looks stuck (pending) is never resent by hand; the contract skips it and verify lists it", () => {
    expect(readme).toMatch(/never resend a payout because an item looks stuck/i);
    expect(readme).toMatch(/`pending`/);
    expect(keeperSrc).toMatch(/never resends a pending payout/i);
  });
  it("during live sales a human starts the keeper with gh workflow run, not from a laptop", () => {
    expect(readme).toMatch(/gh workflow run keeper/);
    expect(readme).toMatch(/not (from )?(a )?(local|laptop)/i);
  });
  it("the relay answers are listed: 202 execute_unknown (look the hashes up, do not resend), 409 already_stored and bid_seq", () => {
    expect(readme).toMatch(/202 execute_unknown/);
    expect(readme).toMatch(/409 already_stored/);
    expect(readme).toMatch(/bid_seq/);
  });
});
