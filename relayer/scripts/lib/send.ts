import { Account, FailoverRpcProvider, JsonRpcProvider, actions, teraToGas } from "near-api-js";
import type { CallStep } from "./cli.js";
import { loadKeyPair } from "./keys.js";
import { RPC, blockHeight, type Network } from "./rpc.js";
import { toUnits } from "./units.js";

/** "3 NEAR" | "0.00125 NEAR" | "1 yoctoNEAR" | "0 NEAR" -> yocto bigint. */
export function depositToYocto(s: string): bigint {
  const m = /^([\d.]+) (NEAR|yoctoNEAR)$/.exec(s);
  if (!m) throw new Error(`cannot read deposit "${s}"`);
  return m[2] === "yoctoNEAR" ? BigInt(m[1] as string) : toUnits(m[1] as string, 24);
}

export function makeAccount(network: Network, accountId: string, rpc?: string): Account {
  const urls = rpc ? [rpc] : RPC[network].normal;
  const provider = new FailoverRpcProvider(urls.map((url) => new JsonRpcProvider({ url })));
  return new Account(accountId, provider, loadKeyPair(network, accountId));
}

export interface Sent { hash: string; ok: boolean; block: number; status: unknown; logs: string[] }

/** Sends one function-call step, waits for FINAL. Never throws on a failed transaction (returns ok=false). */
export async function sendStep(account: Account, s: CallStep, rpc?: string): Promise<Sent> {
  const res: any = await account.signAndSendTransaction({
    receiverId: s.receiver,
    actions: [actions.functionCall(s.method, s.args, teraToGas(s.gasTgas), depositToYocto(s.deposit))],
    waitUntil: "FINAL",
    throwOnFailure: false,
  });
  const hash: string = res.transaction.hash;
  const logs: string[] = (res.receipts_outcome ?? []).flatMap((r: any) => r?.outcome?.logs ?? []);
  const block = await blockHeight(s.network, res.transaction_outcome.block_hash, { rpc });
  return { hash, ok: "SuccessValue" in (res.status ?? {}), block, status: res.status, logs };
}

export function explorer(network: Network, hash: string): string {
  return network === "mainnet" ? `https://nearblocks.io/txns/${hash}` : `https://testnet.nearblocks.io/txns/${hash}`;
}
