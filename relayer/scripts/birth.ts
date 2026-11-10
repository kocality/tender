import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  Account, FailoverRpcProvider, JsonRpcProvider, PublicKey, actions, baseEncode, nearToYocto, teraToGas,
} from "near-api-js";
import { nearNative } from "./lib/chain.js";
import { DRY_RUN_HEADER, parseCommon } from "./lib/cli.js";
import { EVIDENCE_DIR } from "./lib/evidence.js";
import { loadKeyPair, writeNewKeyPair } from "./lib/keys.js";
import { RPC, rpcCall, view, type Network } from "./lib/rpc.js";
import { fromUnits, toUnits } from "./lib/units.js";

// Keyless single-transaction birth (DECISIONS C1): CreateAccount + Transfer + DeployContract + FunctionCall(new) in one batch.
// v1.* never gets a key. rehearsal.* and testnet accounts may get a generated full-access key (PD-05).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MODES = ["identity", "generator", "plain"];
const INIT_FIELDS = ["mpc", "intents", "domain_id", "app_pk_mode", "mpc_public_key", "quote_tokens", "sellers"];
const NEW_GAS_TGAS = 100;

export class BirthRefusal extends Error {}

export interface BirthOpts {
  network: Network;
  signer: string;
  account: string;
  wasm: string; // path (informational for plan output)
  balance: string; // NEAR, decimal string
  init: string; // path to the JSON args of the init method
  initMethod: string; // default "new"
  addFullAccessKey?: "generate" | `ed25519:${string}`;
  yes: boolean;
  releaseSha256?: string; // contract/res/tender.wasm.sha256 (first 64 hex); required on mainnet
}

export type ActionSpec =
  | { type: "CreateAccount" }
  | { type: "Transfer"; yocto: string }
  | { type: "AddKey"; publicKey: string } // publicKey "generate" until main() has made the key
  | { type: "DeployContract"; bytes: number; sha256: string }
  | { type: "FunctionCall"; method: string; args: object; gasTgas: number; deposit: "0" };

