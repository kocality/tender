import { createHash } from "node:crypto";
import { KeyPair, actions, teraToGas, type Account } from "near-api-js";
import { RPCS, UnknownAccessKey, ViewPanic, accessKeyInfo, makeAccount, recordSigned, spendableBalance, viewFunction, type Network } from "./near.js";
import { SlidingWindowLimiter } from "./rate-limit.js";

// Permissionless relay (R3): simulate_intents, then execute_intents, never altering the signed payload.
// Runtime imports: near-api-js and Node built-ins only (D4-03). Relative imports end in .js (D4-18).

export interface RelayConfig {
  intentsId: string;
  tenderId: string; // a transfer that notifies a contract (carries msg) may only notify this one
  allowedOrigins: string[];
  maxSigned: 4;
  maxBodyBytes: 16384;
  minAllowanceYocto: bigint;
  allowFullAccess?: boolean; // humans running their own relayer on mainnet with a full-access key; never set on Vercel
}

export interface RelayHealth {
  relayer: string;
  allowance: string | null; // yocto; null = no cap, no key configured, or unknown
  balance?: string | null; // yocto the relayer account can burn on gas (balance minus storage stake); null = unknown
  key?: "FunctionCall" | "FullAccess" | "WrongScope" | null; // what the signing key is allowed to do; null = unknown
  unknown?: boolean; // the RPC could not be read: the guards are skipped, simulate decides
  node: string;
  network: string;
  intents: string;
}

export interface RelayDeps {
  simulate(signed: unknown[]): Promise<{ ok: true } | { ok: false; error: string }>; // view simulate_intents({signed})
  execute(signed: unknown[]): Promise<{ txHash: string; ok: boolean; error?: string; sent?: string[] }>; // execute_intents, 300 Tgas, 0 deposit; sent = hash of every transaction signed (each may have been broadcast)
  relayerId?: string; // the NEAR account that signs: the sender_account_id of a tx lookup
  bidsOf?(sale: string, signer: string): Promise<{ cm: string }[]>; // the signer's stored bids in a sale, at final
  health(): Promise<RelayHealth>;
  now(): number;
  limiter: SlidingWindowLimiter;
  ipOf?(req: Request): string; // default: the first x-forwarded-for entry (Vercel sets it); a server that owns the socket passes the peer address
  log?: (line: string) => void;
}

export type Check = { ok: true } | { ok: false; status: 400 | 413; code: string; detail: string };

const STANDARDS = ["erc191", "raw_ed25519", "nep413"];
const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const bad = (code: string, detail: string): Check => ({ ok: false, status: 400, code, detail });
const MAX_MIN_GAS = 30_000_000_000_000n; // 30 Tgas: what a bid or a self-reveal notification asks for
const FAILED_TTL_MS = 10 * 60_000; // a body that failed on chain is not executed again for this long
const HEALTH_TTL_MS = 30_000;
const MAX_DEADLINE_AHEAD_MS = 15 * 60_000; // the app and the CLI sign 10 minutes ahead; Intents itself sets no upper bound

type BidRef = { signer: string; sale: string; cm: string; seq?: number };

/**
 * Tender refuses these on chain anyway (dup_bid, bid_seq), but only after intents.near committed the nonce, moved the escrow and the
 * relayer paid for the call. simulate_intents never runs mt_on_transfer, so the relayer reads Tender itself. It acts only on facts that
 * can only grow (bids are never deleted); a failed read refuses nothing. The contract and intents.near are what decide.
 */
async function tenderRefusal(bids: BidRef[], deps: RelayDeps): Promise<{ code: string; detail: string; extra: object } | undefined> {
  if (!deps.bidsOf) return undefined;
  for (const b of bids) {
    let mine: { cm: string }[];
    try {
      mine = await deps.bidsOf(b.sale, b.signer);
    } catch {
      continue; // unknown is not "refuse"
    }
    const i = mine.findIndex((x) => x.cm === b.cm);
    if (i >= 0) return { code: "already_stored", detail: `this sealed bid is already stored in sale ${b.sale} as your bid #${i + 1}`, extra: { sale: b.sale, n: i + 1 } };
    if (b.seq !== undefined && mine.length > b.seq) return { code: "bid_seq", detail: `you already have ${mine.length} bid(s) in sale ${b.sale}; this bid was prepared when you had ${b.seq}`, extra: { sale: b.sale, have: mine.length, seq: b.seq } };
  }
  return undefined;
}

