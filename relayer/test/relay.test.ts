import { FailoverRpcError, FailoverRpcProvider, KeyPair } from "near-api-js";
import { InvalidNonceError } from "near-api-js/rpc-errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NonceAwareFailoverProvider, makeAccount } from "../src/near.js";
import { createRelayHandler, nearDepsFromEnv, sendExecute, validateBody, type RelayConfig, type RelayDeps, type RelayHealth } from "../src/relay.js";
import { SlidingWindowLimiter } from "../src/rate-limit.js";

const NOW = Date.parse("2026-11-10T08:00:00Z");
const cfg: RelayConfig = { intentsId: "intents.near", tenderId: "v1.tenderseal.near", allowedOrigins: ["http://localhost:5173"], maxSigned: 4, maxBodyBytes: 16384, minAllowanceYocto: 310_000_000_000_000_000_000_000n };

const inner = (over: Record<string, unknown> = {}) => ({
  signer_id: "0xabc", verifying_contract: "intents.near", deadline: "2026-11-10T08:10:00.000Z", nonce: "AAAA",
  intents: [{ intent: "transfer", receiver_id: "v1.tenderseal.near", tokens: { x: "1" }, msg: '{"op":"bid"}', min_gas: "30000000000000" }], ...over,
});
const raw = (over: Record<string, unknown> = {}) => ({ standard: "raw_ed25519", payload: JSON.stringify(inner(over)), public_key: "ed25519:x", signature: "ed25519:y" });
const transferTo = (over: Record<string, unknown>) => raw({ intents: [{ intent: "transfer", receiver_id: "v1.tenderseal.near", tokens: { x: "1" }, ...over }] });
const nep = (over: Record<string, unknown> = {}, recipient = "intents.near") => ({
  standard: "nep413", payload: { message: JSON.stringify(inner({ verifying_contract: undefined, ...over })), nonce: "n", recipient }, public_key: "ed25519:x", signature: "ed25519:y",
});
const body = (...signed: unknown[]) => JSON.stringify({ signed });

let sim: RelayDeps["simulate"];
let exec: RelayDeps["execute"];
let allowance: string | null;
let healthOver: Partial<RelayHealth>;
let deps: RelayDeps;
const post = (b: string, headers: Record<string, string> = {}) => new Request("http://localhost/relay", { method: "POST", body: b, headers });
const make = () => createRelayHandler(cfg, deps);

beforeEach(() => {
  sim = vi.fn(async () => ({ ok: true }) as const);
  exec = vi.fn(async () => ({ txHash: "HASH1", ok: true }));
  allowance = "400000000000000000000000";
  healthOver = {};
  deps = {
    simulate: (s) => sim(s), execute: (s) => exec(s), now: () => NOW, limiter: new SlidingWindowLimiter(20, 60_000), log: () => {},
    health: async () => ({ relayer: "relayer.tenderseal.near", allowance, node: "v24", network: "mainnet", intents: "intents.near", ...healthOver }),
  };
});

