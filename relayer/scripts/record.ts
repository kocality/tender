import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseCommon } from "./lib/cli.js";
import {
  EVIDENCE_DIR, SALE_TAGS, STEPS, explorerUrl, upsertGateRow, upsertMainnetRow,
  type GateRow, type MainnetRow, type SaleTag, type Step,
} from "./lib/evidence.js";
import { blockHeight, decodeSuccessValue, txStatus, type Network } from "./lib/rpc.js";

const ONECLICK_STATUS = "https://1click.chaindefuser.com/v0/status";
const MPC: Record<Network, string> = { mainnet: "v1.signer", testnet: "v1.signer-prod.testnet" };
const INBOX = fileURLToPath(new URL("../../docs/internal/tx-inbox.md", import.meta.url));

const usage = `usage:
  tsx scripts/record.ts --sale <tag> --step <step> --tx <hash> --signer <account> [--network mainnet]
    [--expect failure] [--note "..."] [--chain base|arb|sol|near] [--contract <id>]
    [--oneclick <depositAddress>] [--origin-tx <hash>] [--dest-tx <hash>] [--save-result <file>] [--dry-run] [--rpc <url>]
  tsx scripts/record.ts gate --gate <name> --result PASS|ALT|FAIL --path "<chosen path>" [--tx <h1,h2> --signer <acct>] [--ckd] [--notes "..."] [--files a,b] [--network] [--dry-run]
  tsx scripts/record.ts inbox [--network mainnet] [--dry-run]   # records unmarked lines of docs/internal/tx-inbox.md`;

export interface RecordOpts {
  network: Network;
  sale: SaleTag;
  step: Step;
  txHash: string;
  signer: string;
  expect?: "success" | "failure";
  note?: string;
  chain?: MainnetRow["chain"];
  contract?: string;
  oneclick?: string;
  originTx?: string;
  destTx?: string;
  saveResult?: string;
  dryRun?: boolean;
  rpc?: string;
  evidenceDir?: string;
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function snapshotEnvelope(url: string, source: "rpc" | "archival", result: unknown) {
  return {
    _meta: { captured_utc: new Date().toISOString(), rpc_url: url, method: "EXPERIMENTAL_tx_status", label: "snapshot, not live", source },
    result,
  };
}

/** Pulls the CKD request/response out of a tx that called `request_app_private_key` (the shape WS2's `seal:try --try-key` reads). */
export function extractCkd(result: any, mpc: string) {
  const receipts: any[] = result?.receipts_outcome ?? [];
  let request: any;
  for (const r of receipts) {
    const logs: string[] = r?.outcome?.logs ?? [];
    if (r?.outcome?.executor_id === mpc && logs.some((l) => l.includes("request_app_private_key"))) {
      request = r;
      break;
    }
  }
  if (!request) return null;
  const logText = (request.outcome.logs as string[]).join("\n");
  const path = /derivation_path[:=]\s*"([^"]+)"/.exec(logText)?.[1];
  const caller = /predecessor[=:]\s*(?:AccountId\()?"([^"]+)"/.exec(logText)?.[1];
  const parse = (s: string | null) => {
    try {
      const v = s ? JSON.parse(s) : null;
      return v && typeof v.big_y === "string" && typeof v.big_c === "string" ? { big_y: v.big_y as string, big_c: v.big_c as string } : null;
    } catch {
      return null;
    }
  };
  let response = parse(decodeSuccessValue(result.status));
  let responseBlockHash: string | undefined;
  for (const r of receipts) {
    const v = parse(decodeSuccessValue(r?.outcome?.status));
    if (v) {
      response ??= v;
      responseBlockHash = r.block_hash;
      break;
    }
  }
  if (!path || !caller || !response || !responseBlockHash) return null;
  return { caller, path, response, requestBlockHash: request.block_hash as string, responseBlockHash };
}

async function saveTxSnapshot(o: { network: Network; txHash: string; signer: string; rpc?: string; dir: string; dryRun: boolean }) {
  const ts = await txStatus(o.network, o.txHash, o.signer, { rpc: o.rpc }).catch((e: Error) => {
    throw new Error(
      `${e.message}\n(EXPERIMENTAL_tx_status also answers UNKNOWN_TRANSACTION when --signer is not the tx signer, not only when the node window has passed; check --signer ${o.signer})`,
    );
  });
  const snapshot = `rpc/${o.txHash}.json`;
  if (!o.dryRun) writeJson(join(o.dir, snapshot), snapshotEnvelope(ts.url, ts.source, ts.result));
  return { ts, snapshot: `evidence/${snapshot}` };
}