/** R3 + D4-04 + I2: shape, standard, recipient / verifying contract, future deadline, transfer-only intents. */
export function validateBody(raw: string, cfg: RelayConfig, nowMs: number): Check & { signed?: unknown[]; signers?: string[]; bids?: BidRef[] } {
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
  const bids: BidRef[] = [];
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
    if (Date.parse(inner.deadline) > nowMs + MAX_DEADLINE_AHEAD_MS) return bad("deadline_too_far", `${at} deadline ${inner.deadline} is more than 15 minutes ahead; sign a payload that expires within 10 minutes`);
    if (!Array.isArray(inner.intents) || inner.intents.length === 0) return bad("no_intents", `${at} intents must be a non-empty array`);
    if (inner.intents.some((x) => !isObj(x) || x.intent !== "transfer")) return bad("only_transfer_allowed", `${at} may contain only transfer intents`);
    // The relayer pays gas for whatever passes simulate: one transfer per signed item, and a notifying transfer only to the Tender contract.
    if (inner.intents.length !== 1) return bad("one_intent_per_item", `${at} must hold exactly one transfer intent`);
    const t = inner.intents[0] as Record<string, unknown>;
    if (t.msg !== undefined) {
      if (t.receiver_id !== cfg.tenderId) return bad("receiver_not_allowed", `${at} a transfer with msg may only go to ${cfg.tenderId}`);
      if (t.min_gas !== undefined && !(typeof t.min_gas === "string" && /^\d{1,15}$/.test(t.min_gas) && BigInt(t.min_gas) <= MAX_MIN_GAS)) return bad("min_gas_too_high", `${at} min_gas must be at most 30 Tgas`);
      let op: unknown;
      try {
        op = JSON.parse(typeof t.msg === "string" ? t.msg : "");
      } catch {
        return bad("msg_not_allowed", `${at} msg is not valid JSON`);
      }
      if (!isObj(op) || (op.op !== "bid" && op.op !== "reveal")) return bad("msg_not_allowed", `${at} msg.op must be bid or reveal`);
      if (op.op === "bid" && typeof op.sale === "string" && typeof op.cm === "string" && typeof inner.signer_id === "string") {
        bids.push({ signer: inner.signer_id, sale: op.sale, cm: op.cm, seq: typeof op.seq === "number" ? op.seq : undefined });
      }
    } else if (t.receiver_id === cfg.tenderId) {
      // Without msg, mt_on_transfer never runs: the tokens land in the contract's Intents balance and no Tender method moves them out.
      return bad("msg_required", `${at} a transfer to ${cfg.tenderId} must carry a bid or reveal msg`);
    }
    if (typeof inner.signer_id === "string") signers.push(inner.signer_id);
  }
  return { ok: true, signed, signers, bids };
}

export const defaultIpOf = (req: Request): string => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";

type Outcome = { status: number; body: unknown };

