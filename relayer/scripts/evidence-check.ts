import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCommon } from "./lib/cli.js";
import { EVIDENCE_DIR, txOutcome, validateMainnetRow, type MainnetRow, type SaleTag, type Step } from "./lib/evidence.js";
import { txStatus, type Network } from "./lib/rpc.js";

// Which mainnet rows each sale must have by the end (step order is the order of the runbooks).
export const EXPECTED: Record<SaleTag, Step[]> = {
  lock: ["birth"],
  R: ["birth", "create", "bid", "bid", "open", "reveal", "finalize", "withdraw", "delete"],
  "0": ["create", "bid", "attack-early-open" /* open(0) panic */, "cancel"],
  "1": ["create", "bid", "bid", "bid", "bid", "bid", "bid", "open", "reveal", "finalize", "withdraw", "withdraw"],
  "2": ["create", "bid", "bid", "attack-early-open", "attack-eoa-ckd"],
  "3": ["create", "bid", "bid", "bid", "open", "attack-wrong-cm", "reveal", "attack-late", "finalize"],
  spike: [],
  // team account and ops steps recorded so far: tenderseal.near, bidder and relayer birth (3), USDC storage (wNEAR swap legs: 2), 1Click and swap funding (5), swap, bidder key, relayer key, spike delete
  ops: ["birth", "birth", "birth", "storage", "storage", "fund", "fund", "fund", "fund", "fund", "swap", "add-public-key", "key-add", "delete"],
};

// Earliest UTC at which each EXPECTED slot can exist (same index as EXPECTED). `--until <UTC>` counts only slots due by then.
// Times follow the runbooks: R Thu 11-12 02:00-05:00Z, lock 08:00Z, twin Fri 11-13 01:45-06:00Z, #2 07:00Z, #3 07:30-10:30Z, FIN3 Sat ~10:05Z.
export const DUE: Record<SaleTag, string[]> = {
  lock: ["2026-11-12T08:30:00Z"],
  R: ["2026-11-12T03:00:00Z", "2026-11-12T03:00:00Z", "2026-11-12T03:30:00Z", "2026-11-12T03:30:00Z", "2026-11-12T04:00:00Z", "2026-11-12T04:00:00Z", "2026-11-12T04:30:00Z", "2026-11-12T05:00:00Z", "2026-11-12T05:00:00Z"],
  "0": ["2026-11-13T02:00:00Z", "2026-11-13T04:00:00Z", "2026-11-13T04:30:00Z", "2026-11-13T04:30:00Z"],
  "1": ["2026-11-13T02:00:00Z", "2026-11-13T04:00:00Z", "2026-11-13T04:00:00Z", "2026-11-13T04:00:00Z", "2026-11-13T04:00:00Z", "2026-11-13T04:00:00Z", "2026-11-13T04:30:00Z", "2026-11-13T05:00:00Z", "2026-11-13T05:30:00Z", "2026-11-13T06:00:00Z", "2026-11-13T06:00:00Z", "2026-11-13T06:00:00Z"],
  "2": ["2026-11-13T07:30:00Z", "2026-11-13T08:00:00Z", "2026-11-13T08:00:00Z", "2026-11-13T09:45:00Z", "2026-11-13T09:45:00Z"],
  "3": ["2026-11-13T08:00:00Z", "2026-11-13T09:00:00Z", "2026-11-13T09:00:00Z", "2026-11-13T09:00:00Z", "2026-11-13T10:30:00Z", "2026-11-13T10:30:00Z", "2026-11-13T10:30:00Z", "2026-11-13T10:30:00Z", "2026-11-14T10:30:00Z"],
  spike: [],
  ops: Array(14).fill("2026-11-11T02:00:00Z"),
};

export interface CheckResult { rows: number; missing: string[]; problems: string[] }
export type Lookup = (row: MainnetRow) => Promise<"success" | "failure" | null>;

const SECRET_KEY_FIELD = /"(private_key|secret_key|seed_phrase|mnemonic)"\s*:/;
const ED25519_SECRET = /ed25519:[1-9A-HJ-NP-Za-km-z]{85,90}\b/;
const SIGNATURE_LINE = /"signature"\s*:\s*"ed25519:/; // a transaction signature has the same shape as a secret key

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Secret-looking content anywhere under evidence/. Returns "file:line what" problems. */
export function scanSecrets(dir: string): string[] {
  const out: string[] = [];
  for (const file of walk(dir)) {
    if (!/\.(json|md|txt)$/.test(file)) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      const where = `${relative(dir, file)}:${i + 1}`;
      if (SECRET_KEY_FIELD.test(line)) out.push(`${where} contains a private_key / secret_key / seed_phrase field`);
      else if (ED25519_SECRET.test(line) && !SIGNATURE_LINE.test(line)) out.push(`${where} contains an ed25519 secret key shape`);
    });
  }
  return out;
}

