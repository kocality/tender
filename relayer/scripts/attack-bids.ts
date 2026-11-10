import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { APP_PK_JSON, type AppPkMode } from "@tender/seal";
import { bidsDir as defaultBidsDir, consoleIo, writeBidFile, type Io } from "./lib/bidfiles.js";
import { formatDryRunStep, parseCommon, type CallStep, type Common } from "./lib/cli.js";
import { getBids, getConfig, getSale, type BidView, type ConfigView, type SaleView } from "./lib/views.js";
import { toUnits } from "./lib/units.js";

// Builds the inputs of the attack room. Nothing here sends a transaction: bid files go to the app's paste panel,
// the other attacks print the near-cli command for a human to run.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MODES: readonly AppPkMode[] = ["identity", "generator", "plain"];
const ORIGIN_RE = /^[\x21-\x7e]{1,8}$/;
const MIN_BID = 1_000_000n;

const usage = `usage:
  tsx scripts/attack-bids.ts garbage    --sale N --escrow <USDC> --origin <base|arb|sol|near>     # random 160 B ct, random cm
  tsx scripts/attack-bids.ts copy       --sale N --from-idx I --escrow <USDC> --origin <origin>   # ct and cm of bid I, verbatim
  tsx scripts/attack-bids.ts wrong-cm   --sale N --idx I --sealed <seal:bid json> [--signer <id>]  # reveal with salt[0] ^= 1
  tsx scripts/attack-bids.ts early-open --sale N [--signer <id>]                                   # open before close
  tsx scripts/attack-bids.ts eoa-ckd    --sale N [--mode identity|generator|plain] [--init <file>] [--signer <id>]
  common: [--network mainnet|testnet] [--contract <id>]. Nothing is sent.`;

export interface AttackEnv {
  config(): Promise<ConfigView>;
  sale(id: string): Promise<SaleView | null>;
  bids(id: string): Promise<BidView[]>;
}

export interface AttackDeps {
  env?: (c: Common) => AttackEnv;
  io?: Io;
  bidsDir?: string;
  salesDir?: string;
}

function liveEnv(c: Common): AttackEnv {
  return {
    config: () => getConfig(c.network, c.contract, c.rpc),
    sale: (id) => getSale(c.network, c.contract, id, c.rpc),
    bids: (id) => getBids(c.network, c.contract, id, c.rpc),
  };
}

/** Pure. Random ciphertext (160 B, base64 standard padded) and commitment (32 B hex) that no key can open. */
export function garbageBid(sale: string, escrow: bigint, origin: string) {
  return { sale, ct: randomBytes(160).toString("base64"), cm: randomBytes(32).toString("hex"), escrow: escrow.toString(), origin };
}

/** Pure. Another bidder's ciphertext and commitment, byte for byte: it decrypts but the commitment names the first bidder. */
export function copyBid(sale: string, source: BidView, escrow: bigint, origin: string) {
  return { sale, ct: source.ct, cm: source.cm, escrow: escrow.toString(), origin };
}

/** Pure. The salt with the lowest bit of its first byte flipped; the commitment is deliberately not recomputed. */
export function flipSalt(saltHex: string): string {
  if (!/^[0-9a-fA-F]{32}$/.test(saltHex)) throw new Error("salt must be 32 hex characters");
  const first = (parseInt(saltHex.slice(0, 2), 16) ^ 0x01).toString(16).padStart(2, "0");
  return (first + saltHex.slice(2)).toLowerCase();
}

export function revealStep(o: { signer: string; contract: string; sale: string; idx: number; p: string; q: string; salt: string; network: CallStep["network"] }): CallStep {
  return {
    signer: o.signer, receiver: o.contract, method: "reveal",
    args: { sale: o.sale, items: [{ idx: o.idx, p: o.p, q: o.q, salt: o.salt }] },
    deposit: "0 NEAR", gasTgas: 100, network: o.network,
  };
}

export function openStep(o: { signer: string; contract: string; sale: string; network: CallStep["network"] }): CallStep {
  return { signer: o.signer, receiver: o.contract, method: "open", args: { sale: o.sale }, deposit: "0 NEAR", gasTgas: 100, network: o.network };
}

/** The `request_app_private_key` call an EOA (not the Tender contract) makes with the sale's path. */
export function eoaCkdStep(o: { signer: string; mpc: string; path: string; mode: AppPkMode; domainId: number; network: CallStep["network"] }): CallStep {
  return {
    signer: o.signer, receiver: o.mpc, method: "request_app_private_key",
    args: { request: { derivation_path: o.path, app_public_key: APP_PK_JSON[o.mode], domain_id: o.domainId } },
    deposit: "1 yoctoNEAR", gasTgas: 50, network: o.network,
  };
}

