import { Account, FailoverRpcProvider, JsonRpcProvider } from "near-api-js";

// Relayer runtime: near-api-js and Node built-ins only (D4-03), no @tender/* imports.

export type Network = "mainnet" | "testnet";
type KeyPairString = `ed25519:${string}`;

export const RPCS: Record<Network, string[]> = {
  mainnet: ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"],
  testnet: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],
};

/** The contract panicked: `panicMsg` is its own text (for example "insufficient balance or overflow"). */
export class ViewPanic extends Error {
  constructor(readonly panicMsg: string) {
    super(panicMsg);
    this.name = "ViewPanic";
  }
}

export function makeProvider(network: Network, urls: string[] = RPCS[network]): FailoverRpcProvider {
  return new FailoverRpcProvider(urls.map((url) => new JsonRpcProvider({ url })));
}

export function makeAccount(accountId: string, keyPairString: KeyPairString, network: Network, urls?: string[]): Account {
  return new Account(accountId, makeProvider(network, urls), keyPairString);
}

async function rpc(urls: string[], method: string, params: unknown): Promise<any> {
  let last: unknown = new Error("no RPC URL");
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "tender", method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      const body: any = await res.json();
      if (body.error) {
        const e = new Error(`${method} failed: ${JSON.stringify(body.error).slice(0, 300)}`) as Error & { rpc?: boolean };
        e.rpc = true; // the node answered: do not ask the next one
        throw e;
      }
      return body.result;
    } catch (e) {
      if ((e as { rpc?: boolean }).rpc) throw e;
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** call_function at final. Throws ViewPanic when the contract panics, a plain Error when no node answers. */
export async function viewFunction<T>(urls: string[], contractId: string, method: string, args: object): Promise<T> {
  const r = await rpc(urls, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (r.error) {
    const panic = /panic_msg:\s*"((?:[^"\\]|\\.)*)"/.exec(r.error)?.[1];
    if (panic !== undefined) throw new ViewPanic(panic);
    throw new Error(`view ${contractId}.${method}: ${String(r.error).slice(0, 300)}`);
  }
  const text = Buffer.from(r.result ?? []).toString("utf8");
  return (text === "" ? null : JSON.parse(text)) as T;
}

/** Remaining allowance in yocto; null = full-access key (no allowance) or a function-call key without a cap; throws if the key is unknown. */
export async function accessKeyAllowance(urls: string[], accountId: string, publicKey: string): Promise<bigint | null> {
  const r = await rpc(urls, "query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey });
  const p = r.permission;
  if (p === "FullAccess") return null;
  const a = p?.FunctionCall?.allowance;
  return a === null || a === undefined ? null : BigInt(a);
}
