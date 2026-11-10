import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRelayHandler, nearDepsFromEnv, validateBody, type RelayConfig, type RelayDeps } from "../src/relay.js";
import { SlidingWindowLimiter } from "../src/rate-limit.js";

const NOW = Date.parse("2026-11-10T08:00:00Z");
const cfg: RelayConfig = { intentsId: "intents.near", allowedOrigins: ["http://localhost:5173"], maxSigned: 4, maxBodyBytes: 16384, minAllowanceYocto: 310_000_000_000_000_000_000_000n };

const inner = (over: Record<string, unknown> = {}) => ({
  signer_id: "0xabc", verifying_contract: "intents.near", deadline: "2026-11-10T08:10:00.000Z", nonce: "AAAA",
  intents: [{ intent: "transfer", receiver_id: "v1.tenderseal.near", tokens: { x: "1" }, msg: "{}" }], ...over,
});
const raw = (over: Record<string, unknown> = {}) => ({ standard: "raw_ed25519", payload: JSON.stringify(inner(over)), public_key: "ed25519:x", signature: "ed25519:y" });
const nep = (over: Record<string, unknown> = {}, recipient = "intents.near") => ({
  standard: "nep413", payload: { message: JSON.stringify(inner({ verifying_contract: undefined, ...over })), nonce: "n", recipient }, public_key: "ed25519:x", signature: "ed25519:y",
});
const body = (...signed: unknown[]) => JSON.stringify({ signed });

let sim: RelayDeps["simulate"];
let exec: RelayDeps["execute"];
let allowance: string | null;
let deps: RelayDeps;
const post = (b: string, headers: Record<string, string> = {}) => new Request("http://localhost/relay", { method: "POST", body: b, headers });
const make = () => createRelayHandler(cfg, deps);

beforeEach(() => {
  sim = vi.fn(async () => ({ ok: true }) as const);
  exec = vi.fn(async () => ({ txHash: "HASH1", ok: true }));
  allowance = "400000000000000000000000";
  deps = {
    simulate: (s) => sim(s), execute: (s) => exec(s), now: () => NOW, limiter: new SlidingWindowLimiter(20, 60_000), log: () => {},
    health: async () => ({ relayer: "relayer.tenderseal.near", allowance, node: "v24", network: "mainnet", intents: "intents.near" }),
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
  it("200 {txHash} and the payload reaches execute unchanged", async () => {
    const item = raw();
    const r = await make()(post(body(item)));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ txHash: "HASH1" });
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
    for (let i = 0; i < 20; i++) expect((await h(post(body(raw()), { "x-forwarded-for": "1.2.3.4, 9.9.9.9" }))).status).toBe(200);
    expect((await h(post(body(raw()), { "x-forwarded-for": "1.2.3.4" }))).status).toBe(429);
    expect((await h(post(body(raw()), { "x-forwarded-for": "5.6.7.8" }))).status).toBe(200);
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