export function createRelayHandler(cfg: RelayConfig, deps: RelayDeps): (req: Request) => Promise<Response> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const ipOf = deps.ipOf ?? defaultIpOf;
  const inFlight = new Map<string, Promise<Outcome>>(); // signed body -> its pipeline, so a duplicate shares one execution
  const busySigners = new Set<string>(); // one execute at a time per signer
  const failed = new Map<string, number>(); // signed body -> time until which it is refused (it already failed on chain)
  return async (req) => {
    const origin = req.headers.get("origin");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (origin && cfg.allowedOrigins.includes(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers["vary"] = "Origin";
    }
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
    const fail = (status: number, error: string, detail: string, extra: object = {}) => json(status, { error, detail, ...extra });
    const failBody = (status: number, error: string, detail: string, extra: object = {}): Outcome => ({ status, body: { error, detail, ...extra } });

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...headers, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" },
      });
    }
    const ip = ipOf(req);
    if (req.method === "GET") {
      if (!deps.limiter.hit(`get:${ip}`, deps.now())) return fail(429, "rate_limited", "too many requests, try again in a minute");
      try {
        const h = await deps.health();
        return json(200, {
          ...h,
          allowance_near: h.allowance == null ? null : yoctoToNear(BigInt(h.allowance)),
          ...(h.balance == null ? {} : { balance_near: yoctoToNear(BigInt(h.balance)) }),
        });
      } catch (e) {
        return fail(502, "upstream_error", oneLine(e));
      }
    }
    if (req.method !== "POST") return fail(405, "method_not_allowed", "use GET, POST or OPTIONS");

    if (!deps.limiter.hit(ip, deps.now())) return fail(429, "rate_limited", "too many requests, try again in a minute");

    if (Number(req.headers.get("content-length") ?? 0) > cfg.maxBodyBytes) return fail(413, "body_too_large", `body is larger than ${cfg.maxBodyBytes} bytes`);
    const text = await req.text();
    const v = validateBody(text, cfg, deps.now());
    if (!v.ok) return fail(v.status, v.code, v.detail);
    const signed = v.signed as unknown[];
    const signers = [...new Set(v.signers ?? [])];

    const key = createHash("sha256").update(signed.map((s) => String((s as { signature?: unknown }).signature)).join(",")).digest("hex");
    const refusedUntil = failed.get(key);
    if (refusedUntil !== undefined) {
      if (refusedUntil > deps.now()) return fail(409, "already_failed", "this signed payload already failed on chain; sign it again");
      failed.delete(key);
    }
    const running = inFlight.get(key);
    if (running) {
      const o = await running; // a duplicate (an app retry, a timeout resend) gets the first answer and costs nothing
      return json(o.status, o.body);
    }
    let holds = false; // this request marked its signers busy
    const run = (async (): Promise<Outcome> => {
      try {
        let health: RelayHealth | undefined;
        try {
          health = await deps.health();
        } catch (e) {
          log(`relay health unreadable: ${oneLine(e)}`); // unknown is not zero: simulate and execute decide
        }
        if (health && !health.unknown) {
          if (health.key === "FullAccess" && health.network === "mainnet" && !cfg.allowFullAccess) {
            return failBody(503, "relayer_key_full_access", "the relayer is signing with a full-access key; it must be a function-call key limited to execute_intents");
          }
          if (health.key === "WrongScope") return failBody(503, "relayer_key_scope", "the relayer's function-call key is not limited to execute_intents on the Intents contract");
          if (health.allowance != null && BigInt(health.allowance) < cfg.minAllowanceYocto) {
            return failBody(503, "relayer_allowance_low", "the relayer's gas allowance is low; run your own relayer with `pnpm relay:local`");
          }
          if (health.balance != null && BigInt(health.balance) < cfg.minAllowanceYocto) {
            return failBody(503, "relayer_balance_low", "the relayer's NEAR balance is low; run your own relayer with `pnpm relay:local`");
          }
        }

        const sim = await deps.simulate(signed);
        if (!sim.ok) return failBody(400, "simulate_failed", sim.error);
        const refusal = await tenderRefusal(v.bids ?? [], deps);
        if (refusal) return failBody(409, refusal.code, refusal.detail, refusal.extra);
        // The signer id is only proven by simulate: a forged body naming someone must not use up or lock their slot.
        for (const id of signers) if (!deps.limiter.hit(`signer:${id}`, deps.now())) return failBody(429, "rate_limited", "too many requests for this signer, try again in a minute");
        if (signers.some((id) => busySigners.has(id))) return failBody(409, "signer_busy", "another payload of this signer is being relayed, retry in a few seconds");
        for (const id of signers) busySigners.add(id);
        holds = true;

        const out = await deps.execute(signed);
        log(`relay signers=${signers.join(",")} tx=${out.txHash || "none"} ok=${out.ok}`); // never the payload or signature
        if (out.ok) return { status: 200, body: { txHash: out.txHash, sender: deps.relayerId ?? null } };
        if (!out.txHash && out.sent?.length) {
          // Signed and handed to an RPC, the answer lost: it may still land until the payload deadline. Never "retry".
          const until = new Date(Math.max(...payloadDeadlines(signed))).toISOString();
          return { status: 202, body: { status: "execute_unknown", txHashes: out.sent, sender: deps.relayerId ?? null, until, detail: out.error ?? "the send may have landed" } };
        }
        if (!out.txHash) return failBody(503, "execute_unavailable", out.error ?? "the relayer could not send the transaction, retry", { retry: true });
        failed.set(key, deps.now() + FAILED_TTL_MS);
        return { status: 502, body: { error: "execute_failed", txHash: out.txHash, detail: out.error ?? "execute_intents failed" } };
      } catch (e) {
        // A transport failure says nothing about the signed payload or the allowance: the app shows this text for any 5xx.
        return failBody(502, "upstream_error", `the relayer could not complete its NEAR RPC call (${oneLine(e)}); try again in a minute or run your own relayer with \`pnpm relay:local\``);
      }
    })();
    inFlight.set(key, run);
    try {
      const o = await run;
      return json(o.status, o.body);
    } finally {
      inFlight.delete(key);
      if (holds) for (const id of signers) busySigners.delete(id);
    }
  };
}

