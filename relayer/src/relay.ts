import { KeyPair, actions, teraToGas } from "near-api-js";
import { RPCS, ViewPanic, accessKeyAllowance, makeAccount, viewFunction, type Network } from "./near.js";
import { SlidingWindowLimiter } from "./rate-limit.js";

// Permissionless relay (R3): simulate_intents, then execute_intents, never altering the signed payload.
// Runtime imports: near-api-js and Node built-ins only (D4-03). Relative imports end in .js (D4-18).

export interface RelayConfig {
  intentsId: string;
  allowedOrigins: string[];
  maxSigned: 4;
  maxBodyBytes: 16384;
  minAllowanceYocto: bigint;
}

export interface RelayDeps {
  simulate(signed: unknown[]): Promise<{ ok: true } | { ok: false; error: string }>; // view simulate_intents({signed})
  execute(signed: unknown[]): Promise<{ txHash: string; ok: boolean; error?: string }>; // execute_intents, 300 Tgas, 0 deposit
  health(): Promise<{ relayer: string; allowance: string | null; node: string; network: string; intents: string }>; // allowance in yocto
  now(): number;
  limiter: SlidingWindowLimiter;
  log?: (line: string) => void;
}

export type Check = { ok: true } | { ok: false; status: 400 | 413; code: string; detail: string };

const STANDARDS = ["erc191", "raw_ed25519", "nep413"];
const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const bad = (code: string, detail: string): Check => ({ ok: false, status: 400, code, detail });

/** R3 + D4-04 + I2: shape, standard, recipient / verifying contract, future deadline, transfer-only intents. */
export function validateBody(raw: string, cfg: RelayConfig, nowMs: number): Check & { signed?: unknown[]; signers?: string[] } {
  if (Buffer.byteLength(raw) > cfg.maxBodyBytes) return { ok: false, status: 413, code: "body_too_large", detail: `body is larger than ${cfg.maxBodyBytes} bytes` };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return bad("invalid_json", "body is not valid JSON");
  }
  const signed = isObj(body) ? body.signed : undefined;
  if (!Array.isArray(signed)) return bad("signed_required", 'body must be {"signed": [...]}');
  if (signed.length < 1 || signed.length > cfg.maxSigned) return bad("bad_signed_count", `signed must hold 1 to ${cfg.maxSigned} items, got ${signed.length}`);
  const signers: string[] = [];
  for (const [i, item] of signed.entries()) {
    const at = `signed[${i}]`;
    if (!isObj(item)) return bad("bad_item", `${at} is not an object`);
    const standard = item.standard;
    if (typeof standard !== "string" || !STANDARDS.includes(standard)) return bad("unsupported_standard", `${at}.standard must be one of ${STANDARDS.join(", ")}`);
    let inner: unknown;
    try {
      if (standard === "nep413") {
        const p = item.payload;
        if (!isObj(p) || typeof p.message !== "string") return bad("bad_payload", `${at}.payload.message must be a string`);
        if (p.recipient !== cfg.intentsId) return bad("wrong_recipient", `${at}.payload.recipient must be ${cfg.intentsId}`);
        inner = JSON.parse(p.message);
      } else {
        if (typeof item.payload !== "string") return bad("bad_payload", `${at}.payload must be a JSON string`);
        inner = JSON.parse(item.payload);
      }
    } catch {
      return bad("bad_payload", `${at} payload is not valid JSON`);
    }
    if (!isObj(inner)) return bad("bad_payload", `${at} inner payload is not an object`);
    if (standard !== "nep413" && inner.verifying_contract !== cfg.intentsId) return bad("wrong_verifying_contract", `${at} verifying_contract must be ${cfg.intentsId}`);
    if (typeof inner.deadline !== "string" || !RFC3339.test(inner.deadline) || Number.isNaN(Date.parse(inner.deadline))) return bad("bad_deadline", `${at} deadline must be an RFC 3339 timestamp`);
    if (Date.parse(inner.deadline) <= nowMs) return bad("deadline_expired", `${at} deadline ${inner.deadline} has passed`);
    if (!Array.isArray(inner.intents) || inner.intents.length === 0) return bad("no_intents", `${at} intents must be a non-empty array`);
    if (inner.intents.some((x) => !isObj(x) || x.intent !== "transfer")) return bad("only_transfer_allowed", `${at} may contain only transfer intents`);
    if (typeof inner.signer_id === "string") signers.push(inner.signer_id);
  }
  return { ok: true, signed, signers };
}

