import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { KeyPair } from "near-api-js";
import { appId, decryptBids, checkKey, keyFromCkd, type BidToDecrypt, type DecryptedBid, type G1Point, type CkdResponse } from "@tender/seal";
import { parseCommon } from "../scripts/lib/cli.js";
import { resolveKey } from "../scripts/lib/keys.js";
import { rpcCall, type Network } from "../scripts/lib/rpc.js";
import { explorer, sendStep } from "../scripts/lib/send.js";
import { getBids, getConfig, getSale, type BidView, type ConfigView, type SaleView } from "../scripts/lib/views.js";
import { RPCS, accessKeyAllowance, makeAccount } from "./near.js";

// Keeper for a sale: open at close, reveal every bid that decrypts and matches its commitment, finalize, retry failed payouts.
// Stateless and idempotent: every run reads the chain, decides, acts, and can be repeated or interrupted at any point.

export interface RevealItem { idx: number; p: string; q: string; salt: string /* 32 lowercase hex */ }

export type KeeperAction =
  | { kind: "wait"; reason: string; until?: string }
  | { kind: "open" }
  | { kind: "cancel"; rule: "a" | "b" }
  | { kind: "reveal"; items: RevealItem[] }
  | { kind: "finalize"; max: number }
  | { kind: "done"; state: string }
  | { kind: "stop"; reason: string }; // checkKey false, allowance low, no progress

/** The `@tender/seal` functions `decide` uses, injectable so tests need no pairing. */
export interface KeeperCrypto {
  keyFromCkd(r: CkdResponse, mode: "identity" | "generator" | "plain"): G1Point;
  checkKey(S: G1Point, mpk: string, id: Uint8Array): boolean;
  decryptBids(a: { S: G1Point; contract: string; path: string; sale: bigint; bids: BidToDecrypt[] }): DecryptedBid[];
  appId(contract: string, path: string): Uint8Array;
}

export const sealCrypto: KeeperCrypto = { keyFromCkd, checkKey, decryptBids, appId };

export const MAX_BATCH = 8; // reveal items per tx (100 Tgas) and payouts per finalize call (300 Tgas)
const CANCEL_AFTER_NS = 86_400n * 1_000_000_000n;
// Signing needs allowance >= the pessimistic cost of the prepaid gas: 300 Tgas = 0.3009 NEAR, 100 Tgas = 0.1003 NEAR (measured on testnet); 1.05e21 yocto per Tgas keeps a margin.
const YOCTO_PER_TGAS_NEEDED = 1_050_000_000_000_000_000_000n;
const MAX_TURNS = 12;

export const isoSec = (ns: bigint): string => new Date(Number(ns / 1_000_000n)).toISOString().replace(/\.\d{3}Z$/, "Z");

export interface DecideCtx { contractId: string; mpkG2: string; mode: string }

