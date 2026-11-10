import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { baseDecode } from "near-api-js";
import {
  USDC_NEAR, evmNative, evmUsdc, ftBalance, intentsBalances, nearNative, solNative, solUsdc,
} from "./lib/chain.js";
import { nearCliLine, parseCommon } from "./lib/cli.js";
import { EVIDENCE_DIR } from "./lib/evidence.js";
import type { Network } from "./lib/rpc.js";
import { fromUnits, toUnits } from "./lib/units.js";

const ACCOUNTS_FILE = `${EVIDENCE_DIR}team-accounts.json`;
const TARGETS_FILE = fileURLToPath(new URL(["..", "..", "docs", "internal", "funding-targets.json"].join("/"), import.meta.url));

export type Venue = "near" | "intents" | "base" | "arb" | "sol";
export type Asset = "NEAR" | "USDC" | "wNEAR" | "JAMBO" | "ETH" | "SOL";
export interface Req { holder: string; venue: Venue; asset: Asset; min: string }
export interface Target { id: string; label: string; any: Req[] } // PASS when any alternative holds
export type Targets = Record<string, Target[]>;

export interface Accounts {
  updated_utc: string | null;
  near: Record<string, string>;
  evm: Record<string, { address: string | null; chain: "base" | "arb" }>;
  sol: Record<string, { address: string | null; intents_account: string | null }>;
  note?: string;
}

const INTENTS_TOKEN: Record<string, string> = {
  USDC: `nep141:${USDC_NEAR}`,
  wNEAR: "nep141:wrap.near",
  JAMBO: "nep141:jambo-1679.meme-cooking.near",
};
const FT_TOKEN: Record<string, string> = { USDC: USDC_NEAR, wNEAR: "wrap.near" };
const DECIMALS: Record<Asset, number> = { NEAR: 24, USDC: 6, wNEAR: 24, JAMBO: 18, ETH: 18, SOL: 9 };

/** Solana base58 address -> the 64 lowercase hex chars of its implicit Intents account (A12). */
export function solToIntentsAccount(b58: string): string {
  const bytes = baseDecode(b58);
  if (bytes.length !== 32) throw new Error(`not a Solana address (decodes to ${bytes.length} bytes): ${b58}`);
  return Buffer.from(bytes).toString("hex");
}

export function normalizeEvm(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`not an EVM address: ${address}`);
  return address.toLowerCase();
}

export type Holder = { near?: string; evm?: { address: string; chain: "base" | "arb" }; sol?: string; intents?: string };

/** `team`, `bidder`, `relayer`, ... (NEAR accounts), `EVM-1`, `SOL-1`. Unset addresses resolve to an empty holder. */
export function resolveHolder(accounts: Accounts, name: string): Holder {
  if (accounts.near[name]) return { near: accounts.near[name], intents: accounts.near[name] };
  const e = accounts.evm[name];
  if (e) return e.address ? { evm: { address: e.address, chain: e.chain }, intents: e.address.toLowerCase() } : {};
  const s = accounts.sol[name];
  if (s) return s.address ? { sol: s.address, intents: s.intents_account ?? solToIntentsAccount(s.address) } : {};
  throw new Error(`unknown holder "${name}" (team-accounts.json has: ${[...Object.keys(accounts.near), ...Object.keys(accounts.evm), ...Object.keys(accounts.sol)].join(", ")})`);
}

/** null = the holder, account or address does not exist yet. */
export async function fetchBalance(network: Network, accounts: Accounts, r: Req): Promise<bigint | null> {
  const h = resolveHolder(accounts, r.holder);
  switch (r.venue) {
    case "near": {
      if (!h.near) return null;
      if (r.asset === "NEAR") return nearNative(network, h.near);
      const token = FT_TOKEN[r.asset];
      if (!token) throw new Error(`no NEAR fungible token for ${r.asset}`);
      return ftBalance(network, token, h.near);
    }
    case "intents": {
      if (!h.intents) return null;
      const token = INTENTS_TOKEN[r.asset];
      if (!token) throw new Error(`${r.asset} is not an Intents token here`);
      return (await intentsBalances(network, "intents.near", h.intents, [token]))[0] as bigint;
    }
    case "base":
    case "arb":
      if (!h.evm || h.evm.chain !== r.venue) return null;
      return r.asset === "ETH" ? evmNative(r.venue, h.evm.address) : evmUsdc(r.venue, h.evm.address);
    case "sol":
      if (!h.sol) return null;
      return r.asset === "SOL" ? solNative(h.sol) : solUsdc(h.sol);
  }
}

export interface ReqResult { req: Req; have: bigint | null; need: bigint; ok: boolean }
export interface TargetResult { id: string; label: string; status: "PASS" | "LOW"; detail: string; results: ReqResult[] }

const key = (r: Req) => `${r.holder}|${r.venue}|${r.asset}`;
const show = (r: Req, v: bigint) => `${fromUnits(v, DECIMALS[r.asset])} ${r.asset}`;