function liveLookup(network: Network): Lookup {
  return async (row) => {
    const signer = row.signer_id;
    if (!signer) return null;
    const { result } = await txStatus(network, row.tx_hash, signer);
    return txOutcome(result).outcome ?? null;
  };
}

export async function checkEvidence(opts: {
  network?: Network; offline: boolean; until?: Date; evidenceDir?: string; lookup?: Lookup;
}): Promise<CheckResult> {
  const dir = opts.evidenceDir ?? EVIDENCE_DIR;
  const network = opts.network ?? "mainnet";
  const problems: string[] = [];
  const file = join(dir, "mainnet.json");
  const rows: MainnetRow[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  const lookup = opts.lookup ?? liveLookup(network);

  for (const [i, row] of rows.entries()) {
    const tag = `row ${i + 1} ${row?.sale}/${row?.step} ${String(row?.tx_hash).slice(0, 8)}…`;
    const bad = validateMainnetRow(row);
    for (const b of bad) problems.push(`${tag}: ${b}`);
    if (bad.length) continue;
    if (row.network === "testnet") problems.push(`${tag}: a testnet row in mainnet.json`);

    const snap = join(dir, "rpc", `${row.tx_hash}.json`);
    if (!existsSync(snap)) problems.push(`${tag}: evidence/rpc/${row.tx_hash}.json is missing`);
    else {
      try {
        if (JSON.parse(readFileSync(snap, "utf8"))?._meta?.label !== "snapshot, not live") problems.push(`${tag}: snapshot lacks _meta.label "snapshot, not live"`);
      } catch {
        problems.push(`${tag}: evidence/rpc/${row.tx_hash}.json is not valid JSON`);
      }
    }
    if (row.expected === "failure" && row.outcome !== "failure") problems.push(`${tag}: expected a failing transaction but the recorded outcome is ${row.outcome ?? "none"}`);

    // cross-chain rows (1Click): both legs and the status file
    const crossChain = (row.step === "deposit" || row.step === "withdraw") && (row.chain === "base" || row.chain === "arb" || row.chain === "sol" || row.deposit_address !== undefined);
    if (crossChain) {
      if (!row.origin_tx) problems.push(`${tag}: origin_tx is empty`);
      if (!row.deposit_address) problems.push(`${tag}: deposit_address is empty`);
      if (!row.near_tx_hashes?.length) problems.push(`${tag}: near_tx_hashes is empty`);
      if (!row.destination_tx) problems.push(`${tag}: destination_tx is empty (1Click status must be SUCCESS first)`);
      if (row.deposit_address && !existsSync(join(dir, "oneclick", `${row.deposit_address}.json`))) problems.push(`${tag}: evidence/oneclick/${row.deposit_address}.json is missing`);
    }

    if (!opts.offline) {
      try {
        const live = await lookup(row);
        if (live === null) problems.push(`${tag}: transaction not found on any RPC (window passed? use record.ts, it falls back to archival)`);
        else if (row.outcome && live !== row.outcome) problems.push(`${tag}: recorded outcome ${row.outcome} but the chain says ${live}`);
      } catch (e) {
        problems.push(`${tag}: RPC lookup failed: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  }

  // expected multiplicity, limited to slots due by --until
  const missing: string[] = [];
  for (const sale of Object.keys(EXPECTED) as SaleTag[]) {
    const want = new Map<Step, number>();
    EXPECTED[sale].forEach((step, i) => {
      if (opts.until && Date.parse(DUE[sale][i] as string) > opts.until.getTime()) return;
      want.set(step, (want.get(step) ?? 0) + 1);
    });
    for (const [step, n] of want) {
      // a row fills its slot only when the chain did what the runbook expected (a refunded bid is not a bid, S-05)
      const have = rows.filter((r) => r.sale === sale && r.step === step && (r.outcome ?? "success") === (r.expected ?? "success")).length;
      if (have < n) missing.push(`MISSING ${sale}/${step} ×${n - have}`);
    }
  }
  problems.push(...scanSecrets(dir).map((s) => `secret scan: ${s}`));
  return { rows: rows.length, missing, problems };
}

export async function main(argv: string[]): Promise<number> {
  const { common, values } = parseCommon(argv, { offline: { type: "boolean" }, until: { type: "string" } });
  let until: Date | undefined;
  if (values.until !== undefined) {
    until = new Date(values.until as string);
    if (Number.isNaN(until.getTime())) {
      console.error(`error: --until must be a UTC timestamp such as 2026-11-14T04:00:00Z`);
      return 2;
    }
  }
  const r = await checkEvidence({ network: common.network, offline: values.offline === true, until });
  for (const m of r.missing) console.log(m);
  for (const p of r.problems) console.log(`PROBLEM ${p}`);
  console.log(`evidence: ${r.rows} rows · ${r.missing.length} missing · ${r.problems.length} problems`);
  return r.missing.length === 0 && r.problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