/** Pure: what to do next. Several `reveal` actions mean several batches; the runner sends the first and decides again. */
export function decide(sale: SaleView, bids: BidView[], nowNs: bigint, crypto: KeeperCrypto, ctx: DecideCtx): KeeperAction[] {
  if (sale.state === "Finalized" || sale.state === "Cancelled") {
    if (sale.payouts_done < sale.payouts_total) return [{ kind: "finalize", max: MAX_BATCH }]; // also pays out a cancelled sale; retries failed transfers
    return [{ kind: "done", state: `${sale.state} · paid ${sale.payouts_done}/${sale.payouts_total} ok` }];
  }

  const close = BigInt(sale.close_ns);
  if (sale.state === "Open" || sale.state === "Opening") {
    if (sale.in_flight || sale.state === "Opening") return [{ kind: "wait", reason: "the key request is in flight" }];
    if (nowNs < close) return [{ kind: "wait", reason: `would call open(${sale.id}) after ${isoSec(close)}`, until: isoSec(close) }];
    const conditions = BigInt(sale.escrow_total) >= BigInt(sale.min_escrow) && sale.bidders >= sale.min_bidders;
    if (!conditions && sale.key_requests === 0) return [{ kind: "cancel", rule: "a" }];
    if (nowNs >= close + CANCEL_AFTER_NS && sale.key === null) return [{ kind: "cancel", rule: "b" }];
    if (conditions) return [{ kind: "open" }];
    return [{ kind: "stop", reason: "open conditions fail although a key was requested (not reachable on chain)" }];
  }

  // Keyed
  const deadline = sale.reveal_deadline_ns === null ? null : BigInt(sale.reveal_deadline_ns);
  const windowOpen = deadline !== null && nowNs < deadline;
  const finalize: KeeperAction = { kind: "finalize", max: MAX_BATCH };
  const keyStop = (why: string): KeeperAction[] =>
    windowOpen ? [{ kind: "stop", reason: `FAIL checkKey: ${why}` }] : [finalize]; // no valid key: no reveal; after the window finalize refunds everyone in full
  if (!sale.key) return keyStop("the sale is Keyed but get_sale shows no key");
  const mode = ctx.mode;
  if (mode !== "identity" && mode !== "generator" && mode !== "plain") return keyStop(`unknown app_pk_mode "${mode}"`);
  let S: G1Point;
  try {
    S = crypto.keyFromCkd({ big_y: sale.key.big_y, big_c: sale.key.big_c }, mode);
    if (!crypto.checkKey(S, ctx.mpkG2, crypto.appId(ctx.contractId, sale.path))) return keyStop("the key does not match the MPC public key and this sale's app_id");
  } catch (e) {
    return keyStop((e as Error).message);
  }

  if (!windowOpen || sale.revealed === sale.bids) return [finalize];

  // only items the contract will accept: one bad item reverts the whole reveal batch
  const sealed = bids.filter((b) => b.state === "Sealed");
  const dec = crypto.decryptBids({
    S, contract: ctx.contractId, path: sale.path, sale: BigInt(sale.id),
    bids: sealed.map((b) => ({ idx: b.idx, bidder: b.bidder, B: BigInt(b.escrow), ct: b.ct, cm: b.cm })),
  });
  const items: RevealItem[] = [];
  for (const d of dec) {
    const bid = sealed.find((b) => b.idx === d.idx);
    if (!bid || !d.ok || d.cmOk !== true || d.p === undefined || d.q === undefined || d.salt_hex === undefined) continue;
    if (d.q < 1n || d.q > BigInt(bid.escrow)) continue;
    items.push({ idx: d.idx, p: d.p.toString(), q: d.q.toString(), salt: d.salt_hex });
  }
  if (items.length === 0) {
    return [{ kind: "wait", reason: `nothing left to reveal; finalize after ${isoSec(deadline as bigint)} or when every bid is revealed`, until: isoSec(deadline as bigint) }];
  }
  const out: KeeperAction[] = [];
  for (let i = 0; i < items.length; i += MAX_BATCH) out.push({ kind: "reveal", items: items.slice(i, i + MAX_BATCH) });
  return out;
}

export interface KeeperCall { method: "open" | "cancel" | "reveal" | "finalize"; args: object; gasTgas: number }
export interface KeeperSent { hash: string; ok: boolean; url: string; error?: string }

export interface KeeperDeps {
  config(): Promise<ConfigView>;
  sale(id: string): Promise<SaleView | null>;
  bids(id: string): Promise<BidView[]>;
  nowNs(): Promise<bigint>;
  allowance(): Promise<bigint | null>; // null = no cap
  call(c: KeeperCall): Promise<KeeperSent>;
  crypto: KeeperCrypto;
  log(line: string): void;
  record?(c: KeeperCall, hash: string): Promise<void>;
}

export interface KeeperOpts { network: Network; contract: string; sale: string; dryRun: boolean; once: boolean }
export interface KeeperRow { turn: number; action: string; tx?: string; url?: string; ok?: boolean }
export interface KeeperReport { rows: KeeperRow[]; last: KeeperAction | null; exitCode: 0 | 1 }

export function toCall(a: KeeperAction, sale: string): KeeperCall | null {
  switch (a.kind) {
    case "open": return { method: "open", args: { sale }, gasTgas: 100 };
    case "cancel": return { method: "cancel", args: { sale }, gasTgas: 300 };
    case "reveal": return { method: "reveal", args: { sale, items: a.items }, gasTgas: 100 };
    case "finalize": return { method: "finalize", args: { sale, max: a.max }, gasTgas: 300 };
    default: return null;
  }
}