describe("validateBody", () => {
  it("accepts one item of each standard", () => {
    expect(validateBody(body(raw(), nep()), cfg, NOW)).toMatchObject({ ok: true, signers: ["0xabc", "0xabc"] });
    expect(validateBody(body({ ...raw(), standard: "erc191" }), cfg, NOW).ok).toBe(true);
  });
  const codes: Array<[string, string, number]> = [
    ["not json", "{", 400],
    ["no signed", "{}", 400],
    ["empty signed", body(), 400],
    ["5 items", body(raw(), raw(), raw(), raw(), raw()), 400],
    ["webauthn", body({ standard: "webauthn" }), 400],
    ["non-transfer intent", body(raw({ intents: [{ intent: "ft_withdraw", token: "x", receiver_id: "a", amount: "1" }] })), 400],
    ["transfer + other", body(raw({ intents: [{ intent: "transfer", receiver_id: "a", tokens: {} }, { intent: "token_diff" }] })), 400],
    ["nep413 recipient", body(nep({}, "other.near")), 400],
    ["wrong verifying_contract", body(raw({ verifying_contract: "evil.near" })), 400],
    ["past deadline", body(raw({ deadline: "2026-11-10T07:59:59.000Z" })), 400],
    ["deadline not RFC 3339", body(raw({ deadline: "tomorrow" })), 400],
    ["empty intents", body(raw({ intents: [] })), 400],
  ];
  for (const [name, b, status] of codes) {
    it(`rejects: ${name}`, () => {
      const r = validateBody(b, cfg, NOW);
      expect(r.ok).toBe(false);
      expect((r as { status: number }).status).toBe(status);
    });
  }
  it("names the codes the app shows", () => {
    expect((validateBody(body(raw({ intents: [{ intent: "ft_withdraw" }] })), cfg, NOW) as any).code).toBe("only_transfer_allowed");
    expect((validateBody(body({ standard: "webauthn" }), cfg, NOW) as any).code).toBe("unsupported_standard");
    expect((validateBody(body(nep({}, "x.near")), cfg, NOW) as any).code).toBe("wrong_recipient");
  });
  it("over 16 KB is 413", () => {
    expect(validateBody("x".repeat(17 * 1024), cfg, NOW)).toMatchObject({ ok: false, status: 413 });
  });
  it("a deadline more than 15 minutes ahead is 400 deadline_too_far; exactly 15 minutes passes (X12-01)", () => {
    expect(validateBody(body(raw({ deadline: "2026-11-10T08:15:00.001Z" })), cfg, NOW)).toMatchObject({ ok: false, status: 400, code: "deadline_too_far" });
    expect(validateBody(body(nep({ deadline: "2026-11-11T08:00:00.000Z" })), cfg, NOW)).toMatchObject({ ok: false, code: "deadline_too_far" });
    expect(validateBody(body(raw({ deadline: "2026-11-10T08:15:00.000Z" })), cfg, NOW).ok).toBe(true);
  });
});

