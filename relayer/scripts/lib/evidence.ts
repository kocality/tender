import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const EVIDENCE_DIR = fileURLToPath(new URL("../../../evidence/", import.meta.url));

export const SALE_TAGS = ["R", "0", "1", "2", "3", "lock", "spike", "ops"] as const;
export type SaleTag = (typeof SALE_TAGS)[number];

export const STEPS = [
  "birth", "create", "fund", "deposit", "bid", "open", "cancel", "reveal", "self-reveal",
  "finalize", "payout", "withdraw", "swap", "add-public-key", "storage", "delete", "key-add",
  "attack-garbage", "attack-copy", "attack-late", "attack-wrong-cm", "attack-early-open", "attack-eoa-ckd",
] as const;
export type Step = (typeof STEPS)[number];

export interface MainnetRow {
  // M18 required fields first
  sale: SaleTag;
  step: Step;
  tx_hash: string;
  block: number;
  explorer_url: string;
  origin_tx?: string;
  deposit_address?: string;
  near_tx_hashes?: string[];
  destination_tx?: string;
  network?: "mainnet" | "testnet";
  signer_id?: string;
  receiver_id?: string;
  contract?: string;
  outcome?: "success" | "failure";
  expected?: "success" | "failure";
  reason?: string;
  chain?: "base" | "arb" | "sol" | "near";
  snapshot?: string;
  snapshot_source?: "rpc" | "archival";
  oneclick_status?: string;
  recorded_utc?: string;
  note?: string;
}

export interface GateRow {
  // G11
  gate: string;
  date_utc: string;
  result: "PASS" | "ALT" | "FAIL";
  chosen_path: string;
  tx_hashes: string[];
  blocks: { request?: number; response?: number };
  notes: string;
  evidence_files?: string[];
}

const BASE58_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const isObj = (r: unknown): r is Record<string, unknown> => typeof r === "object" && r !== null && !Array.isArray(r);

function checkEnum(o: Record<string, unknown>, key: string, allowed: readonly string[], problems: string[], required = false) {
  const v = o[key];
  if (v === undefined) {
    if (required) problems.push(`${key} is missing`);
    return;
  }
  if (typeof v !== "string" || !allowed.includes(v)) problems.push(`${key} must be one of ${allowed.join("|")}, got ${JSON.stringify(v)}`);
}

function checkString(o: Record<string, unknown>, key: string, problems: string[], required = false) {
  const v = o[key];
  if (v === undefined) {
    if (required) problems.push(`${key} is missing`);
    return;
  }
  if (typeof v !== "string" || v === "") problems.push(`${key} must be a non-empty string`);
}

export function validateMainnetRow(r: unknown): string[] {
  if (!isObj(r)) return ["row is not an object"];
  const p: string[] = [];
  checkEnum(r, "sale", SALE_TAGS, p, true);
  checkEnum(r, "step", STEPS, p, true);
  if (r.tx_hash === undefined) p.push("tx_hash is missing");
  else if (typeof r.tx_hash !== "string" || !BASE58_HASH.test(r.tx_hash)) p.push("tx_hash must be a base58 transaction hash");
  if (r.block === undefined) p.push("block is missing");
  else if (typeof r.block !== "number" || !Number.isInteger(r.block) || r.block < 0) p.push("block must be a non-negative integer");
  if (r.explorer_url === undefined) p.push("explorer_url is missing");
  else if (typeof r.explorer_url !== "string" || !r.explorer_url.startsWith("https://")) p.push("explorer_url must be an https URL");
  for (const k of ["origin_tx", "deposit_address", "destination_tx", "signer_id", "receiver_id", "contract", "reason", "snapshot", "oneclick_status", "recorded_utc", "note"]) checkString(r, k, p);
  checkEnum(r, "network", ["mainnet", "testnet"], p);
  checkEnum(r, "outcome", ["success", "failure"], p);
  checkEnum(r, "expected", ["success", "failure"], p);
  checkEnum(r, "chain", ["base", "arb", "sol", "near"], p);
  checkEnum(r, "snapshot_source", ["rpc", "archival"], p);
  if (r.near_tx_hashes !== undefined && (!Array.isArray(r.near_tx_hashes) || r.near_tx_hashes.some((h) => typeof h !== "string"))) {
    p.push("near_tx_hashes must be an array of strings");
  }
  return p;
}