/** Pure: compares fetched balances with a target. A missing balance (null) is LOW. */
export function evaluate(t: Target, balances: Map<string, bigint | null>): TargetResult {
  const results: ReqResult[] = t.any.map((req) => {
    const have = balances.get(key(req)) ?? null;
    const need = toUnits(req.min, DECIMALS[req.asset]);
    return { req, have, need, ok: have !== null && have >= need };
  });
  const ok = results.some((x) => x.ok);
  const detail = results
    .map((x) => `${x.req.holder}@${x.req.venue} ${x.req.asset}: ${x.have === null ? "n/a (not created / address not set)" : `have ${show(x.req, x.have)}`}, need ${show(x.req, x.need)}`)
    .join("  OR  ");
  return { id: t.id, label: t.label, status: ok ? "PASS" : "LOW", detail, results };
}

export interface TopupLine { holder: string; recipient: string; deficit: bigint; amount: bigint; command: string }

/**
 * H-TOPUP (D4-21): recipients are Intents USDC rows (first alternative) that are LOW. The need of a holder is the sum of its
 * rows over the given checks. amount = deficit + 0.1 USDC, sent from the team account's NEAR-native USDC straight into the
 * recipient's Intents balance with ft_transfer_call (msg = recipient account). Prints, never sends.
 */
export function planTopup(
  checks: Target[][],
  balances: Map<string, bigint | null>,
  accounts: Accounts,
  network: Network,
): TopupLine[] {
  const need = new Map<string, bigint>();
  for (const targets of checks) {
    for (const t of targets) {
      const r = evaluate(t, balances);
      const first = t.any[0] as Req;
      if (r.status === "PASS" || first.venue !== "intents" || first.asset !== "USDC") continue;
      need.set(first.holder, (need.get(first.holder) ?? 0n) + toUnits(first.min, 6));
    }
  }
  const lines: TopupLine[] = [];
  for (const [holder, total] of need) {
    const have = balances.get(`${holder}|intents|USDC`) ?? 0n;
    const deficit = total > have ? total - have : 0n;
    if (deficit === 0n) continue;
    const amount = deficit + toUnits("0.1", 6);
    const recipient = resolveHolder(accounts, holder).intents;
    if (!recipient) {
      lines.push({ holder, recipient: "", deficit, amount, command: `# ${holder}: address not set in evidence/team-accounts.json, cannot top up` });
      continue;
    }
    const team = accounts.near.team as string;
    const command = nearCliLine({
      signer: team, receiver: USDC_NEAR, method: "ft_transfer_call",
      args: { receiver_id: "intents.near", amount: amount.toString(), msg: recipient },
      deposit: "1 yoctoNEAR", gasTgas: 100, network,
    });
    lines.push({ holder, recipient, deficit, amount, command });
  }
  return lines;
}

export function readAccounts(file = ACCOUNTS_FILE): Accounts {
  return JSON.parse(readFileSync(file, "utf8")) as Accounts;
}

export function readTargets(file = TARGETS_FILE): Targets {
  if (!existsSync(file)) throw new Error(`${file} not found (a local, gitignored file)`);
  const j = JSON.parse(readFileSync(file, "utf8")) as { checks?: Targets };
  if (!j.checks) throw new Error(`${file} has no "checks" object`);
  return j.checks;
}

/** `--add EVM-1 0xAbC...` or `--add SOL-1 <base58>`; writes evidence/team-accounts.json. */
export function addAddress(accounts: Accounts, name: string, address: string, nowIso = new Date().toISOString()): Accounts {
  const out: Accounts = structuredClone(accounts);
  if (out.evm[name]) out.evm[name].address = normalizeEvm(address);
  else if (out.sol[name]) {
    out.sol[name].address = address;
    out.sol[name].intents_account = solToIntentsAccount(address);
  } else throw new Error(`--add: unknown wallet "${name}" (EVM-1..3, SOL-1..2)`);
  out.updated_utc = nowIso;
  return out;
}

async function collect(network: Network, accounts: Accounts, reqs: Req[]): Promise<Map<string, bigint | null>> {
  const m = new Map<string, bigint | null>();
  for (const r of reqs) {
    if (m.has(key(r))) continue;
    try {
      m.set(key(r), await fetchBalance(network, accounts, r));
    } catch (e) {
      console.warn(`WARN ${r.holder}@${r.venue} ${r.asset}: ${(e as Error).message}`);
      m.set(key(r), null);
    }
  }
  return m;
}