describe("handler", () => {
  it("405 on PUT", async () => expect((await make()(new Request("http://localhost/relay", { method: "PUT" }))).status).toBe(405));
  it("413 on a 17 KB body", async () => expect((await make()(post("x".repeat(17 * 1024)))).status).toBe(413));
  it("413 from the content-length header alone", async () => {
    expect((await make()(post("{}", { "content-length": "99999" }))).status).toBe(413);
  });
  it("400 on bad JSON, empty signed, 5 items, webauthn", async () => {
    for (const b of ["{", body(), body(raw(), raw(), raw(), raw(), raw()), body({ standard: "webauthn" })]) {
      expect((await make()(post(b))).status).toBe(400);
    }
    expect(sim).not.toHaveBeenCalled();
  });
  it("400 only_transfer_allowed for an inner ft_withdraw; nothing is simulated or sent", async () => {
    const r = await make()(post(body(raw({ intents: [{ intent: "ft_withdraw" }] }))));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("only_transfer_allowed");
    expect(sim).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
  it("400 simulate_failed carries the intents error text and nothing is sent", async () => {
    sim = async () => ({ ok: false, error: "insufficient balance or overflow" });
    const r = await make()(post(body(raw())));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "simulate_failed", detail: "insufficient balance or overflow" });
    expect(exec).not.toHaveBeenCalled();
  });
  it("200 names the relayer account as sender, like the 202, so the app can read the Tender event of the tx", async () => {
    const r = await createRelayHandler(cfg, { ...deps, relayerId: "relayer.tenderseal.near" })(post(body(raw())));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ txHash: "HASH1", sender: "relayer.tenderseal.near" });
  });
  it("200 {txHash, sender} and the payload reaches execute unchanged", async () => {
    const item = raw();
    const r = await make()(post(body(item)));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ txHash: "HASH1", sender: null });
    expect(exec).toHaveBeenCalledWith([item]);
    expect(sim).toHaveBeenCalledWith([item]);
  });
  it("502 execute_failed with the hash", async () => {
    exec = async () => ({ txHash: "BAD", ok: false, error: "nonce was already used" });
    const r = await make()(post(body(raw())));
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "execute_failed", txHash: "BAD", detail: "nonce was already used" });
  });
  it("502 upstream_error when no RPC answers", async () => {
    sim = async () => { throw new Error("HTTP 503 from https://rpc"); };
    const r = await make()(post(body(raw())));
    expect(r.status).toBe(502);
    expect((await r.json()).error).toBe("upstream_error");
  });
  it("429 on the 21st request from one IP, other IPs unaffected", async () => {
    const h = make();
    for (let i = 0; i < 20; i++) expect((await h(post(body(raw({ signer_id: `0x${i}` })), { "x-forwarded-for": "1.2.3.4, 9.9.9.9" }))).status).toBe(200);
    expect((await h(post(body(raw({ signer_id: "0xa" })), { "x-forwarded-for": "1.2.3.4" }))).status).toBe(429);
    expect((await h(post(body(raw({ signer_id: "0xb" })), { "x-forwarded-for": "5.6.7.8" }))).status).toBe(200);
  });
  it("the window slides", () => {
    const l = new SlidingWindowLimiter(2, 1000);
    expect([l.hit("a", 0), l.hit("a", 10), l.hit("a", 20)]).toEqual([true, true, false]);
    expect(l.hit("a", 1011)).toBe(true);
  });
  it("OPTIONS: allowed origin gets ACAO and Vary; another origin gets none", async () => {
    const ok = await make()(new Request("http://localhost/relay", { method: "OPTIONS", headers: { origin: "http://localhost:5173" } }));
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(ok.headers.get("vary")).toBe("Origin");
    expect(ok.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(ok.headers.get("access-control-allow-headers")).toBe("content-type");
    const no = await make()(new Request("http://localhost/relay", { method: "OPTIONS", headers: { origin: "https://evil.example" } }));
    expect(no.status).toBe(204);
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("503 relayer_allowance_low at 0.30 NEAR (a 300 Tgas call needs 0.3009); 0.32 and a full-access key (null) are fine", async () => {
    allowance = "300000000000000000000000";
    const r = await make()(post(body(raw())));
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe("relayer_allowance_low");
    allowance = "320000000000000000000000";
    expect((await make()(post(body(raw())))).status).toBe(200);
    allowance = null;
    expect((await make()(post(body(raw())))).status).toBe(200);
  });
  it("the shipped default threshold is 0.31 NEAR (testnet: a 300 Tgas call with a 0.2 NEAR key is refused, cost 0.3009)", () => {
    expect(nearDepsFromEnv({ NEAR_NETWORK: "mainnet" }).cfg.minAllowanceYocto).toBe(310_000_000_000_000_000_000_000n);
  });
  it("GET returns health with the allowance in NEAR", async () => {
    const r = await make()(new Request("http://localhost/relay"));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ relayer: "relayer.tenderseal.near", allowance: "400000000000000000000000", allowance_near: "0.4", intents: "intents.near" });
  });
  it("logs signer ids and the hash, never the payload or signature", async () => {
    const lines: string[] = [];
    const h = createRelayHandler(cfg, { ...deps, log: (l) => lines.push(l) });
    await h(post(body(raw())));
    expect(lines).toEqual(["relay signers=0xabc tx=HASH1 ok=true"]);
  });
});