export function describeAction(a: KeeperAction, sale: string): string {
  switch (a.kind) {
    case "wait": return a.reason;
    case "open": return `open(${sale})`;
    case "cancel": return `cancel(${sale}) rule ${a.rule}`;
    case "reveal": return `reveal(${sale}, bids ${a.items.map((i) => i.idx).join(",")})`;
    case "finalize": return `finalize(${sale}, ${a.max})`;
    case "done": return a.state;
    case "stop": return a.reason;
  }
}

const NO_CONTRACT = /UNKNOWN_ACCOUNT|CodeDoesNotExist|does not exist/;

export async function runKeeper(opts: KeeperOpts, deps: KeeperDeps): Promise<KeeperReport> {
  const rows: KeeperRow[] = [];
  const say = (line: string) => deps.log(line);
  const finish = (last: KeeperAction | null, exitCode: 0 | 1): KeeperReport => ({ rows, last, exitCode });

  let config: ConfigView;
  try {
    config = await deps.config();
  } catch (e) {
    if (!NO_CONTRACT.test((e as Error).message)) throw e;
    say(`no such sale: ${opts.contract} does not exist on ${opts.network} yet`);
    return finish(null, 0);
  }
  const ctx: DecideCtx = { contractId: opts.contract, mpkG2: config.mpc_public_key, mode: config.app_pk_mode };

  let before: { kind: string; sig: string } | null = null;
  let last: KeeperAction | null = null;
  for (let turn = 1; turn <= (opts.once ? 1 : MAX_TURNS); turn++) {
    const sale = await deps.sale(opts.sale);
    if (!sale) {
      say(`no such sale: ${opts.contract} has no sale ${opts.sale} yet`);
      return finish(null, 0);
    }
    const bids = sale.state === "Keyed" ? await deps.bids(opts.sale) : [];
    const sig = [sale.state, sale.revealed, sale.payouts_done].join("|"); // what an action must change
    const action = decide(sale, bids, await deps.nowNs(), deps.crypto, ctx)[0] as KeeperAction;
    const text = describeAction(action, opts.sale);
    last = action;

    if (action.kind === "wait") {
      say(`${opts.dryRun ? "dry-run: " : "wait: "}${text}`);
      rows.push({ turn, action: `wait: ${text}` });
      return finish(action, 0);
    }
    if (action.kind === "done") {
      say(`done: ${text}`);
      rows.push({ turn, action: `done: ${text}` });
      return finish(action, 0);
    }
    if (action.kind === "stop") {
      say(`stop: ${text}`);
      rows.push({ turn, action: `stop: ${text}` });
      return finish(action, 1);
    }

    if (opts.dryRun) {
      say(`dry-run: would call ${text} now`);
      rows.push({ turn, action: `would call ${text}` });
      return finish(action, 0);
    }
    if (before && before.kind === action.kind && before.sig === sig) {
      const stop: KeeperAction = { kind: "stop", reason: `${text} changed nothing on chain; the next scheduled run tries again` };
      say(`stop: ${stop.reason}`);
      rows.push({ turn, action: `stop: ${stop.reason}` });
      return finish(stop, 1);
    }
    const call = toCall(action, opts.sale) as KeeperCall;
    const allowance = await deps.allowance();
    const needed = BigInt(call.gasTgas) * YOCTO_PER_TGAS_NEEDED;
    if (allowance !== null && allowance < needed) {
      const stop: KeeperAction = { kind: "stop", reason: `function-call key allowance ${allowance} yocto is below ${needed} yocto, the cost of ${call.gasTgas} Tgas prepaid gas` };
      say(`stop: ${stop.reason}`);
      rows.push({ turn, action: `stop: ${stop.reason}` });
      return finish(stop, 1);
    }

    const sent = await deps.call(call);
    say(`${text} tx=${sent.hash} status=${sent.ok ? "SuccessValue" : "Failure"} url=${sent.url}${sent.error ? ` error=${sent.error}` : ""}`);
    rows.push({ turn, action: text, tx: sent.hash, url: sent.url, ok: sent.ok });
    if (deps.record && sent.hash) {
      try {
        await deps.record(call, sent.hash);
      } catch (e) {
        say(`WARN recording failed (run scripts/record.ts by hand within 2 h): ${(e as Error).message}`);
      }
    }
    if (!sent.ok) return finish(action, 1);
    before = { kind: action.kind, sig };
  }
  if (!opts.once) say(`stop after ${MAX_TURNS} turns; the next scheduled run continues`);
  return finish(last, 0);
}

