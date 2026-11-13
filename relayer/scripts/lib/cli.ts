import { parseArgs, type ParseArgsConfig } from "node:util";
import type { Network } from "./rpc.js";

export interface Common {
  network: Network;
  contract: string;
  rpc?: string;
  yes: boolean;
  dryRunFlag: boolean; // --dry-run given explicitly
  dryRun: boolean; // true unless --yes (or forced by --dry-run)
  noRecord: boolean;
}

type Options = NonNullable<ParseArgsConfig["options"]>;

export function parseCommon(argv: string[], extra: Options = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      network: { type: "string" },
      contract: { type: "string" },
      rpc: { type: "string" },
      yes: { type: "boolean" },
      "dry-run": { type: "boolean" },
      "no-record": { type: "boolean" },
      ...extra,
    },
  });
  const network = (values.network as string | undefined) ?? "mainnet";
  if (network !== "mainnet" && network !== "testnet") throw new Error(`--network must be mainnet or testnet, got "${network}"`);
  const yes = values.yes === true;
  const dryRunFlag = values["dry-run"] === true;
  const common: Common = {
    network,
    contract: (values.contract as string | undefined) ?? process.env.TENDER_CONTRACT_ID ?? "v1.tenderseal.near",
    rpc: values.rpc as string | undefined,
    yes,
    dryRunFlag,
    dryRun: !yes || dryRunFlag,
    noRecord: values["no-record"] === true,
  };
  return { common, values: values as Record<string, string | boolean | undefined>, positionals };
}

/** One function-call step of a value-moving script. `deposit` is a near-cli amount string such as "3 NEAR" or "1 yoctoNEAR". */
export interface CallStep {
  signer: string;
  receiver: string;
  method: string;
  args: object;
  deposit: string;
  gasTgas: number;
  network: Network;
}

export function nearCliLine(s: CallStep): string {
  const json = JSON.stringify(s.args);
  if (json.includes("'")) throw new Error("json args must not contain a single quote (they are wrapped in single quotes)");
  return (
    `near contract call-function as-transaction ${s.receiver} ${s.method} json-args '${json}' ` +
    `prepaid-gas '${s.gasTgas} Tgas' attached-deposit '${s.deposit}' sign-as ${s.signer} ` +
    `network-config ${s.network} sign-with-legacy-keychain send`
  );
}

export const DRY_RUN_HEADER = "DRY-RUN · nothing sent · re-run with --yes to send";

/** The line above a plan: a --yes run must never say "nothing sent" right before it sends. */
export function planHeader(dryRun: boolean): string {
  return dryRun ? DRY_RUN_HEADER : "SENDING · --yes · the step(s) below are sent now unless a BLOCKED line follows";
}

export function formatDryRunStep(i: number, n: number, s: CallStep): string {
  return [
    `[${i}/${n}] signer=${s.signer} receiver=${s.receiver} method=${s.method} deposit=${s.deposit} gas=${s.gasTgas} Tgas`,
    `      args=${JSON.stringify(s.args)}`,
    `      near-cli: ${nearCliLine(s)}`,
  ].join("\n");
}

export function printDryRunStep(i: number, n: number, s: CallStep): void {
  console.log(formatDryRunStep(i, n, s));
}