describe("gas griefing: the relayer only pays for what the app sends (REL-01)", () => {
  const manyIntents = (n: number) => Array.from({ length: n }, () => ({ intent: "transfer", receiver_id: "v1.tenderseal.near", tokens: { x: "1" }, msg: '{"op":"bid"}', min_gas: "30000000000000" }));
  it("25 transfers in one signed item are 400 one_intent_per_item; nothing is simulated or sent", async () => {
    const r = await make()(post(body(raw({ intents: manyIntents(25) }))));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("one_intent_per_item");
    expect(sim).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
  const rejected: Array<[string, Record<string, unknown>, string]> = [
    ["a notifying transfer to another contract", { receiver_id: "burner.near", msg: '{"op":"bid"}' }, "receiver_not_allowed"],
    ["msg that is not JSON", { msg: "hello" }, "msg_not_allowed"],
    ["msg op create", { msg: '{"op":"create"}' }, "msg_not_allowed"],
    ["min_gas above 30 Tgas", { msg: '{"op":"bid"}', min_gas: "300000000000000" }, "min_gas_too_high"],
    ["min_gas that is not a number", { msg: '{"op":"bid"}', min_gas: "lots" }, "min_gas_too_high"],
    ["a plain transfer to the Tender contract (no msg: nothing would ever move it out again)", { msg: undefined }, "msg_required"],
  ];
  for (const [name, over, code] of rejected) {
    it(`400 ${code}: ${name}`, async () => {
      const r = await make()(post(body(transferTo(over))));
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe(code);
      expect(exec).not.toHaveBeenCalled();
    });
  }
  it("a bid, a self-reveal and a 1Click withdrawal (no msg, any receiver) are still relayed", async () => {
    for (const over of [{ msg: '{"op":"bid","sale":"2"}' }, { msg: '{"op":"reveal","sale":"2"}', min_gas: "30000000000000" }, { receiver_id: "abc123depositaddress", msg: undefined, min_gas: undefined }]) {
      expect((await make()(post(body(transferTo({ ...over }))))).status).toBe(200);
    }
  });
  it("a body that failed on chain is answered 409 for 10 minutes and executed once", async () => {
    exec = vi.fn(async () => ({ txHash: "BAD", ok: false, error: "The length of a log message 16579 exceeds the limit 16384" }));
    let now = NOW;
    deps.now = () => now;
    const h = make();
    const b = body(raw({ deadline: "2026-11-10T08:15:00.000Z" }));
    expect((await h(post(b))).status).toBe(502);
    const again = await h(post(b));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("already_failed");
    expect(exec).toHaveBeenCalledTimes(1);
    now += 10 * 60_000 + 1;
    deps.limiter = new SlidingWindowLimiter(20, 60_000);
    expect((await h(post(b))).status).toBe(502);
    expect(exec).toHaveBeenCalledTimes(2);
  });
  it("a send that never produced a transaction (503 retry) is not remembered as failed", async () => {
    exec = vi.fn(async () => ({ txHash: "", ok: false, error: "Exceeded 2 providers to execute request" }));
    const h = make();
    const b = body(raw());
    const first = await h(post(b));
    expect(first.status).toBe(503);
    expect((await first.json()).error).toBe("execute_unavailable");
    expect((await h(post(b))).status).toBe(503);
    expect(exec).toHaveBeenCalledTimes(2);
  });
  it("the limit also counts per signer, whatever the IP", async () => {
    const h = make();
    for (let i = 0; i < 20; i++) expect((await h(post(body(raw({ nonce: `n${i}` })), { "x-forwarded-for": `10.0.0.${i}` }))).status).toBe(200);
    expect((await h(post(body(raw({ nonce: "n21" })), { "x-forwarded-for": "10.0.1.1" }))).status).toBe(429);
  });
  const forgedSim = (gate?: Promise<void>) =>
    vi.fn(async (s: unknown[]) => {
      if (!JSON.stringify(s).includes("forged")) return { ok: true } as const;
      await gate;
      return { ok: false, error: "invalid signature" } as const;
    });
  it("forged payloads naming a signer (simulate refuses them) do not use up that signer's bucket", async () => {
    sim = forgedSim();
    const h = make();
    for (let i = 0; i < 20; i++) expect((await h(post(body({ ...raw(), signature: `ed25519:forged${i}` }), { "x-forwarded-for": "6.6.6.6" }))).status).toBe(400);
    expect((await h(post(body(raw()), { "x-forwarded-for": "1.2.3.4" }))).status).toBe(200);
  });
  it("a forged payload still in simulate does not make the signer it names busy", async () => {
    let release!: () => void;
    sim = forgedSim(new Promise<void>((r) => (release = r)));
    const h = make();
    const forged = h(post(body({ ...raw(), signature: "ed25519:forged" }), { "x-forwarded-for": "6.6.6.6" }));
    await new Promise((r) => setTimeout(r, 5));
    expect((await h(post(body(raw()), { "x-forwarded-for": "1.2.3.4" }))).status).toBe(200);
    release();
    expect((await forged).status).toBe(400);
  });
});

describe("idempotency (REL-02)", () => {
  const slowExec = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    exec = vi.fn(async () => {
      await gate;
      return { txHash: "HASH1", ok: true };
    });
    return release;
  };
  it("two concurrent POSTs of the same signed body are executed once and both answer 200 with the same hash", async () => {
    const release = slowExec();
    const h = make();
    const b = body(raw());
    const a = h(post(b));
    const c = h(post(b));
    await new Promise((r) => setTimeout(r, 5));
    release();
    const [ra, rc] = await Promise.all([a, c]);
    expect([ra.status, rc.status]).toEqual([200, 200]);
    expect(await ra.json()).toEqual({ txHash: "HASH1", sender: null });
    expect(await rc.json()).toEqual({ txHash: "HASH1", sender: null });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(sim).toHaveBeenCalledTimes(1);
  });
  it("a second payload of a signer whose first one is still being relayed is 409 signer_busy", async () => {
    const release = slowExec();
    const h = make();
    const a = h(post(body(raw({ nonce: "one" }))));
    await new Promise((r) => setTimeout(r, 5));
    const other = await h(post(body({ ...raw({ nonce: "two" }), signature: "ed25519:other" })));
    expect(other.status).toBe(409);
    expect((await other.json()).error).toBe("signer_busy");
    release();
    expect((await a).status).toBe(200);
    expect(exec).toHaveBeenCalledTimes(1);
    // the signer is free again
    expect((await h(post(body({ ...raw({ nonce: "three" }), signature: "ed25519:third" })))).status).toBe(200);
  });
});

describe("who is the client (REL-03)", () => {
  it("with an ipOf that ignores x-forwarded-for, rotating that header does not escape the limit", async () => {
    const h = createRelayHandler(cfg, { ...deps, ipOf: () => "127.0.0.1" });
    for (let i = 0; i < 20; i++) expect((await h(post(body(raw({ signer_id: `0x${i}` })), { "x-forwarded-for": `9.9.9.${i}` }))).status).toBe(200);
    expect((await h(post(body(raw({ signer_id: "0xz" })), { "x-forwarded-for": "9.9.9.200" }))).status).toBe(429);
  });
  it("GET is rate limited per IP as well", async () => {
    const h = make();
    for (let i = 0; i < 20; i++) expect((await h(new Request("http://localhost/relay", { headers: { "x-forwarded-for": "1.1.1.1" } }))).status).toBe(200);
    expect((await h(new Request("http://localhost/relay", { headers: { "x-forwarded-for": "1.1.1.1" } }))).status).toBe(429);
  });
});

describe("relayer balance and key health (OPS-05, X12A-03, KEEP-05)", () => {
  it("allowance 0.5 NEAR but spendable balance 0.305 NEAR: 503 relayer_balance_low and nothing is sent", async () => {
    healthOver = { allowance: "500000000000000000000000", balance: "305000000000000000000000" };
    const r = await make()(post(body(raw())));
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe("relayer_balance_low");
    expect(exec).not.toHaveBeenCalled();
    healthOver = { allowance: "500000000000000000000000", balance: "320000000000000000000000" };
    expect((await make()(post(body(raw())))).status).toBe(200);
  });
  it("GET shows the balance in NEAR", async () => {
    healthOver = { balance: "305000000000000000000000" };
    expect(await (await make()(new Request("http://localhost/relay"))).json()).toMatchObject({ balance_near: "0.305" });
  });
  it("a full-access key on mainnet is 503 relayer_key_full_access and nothing is simulated or sent; testnet and the human opt-in are fine", async () => {
    healthOver = { allowance: null, key: "FullAccess" };
    const r = await make()(post(body(raw())));
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe("relayer_key_full_access");
    expect(sim).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect((await createRelayHandler({ ...cfg, allowFullAccess: true }, deps)(post(body(raw({ nonce: "b" }))))).status).toBe(200);
    healthOver = { allowance: null, key: "FullAccess", network: "testnet" };
    expect((await make()(post(body(raw({ nonce: "c", signer_id: "0xc" }))))).status).toBe(200);
  });
  it("a function-call key that is not limited to execute_intents on Intents is 503 relayer_key_scope", async () => {
    healthOver = { key: "WrongScope" };
    const r = await make()(post(body(raw())));
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe("relayer_key_scope");
  });
  it("unreadable health (an RPC problem) is not 'allowance 0': the request goes on to simulate and execute", async () => {
    healthOver = { allowance: null, balance: null, key: null, unknown: true };
    expect((await make()(post(body(raw())))).status).toBe(200);
    deps.health = async () => { throw new Error("HTTP 429"); };
    expect((await createRelayHandler(cfg, deps)(post(body(raw({ nonce: "z", signer_id: "0xz" }))))).status).toBe(200);
  });
  it("RELAYER_PUBLIC_KEY that does not belong to RELAYER_PRIVATE_KEY refuses to start", () => {
    const k1 = KeyPair.fromRandom("ed25519");
    const k2 = KeyPair.fromRandom("ed25519");
    expect(() => nearDepsFromEnv({ RELAYER_PRIVATE_KEY: k1.toString(), RELAYER_PUBLIC_KEY: k2.getPublicKey().toString() })).toThrow(/relayer_key_mismatch/);
    expect(() => nearDepsFromEnv({ RELAYER_PRIVATE_KEY: k1.toString(), RELAYER_PUBLIC_KEY: k1.getPublicKey().toString() })).not.toThrow();
    expect(() => nearDepsFromEnv({ RELAYER_PRIVATE_KEY: k1.toString() })).not.toThrow();
  });
  it("the Tender contract id defaults on mainnet, comes from TENDER_CONTRACT_ID, and is required on testnet", () => {
    expect(nearDepsFromEnv({}).cfg.tenderId).toBe("v1.tenderseal.near");
    expect(nearDepsFromEnv({ NEAR_NETWORK: "testnet", INTENTS_CONTRACT_ID: "i.testnet", TENDER_CONTRACT_ID: "t.testnet" }).cfg.tenderId).toBe("t.testnet");
    expect(() => nearDepsFromEnv({ NEAR_NETWORK: "testnet", INTENTS_CONTRACT_ID: "i.testnet" })).toThrow(/TENDER_CONTRACT_ID/);
  });
});

describe("an RPC failure is not 'allowance 0' (REL-04)", () => {
  const PK = KeyPair.fromRandom("ed25519").getPublicKey().toString();
  const withFetch = async (fake: (url: string, body: any) => Response, run: (calls: any[]) => Promise<void>) => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      const b = JSON.parse(init.body);
      calls.push(b);
      return fake(url, b);
    });
    try {
      await run(calls);
    } finally {
      vi.unstubAllGlobals();
    }
  };
  const live = () => nearDepsFromEnv({ RELAYER_PUBLIC_KEY: PK, NEAR_RPC_URL: "https://rpc.one" });
  const err429 = () => new Response("slow down", { status: 429 });
  it("with every RPC answering 429, GET reports the allowance as unknown and POST is not 503 relayer_allowance_low", async () => {
    await withFetch(err429, async () => {
      const { cfg: c, deps: d } = live();
      const h = createRelayHandler(c, { ...d, now: () => NOW, simulate: async () => ({ ok: true }), execute: async () => ({ txHash: "H", ok: true }), log: () => {} });
      const g = await (await h(new Request("http://localhost/relay"))).json();
      expect(g).toMatchObject({ unknown: true, allowance: null, allowance_near: null });
      const r = await h(post(body(raw())));
      expect(r.status).toBe(200);
    });
  });
  it("a POST while every RPC answers 429 is 502 upstream_error whose detail says to retry or run a relayer, never relayer_allowance_low (DUP-REL04)", async () => {
    await withFetch(err429, async () => {
      const { cfg: c, deps: d } = live();
      const h = createRelayHandler(c, { ...d, now: () => NOW, log: () => {} });
      const r = await h(post(body(raw())));
      const j = await r.json();
      expect(r.status).toBe(502);
      expect(j.error).toBe("upstream_error");
      expect(j.detail).toMatch(/try again in a minute or run your own relayer with `pnpm relay:local`/);
      expect(j.detail).not.toMatch(/allowance/);
    });
  });
  it("a key that is not on chain is still allowance 0", async () => {
    await withFetch(() => new Response(JSON.stringify({ jsonrpc: "2.0", id: "tender", result: { error: `access key ${PK} does not exist while viewing`, logs: [] } })), async () => {
      const { deps: d } = live();
      expect(await d.health()).toMatchObject({ allowance: "0" });
    });
  });
  it("100 GETs within 30 s read the access key once", async () => {
    await withFetch((_u, b) => {
      const result = b.params.request_type === "view_account" ? { amount: "500000000000000000000000", storage_usage: 320 } : { permission: { FunctionCall: { allowance: "499456000000000000000000", receiver_id: "intents.near", method_names: ["execute_intents"] } } };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "tender", result }));
    }, async (calls) => {
      const { cfg: c, deps: d } = live();
      const h = createRelayHandler(c, { ...d, now: () => NOW, limiter: new SlidingWindowLimiter(1000, 60_000) });
      for (let i = 0; i < 100; i++) expect((await h(new Request("http://localhost/relay"))).status).toBe(200);
      expect(calls.filter((x) => x.params.request_type === "view_access_key")).toHaveLength(1);
    });
  });
});

