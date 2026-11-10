import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCommon } from "./lib/cli.js";
import { EVIDENCE_DIR } from "./lib/evidence.js";
import { rpcCall, view, type Network } from "./lib/rpc.js";

const usage = "usage: tsx scripts/snapshot.ts --target <v1|rehearsal|spike> --sale <id> [--network mainnet|testnet] [--contract <id>] [--rpc <url>]";
const NO_METHOD = /MethodNotFound|MethodResolveError/;

function targetContract(target: string): string {
  const team = process.env.TENDER_TEAM_ACCOUNT_ID ?? "tenderseal.near";
  if (target === "v1" || target === "rehearsal" || target === "spike") return `${target}.${team}`;
  throw new Error(`--target must be v1, rehearsal or spike, got "${target}"`);
}

export async function snapshot(o: { network: Network; contract: string; sale: string; rpc?: string; evidenceDir?: string }) {
  const intentsId = process.env.INTENTS_CONTRACT_ID ?? "intents.near";
  // one block for every read
  const { result: block } = await rpcCall<{ header: { height: number; hash: string } }>(o.network, "block", { finality: "final" }, { rpc: o.rpc });
  const blockId = block.header.height;
  const at = { blockId, rpc: o.rpc };
  const read = async <T>(method: string, args: object): Promise<T | null> => {
    try {
      return await view<T>(o.network, o.contract, method, args, at);
    } catch (e) {
      if (NO_METHOD.test((e as Error).message)) return null; // the view does not exist (yet)
      throw e;
    }
  };
  const query = async (request: object) => {
    const { result, url } = await rpcCall<any>(o.network, "query", { ...request, block_id: blockId }, { rpc: o.rpc });
    return { result, url };
  };

  const get_config = await read("get_config", {});
  const get_sale = await read<any>("get_sale", { id: o.sale });
  const get_bids: unknown[] = [];
  for (let from = 0; ; from += 64) {
    const page = (await read<unknown[]>("get_bids", { id: o.sale, from, limit: 64 })) ?? [];
    get_bids.push(...page);
    if (page.length < 64) break;
  }
  const get_result = await read("get_result", { id: o.sale });
  const get_key_log: unknown[] = [];
  for (let from = 0; ; from += 100) {
    const page = (await read<unknown[]>("get_key_log", { from: String(from), limit: 100 })) ?? [];
    get_key_log.push(...page);
    if (page.length < 100) break;
  }
  const keys = await query({ request_type: "view_access_key_list", account_id: o.contract });
  const account = await query({ request_type: "view_account", account_id: o.contract });
  let mt_batch_balance_of: unknown = null;
  if (get_sale?.quote_token && get_sale?.token) {
    mt_batch_balance_of = await view(o.network, intentsId, "mt_batch_balance_of", { account_id: o.contract, token_ids: [get_sale.quote_token, get_sale.token] }, at);
  }

  const now = new Date();
  const hhmm = now.toISOString().slice(0, 16).replace(/[-:]/g, "") + "Z"; // YYYYMMDDTHHMMZ
  const out = {
    _meta: { captured_utc: now.toISOString(), block_height: blockId, block_hash: block.header.hash, rpc_url: keys.url, label: "snapshot, not live" },
    get_config, get_sale, get_bids, get_result, get_key_log,
    view_access_key_list: keys.result,
    view_account: account.result,
    mt_batch_balance_of,
  };
  const dir = join(o.evidenceDir ?? EVIDENCE_DIR, "state");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${o.contract}-sale${o.sale}-${hhmm}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  return { file, out };
}

export async function main(argv: string[]): Promise<number> {
  const { common, values } = parseCommon(argv, { target: { type: "string" }, sale: { type: "string" } });
  const target = values.target as string | undefined;
  const sale = values.sale as string | undefined;
  if (!sale || (!target && !values.contract)) {
    console.error(usage);
    return 2;
  }
  try {
    const contract = (values.contract as string | undefined) ?? targetContract(target as string);
    const { file, out } = await snapshot({ network: common.network, contract, sale, rpc: common.rpc });
    console.log(`wrote ${file} (block ${out._meta.block_height}, bids ${out.get_bids.length}, key_log ${out.get_key_log.length})`);
    return 0;
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