function payloadDeadlines(signed: unknown[]): number[] {
  return signed.map((s) => {
    const it = s as { standard: string; payload: unknown };
    const inner = it.standard === "nep413" ? JSON.parse((it.payload as { message: string }).message) : JSON.parse(it.payload as string);
    return Date.parse(inner.deadline);
  });
}

const oneLine = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0]?.slice(0, 200) ?? "";

function yoctoToNear(y: bigint): string {
  const s = y.toString().padStart(25, "0");
  const frac = s.slice(-24).replace(/0+$/, "");
  return frac ? `${s.slice(0, -24)}.${frac}` : s.slice(0, -24);
}

/**
 * One execute_intents call, 300 Tgas, 0 deposit. Account drops its cached nonce and retries on InvalidNonce (the failover provider hands that error through).
 * A transaction's hash is fixed when it is signed, before any RPC sees it: `sent` lists every one (the InvalidNonce retry signs again), so a lost answer can still be looked up.
 */
export async function sendExecute(account: Account, intentsId: string, signed: unknown[]): Promise<{ txHash: string; ok: boolean; error?: string; sent: string[] }> {
  const { signer, hashes: sent } = recordSigned(account);
  try {
    const res: any = await account.signAndSendTransaction({
      receiverId: intentsId,
      actions: [actions.functionCall("execute_intents", { signed }, teraToGas(300), 0n)],
      waitUntil: "EXECUTED_OPTIMISTIC",
      throwOnFailure: false,
      signer,
    });
    const ok = "SuccessValue" in (res.status ?? {});
    return { txHash: res.transaction.hash as string, ok, error: ok ? undefined : failureText(res.status), sent };
  } catch (e) {
    return { txHash: "", ok: false, error: String((e as Error).message).slice(0, 300), sent };
  }
}