describe("nonce retry through the failover provider (OPS-02)", () => {
  const counters = { send: 0, viewAccessKey: 0 };
  let chainNonce: bigint;
  const fake = (name: string) => ({
    name,
    async viewAccessKey() { counters.viewAccessKey++; return { nonce: counters.viewAccessKey === 1 ? 90n : chainNonce, permission: "FullAccess" }; },
    async viewBlock() { return { header: { hash: "11111111111111111111111111111111" } }; },
    async sendTransactionUntil(stx: any) {
      counters.send++;
      if (stx.transaction.nonce <= chainNonce) throw new InvalidNonceError(chainNonce as never, stx.transaction.nonce as never, "", "");
      return { status: { SuccessValue: "" }, transaction: { hash: "TXOK" }, transaction_outcome: {}, receipts_outcome: [] };
    },
  });
  beforeEach(() => {
    counters.send = 0;
    counters.viewAccessKey = 0;
    chainNonce = 100n; // another instance with the same key already used up to 100
    vi.spyOn(console, "error").mockImplementation(() => {}); // FailoverRpcProvider logs every failure
  });
  const account = () => makeAccount("relayer.tenderseal.near", KeyPair.fromRandom("ed25519").toString() as `ed25519:${string}`, "mainnet", undefined, new NonceAwareFailoverProvider([fake("fastnear"), fake("second")] as never));
  it("an InvalidNonce from both providers drops the nonce cache and the send succeeds: execute resolves ok, the nonce is read twice", async () => {
    const out = await sendExecute(account(), "intents.near", [{}]);
    expect(out).toMatchObject({ txHash: "TXOK", ok: true, error: undefined });
    expect(out.sent).toHaveLength(2); // the InvalidNonce copy and the one that landed
    expect(counters.viewAccessKey).toBe(2);
  });
  it("the stock FailoverRpcProvider hides the InvalidNonce in a FailoverRpcError (the bug the subclass works around)", async () => {
    const a = makeAccount("relayer.tenderseal.near", KeyPair.fromRandom("ed25519").toString() as `ed25519:${string}`, "mainnet", undefined, new FailoverRpcProvider([fake("one"), fake("two")] as never));
    await expect(a.signAndSendTransaction({ receiverId: "intents.near", actions: [], waitUntil: "EXECUTED_OPTIMISTIC" })).rejects.toBeInstanceOf(FailoverRpcError);
    expect(counters.viewAccessKey).toBe(1); // the nonce cache was never dropped
  });
  it("any other failure comes back as a failed send with no hash", async () => {
    const a = account();
    (a.provider as any).providers.forEach((p: any) => { p.sendTransactionUntil = async () => { throw new Error("HTTP 429"); }; });
    const out = await sendExecute(a, "intents.near", [{}]);
    expect(out.ok).toBe(false);
    expect(out.txHash).toBe("");
    expect(out.error).toMatch(/providers/);
  });
});