function allRows(accounts: Accounts): Req[] {
  const rows: Req[] = [];
  for (const h of ["team", "bidder", "relayer"]) {
    for (const asset of ["NEAR", "USDC", "wNEAR"] as const) rows.push({ holder: h, venue: "near", asset, min: "0" });
    for (const asset of ["USDC", "wNEAR", "JAMBO"] as const) rows.push({ holder: h, venue: "intents", asset, min: "0" });
  }
  for (const [name, e] of Object.entries(accounts.evm)) {
    rows.push({ holder: name, venue: e.chain, asset: "ETH", min: "0" }, { holder: name, venue: e.chain, asset: "USDC", min: "0" }, { holder: name, venue: "intents", asset: "USDC", min: "0" });
  }
  for (const name of Object.keys(accounts.sol)) {
    rows.push({ holder: name, venue: "sol", asset: "SOL", min: "0" }, { holder: name, venue: "sol", asset: "USDC", min: "0" }, { holder: name, venue: "intents", asset: "USDC", min: "0" });
  }
  return rows;
}

const usage = `usage:
  tsx scripts/balances.ts [--check <R|twin|sale2|sale3|fund|topup>] [--json] [--network mainnet] [--targets <file>] [--for sale2,sale3]
  tsx scripts/balances.ts --add EVM-1 0x...      # or: --add SOL-1 <base58 address>   (updates evidence/team-accounts.json)`;

export async function main(argv: string[]): Promise<number> {
  const { common, values, positionals } = parseCommon(argv, {
    check: { type: "string" }, json: { type: "boolean" }, add: { type: "string" }, targets: { type: "string" }, for: { type: "string" },
  });
  const json = values.json === true;
  try {
    if (values.add !== undefined) {
      const address = positionals[0];
      if (!address) {
        console.error(usage);
        return 2;
      }
      const updated = addAddress(readAccounts(), values.add as string, address);
      writeFileSync(ACCOUNTS_FILE, JSON.stringify(updated, null, 2) + "\n");
      console.log(`${values.add}: ${address} (intents account ${resolveHolder(updated, values.add as string).intents})`);
      return 0;
    }
    const accounts = readAccounts();
    const check = values.check as string | undefined;
    if (!check) {
      const rows = allRows(accounts);
      const bal = await collect(common.network, accounts, rows);
      const out = rows.map((r) => {
        const v = bal.get(key(r)) ?? null;
        return { holder: r.holder, venue: r.venue, asset: r.asset, balance: v === null ? null : fromUnits(v, DECIMALS[r.asset]) };
      });
      if (json) console.log(JSON.stringify(out, null, 2));
      else {
        for (const o of out) {
          const nearHolder = accounts.near[o.holder];
          const state = o.balance !== null ? o.balance : o.venue === "near" && nearHolder && o.asset === "NEAR" ? "UNKNOWN_ACCOUNT" : "-";
          console.log(`${o.holder.padEnd(8)} ${o.venue.padEnd(8)} ${o.asset.padEnd(6)} ${state}`);
        }
      }
      return 0;
    }
    const targets = readTargets(values.targets as string | undefined);
    if (check === "topup") {
      const names = ((values.for as string | undefined) ?? "sale2,sale3").split(",");
      const lists = names.map((n) => targets[n] ?? (() => { throw new Error(`no "${n}" checks in the targets file`); })());
      const reqs = lists.flat().flatMap((t) => t.any);
      reqs.push({ holder: "team", venue: "near", asset: "USDC", min: "0" });
      const bal = await collect(common.network, accounts, reqs);
      const lines = planTopup(lists, bal, accounts, common.network);
      const sum = lines.reduce((s, l) => s + l.amount, 0n);
      const reserve = bal.get("team|near|USDC") ?? 0n;
      if (json) console.log(JSON.stringify({ lines: lines.map((l) => ({ ...l, deficit: l.deficit.toString(), amount: l.amount.toString() })), total: sum.toString(), reserve: reserve.toString() }, null, 2));
      else {
        if (!lines.length) console.log("topup: nothing is LOW, no H-TOPUP needed");
        for (const l of lines) console.log(l.recipient ? `# ${l.holder}: short by ${fromUnits(l.deficit, 6)} USDC, sending ${fromUnits(l.amount, 6)}\n${l.command}` : l.command);
        console.log(`${reserve >= sum ? "PASS" : "LOW "} team NEAR-native USDC ${fromUnits(reserve, 6)} (need ${fromUnits(sum, 6)} for the lines above)`);
      }
      return reserve >= sum ? 0 : 1;
    }
    const list = targets[check];
    if (!list) throw new Error(`no "${check}" checks in the targets file (have: ${Object.keys(targets).join(", ")})`);
    const bal = await collect(common.network, accounts, list.flatMap((t) => t.any));
    const results = list.map((t) => evaluate(t, bal));
    if (json) {
      console.log(JSON.stringify(results.map((r) => ({ id: r.id, status: r.status, detail: r.detail })), null, 2));
    } else {
      for (const r of results) console.log(`${r.status.padEnd(4)} ${r.label}  (${r.detail})`);
    }
    return results.every((r) => r.status === "PASS") ? 0 : 1;
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