export function summaryMarkdown(opts: KeeperOpts, rows: KeeperRow[]): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|");
  const lines = [`### keeper · sale ${opts.sale} · ${opts.contract} (${opts.network})${opts.dryRun ? " · dry-run" : ""}`, "", "| turn | action | tx |", "|---|---|---|"];
  for (const r of rows) lines.push(`| ${r.turn} | ${cell(r.action)} | ${r.tx ? `[${r.tx}](${r.url})${r.ok === false ? " (failed)" : ""}` : ""} |`);
  return lines.join("\n") + "\n";
}

const usage = "usage: tsx src/keeper.ts --sale <id> [--network mainnet|testnet] [--contract <id>] [--dry-run | --yes] [--once] [--rpc <url>]";

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let parsed;
  try {
    parsed = parseCommon(argv, { sale: { type: "string" }, once: { type: "boolean" } });
  } catch (e) {
    console.error(`error: ${(e as Error).message}\n${usage}`);
    return 2;
  }
  const { common, values } = parsed;
  const sale = values.sale as string | undefined;
  if (!sale || !/^\d+$/.test(sale)) {
    console.error(`error: --sale <id> is required (a number)\n${usage}`);
    return 2;
  }
  const opts: KeeperOpts = { network: common.network, contract: common.contract, sale, dryRun: common.dryRun, once: values.once === true };
  const urls = common.rpc ? [common.rpc] : RPCS[opts.network];

  let deps: KeeperDeps;
  try {
    let call: KeeperDeps["call"] = async () => {
      throw new Error("dry-run has no signer");
    };
    let allowance: KeeperDeps["allowance"] = async () => null;
    let record: KeeperDeps["record"];
    if (!opts.dryRun) {
      const accountId = env.KEEPER_ACCOUNT_ID || env.TENDER_TEAM_ACCOUNT_ID || "tenderseal.near";
      const { privateKey } = resolveKey(opts.network, accountId, { envVar: "KEEPER_PRIVATE_KEY", publicKey: env.KEEPER_PUBLIC_KEY || undefined });
      const publicKey = KeyPair.fromString(privateKey).getPublicKey().toString();
      const account = makeAccount(accountId, privateKey, opts.network, urls);
      allowance = () => accessKeyAllowance(urls, accountId, publicKey);
      call = async (c) => {
        const r = await sendStep(account, { signer: accountId, receiver: opts.contract, method: c.method, args: c.args, deposit: "0 NEAR", gasTgas: c.gasTgas, network: opts.network }, common.rpc);
        return { hash: r.hash, ok: r.ok, url: explorer(opts.network, r.hash), error: r.ok ? undefined : JSON.stringify(r.status).slice(0, 300) };
      };
      if (opts.network === "mainnet" && !common.noRecord && !env.GITHUB_ACTIONS) {
        record = async (c, hash) => {
          const tag = opts.contract.startsWith("rehearsal.") ? "R" : opts.sale;
          if (!["R", "0", "1", "2", "3"].includes(tag)) return;
          const { recordTx } = await import("../scripts/record.js");
          await recordTx({ network: opts.network, sale: tag as "R", step: c.method, txHash: hash, signer: accountId, contract: opts.contract, chain: "near" });
        };
      }
    }
    deps = {
      config: () => getConfig(opts.network, opts.contract, common.rpc),
      sale: (id) => getSale(opts.network, opts.contract, id, common.rpc),
      bids: (id) => getBids(opts.network, opts.contract, id, common.rpc),
      nowNs: async () => {
        const { result } = await rpcCall<{ header: { timestamp_nanosec: string } }>(opts.network, "block", { finality: "final" }, { rpc: common.rpc });
        return BigInt(result.header.timestamp_nanosec);
      },
      allowance, call, record,
      crypto: sealCrypto,
      log: (line) => console.log(line),
    };
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 2;
  }

  try {
    const report = await runKeeper(opts, deps);
    const summary = env.GITHUB_STEP_SUMMARY;
    if (summary && report.rows.length) appendFileSync(summary, summaryMarkdown(opts, report.rows));
    return report.exitCode;
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
