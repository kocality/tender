import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { KeyPair, KeyPairSigner } from "near-api-js";
import {
  b58encode, bidMsg, blockTimestampNs, buildPayload, buildVersionedNonce, currentSalt, fromBase64, makeDeadline, mtBalanceOf,
  nep413FromWallet, nep413Message, payloadString, simulateIntents, transferIntent,
  type BidOrigin, type DefusePayload, type MultiPayload,
} from "@tender/intents";
import { MPC_DOMAIN2_PK, commitmentHex, sealBid } from "@tender/seal";
import { bidsDir as defaultBidsDir, consoleIo, utcStamp, writeBidFile, type Io } from "./lib/bidfiles.js";
import { intentsPublicKeys } from "./lib/chain.js";
import { DRY_RUN_HEADER, formatDryRunStep, parseCommon, type CallStep, type Common } from "./lib/cli.js";
import type { SaleTag, Step } from "./lib/evidence.js";
import { loadKeyPair, type KeyPairString } from "./lib/keys.js";
import { RPC } from "./lib/rpc.js";
import { explorer, gasBalanceProblem, makeAccount, sendStep } from "./lib/send.js";
import { spendableBalance } from "../src/near.js";
import { fromUnits, toUnits } from "./lib/units.js";
import { getBids, getConfig, getSale, type BidView, type ConfigView, type SaleView } from "./lib/views.js";

const usage = `usage:
  tsx scripts/bid-nep413.ts --sale <id> --price <USDC per 10^lot_exp tokens> --size <USDC> --escrow <USDC>
    [--signer bidder.tenderseal.near] [--origin near] [--network mainnet|testnet] [--contract <id>]
    [--sealed <seal:bid json>] [--via-relay <url>] [--late] [--tag R|0|1|2|3] [--yes]
  Signs one Intents Transfer with the signer's NEAR key (nep413) and submits it. Dry-run unless --yes.
  With --sealed, --price and --size are not needed: ct, cm and the escrow come from that file.`;

const MIN_BID = 1_000_000n; // micro-USDC
const ORIGIN_RE = /^[\x21-\x7e]{1,8}$/;
const MS = 1000;

export interface Submitted {
  hash: string;
  ok: boolean;
  block?: number;
  logs: string[];
  status?: unknown;
  signer: string; // the account that signed the NEAR transaction (the bidder, or the relayer when --via-relay)
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
  simulate(intents: string, mp: MultiPayload): Promise<{ ok: true } | { ok: false; kind: string; message: string }>;
  /** `null` when the signer has no key on this machine. */
  secretKey(signer: string): KeyPairString | null;
  execute(signer: string, intents: string, mp: MultiPayload): Promise<Submitted>;
  relay(url: string, mp: MultiPayload): Promise<Submitted>;
  record(row: { sale: SaleTag; step: Step; txHash: string; signer: string; contract: string }): Promise<void>;
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
      const r = await sendStep(makeAccount(c.network, signer, c.rpc), step, c.rpc);
      return { hash: r.hash, ok: r.ok, block: r.block, logs: r.logs, status: r.status, signer };
    },
    async relay(url, mp) {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signed: [mp] }), signal: AbortSignal.timeout(60_000) });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`relay answered ${res.status}: ${body.error ?? "?"}${body.detail ? ` · ${body.detail}` : ""}`);
      const health: any = await fetch(url, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json()).catch(() => ({}));
      return { hash: String(body.txHash), ok: true, logs: [], signer: String(health.relayer ?? "") };
    },
    async record(row) {
      const { recordTx } = await import("./record.js");
      await recordTx({ network: c.network, sale: row.sale, step: row.step, txHash: row.txHash, signer: row.signer, contract: row.contract, chain: "near" });
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
  if (f.p !== undefined && f.q !== undefined && f.salt !== undefined) {
    const again = commitmentHex({ sale: BigInt(want.sale), bidder: want.signer, B: want.escrow, p: BigInt(f.p), q: BigInt(f.q), salt: Uint8Array.from(Buffer.from(f.salt, "hex")) });
    if (again !== f.cm) throw new Error("--sealed file: cm does not match (sale, signer, escrow, p, q, salt); refusing to send a bid that cannot be revealed");
  }
  return f;
}