/** The mode comes from the init file; --mode and the deployed contract's `app_pk_mode` must agree with it when they are known. */
export function resolveMode(sources: { file?: string; flag?: string; chain?: string }): AppPkMode {
  const known = Object.entries(sources).filter((e): e is [string, string] => typeof e[1] === "string" && (MODES as readonly string[]).includes(e[1]));
  const bad = Object.entries(sources).find(([k, v]) => k === "flag" && v !== undefined && !(MODES as readonly string[]).includes(v));
  if (bad) throw new Error(`--mode must be one of ${MODES.join("|")}`);
  if (known.length === 0) throw new Error("app_pk_mode is not decided yet (init file holds a placeholder): pass --mode once the mode is decided");
  const first = known[0] as [string, string];
  const clash = known.find(([, v]) => v !== first[1]);
  if (clash) throw new Error(`app_pk_mode disagrees: ${known.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  return first[1] as AppPkMode;
}

const printStep = (io: Io, step: CallStep) => io.out(formatDryRunStep(1, 1, step));

export async function main(argv: string[], deps: AttackDeps = {}): Promise<number> {
  const io = deps.io ?? consoleIo;
  let parsed;
  try {
    parsed = parseCommon(argv, {
      sale: { type: "string" }, escrow: { type: "string" }, origin: { type: "string" }, "from-idx": { type: "string" }, idx: { type: "string" },
      sealed: { type: "string" }, signer: { type: "string" }, mode: { type: "string" }, init: { type: "string" },
    });
  } catch (e) {
    io.err(`error: ${(e as Error).message}\n${usage}`);
    return 2;
  }
  const { common, positionals } = parsed;
  const str = (k: string) => parsed.values[k] as string | undefined;
  const sub = positionals[0];
  const sale = str("sale");
  if (!sub || !sale) {
    io.err(usage);
    return 2;
  }
  const signer = str("signer") ?? process.env.TENDER_TEAM_ACCOUNT_ID ?? "tenderseal.near";
  const dir = deps.bidsDir ?? defaultBidsDir();
  const env = () => (deps.env ?? liveEnv)(common);
  try {
    if (!/^\d+$/.test(sale)) throw new Error("--sale must be a sale id");
    if (sub === "garbage" || sub === "copy") {
      if (!str("escrow") || !str("origin")) throw new Error("--escrow and --origin are required");
      const escrow = toUnits(str("escrow") as string, 6);
      if (escrow < MIN_BID) throw new Error("--escrow must be at least 1 USDC");
      const origin = str("origin") as string;
      if (!ORIGIN_RE.test(origin)) throw new Error("--origin must be 1 to 8 printable ASCII characters");
      let bid;
      if (sub === "garbage") bid = garbageBid(sale, escrow, origin);
      else {
        if (!/^\d+$/.test(str("from-idx") ?? "")) throw new Error("--from-idx is required (index of the bid to copy)");
        const idx = Number(str("from-idx"));
        const source = (await env().bids(sale)).find((b) => b.idx === idx);
        if (!source) throw new Error(`sale ${sale} has no bid with idx ${idx}`);
        bid = copyBid(sale, source, escrow, origin);
      }
      const file = writeBidFile(dir, `${sale}-${sub}.json`, bid);
      io.out(`wrote ${file}\n${JSON.stringify(bid)}\nsend it from a different wallet through the app's "Paste a sealed bid" panel; expected: ${sub === "garbage" ? "accepted as a bid (the contract cannot read ct), unrevealable" : "accepted, decrypts, but its commitment names the first bidder so it never reveals"}`);
      return 0;
    }
    if (sub === "wrong-cm") {
      if (!str("sealed") || !/^\d+$/.test(str("idx") ?? "")) throw new Error("--idx and --sealed are required");
      let f: { sale?: string; p?: string; q?: string; salt?: string };
      try {
        f = JSON.parse(readFileSync(str("sealed") as string, "utf8"));
      } catch {
        throw new Error(`cannot read ${str("sealed")} as JSON`);
      }
      if (String(f.sale) !== sale) throw new Error(`--sealed file is for sale ${f.sale}, not sale ${sale}`);
      if (!f.p || !f.q || !f.salt) throw new Error("--sealed file needs p, q and salt");
      // The reveal call publishes the real p and q (and a salt one bit away from the real one) in the transaction: only once the key is out.
      const info = await env().sale(sale);
      if (!info) throw new Error(`sale ${sale} not found on ${common.contract}`);
      if (info.state !== "Keyed") throw new Error(`sale ${sale} is ${info.state}, not Keyed: the printed reveal would publish this bid's p and q before the key is released. Run it after open() delivered the key`);
      printStep(io, revealStep({ signer, contract: common.contract, sale, idx: Number(str("idx")), p: f.p, q: f.q, salt: flipSalt(f.salt), network: common.network }));
      io.out("expected: panic (commitment mismatch); run it only after open() delivered the key (state Keyed). Record with --step attack-wrong-cm --expect failure");
      return 0;
    }
    if (sub === "early-open") {
      printStep(io, openStep({ signer, contract: common.contract, sale, network: common.network }));
      io.out("expected: panic (before close). Record with --step attack-early-open --expect failure");
      return 0;
    }
    if (sub === "eoa-ckd") {
      const e = env();
      const [config, info] = await Promise.all([e.config(), e.sale(sale)]);
      if (!info) throw new Error(`sale ${sale} not found on ${common.contract}`);
      const initFile = str("init") ?? resolve(deps.salesDir ?? resolve(ROOT, "sales"), common.network === "mainnet" ? "v1-init.json" : "testnet-init.json");
      let fileMode: string | undefined;
      try {
        fileMode = (JSON.parse(readFileSync(initFile, "utf8")) as { app_pk_mode?: string }).app_pk_mode;
      } catch {
        throw new Error(`cannot read ${initFile}`);
      }
      const mode = resolveMode({ file: fileMode, flag: str("mode"), chain: config.app_pk_mode });
      printStep(io, eoaCkdStep({ signer, mpc: config.mpc, path: info.path, mode, domainId: Number(config.domain_id), network: common.network }));
      io.out(`expected: the MPC answers for an EOA caller; the key is derived for ${signer}, so it does not open the sale's bids (record with --step attack-eoa-ckd --save-result evidence/spikes/eoa-ckd-${sale}.json)`);
      return 0;
    }
    io.err(usage);
    return 2;
  } catch (e) {
    io.err(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