export function nearDepsFromEnv(env: NodeJS.ProcessEnv, account?: Account): { cfg: RelayConfig; deps: RelayDeps } {
  const network: Network = (env.NEAR_NETWORK ?? env.TENDER_NETWORK ?? "mainnet") === "testnet" ? "testnet" : "mainnet";
  const intentsId = env.INTENTS_CONTRACT_ID || (network === "mainnet" ? "intents.near" : "");
  if (!intentsId) throw new Error("INTENTS_CONTRACT_ID is required on testnet");
  const tenderId = env.TENDER_CONTRACT_ID || (network === "mainnet" ? "v1.tenderseal.near" : "");
  if (!tenderId) throw new Error("TENDER_CONTRACT_ID is required on testnet");
  const relayerId = env.RELAYER_ACCOUNT_ID || "relayer.tenderseal.near";
  const urls = [...new Set(network === "testnet"
    ? [env.NEAR_TESTNET_RPC_URL, ...RPCS.testnet].filter((u): u is string => !!u)
    : [env.NEAR_RPC_URL, ...(env.NEAR_RPC_FALLBACKS ?? "").split(","), ...RPCS.mainnet].map((u) => u?.trim()).filter((u): u is string => !!u))];
  const key = env.RELAYER_PRIVATE_KEY?.startsWith("ed25519:") ? (env.RELAYER_PRIVATE_KEY as `ed25519:${string}`) : undefined;
  // Health, the allowance guard and signing must describe one key: the public key always comes from the private key.
  const derived = key ? KeyPair.fromString(key).getPublicKey().toString() : undefined;
  if (derived && env.RELAYER_PUBLIC_KEY && env.RELAYER_PUBLIC_KEY !== derived) {
    throw new Error("relayer_key_mismatch: RELAYER_PUBLIC_KEY is not the public key of RELAYER_PRIVATE_KEY");
  }
  const publicKey = derived ?? (env.RELAYER_PUBLIC_KEY || undefined);
  const cfg: RelayConfig = {
    intentsId,
    tenderId,
    allowedOrigins: (env.RELAY_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    maxSigned: 4,
    maxBodyBytes: 16384,
    minAllowanceYocto: 310_000_000_000_000_000_000_000n, // 0.31 NEAR: signing a 300 Tgas call needs allowance >= the pessimistic cost (0.3009 NEAR measured on testnet), not 0.03
    allowFullAccess: env.RELAY_ALLOW_FULL_ACCESS === "1" && !env.VERCEL,
  };

  // Transactions of one instance go through one queue (nonce).
  let queue: Promise<unknown> = Promise.resolve();
  const signer = account ?? (key ? makeAccount(relayerId, key, network, urls) : undefined);
  const send = async (signed: unknown[]) => (signer ? sendExecute(signer, intentsId, signed) : { txHash: "", ok: false, error: "relayer key is not configured", sent: [] });

  // Allowance and balance of the signing key, read at most once per 30 s (and again after every execute).
  const readHealth = async (): Promise<RelayHealth> => {
    const base = { relayer: relayerId, node: process.version, network, intents: intentsId };
    if (!publicKey) return { ...base, allowance: null, balance: null, key: null };
    try {
      const [info, balance] = await Promise.all([accessKeyInfo(urls, relayerId, publicKey), spendableBalance(urls, relayerId)]);
      const scopeOk = info.kind === "FullAccess" || ((!info.receiverId || info.receiverId === intentsId) && (!info.methodNames?.length || info.methodNames.includes("execute_intents")));
      return { ...base, allowance: info.allowance === null ? null : info.allowance.toString(), balance: balance.toString(), key: scopeOk ? info.kind : "WrongScope" };
    } catch (e) {
      if (e instanceof UnknownAccessKey) return { ...base, allowance: "0", balance: null, key: null }; // the key is not on chain: POST answers 503 instead of failing at execute
      return { ...base, allowance: null, balance: null, key: null, unknown: true }; // a 429 or a timeout says nothing about the allowance
    }
  };
  let cached: { at: number; value: Promise<RelayHealth> } | undefined;

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
      return run.finally(() => {
        cached = undefined; // the gas just burnt changes the allowance and the balance
      });
    },
    health() {
      if (cached && Date.now() - cached.at < HEALTH_TTL_MS) return cached.value;
      const value = readHealth();
      const entry = { at: Date.now(), value };
      cached = entry;
      void value.then((h) => { if (h.unknown && cached === entry) cached = undefined; });
      return value;
    },
    relayerId,
    async bidsOf(sale, bidder) {
      const all = await viewFunction<{ bidder: string; cm: string }[]>(urls, tenderId, "get_bids", { id: sale, from: 0, limit: 64 });
      return all.filter((b) => b.bidder === bidder);
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