/** The bid transfer, with the msg the contract parses (op, sale, ct, cm, origin). */
export async function buildBidPayload(o: {
  signer: string; intents: string; contract: string; token: string; amount: bigint; sale: string; ct: string; cm: string; origin: string;
  saltHex: string; nowMs?: number;
}): Promise<{ payload: DefusePayload; nonce32: Uint8Array; msg: string }> {
  const msg = bidMsg({ sale: o.sale, ct: o.ct, cm: o.cm, origin: o.origin as BidOrigin });
  if (Buffer.byteLength(msg) > 512) throw new Error("bid msg is longer than 512 bytes");
  const { deadlineMs, deadlineIso } = makeDeadline(o.nowMs);
  const nonce32 = buildVersionedNonce({ saltHex: o.saltHex, deadlineMs });
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
  return nowNs < close ? null : `sale closed ${closeIso}; use --late to send a deliberately late bid`;
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
      origin: { type: "string" }, sealed: { type: "string" }, "via-relay": { type: "string" }, late: { type: "boolean" }, tag: { type: "string" },
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
    const problem = windowProblem(sale, await env.nowNs(), late);
    if (problem) throw new Error(problem);
    const repoMpk = MPC_DOMAIN2_PK[common.network];
    if (config.mpc_public_key !== repoMpk) throw new Error(`MPC key mismatch, refusing to seal: contract ${config.mpc_public_key} · repo ${repoMpk}`);
    const unit = 10n ** BigInt(sale.lot_exp);
    io.out(`sale ${saleId} on ${common.contract}: ${sale.state}, closes ${new Date(Number(BigInt(sale.close_ns) / 1_000_000n)).toISOString()}${late ? " (LATE bid on purpose)" : ""}`);

    // ct / cm
    let ct: string;
    let cm: string;
    let bidOrigin = origin;
    let savedTo: string;
    if (sealedPath) {
      const f = loadSealedFile(sealedPath, { sale: saleId, escrow: B, signer, contract: common.contract });
      ct = f.ct;
      cm = f.cm;
      if (str("origin") === undefined && f.origin) bidOrigin = f.origin;
      savedTo = sealedPath;
    } else {
      const sealed = sealBid({ mpk: config.mpc_public_key, contract: common.contract, path: sale.path, sale: BigInt(saleId), bidder: signer, B, p, q });
      ct = sealed.ct_b64;
      cm = sealed.cm_hex;
      savedTo = writeBidFile(deps.bidsDir ?? defaultBidsDir(), `${saleId}-${signer}-${utcStamp()}.json`, {
        sale: saleId, contract: common.contract, network: common.network, signer, ct, cm, salt: sealed.salt_hex,
        p: p.toString(), q: q.toString(), escrow: B.toString(), origin: bidOrigin,
      });
      io.out(`p = ${p} micro-USDC per ${unit} token(s) · q = ${q} micro-USDC · escrow = ${B} micro-USDC (${fromUnits(B, 6)} USDC)`);
      if (p < BigInt(sale.reserve)) io.out(`note: p is below the reserve (${sale.reserve}); the bid is refunded in full but still counts toward the open conditions`);
    }
    io.out(`sealed bid file (plaintext p, q, salt; local only, never commit): ${savedTo}`);
    if (!sealedPath) io.out(`to send exactly this bid later: re-run with --sealed ${savedTo}`);

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
      saltHex: await env.currentSalt(config.intents),
    });
    io.out(`payload (unsigned): ${payloadString(payload)}`);
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
    io.out(DRY_RUN_HEADER);
    io.out(relayUrl ? `[1/1] POST ${relayUrl}\n      body={"signed":["<nep413 MultiPayload, printed only when sent>"]}` : formatDryRunStep(1, 1, step).split("\n").slice(0, 2).join("\n"));
    if (common.dryRun) return 0;
    if (!mp) throw new Error("internal: no signed payload");

    const bidsBefore = (await env.bids(saleId)).length;
    const r = relayUrl ? await env.relay(relayUrl, mp) : await env.execute(signer, config.intents, mp);
    io.out(`tx=${r.hash} status=${r.ok ? "SuccessValue" : "Failure"}${r.block !== undefined ? ` block=${r.block}` : ""} url=${explorer(common.network, r.hash)}`);
    const tag = saleTag(str("tag"), saleId, common.contract);
    if (common.network === "mainnet" && !common.noRecord && tag && r.signer) {
      try {
        await env.record({ sale: tag, step: late ? "attack-late" : "bid", txHash: r.hash, signer: r.signer, contract: common.contract });
      } catch (e) {
        io.err(`WARN recording failed (run scripts/record.ts by hand within 2 h): ${(e as Error).message}`);
      }
    } else if (common.network === "mainnet" && !common.noRecord) io.err("WARN not recorded: pass --tag R|0|1|2|3 (and a signer) or run scripts/record.ts by hand within 2 h");
    if (!r.ok) {
      io.err(`FAIL execute_intents: ${JSON.stringify(r.status).slice(0, 400)}`);
      return 1;
    }

    // outcome as the chain shows it
    for (let attempt = 0; attempt < 10; attempt++) {
      const bids = await env.bids(saleId);
      if (!late) {
        const last = bids.at(-1);
        if (bids.length > bidsBefore && last && last.bidder === signer && last.cm === cm) {
          io.out(`OK bid idx ${last.idx} sealed`);
          return 0;
        }
      } else if ((await env.balance(config.intents, signer, sale.quote_token)) === have) {
        if (bids.length !== bidsBefore) {
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
  } catch (e) {
    io.err(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