export function validateGateRow(r: unknown): string[] {
  if (!isObj(r)) return ["row is not an object"];
  const p: string[] = [];
  checkString(r, "gate", p, true);
  if (typeof r.date_utc !== "string" || Number.isNaN(Date.parse(r.date_utc))) p.push("date_utc must be an ISO date string");
  checkEnum(r, "result", ["PASS", "ALT", "FAIL"], p, true);
  if (typeof r.chosen_path !== "string") p.push("chosen_path must be a string");
  if (!Array.isArray(r.tx_hashes) || r.tx_hashes.some((h) => typeof h !== "string")) p.push("tx_hashes must be an array of strings");
  if (!isObj(r.blocks)) p.push("blocks must be an object");
  else for (const k of ["request", "response"]) {
    const v = r.blocks[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v))) p.push(`blocks.${k} must be an integer`);
  }
  if (typeof r.notes !== "string") p.push("notes must be a string");
  if (r.evidence_files !== undefined && (!Array.isArray(r.evidence_files) || r.evidence_files.some((f) => typeof f !== "string"))) {
    p.push("evidence_files must be an array of strings");
  }
  return p;
}

/** Tender NEP-297 events in the receipt logs of an EXPERIMENTAL_tx_status result. */
export function tenderEvents(result: unknown): { event: string; data: Record<string, unknown> }[] {
  const ros = (result as { receipts_outcome?: { outcome?: { logs?: string[] } }[] } | null)?.receipts_outcome ?? [];
  const out: { event: string; data: Record<string, unknown> }[] = [];
  for (const line of ros.flatMap((ro) => ro.outcome?.logs ?? [])) {
    if (!line.startsWith("EVENT_JSON:")) continue;
    try {
      const e = JSON.parse(line.slice("EVENT_JSON:".length)) as { standard?: string; event?: string; data?: Record<string, unknown>[] };
      if (e.standard === "tender" && typeof e.event === "string") out.push({ event: e.event, data: e.data?.[0] ?? {} });
    } catch {
      // not ours
    }
  }
  return out;
}

/**
 * The outcome of a recorded transaction (S-05). The top-level status is not enough: execute_intents and mt_transfer_call
 * succeed when Tender refuses the op (it returns the amount and logs a `refund` event), and finalize / cancel succeed
 * when a detached payout fails (a `payout` event with ok false). Those are failures, with the reason in `why`.
 */
export function txOutcome(result: unknown): { outcome?: "success" | "failure"; why?: string } {
  const status = (result as { status?: Record<string, unknown> } | null)?.status ?? {};
  if ("Failure" in status) return { outcome: "failure" };
  if (!("SuccessValue" in status)) return {};
  const events = tenderEvents(result);
  const refund = events.find((e) => e.event === "refund");
  if (refund) return { outcome: "failure", why: `Tender refunded it: ${String(refund.data.reason ?? "no reason logged")}` };
  const failed = events.filter((e) => e.event === "payout" && e.data.ok === false).map((e) => String(e.data.idx));
  if (failed.length) return { outcome: "failure", why: `payout failed for item(s) ${failed.join(", ")}` };
  return { outcome: "success" };
}

export function explorerUrl(network: "mainnet" | "testnet", hash: string): string {
  return network === "mainnet" ? `https://nearblocks.io/txns/${hash}` : `https://testnet.nearblocks.io/txns/${hash}`;
}

function readRows(file: string): unknown[] {
  if (!existsSync(file)) return [];
  const rows: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(rows)) throw new Error(`${file} is not a JSON array`);
  return rows;
}

function writeRows(file: string, rows: unknown[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(rows, null, 2) + "\n");
}

function upsert(file: string, row: unknown, same: (existing: unknown) => boolean): "added" | "updated" {
  const rows = readRows(file);
  const i = rows.findIndex(same);
  if (i >= 0) rows[i] = row;
  else rows.push(row);
  writeRows(file, rows);
  return i >= 0 ? "updated" : "added";
}

// key = tx_hash + step
export function upsertMainnetRow(file: string, row: MainnetRow): "added" | "updated" {
  const problems = validateMainnetRow(row);
  if (problems.length) throw new Error(`invalid mainnet row: ${problems.join("; ")}`);
  return upsert(file, row, (e) => isObj(e) && e.tx_hash === row.tx_hash && e.step === row.step);
}

// key = gate
export function upsertGateRow(file: string, row: GateRow): "added" | "updated" {
  const problems = validateGateRow(row);
  if (problems.length) throw new Error(`invalid gate row: ${problems.join("; ")}`);
  return upsert(file, row, (e) => isObj(e) && e.gate === row.gate);
}
