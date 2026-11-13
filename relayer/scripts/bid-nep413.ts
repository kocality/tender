import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { KeyPair, KeyPairSigner } from "near-api-js";
import {
  b58encode, bidMsg, bidNonce, bidNonceDeadlineMs, blockTimestampNs, buildPayload, buildVersionedNonce, currentSalt, fromBase64, isNonceUsed, isValidSalt, makeDeadline, mtBalanceOf,
  nep413FromWallet, nep413Message, payloadString, simulateIntents, toBase64, transferIntent,
  type BidOrigin, type DefusePayload, type MultiPayload,
} from "@tender/intents";
import { MPC_DOMAIN2_PK, commitmentHex, sealBid } from "@tender/seal";
import { bidsDir as defaultBidsDir, consoleIo, utcStamp, writeBidFile, type Io } from "./lib/bidfiles.js";
import { intentsPublicKeys } from "./lib/chain.js";
import { formatDryRunStep, parseCommon, planHeader, type CallStep, type Common } from "./lib/cli.js";
import type { SaleTag, Step } from "./lib/evidence.js";
import { loadKeyPair, type KeyPairString } from "./lib/keys.js";
import { RPC } from "./lib/rpc.js";
import { explorer, gasBalanceProblem, makeAccount, sendStep } from "./lib/send.js";
import { recordSigned, spendableBalance } from "../src/near.js";
import { fromUnits, toUnits } from "./lib/units.js";
import { getBids, getConfig, getSale, type BidView, type ConfigView, type SaleView } from "./lib/views.js";

const usage = `usage:
  tsx scripts/bid-nep413.ts --sale <id> --price <USDC per 10^lot_exp tokens> --size <USDC> --escrow <USDC>
    [--signer bidder.tenderseal.near] [--origin near] [--network mainnet|testnet] [--contract <id>]
    [--sealed <seal:bid json>] [--via-relay <url>] [--late] [--additional] [--tag R|0|1|2|3] [--yes]
  Signs one Intents Transfer with the signer's NEAR key (nep413) and submits it. Dry-run unless --yes.
  With --sealed, --price and --size are not needed: ct, cm, seq, the Intents salt and the escrow come from that file.
  A sealed bid has one Intents nonce, so running it again can never place it twice; a bid the chain already shows is not sent.
  --additional: send a different bid although the signer already has one in this sale (a second bid on purpose).`;

const MIN_BID = 1_000_000n; // micro-USDC
const ORIGIN_RE = /^[\x21-\x7e]{1,8}$/;
const MS = 1000;
const CLOSE_MARGIN_MS = 60_000; // a signed bid expires a minute before close, so a late relay is never stored (X12P-02)
const MAX_ESCROW_TOTAL = 1_000_000_000_000n; // micro-USDC per sale, contract/src/sale.rs

export interface Submitted {
  hash: string;
  ok: boolean;
  block?: number;
  logs: string[];
  status?: unknown;
  signer: string; // the account that signed the NEAR transaction (the bidder, or the relayer when --via-relay)
}

/** The send may have landed (a transaction was signed, or the relayer answered 202 execute_unknown): never send the same bid again with a new nonce. */
export class SendUnknown extends Error {
  constructor(readonly hashes: string[], readonly sender?: string, readonly until?: string) {
    super(`the send may have landed: ${hashes.join(", ") || "no hash"}`);
    this.name = "SendUnknown";
  }
}