export function createRelayHandler(cfg: RelayConfig, deps: RelayDeps): (req: Request) => Promise<Response> {
  const log = deps.log ?? ((line: string) => console.log(line));
  return async (req) => {
    const origin = req.headers.get("origin");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (origin && cfg.allowedOrigins.includes(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers["vary"] = "Origin";
    }
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
    const fail = (status: number, error: string, detail: string, extra: object = {}) => json(status, { error, detail, ...extra });

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...headers, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" },
      });
    }
    if (req.method === "GET") {
      try {
        const h = await deps.health();
        return json(200, { ...h, allowance_near: h.allowance === null ? null : yoctoToNear(BigInt(h.allowance)) });
      } catch (e) {
        return fail(502, "upstream_error", oneLine(e));
      }
    }
    if (req.method !== "POST") return fail(405, "method_not_allowed", "use GET, POST or OPTIONS");

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
    if (!deps.limiter.hit(ip, deps.now())) return fail(429, "rate_limited", "too many requests, try again in a minute");

    if (Number(req.headers.get("content-length") ?? 0) > cfg.maxBodyBytes) return fail(413, "body_too_large", `body is larger than ${cfg.maxBodyBytes} bytes`);
    const text = await req.text();
    const v = validateBody(text, cfg, deps.now());
    if (!v.ok) return fail(v.status, v.code, v.detail);

    try {
      const health = await deps.health();
      if (health.allowance !== null && BigInt(health.allowance) < cfg.minAllowanceYocto) {
        return fail(503, "relayer_allowance_low", "the relayer's gas allowance is low; run your own relayer with `pnpm relay:local`");
      }

      const signed = v.signed as unknown[];
      const sim = await deps.simulate(signed);
      if (!sim.ok) return fail(400, "simulate_failed", sim.error);

      const out = await deps.execute(signed);
      log(`relay signers=${(v.signers ?? []).join(",")} tx=${out.txHash || "none"} ok=${out.ok}`); // never the payload or signature
      if (out.ok) return json(200, { txHash: out.txHash });
      return json(502, { error: "execute_failed", txHash: out.txHash, detail: out.error ?? "execute_intents failed" });
    } catch (e) {
      return fail(502, "upstream_error", oneLine(e));
    }
  };
}

const oneLine = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0]?.slice(0, 200) ?? "";

function yoctoToNear(y: bigint): string {
  const s = y.toString().padStart(25, "0");
  const frac = s.slice(-24).replace(/0+$/, "");
  return frac ? `${s.slice(0, -24)}.${frac}` : s.slice(0, -24);
}

export function nearDepsFromEnv(env: NodeJS.ProcessEnv): { cfg: RelayConfig; deps: RelayDeps } {
  const network: Network = (env.NEAR_NETWORK ?? env.TENDER_NETWORK ?? "mainnet") === "testnet" ? "testnet" : "mainnet";
  const intentsId = env.INTENTS_CONTRACT_ID || (network === "mainnet" ? "intents.near" : "");
  if (!intentsId) throw new Error("INTENTS_CONTRACT_ID is required on testnet");
  const relayerId = env.RELAYER_ACCOUNT_ID || "relayer.tenderseal.near";
  const urls = network === "testnet"
    ? [env.NEAR_TESTNET_RPC_URL, ...RPCS.testnet].filter((u): u is string => !!u)
    : [env.NEAR_RPC_URL, ...(env.NEAR_RPC_FALLBACKS ?? "").split(","), ...RPCS.mainnet].map((u) => u?.trim()).filter((u): u is string => !!u);
  const key = env.RELAYER_PRIVATE_KEY?.startsWith("ed25519:") ? (env.RELAYER_PRIVATE_KEY as `ed25519:${string}`) : undefined;
  const publicKey = env.RELAYER_PUBLIC_KEY || (key ? KeyPair.fromString(key).getPublicKey().toString() : undefined);
  const cfg: RelayConfig = {
    intentsId,
    allowedOrigins: (env.RELAY_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    maxSigned: 4,
    maxBodyBytes: 16384,
    minAllowanceYocto: 50_000_000_000_000_000_000_000n, // 0.05 NEAR (D4-13)
  };

  // Transactions of one instance go through one queue (nonce); InvalidNonce is retried once.
  let queue: Promise<unknown> = Promise.resolve();
  const account = key ? makeAccount(relayerId, key, network, urls) : undefined;
  const send = async (signed: unknown[]) => {
    if (!account) return { txHash: "", ok: false, error: "relayer key is not configured" };
    for (let attempt = 0; ; attempt++) {
      try {
        const res: any = await account.signAndSendTransaction({
          receiverId: intentsId,
          actions: [actions.functionCall("execute_intents", { signed }, teraToGas(300), 0n)],
          waitUntil: "EXECUTED_OPTIMISTIC",
          throwOnFailure: false,
        });
        const ok = "SuccessValue" in (res.status ?? {});
        return { txHash: res.transaction.hash as string, ok, error: ok ? undefined : failureText(res.status) };
      } catch (e) {
        if (attempt === 0 && /InvalidNonce/.test(String((e as Error).message))) continue;
        return { txHash: "", ok: false, error: String((e as Error).message).slice(0, 300) };
      }
    }
  };

  const deps: RelayDeps = {
    async simulate(signed) {
      try {
        await viewFunction(urls, intentsId, "simulate_intents", { signed });
        return { ok: true };
      } catch (e) {
        if (e instanceof ViewPanic) return { ok: false, error: e.panicMsg };
        throw e;
      }
    },
    execute(signed) {
      const run = queue.then(() => send(signed));
      queue = run.catch(() => undefined);
      return run;
    },
    async health() {
      let allowance: string | null = null;
      if (publicKey) {
        try {
          const a = await accessKeyAllowance(urls, relayerId, publicKey);
          allowance = a === null ? null : a.toString();
        } catch {
          allowance = "0"; // key unknown on chain: report empty so POST answers 503 instead of failing at execute
        }
      }
      return { relayer: relayerId, allowance, node: process.version, network, intents: intentsId };
    },
    now: () => Date.now(),
    limiter: new SlidingWindowLimiter(20, 60_000),
  };
  return { cfg, deps };
}

function failureText(status: unknown): string {
  const s = JSON.stringify(status);
  const panic = /panic_msg":"((?:[^"\\]|\\.)*)"/.exec(s)?.[1] ?? /panic_msg: \\?"((?:[^"\\]|\\.)*)/.exec(s)?.[1];
  return (panic ?? s).slice(0, 300);
}
