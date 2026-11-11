import { Account, JsonRpcProvider, actions, teraToGas, type Signer } from "near-api-js";
import type { CallStep } from "./cli.js";
import { NonceAwareFailoverProvider } from "../../src/near.js";
import { loadKeyPair } from "./keys.js";
import { RPC, blockHeight, type Network } from "./rpc.js";
import { fromUnits, toUnits } from "./units.js";

/** "3 NEAR" | "0.00125 NEAR" | "1 yoctoNEAR" | "0 NEAR" -> yocto bigint. */
export function depositToYocto(s: string): bigint {
  const m = /^([\d.]+) (NEAR|yoctoNEAR)$/.exec(s);
  if (!m) throw new Error(`cannot read deposit "${s}"`);
  return m[2] === "yoctoNEAR" ? BigInt(m[1] as string) : toUnits(m[1] as string, 24);
}

export function makeAccount(network: Network, accountId: string, rpc?: string): Account {
  const urls = rpc ? [rpc] : RPC[network].normal;
  const provider = new NonceAwareFailoverProvider(urls.map((url) => new JsonRpcProvider({ url })));
  return new Account(accountId, provider, loadKeyPair(network, accountId));
}

// Signing a call with N Tgas prepaid needs the signer to hold the pessimistic cost of that gas: 300 Tgas = 0.3009 NEAR (measured on testnet:
// an account with 0.2 NEAR was refused with NotEnoughBalance at 300 Tgas and served at 100 Tgas).
const YOCTO_PER_TGAS_BALANCE = 1_003_100_000_000_000_000_000n;

/** null = `spendable` (balance minus the storage stake, yocto) covers the prepaid gas; otherwise why the send would be rejected. */
export function gasBalanceProblem(signer: string, spendable: bigint, gasTgas: number): string | null {
  const need = BigInt(gasTgas) * YOCTO_PER_TGAS_BALANCE;
  if (spendable >= need) return null;
  return `${signer} can spend ${fromUnits(spendable, 24)} NEAR and signing ${gasTgas} Tgas needs ${fromUnits(need, 24)} NEAR: top it up above that or send through a relayer (--via-relay <url>)`;
}

export interface Sent { hash: string; ok: boolean; block: number; status: unknown; logs: string[] }

/** Sends one function-call step, waits for FINAL. Never throws on a failed transaction (returns ok=false). `signer` (from recordSigned) lets the caller see the hash of a send that throws. */
export async function sendStep(account: Account, s: CallStep, rpc?: string, signer?: Signer): Promise<Sent> {
  const res: any = await account.signAndSendTransaction({
    receiverId: s.receiver,
    actions: [actions.functionCall(s.method, s.args, teraToGas(s.gasTgas), depositToYocto(s.deposit))],
    waitUntil: "FINAL",
    throwOnFailure: false,
    ...(signer ? { signer } : {}),
  });
  const hash: string = res.transaction.hash;
  const logs: string[] = (res.receipts_outcome ?? []).flatMap((r: any) => r?.outcome?.logs ?? []);
  const block = await blockHeight(s.network, res.transaction_outcome.block_hash, { rpc });
  return { hash, ok: "SuccessValue" in (res.status ?? {}), block, status: res.status, logs };
}

export function explorer(network: Network, hash: string): string {
  return network === "mainnet" ? `https://nearblocks.io/txns/${hash}` : `https://testnet.nearblocks.io/txns/${hash}`;
}