/** Everything that touches the network or a key. Tests pass a fake. */
export interface BidEnv {
  config(): Promise<ConfigView>;
  sale(id: string): Promise<SaleView | null>;
  bids(id: string): Promise<BidView[]>;
  nowNs(): Promise<bigint>;
  balance(intents: string, account: string, token: string): Promise<bigint>;
  /** NEAR the signer can burn on gas: balance minus the storage stake, yocto. */
  spendable(account: string): Promise<bigint>;
  intentsKeys(intents: string, account: string): Promise<string[]>;
  currentSalt(intents: string): Promise<string>;
  /** Whether intents.near still accepts this salt (8 hex). */
  saltValid(intents: string, salt: string): Promise<boolean>;
  /** Whether the account's nonce (base64) was already executed. */
  nonceUsed(intents: string, account: string, nonceB64: string): Promise<boolean>;
  simulate(intents: string, mp: MultiPayload): Promise<{ ok: true } | { ok: false; kind: string; message: string }>;
  /** `null` when the signer has no key on this machine. */
  secretKey(signer: string): KeyPairString | null;
  execute(signer: string, intents: string, mp: MultiPayload): Promise<Submitted>;
  relay(url: string, mp: MultiPayload): Promise<Submitted>;
  record(row: { sale: SaleTag; step: Step; txHash: string; signer: string; contract: string; expect?: "failure" }): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface BidDeps {
  env?: (c: Common) => BidEnv;
  io?: Io;
  bidsDir?: string;
}

export function liveEnv(c: Common): BidEnv {
  const urls = c.rpc ? [c.rpc] : RPC[c.network].normal;
  return {
    config: () => getConfig(c.network, c.contract, c.rpc),
    sale: (id) => getSale(c.network, c.contract, id, c.rpc),
    bids: (id) => getBids(c.network, c.contract, id, c.rpc),
    nowNs: () => blockTimestampNs(urls),
    balance: (intents, account, token) => mtBalanceOf(urls, intents, account, token),
    spendable: (account) => spendableBalance(urls, account),
    intentsKeys: (intents, account) => intentsPublicKeys(c.network, intents, account),
    currentSalt: (intents) => currentSalt(urls, intents),
    saltValid: (intents, salt) => isValidSalt(urls, intents, salt),
    nonceUsed: (intents, account, nonce) => isNonceUsed(urls, intents, account, nonce),
    simulate: (intents, mp) => simulateIntents(urls, intents, [mp]),
    secretKey(signer) {
      try {
        return loadKeyPair(c.network, signer);
      } catch (e) {
        if (/^no key for /.test((e as Error).message)) return null;
        throw e;
      }
    },
    async execute(signer, intents, mp) {
      const step: CallStep = { signer, receiver: intents, method: "execute_intents", args: { signed: [mp] }, deposit: "0 NEAR", gasTgas: 300, network: c.network };
      const account = makeAccount(c.network, signer, c.rpc);
      const rec = recordSigned(account);
      let r;
      try {
        r = await sendStep(account, step, c.rpc, rec.signer);
      } catch (e) {
        if (rec.hashes.length) throw new SendUnknown(rec.hashes, signer);
        throw e;
      }
      return { hash: r.hash, ok: r.ok, block: r.block, logs: r.logs, status: r.status, signer };
    },
    async relay(url, mp) {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signed: [mp] }), signal: AbortSignal.timeout(60_000) });
      const body: any = await res.json().catch(() => ({}));
      if (res.status === 202) throw new SendUnknown(Array.isArray(body.txHashes) ? body.txHashes.map(String) : [], body.sender ?? undefined, body.until);
      if (!res.ok) throw new Error(`relay answered ${res.status}: ${body.error ?? "?"}${body.detail ? ` · ${body.detail}` : ""}`);
      const health: any = await fetch(url, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json()).catch(() => ({}));
      return { hash: String(body.txHash), ok: true, logs: [], signer: String(health.relayer ?? "") };
    },
    async record(row) {
      const { recordTx } = await import("./record.js");
      await recordTx({ network: c.network, sale: row.sale, step: row.step, txHash: row.txHash, signer: row.signer, contract: row.contract, chain: "near", expect: row.expect });
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** NEP-413 signature by the signer's own key (near-api-js), wrapped as an Intents MultiPayload. */
export async function signNep413(secret: KeyPairString, accountId: string, payload: DefusePayload, nonce32: Uint8Array): Promise<MultiPayload> {
  const signer = KeyPairSigner.fromSecretKey(secret);
  const signed = await signer.signNep413Message(accountId, { message: nep413Message(payload), recipient: payload.verifying_contract, nonce: nonce32 });
  return nep413FromWallet({
    payload,
    nonce32,
    publicKey: signed.publicKey.toString(),
    signature: `ed25519:${b58encode(signed.signature)}`,
  });
}

export interface SealedFile {
  sale: string;
  ct: string;
  cm: string;
  escrow: string; // micro-USDC
  origin: string | null;
  seq?: number; // how many bids the signer had in this sale when the bid was sealed
  intents_salt?: string; // the Intents salt the bid's nonce was derived with (8 hex)
  salt?: string;
  p?: string;
  q?: string;
  signer?: string;
  contract?: string;
}

/** Reads and checks a `seal:bid` style file. Throws on any mismatch with the requested bid. */
export function loadSealedFile(path: string, want: { sale: string; escrow: bigint; signer: string; contract: string }): SealedFile {
  let f: SealedFile;
  try {
    f = JSON.parse(readFileSync(path, "utf8")) as SealedFile;
  } catch {
    throw new Error(`cannot read ${path} as JSON`);
  }
  if (String(f.sale) !== want.sale) throw new Error(`--sealed file is for sale ${f.sale}, not sale ${want.sale}`);
  if (typeof f.escrow !== "string" || BigInt(f.escrow) !== want.escrow) throw new Error(`--sealed file escrow ${f.escrow} micro-USDC differs from --escrow (${want.escrow})`);
  if (f.signer !== undefined && f.signer !== want.signer) throw new Error(`--sealed file was sealed for ${f.signer}; the commitment binds the signer, so ${want.signer} could never reveal it`);
  if (f.contract !== undefined && f.contract !== want.contract) throw new Error(`--sealed file is for contract ${f.contract}, not ${want.contract}`);
  if (typeof f.ct !== "string" || fromBase64(f.ct).length !== 160 || f.ct.length !== 216) throw new Error("--sealed ct must be base64 (standard, padded) of exactly 160 bytes");
  if (typeof f.cm !== "string" || !/^[0-9a-f]{64}$/.test(f.cm)) throw new Error("--sealed cm must be 64 lowercase hex characters");
  if (f.seq === undefined) throw new Error("--sealed file has no seq: it was made by an older seal:bid; re-run pnpm seal:bid");
  if (!Number.isInteger(f.seq) || f.seq < 0 || f.seq > 0xffff) throw new Error("--sealed seq must be an integer from 0 to 65535");
  if (f.intents_salt === undefined) throw new Error("--sealed file has no intents_salt: it was made by an older seal:bid; re-run pnpm seal:bid");
  if (typeof f.intents_salt !== "string" || !/^[0-9a-f]{8}$/.test(f.intents_salt)) throw new Error("--sealed intents_salt must be 8 lowercase hex characters");
  if (f.p !== undefined && f.q !== undefined && f.salt !== undefined) {
    const again = commitmentHex({ sale: BigInt(want.sale), bidder: want.signer, B: want.escrow, p: BigInt(f.p), q: BigInt(f.q), salt: Uint8Array.from(Buffer.from(f.salt, "hex")) });
    if (again !== f.cm) throw new Error("--sealed file: cm does not match (sale, signer, escrow, p, q, salt); refusing to send a bid that cannot be revealed");
  }
  return f;
}

/**
 * The bid transfer, with the msg the contract parses (op, sale, ct, cm, origin, seq).
 * With `closeNs` the nonce is the one nonce of this sealed bid (bidNonce) and the payload deadline never passes its deadline (close - 60 s);
 * without it (a deliberate --late bid) the nonce is random and the deadline is 10 minutes.
 */
export async function buildBidPayload(o: {
  signer: string; intents: string; contract: string; token: string; amount: bigint; sale: string; ct: string; cm: string; origin: string;
  saltHex: string; seq?: number; nowMs?: number; closeNs?: bigint;
}): Promise<{ payload: DefusePayload; nonce32: Uint8Array; msg: string }> {
  const msg = bidMsg({ sale: o.sale, ct: o.ct, cm: o.cm, origin: o.origin as BidOrigin, seq: o.seq });
  if (Buffer.byteLength(msg) > 512) throw new Error("bid msg is longer than 512 bytes");
  // 10 minutes from `nowMs` (chain time; the local clock only when the caller gives none), and never past the nonce deadline
  const nowMs = o.nowMs ?? Date.now();
  const { deadlineMs, deadlineIso } = makeDeadline(nowMs, 600_000, o.closeNs === undefined ? Infinity : bidNonceDeadlineMs(o.closeNs));
  const nonce32 = o.closeNs === undefined
    ? buildVersionedNonce({ saltHex: o.saltHex, deadlineMs })
    : bidNonce({ saltHex: o.saltHex, closeNs: o.closeNs, contract: o.contract, sale: o.sale, signer: o.signer, cm: o.cm });
  const intent = transferIntent({ receiverId: o.contract, tokenId: o.token, amount: o.amount, msg });
  const payload = buildPayload({ signerId: o.signer, verifyingContract: o.intents, deadlineIso, nonce: nonce32, intents: [intent] });
  return { payload, nonce32, msg };
}

/** Pure: why this sale cannot take the bid now (or, with `late`, cannot take a late bid yet). `null` = fine. */
export function windowProblem(sale: SaleView, nowNs: bigint, late: boolean): string | null {
  const close = BigInt(sale.close_ns);
  const closeIso = new Date(Number(close / 1_000_000n)).toISOString();
  if (late) return nowNs >= close ? null : `--late needs the sale to be closed; it closes ${closeIso}`;
  if (sale.state !== "Open") return `sale is ${sale.state}, not Open`;
  if (nowNs >= close) return `sale closed ${closeIso}; use --late to send a deliberately late bid`;
  if (nowNs >= close - BigInt(CLOSE_MARGIN_MS) * 1_000_000n) return `sale closes ${closeIso}, less than a minute from now: a bid that lands after close is refunded and its ciphertext stays public (X12P-02); use --late to send a deliberately late bid after close`;
  return null;
}

/** Pure: the contract would refund this bid (sale full, escrow cap, key request in flight) and its ciphertext would stay in public tx history (X12P-02). `null` = fine. */
export function refundProblem(sale: SaleView, B: bigint): string | null {
  if (sale.in_flight) return "the key request is in flight: the sale no longer takes bids";
  if (sale.bids >= sale.max_bids) return `sale is full (${sale.bids}/${sale.max_bids} bids)`;
  if (BigInt(sale.escrow_total) + B > MAX_ESCROW_TOTAL) return `escrow cap: ${sale.escrow_total} + ${B} > ${MAX_ESCROW_TOTAL} micro-USDC`;
  return null;
}

function saleTag(explicit: string | undefined, saleId: string, contract: string): SaleTag | null {
  if (explicit !== undefined) return ["R", "0", "1", "2", "3"].includes(explicit) ? (explicit as SaleTag) : null;
  if (contract.startsWith("rehearsal.")) return "R";
  return ["0", "1", "2", "3"].includes(saleId) ? (saleId as SaleTag) : null;
}

export async function main(argv: string[], deps: BidDeps = {}): Promise<number> {
  const io = deps.io ?? consoleIo;
  let parsed;
  try {
    parsed = parseCommon(argv, {
      sale: { type: "string" }, price: { type: "string" }, size: { type: "string" }, escrow: { type: "string" }, signer: { type: "string" },
      origin: { type: "string" }, sealed: { type: "string" }, "via-relay": { type: "string" }, late: { type: "boolean" }, additional: { type: "boolean" }, tag: { type: "string" },
    });
  } catch (e) {
    io.err(`error: ${(e as Error).message}\n${usage}`);
    return 2;
  }
  const { common } = parsed;
  const str = (k: string) => parsed.values[k] as string | undefined;
  const late = parsed.values.late === true;
  const sealedPath = str("sealed");
  for (const k of sealedPath ? (["sale", "escrow"] as const) : (["sale", "price", "size", "escrow"] as const)) {
    if (!str(k)) {
      io.err(`error: --${k} is required\n${usage}`);
      return 2;
    }
  }
  const saleId = str("sale") as string;
  const signer = (str("signer") ?? process.env.TENDER_BIDDER_ACCOUNT_ID ?? "bidder.tenderseal.near").toLowerCase();
  const origin = str("origin") ?? "near";
  const env = (deps.env ?? liveEnv)(common);

  try {
    if (!/^\d+$/.test(saleId)) throw new Error("--sale must be a sale id");
    if (!ORIGIN_RE.test(origin)) throw new Error("--origin must be 1 to 8 printable ASCII characters (base, arb, sol, near)");
    const B = toUnits(str("escrow") as string, 6);
    if (B < MIN_BID) throw new Error("--escrow must be at least 1 USDC");
    let p = 0n;
    let q = 0n;
    if (!sealedPath) {
      p = toUnits(str("price") as string, 6);
      q = toUnits(str("size") as string, 6);
      if (p < 1n) throw new Error("--price must be positive");
      if (q < 1n || q > B) throw new Error("--size must be at least 0.000001 and at most --escrow");
    }

    const config = await env.config();
    const sale = await env.sale(saleId);
    if (!sale) throw new Error(`sale ${saleId} not found on ${common.contract}`);
    const problem = windowProblem(sale, await env.nowNs(), late) ?? (late ? null : refundProblem(sale, B));
    if (problem) throw new Error(problem);
    const repoMpk = MPC_DOMAIN2_PK[common.network];
    if (config.mpc_public_key !== repoMpk) throw new Error(`MPC key mismatch, refusing to seal: contract ${config.mpc_public_key} · repo ${repoMpk}`);
    const unit = 10n ** BigInt(sale.lot_exp);
    io.out(`sale ${saleId} on ${common.contract}: ${sale.state}, closes ${new Date(Number(BigInt(sale.close_ns) / 1_000_000n)).toISOString()}${late ? " (LATE bid on purpose)" : ""}`);

    // ct / cm / seq / the Intents salt the nonce is derived with
    let ct: string;
    let cm: string;
    let bidOrigin = origin;
    let savedTo: string;
    let seq: number;
    let saltHex: string;
    const closeNs = BigInt(sale.close_ns);
    if (sealedPath) {
      const f = loadSealedFile(sealedPath, { sale: saleId, escrow: B, signer, contract: common.contract });
      ct = f.ct;
      cm = f.cm;
      seq = f.seq as number;
      saltHex = f.intents_salt as string;
      if (str("origin") === undefined && f.origin) bidOrigin = f.origin;
      savedTo = sealedPath;
    } else {
      // the signer's bids already stored in this sale: a second, different bid is allowed only on purpose
      seq = (await env.bids(saleId)).filter((b) => b.bidder === signer).length;
      saltHex = await env.currentSalt(config.intents);
      if (seq > 0 && !late) {
        io.out(`NOTE ${signer} already has ${seq} bid(s) in sale ${saleId}; this would be an additional bid (seq ${seq})`);
        if (!common.dryRun && parsed.values.additional !== true) throw new Error(`${signer} already has ${seq} bid(s) in sale ${saleId}: to place a second bid on purpose pass --additional; to send the bid you sealed before, pass --sealed <file>`);
      }
      const sealed = sealBid({ mpk: config.mpc_public_key, contract: common.contract, path: sale.path, sale: BigInt(saleId), bidder: signer, B, p, q });
      ct = sealed.ct_b64;
      cm = sealed.cm_hex;
      savedTo = writeBidFile(deps.bidsDir ?? defaultBidsDir(), `${saleId}-${signer}-${utcStamp()}.json`, {
        sale: saleId, contract: common.contract, network: common.network, signer, ct, cm, salt: sealed.salt_hex,
        p: p.toString(), q: q.toString(), escrow: B.toString(), origin: bidOrigin, seq, intents_salt: saltHex,
      });
      io.out(`p = ${p} micro-USDC per ${unit} token(s) · q = ${q} micro-USDC · escrow = ${B} micro-USDC (${fromUnits(B, 6)} USDC)`);
      if (q === B) io.out("note: --escrow equals --size: the escrow is public the moment the bid lands, so the size is public too; use an escrow above the size");
      if (p < BigInt(sale.reserve)) io.out(`note: p is below the reserve (${sale.reserve}); refunded in full once it is revealed (left unrevealed while another bid is revealed, 10% stays in the contract); still counts toward the open conditions`);
    }
    io.out(`sealed bid file (plaintext p, q, salt; local only, never commit): ${savedTo}`);
    if (!sealedPath) io.out(`to send exactly this bid later: re-run with --sealed ${savedTo}`);

    // What the chain already shows comes before anything else: after the bid landed the escrow is spent, and the nonce is used.
    if (sealedPath && !late) {
      if (!(await env.saltValid(config.intents, saltHex))) {
        const fresh = await env.currentSalt(config.intents);
        io.out(`NOTE the file's Intents salt ${saltHex} is no longer valid; signing with the current salt ${fresh}, so the nonce differs from any earlier signature (the contract's dup_bid still refuses a second copy)`);
        saltHex = fresh;
      }
      const nonceB64 = toBase64(bidNonce({ saltHex, closeNs, contract: common.contract, sale: saleId, signer, cm }));
      const used = await env.nonceUsed(config.intents, signer, nonceB64);
      const rows = (await env.bids(saleId)).filter((b) => b.bidder === signer);
      const stored = rows.find((b) => b.cm === cm);
      if (stored) {
        io.out(`OK already stored as bid idx ${stored.idx}; nothing sent`);
        return 0;
      }
      if (used) throw new Error(`the nonce of this bid was already used, but no bid of yours with this commitment is stored in sale ${saleId}: an earlier send is still running, or intents.near ran it and ${common.contract} refunded it. Do not send it again; look its transaction up, then re-run to see what the chain shows`);
      if (rows.length > seq) throw new Error(`you already have ${rows.length} bid(s) in sale ${saleId}; this bid was prepared when you had ${seq}, so the contract would refund it (bid_seq). Run pnpm seal:bid again: it takes the current count`);
    }

    // funding and key registration
    const have = await env.balance(config.intents, signer, sale.quote_token);
    if (have < B) throw new Error(`deposit first: ${signer} holds ${have} of ${sale.quote_token} in ${config.intents}, the bid needs ${B}`);
    const secret = env.secretKey(signer);
    if (!secret) {
      if (!common.dryRun) throw new Error(`no key for ${signer} on ${common.network} (looked in the near-credentials directory)`);
      io.out(`note: no local key for ${signer}; signature, key-registration check and simulate_intents are skipped in this dry-run`);
    }
    const publicKey = secret ? KeyPair.fromString(secret).getPublicKey().toString() : null;
    if (publicKey && !(await env.intentsKeys(config.intents, signer)).includes(publicKey)) {
      throw new Error(`run H-INTENTS-KEYS for ${signer}: ${publicKey} is not registered in ${config.intents} (intents.add_public_key, 1 yocto), the bid would fail with "public key doesn't exist"`);
    }

    // payload, signature, simulate
    const { payload, nonce32 } = await buildBidPayload({
      signer, intents: config.intents, contract: common.contract, token: sale.quote_token, amount: B, sale: saleId, ct, cm, origin: bidOrigin,
      saltHex, seq,
      nowMs: Number((await env.nowNs()) / 1_000_000n), // chain time, not the local clock (X12-01)
      ...(late ? {} : { closeNs }),
    });
    io.out(`payload (unsigned): ${payloadString(payload)}`);
    if (!late) io.out(`nonce (one per sealed bid, the same on every signing): ${toBase64(nonce32)}`);
    let mp: MultiPayload | null = null;
    if (secret) {
      mp = await signNep413(secret, signer, payload, nonce32);
      const sim = await env.simulate(config.intents, mp);
      if (!sim.ok) {
        io.err(`simulate_intents failed (${sim.kind}): ${sim.message}`);
        return 1;
      }
      io.out("simulate_intents: ok");
    }

    const relayUrl = str("via-relay");
    if (!relayUrl) {
      // sending it yourself prepays 300 Tgas, which the signer must be able to cover (a bidder with 0.2 NEAR is refused)
      const blocked = gasBalanceProblem(signer, await env.spendable(signer), 300);
      if (blocked) {
        io.out(`BLOCKED: ${blocked}`);
        return 1;
      }
    }
    const step: CallStep = { signer, receiver: config.intents, method: "execute_intents", args: { signed: ["<nep413 MultiPayload, printed only when sent>"] }, deposit: "0 NEAR", gasTgas: 300, network: common.network };
    io.out(planHeader(common.dryRun));
    io.out(relayUrl ? `[1/1] POST ${relayUrl}\n      body={"signed":["<nep413 MultiPayload, printed only when sent>"]}` : formatDryRunStep(1, 1, step).split("\n").slice(0, 2).join("\n"));
    if (common.dryRun) return 0;
    if (!mp) throw new Error("internal: no signed payload");

    const bidsBefore = (await env.bids(saleId)).length;
    let r: Submitted;
    try {
      r = relayUrl ? await env.relay(relayUrl, mp) : await env.execute(signer, config.intents, mp);
    } catch (e) {
      if (!(e instanceof SendUnknown)) throw e;
      io.err(`UNKNOWN the send may have landed: ${e.hashes.map((h) => `${h} (${explorer(common.network, h)})`).join(", ") || "no hash"}${e.sender ? ` · sender ${e.sender}` : ""}`);
      io.err(`do not re-run before ${e.until ?? payload.deadline}: the signed payload can still be executed until then. Re-running with --sealed ${savedTo} is safe (same nonce, intents.near runs it once); the bid is stored when get_bids shows its cm`);
      return 1;
    }
    io.out(`tx=${r.hash} status=${r.ok ? "SuccessValue" : "Failure"}${r.block !== undefined ? ` block=${r.block}` : ""} url=${explorer(common.network, r.hash)}`);
    const tag = saleTag(str("tag"), saleId, common.contract);
    // What the chain shows, before anything is recorded: a tx that succeeded at top level can still be a refund (S-05).
    const mineIn = (bids: BidView[]) => bids.slice(bidsBefore).find((b) => b.bidder === signer && b.cm === cm); // not "the last bid": another bidder may land after ours
    const confirm = async (): Promise<number> => {
      if (!r.ok) {
        io.err(`FAIL execute_intents: ${JSON.stringify(r.status).slice(0, 400)}`);
        return 1;
      }
      for (let attempt = 0; attempt < 10; attempt++) {
        const bids = await env.bids(saleId);
        if (!late) {
          const mine = mineIn(bids);
          if (mine) {
            io.out(`OK bid idx ${mine.idx} sealed`);
            return 0;
          }
        } else if ((await env.balance(config.intents, signer, sale.quote_token)) === have) {
          if (mineIn(bids)) {
            io.err(`FAIL late bid was accepted: ${bids.length} bids now, ${bidsBefore} before`);
            return 1;
          }
          io.out("OK late bid refunded");
          return 0;
        }
        await env.sleep(3 * MS);
      }
      io.err(late ? "FAIL the refund of the late bid is not visible yet (balance differs from before)" : `FAIL the bid is not in get_bids; contract log: ${r.logs.filter((l) => /refund/i.test(l)).join(" | ") || r.logs.join(" | ") || "(no log)"}`);
      return 1;
    };
    const code = await confirm();
    if (common.network === "mainnet" && !common.noRecord && tag && r.signer) {
      try {
        await env.record({ sale: tag, step: late ? "attack-late" : "bid", txHash: r.hash, signer: r.signer, contract: common.contract, ...(late ? { expect: "failure" as const } : {}) });
      } catch (e) {
        io.err(`WARN recording failed (run scripts/record.ts by hand within 2 h): ${(e as Error).message}`);
      }
    } else if (common.network === "mainnet" && !common.noRecord) io.err("WARN not recorded: pass --tag R|0|1|2|3 (and a signer) or run scripts/record.ts by hand within 2 h");
    return code;
  } catch (e) {
    io.err(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