export const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** C25: ceil(wasm_bytes / 100000) + 1.5 NEAR. Returned as a decimal string. */
export function minBalance(wasmBytes: number): string {
  const tenths = Math.ceil(wasmBytes / 100_000) * 10 + 15;
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

/** Pure. Every rule violation throws BirthRefusal (exit 2). */
export function planBirth(o: BirthOpts, wasm: Uint8Array, initArgs: object = {}): { actions: ActionSpec[]; checks: string[] } {
  const prefix = o.account.endsWith(`.${o.signer}`) ? o.account.slice(0, -(o.signer.length + 1)) : null;
  if (!prefix || prefix.includes(".")) {
    throw new BirthRefusal(`account must be <label>.${o.signer} (one level; the contract's create check needs predecessor == parent), got ${o.account}`);
  }
  if (o.addFullAccessKey) {
    if (o.account.startsWith("v1.")) throw new BirthRefusal("refusing: v1.* must be born keyless (DECISIONS C1)");
    if (o.network !== "testnet" && !o.account.startsWith("rehearsal.")) {
      throw new BirthRefusal("refusing: --add-full-access-key is only for testnet or rehearsal.* accounts (PD-05)");
    }
  }
  if (o.initMethod !== "new" && o.network !== "testnet") throw new BirthRefusal("refusing: --init-method other than new is testnet only (D4-12)");
  const min = minBalance(wasm.length);
  if (toUnits(o.balance, 24) < toUnits(min, 24)) {
    throw new BirthRefusal(`balance ${o.balance} NEAR is below the storage minimum ${min} NEAR for ${wasm.length} wasm bytes (C25: ceil(bytes/100000) + 1.5)`);
  }
  const sha = sha256Hex(wasm);
  if (o.network === "mainnet") {
    if (!o.releaseSha256) throw new BirthRefusal("refusing: contract/res/tender.wasm.sha256 not found, cannot prove the wasm is the release artifact");
    if (o.releaseSha256 !== sha) throw new BirthRefusal(`wasm is not the release artifact (sha256 ${sha} != contract/res/tender.wasm.sha256 ${o.releaseSha256})`);
  }
  const acts: ActionSpec[] = [{ type: "CreateAccount" }, { type: "Transfer", yocto: toUnits(o.balance, 24).toString() }];
  if (o.addFullAccessKey) acts.push({ type: "AddKey", publicKey: o.addFullAccessKey });
  acts.push({ type: "DeployContract", bytes: wasm.length, sha256: sha });
  acts.push({ type: "FunctionCall", method: o.initMethod, args: initArgs, gasTgas: NEW_GAS_TGAS, deposit: "0" });
  const checks = [
    `target account ${o.account} does not exist`,
    `signer ${o.signer} holds at least ${fromUnits(toUnits(o.balance, 24) + toUnits("0.5", 24), 24)} NEAR`,
    ...(o.addFullAccessKey ? [] : [`access keys of ${o.account}: 0 after the transaction`]),
    `code hash of ${o.account} = base58(sha256(wasm)) = ${baseEncode(Buffer.from(sha, "hex"))}`,
  ];
  return { actions: acts, checks };
}

/** Problems with the init JSON for the real `new` method (empty list = ok). `ping` on testnet needs none. */
export function validateInit(init: any, initMethod: string): string[] {
  if (initMethod !== "new") return [];
  const p: string[] = [];
  if (typeof init !== "object" || init === null || Array.isArray(init)) return ["init JSON is not an object"];
  for (const f of INIT_FIELDS) if (init[f] === undefined) p.push(`init JSON lacks "${f}"`);
  if (init.app_pk_mode !== undefined && !MODES.includes(init.app_pk_mode)) {
    p.push(`app_pk_mode is ${JSON.stringify(init.app_pk_mode)}, expected one of ${MODES.join("|")} (decided by gate G-S1; PENDING until H-S1 runs)`);
  }
  if (init.domain_id !== undefined && !Number.isInteger(init.domain_id)) p.push("domain_id must be an integer");
  for (const f of ["quote_tokens", "sellers"]) if (init[f] !== undefined && (!Array.isArray(init[f]) || init[f].length === 0)) p.push(`${f} must be a non-empty array`);
  return p;
}

function describe(a: ActionSpec): string {
  return a.type === "FunctionCall" ? `FunctionCall:${a.method}` : a.type;
}

function toNearActions(specs: ActionSpec[], wasm: Uint8Array) {
  return specs.map((a) => {
    switch (a.type) {
      case "CreateAccount": return actions.createAccount();
      case "Transfer": return actions.transfer(BigInt(a.yocto));
      case "AddKey": return actions.addFullAccessKey(PublicKey.fromString(a.publicKey));
      case "DeployContract": return actions.deployContract(wasm);
      case "FunctionCall": return actions.functionCall(a.method, a.args, teraToGas(a.gasTgas), 0n);
    }
  });
}

/** The same transaction for near-cli-rs. Syntax is not verified: build it interactively once with `near transaction construct-transaction`. */
function nearCliFallback(o: BirthOpts, specs: ActionSpec[]): string {
  const parts = specs.map((a) => {
    switch (a.type) {
      case "CreateAccount": return "add-action create-account";
      case "Transfer": return `add-action transfer '${fromUnits(BigInt(a.yocto), 24)} NEAR'`;
      case "AddKey": return `add-action add-key grant-full-access use-manually-provided-public-key ${a.publicKey}`;
      case "DeployContract": return `add-action deploy-contract use-file ${o.wasm} without-init-call`;
      case "FunctionCall": return `add-action function-call ${a.method} json-args '${JSON.stringify(a.args)}' prepaid-gas '${a.gasTgas} Tgas' attached-deposit '0 NEAR'`;
    }
  });
  return `near transaction construct-transaction ${o.signer} ${o.account} ${parts.join(" ")} skip network-config ${o.network} sign-with-legacy-keychain send`;
}

export function formatPlan(o: BirthOpts, specs: ActionSpec[]): string {
  const method = `batch(${specs.map(describe).join("+")})`;
  const fc = specs.find((a): a is Extract<ActionSpec, { type: "FunctionCall" }> => a.type === "FunctionCall") as Extract<ActionSpec, { type: "FunctionCall" }>;
  return [
    DRY_RUN_HEADER,
    `[1/1] signer=${o.signer} receiver=${o.account} method=${method} deposit=${o.balance} NEAR gas=${fc.gasTgas} Tgas`,
    `      args=${JSON.stringify(fc.args)}`,
    `      near-cli: ${nearCliFallback(o, specs)}`,
  ].join("\n");
}

function provider(network: Network, rpc?: string) {
  const urls = rpc ? [rpc] : RPC[network].normal;
  return new FailoverRpcProvider(urls.map((url) => new JsonRpcProvider({ url })));
}

const usage = `usage:
  tsx scripts/birth.ts --network mainnet|testnet --signer <parent> --account <label>.<parent> --wasm <file> --balance <NEAR> --init <json>
    [--init-method new] [--add-full-access-key generate|ed25519:<pk>] [--yes]
  Dry-run unless --yes. v1.* is always born keyless. Run from the repo root via: pnpm --filter @tender/relayer exec tsx scripts/birth.ts ...`;

export async function main(argv: string[]): Promise<number> {
  const { common, values } = parseCommon(argv, {
    signer: { type: "string" }, account: { type: "string" }, wasm: { type: "string" }, balance: { type: "string" }, init: { type: "string" },
    "init-method": { type: "string" }, "add-full-access-key": { type: "string" },
  });
  const str = (k: string) => values[k] as string | undefined;
  if (!str("signer") || !str("account") || !str("wasm") || !str("balance") || !str("init")) {
    console.error(usage);
    return 2;
  }
  const network = common.network;
  try {
    const wasmPath = resolve(str("wasm") as string);
    const wasm = new Uint8Array(readFileSync(wasmPath));
    const initText = readFileSync(resolve(str("init") as string), "utf8").trim();
    const initArgs: object = initText === "" ? {} : JSON.parse(initText);
    const shaFile = resolve(ROOT, "contract/res/tender.wasm.sha256");
    const releaseSha256 = existsSync(shaFile) ? readFileSync(shaFile, "utf8").trim().slice(0, 64) : undefined;
    const key = str("add-full-access-key");
    if (key !== undefined && key !== "generate" && !/^ed25519:/.test(key)) throw new BirthRefusal('--add-full-access-key takes "generate" or an ed25519:<public key>');
    const o: BirthOpts = {
      network, signer: str("signer") as string, account: str("account") as string, wasm: str("wasm") as string,
      balance: str("balance") as string, init: str("init") as string, initMethod: str("init-method") ?? "new",
      addFullAccessKey: key as BirthOpts["addFullAccessKey"], yes: common.yes && !common.dryRunFlag, releaseSha256,
    };
    const plan = planBirth(o, wasm, initArgs);

    // Preflight (view only). Problems block --yes; a dry-run still prints the plan and exits 1 at the end.
    const problems = validateInit(initArgs, o.initMethod);
    if (await nearNative(network, o.account, { rpc: common.rpc }) !== null) problems.push(`${o.account} already exists`);
    const signerBalance = await nearNative(network, o.signer, { rpc: common.rpc });
    const need = toUnits(o.balance, 24) + toUnits("0.5", 24);
    if (signerBalance === null) problems.push(`signer ${o.signer} does not exist on ${network} yet`);
    else if (signerBalance < need) problems.push(`signer ${o.signer} has ${fromUnits(signerBalance, 24)} NEAR, needs ${fromUnits(need, 24)} (balance + 0.5)`);
    if (o.initMethod === "new" && typeof (initArgs as any).mpc === "string" && (initArgs as any).mpc_public_key !== undefined) {
      try {
        const live = await view<string>(network, (initArgs as any).mpc, "public_key", { domain_id: (initArgs as any).domain_id }, { rpc: common.rpc });
        if (live !== (initArgs as any).mpc_public_key) problems.push(`mpc_public_key differs from ${(initArgs as any).mpc}.public_key({domain_id:${(initArgs as any).domain_id}}) = ${live}`);
      } catch (e) {
        problems.push(`could not read the live MPC public key: ${(e as Error).message}`);
      }
    }
    if (network === "mainnet" && o.initMethod === "new") {
      const spikes = existsSync(`${EVIDENCE_DIR}spikes.json`) ? (JSON.parse(readFileSync(`${EVIDENCE_DIR}spikes.json`, "utf8")) as any[]) : [];
      const s1 = spikes.find((r) => r.gate === "S1" && r.result !== "FAIL");
      if (!s1) console.warn("WARN evidence/spikes.json has no S1 row yet (G-S1 PENDING); app_pk_mode is not cross-checked");
      else if (s1.chosen_path !== (initArgs as any).app_pk_mode) problems.push(`app_pk_mode ${(initArgs as any).app_pk_mode} differs from gate S1 chosen_path ${s1.chosen_path}`);
    }

    console.log(formatPlan(o, plan.actions));
    console.log("post-checks:\n" + plan.checks.map((c) => `  - ${c}`).join("\n"));
    for (const p of problems) console.log(`BLOCKED: ${p}`);
    if (!o.yes) return problems.length ? 1 : 0;
    if (problems.length) return 2;

    // --yes
    const specs = plan.actions.map((a) => ({ ...a }));
    let newKey: { publicKey: string; path: string } | undefined;
    if (o.addFullAccessKey === "generate") {
      newKey = writeNewKeyPair(network, o.account);
      const add = specs.find((a) => a.type === "AddKey") as Extract<ActionSpec, { type: "AddKey" }>;
      add.publicKey = newKey.publicKey;
      console.log(`generated full-access key ${newKey.publicKey} -> ${newKey.path} (mode 600)`);
    }
    const signerAccount = new Account(o.signer, provider(network, common.rpc), loadKeyPair(network, o.signer));
    const res: any = await signerAccount.signAndSendTransaction({
      receiverId: o.account, actions: toNearActions(specs, wasm), waitUntil: "FINAL", throwOnFailure: false,
    });
    const hash: string = res.transaction.hash;
    const ok = "SuccessValue" in (res.status ?? {});
    console.log(`tx=${hash} status=${ok ? "SuccessValue" : "Failure"} url=${network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io"}/txns/${hash}`);
    if (!ok) {
      console.error(`FAIL birth transaction failed: ${JSON.stringify(res.status).slice(0, 400)}`);
      return 1;
    }

    // post-checks
    let failed = false;
    const keys = (await rpcCall<{ keys: unknown[] }>(network, "query", { request_type: "view_access_key_list", account_id: o.account, finality: "final" }, { rpc: common.rpc })).result.keys;
    console.log(`access keys: ${keys.length}`);
    if (!o.addFullAccessKey && keys.length !== 0) {
      console.error(`\x1b[1;31mFAIL ${o.account} has ${keys.length} access key(s) after a keyless birth. STOP.\x1b[0m`);
      failed = true;
    }
    const code = (await rpcCall<{ hash: string }>(network, "query", { request_type: "view_code", account_id: o.account, finality: "final" }, { rpc: common.rpc })).result;
    const want = baseEncode(Buffer.from(sha256Hex(wasm), "hex"));
    console.log(`code_hash=${code.hash} ${code.hash === want ? "matches" : `MISMATCH (expected ${want})`}`);
    if (code.hash !== want) failed = true;
    if (o.initMethod === "new") {
      try {
        const cfg = (await view<any>(network, o.account, "get_config", {}, { rpc: common.rpc })) ?? {};
        const diff = Object.entries(initArgs as Record<string, unknown>).filter(([k, v]) => k in cfg && JSON.stringify(cfg[k]) !== JSON.stringify(v)).map(([k]) => k);
        console.log(diff.length ? `FAIL get_config differs from init in: ${diff.join(", ")}` : "get_config matches init (fields get_config shows)");
        if (diff.length) failed = true;
      } catch (e) {
        console.warn(`WARN get_config not readable: ${(e as Error).message}`);
      }
    }

    // D4-07: mainnet births are evidence; testnet is not
    if (network === "mainnet" && !common.noRecord) {
      try {
        const { recordTx } = await import("./record.js");
        await recordTx({
          network, sale: o.account.startsWith("v1.") ? "lock" : "R", step: "birth", txHash: hash, signer: o.signer, contract: o.account, chain: "near",
        });
        const { snapshot } = await import("./snapshot.js");
        const snap = await snapshot({ network, contract: o.account, sale: "0", rpc: common.rpc });
        console.log(`snapshot ${snap.file}`);
      } catch (e) {
        console.warn(`WARN recording failed (run scripts/record.ts by hand within 2 h, D4-01): ${(e as Error).message}`);
      }
    }
    return failed ? 1 : 0;
  } catch (e) {
    console.error(`${e instanceof BirthRefusal ? "refused" : "error"}: ${(e as Error).message}`);
    return e instanceof BirthRefusal ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