export async function recordTx(o: RecordOpts): Promise<MainnetRow> {
  const dir = o.evidenceDir ?? EVIDENCE_DIR;
  const dryRun = o.dryRun === true;
  if (o.signer === o.txHash) throw new Error("--signer is the tx hash; pass the account that signed the transaction");
  const { ts, snapshot } = await saveTxSnapshot({ network: o.network, txHash: o.txHash, signer: o.signer, rpc: o.rpc, dir, dryRun });
  const r = ts.result;
  const notes: string[] = o.note ? [o.note] : [];
  const txSigner: string | undefined = r?.transaction?.signer_id;
  if (txSigner && txSigner !== o.signer) console.warn(`WARN --signer ${o.signer} differs from the transaction signer ${txSigner}; recording ${txSigner}`);
  if (o.rpc) notes.push("rpc override");

  const block = await blockHeight(o.network, r.transaction_outcome.block_hash, { rpc: o.rpc });
  const status = r?.status ?? {};
  const outcome: MainnetRow["outcome"] | undefined = "SuccessValue" in status ? "success" : "Failure" in status ? "failure" : undefined;
  if (!outcome) console.warn(`WARN transaction status is neither SuccessValue nor Failure: ${JSON.stringify(status).slice(0, 120)}`);
  if (o.expect && outcome && o.expect !== outcome) {
    const msg = `WARN expected ${o.expect} but got ${outcome}`;
    console.warn(msg);
    notes.push(msg);
  }

  const row: MainnetRow = {
    sale: o.sale,
    step: o.step,
    tx_hash: o.txHash,
    block,
    explorer_url: explorerUrl(o.network, o.txHash),
    network: o.network,
    signer_id: txSigner ?? o.signer,
    receiver_id: r?.transaction?.receiver_id,
  };
  if (o.contract) row.contract = o.contract;
  if (outcome) row.outcome = outcome;
  if (o.expect) row.expected = o.expect;
  if (o.chain) row.chain = o.chain;
  row.snapshot = snapshot;
  row.snapshot_source = ts.source;

  let originTx = o.originTx;
  let destTx = o.destTx;
  if (o.oneclick) {
    row.deposit_address = o.oneclick;
    try {
      const res = await fetch(`${ONECLICK_STATUS}?depositAddress=${encodeURIComponent(o.oneclick)}`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: any = await res.json();
      if (!dryRun) writeJson(join(dir, "oneclick", `${o.oneclick}.json`), body);
      if (typeof body?.status === "string") row.oneclick_status = body.status;
      const sd = body?.swapDetails;
      if (Array.isArray(sd?.nearTxHashes) && sd.nearTxHashes.length) row.near_tx_hashes = sd.nearTxHashes;
      originTx = sd?.originChainTxHashes?.[0]?.hash ?? originTx;
      destTx = sd?.destinationChainTxHashes?.[0]?.hash ?? destTx;
    } catch (e) {
      const msg = `WARN 1Click status fetch failed: ${(e as Error).message}`;
      console.warn(msg);
      notes.push(msg);
    }
  }
  if (originTx) row.origin_tx = originTx;
  if (destTx) row.destination_tx = destTx;

  if (o.saveResult) {
    const ckd = extractCkd(r, MPC[o.network]);
    if (!ckd) throw new Error(`--save-result: no ${MPC[o.network]} request_app_private_key receipt with a {big_y, big_c} response in ${o.txHash}`);
    const out = {
      gate: "M15",
      network: o.network,
      mpc: MPC[o.network],
      caller: ckd.caller,
      path: ckd.path,
      response: ckd.response,
      tx_hash: o.txHash,
      blocks: {
        tx: block,
        request: await blockHeight(o.network, ckd.requestBlockHash, { rpc: o.rpc }),
        response: await blockHeight(o.network, ckd.responseBlockHash, { rpc: o.rpc }),
      },
    };
    if (dryRun) console.log(`(dry-run) would write ${o.saveResult}:\n${JSON.stringify(out, null, 2)}`);
    else writeJson(o.saveResult, out);
  }

  if (notes.length) row.note = notes.join("; ");
  row.recorded_utc = new Date().toISOString();

  if (dryRun) console.log(JSON.stringify(row, null, 2));
  else console.log(`${upsertMainnetRow(join(dir, "mainnet.json"), row)} ${row.sale}/${row.step} ${row.tx_hash} block=${row.block} outcome=${row.outcome} source=${row.snapshot_source}`);
  return row;
}

export interface GateOpts {
  network: Network;
  gate: string;
  result: GateRow["result"];
  path: string;
  txs: string[];
  signer?: string;
  ckd?: boolean;
  notes?: string;
  files?: string[];
  dryRun?: boolean;
  rpc?: string;
  evidenceDir?: string;
}

export async function recordGate(o: GateOpts): Promise<GateRow> {
  const dir = o.evidenceDir ?? EVIDENCE_DIR;
  const dryRun = o.dryRun === true;
  if (o.txs.length && !o.signer) throw new Error("gate with --tx needs --signer (EXPERIMENTAL_tx_status requires the sender)");
  const files = [...(o.files ?? [])];
  const blocks: GateRow["blocks"] = {};
  for (const txHash of o.txs) {
    const { ts, snapshot } = await saveTxSnapshot({ network: o.network, txHash, signer: o.signer as string, rpc: o.rpc, dir, dryRun });
    files.push(snapshot);
    if (o.ckd && blocks.request === undefined) {
      const ckd = extractCkd(ts.result, MPC[o.network]);
      if (ckd) {
        blocks.request = await blockHeight(o.network, ckd.requestBlockHash, { rpc: o.rpc });
        blocks.response = await blockHeight(o.network, ckd.responseBlockHash, { rpc: o.rpc });
      } else console.warn(`WARN --ckd: no CKD request/response found in ${txHash}`);
    }
  }
  const row: GateRow = {
    gate: o.gate,
    date_utc: new Date().toISOString(),
    result: o.result,
    chosen_path: o.path,
    tx_hashes: o.txs,
    blocks,
    notes: o.notes ?? "",
  };
  if (files.length) row.evidence_files = files;
  if (dryRun) console.log(JSON.stringify(row, null, 2));
  else console.log(`${upsertGateRow(join(dir, "spikes.json"), row)} gate ${row.gate} ${row.result}`);
  return row;
}

const INBOX_LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.*)$/;

/** D4-06: records every unmarked `<UTC> | <sale> | <step> | <tx_hash> | <signer_id> | <note>` line, then appends " → recorded". */
export async function recordInbox(o: { network: Network; dryRun?: boolean; rpc?: string; inboxFile?: string; evidenceDir?: string }): Promise<number> {
  const file = o.inboxFile ?? INBOX;
  if (!existsSync(file)) throw new Error(`${file} does not exist`);
  const lines = readFileSync(file, "utf8").split("\n");
  let failed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = INBOX_LINE.exec(line);
    if (!m || line.trimEnd().endsWith("→ recorded")) continue;
    const [, , sale, step, txHash, signer, note] = m as unknown as string[];
    try {
      if (!(SALE_TAGS as readonly string[]).includes(sale as string)) throw new Error(`unknown sale tag "${sale}"`);
      if (!(STEPS as readonly string[]).includes(step as string)) throw new Error(`unknown step "${step}"`);
      await recordTx({
        network: o.network, sale: sale as SaleTag, step: step as Step, txHash: txHash as string, signer: signer as string,
        note: note || undefined, expect: /expected failure/i.test(note ?? "") ? "failure" : undefined,
        dryRun: o.dryRun, rpc: o.rpc, evidenceDir: o.evidenceDir,
      });
      lines[i] = `${line.trimEnd()} → recorded`;
    } catch (e) {
      failed++;
      console.error(`inbox line ${i + 1} not recorded: ${(e as Error).message}`);
    }
  }
  if (!o.dryRun) writeFileSync(file, lines.join("\n"));
  return failed;
}

export async function main(argv: string[]): Promise<number> {
  const { common, values, positionals } = parseCommon(argv, {
    sale: { type: "string" }, step: { type: "string" }, tx: { type: "string" }, signer: { type: "string" },
    expect: { type: "string" }, note: { type: "string" }, chain: { type: "string" }, oneclick: { type: "string" },
    "origin-tx": { type: "string" }, "dest-tx": { type: "string" }, "save-result": { type: "string" },
    gate: { type: "string" }, result: { type: "string" }, path: { type: "string" }, ckd: { type: "boolean" },
    notes: { type: "string" }, files: { type: "string" },
  });
  const str = (k: string) => values[k] as string | undefined;
  // record is not a value-moving script: it writes by default, `--dry-run` only prints
  const dryRun = common.dryRunFlag;
  const sub = positionals[0];
  try {
    if (sub === "inbox") return (await recordInbox({ network: common.network, dryRun, rpc: common.rpc })) ? 1 : 0;
    if (sub === "gate") {
      const result = str("result");
      if (!str("gate") || !result || !["PASS", "ALT", "FAIL"].includes(result) || str("path") === undefined) {
        console.error(usage);
        return 2;
      }
      await recordGate({
        network: common.network, gate: str("gate") as string, result: result as GateRow["result"], path: str("path") as string,
        txs: (str("tx") ?? "").split(",").filter(Boolean), signer: str("signer"), ckd: values.ckd === true, notes: str("notes"),
        files: str("files")?.split(",").filter(Boolean), dryRun, rpc: common.rpc,
      });
      return 0;
    }
    const sale = str("sale");
    const step = str("step");
    if (!sale || !step || !str("tx") || !str("signer")) {
      console.error(usage);
      return 2;
    }
    if (!(SALE_TAGS as readonly string[]).includes(sale)) throw new Error(`--sale must be one of ${SALE_TAGS.join("|")}`);
    if (!(STEPS as readonly string[]).includes(step)) throw new Error(`--step must be one of ${STEPS.join("|")}`);
    const expect = str("expect");
    if (expect !== undefined && expect !== "success" && expect !== "failure") throw new Error("--expect must be success or failure");
    const chain = str("chain");
    if (chain !== undefined && !["base", "arb", "sol", "near"].includes(chain)) throw new Error("--chain must be base|arb|sol|near");
    await recordTx({
      network: common.network, sale: sale as SaleTag, step: step as Step, txHash: str("tx") as string, signer: str("signer") as string,
      expect, note: str("note"), chain: chain as MainnetRow["chain"], contract: values.contract as string | undefined,
      oneclick: str("oneclick"), originTx: str("origin-tx"), destTx: str("dest-tx"), saveResult: str("save-result"),
      dryRun, rpc: common.rpc,
    });
    return 0;
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
