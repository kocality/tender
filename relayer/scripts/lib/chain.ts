import { rpcCall, view, type Network } from "./rpc.js";

// Read-only balance and key views. Public RPCs rate-limit: callers use `pace()` between requests.

export const USDC_NEAR = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
export const USDC_SOL_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const EVM_RPC = { base: "https://mainnet.base.org", arb: "https://arb1.arbitrum.io/rpc" } as const;
export const SOL_RPC = "https://api.mainnet-beta.solana.com";

export const pace = { ms: 200, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };

async function json(url: string, body: unknown): Promise<any> {
  await pace.sleep(pace.ms);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const out: any = await res.json();
  if (out.error) throw new Error(`${url}: ${JSON.stringify(out.error).slice(0, 200)}`);
  return out.result;
}

/** Native NEAR balance in yocto; `null` when the account does not exist. */
export async function nearNative(network: Network, accountId: string, opts: { rpc?: string } = {}): Promise<bigint | null> {
  await pace.sleep(pace.ms);
  try {
    const { result } = await rpcCall<{ amount: string }>(network, "query", { request_type: "view_account", account_id: accountId, finality: "final" }, opts);
    return BigInt(result.amount);
  } catch (e) {
    if (/UNKNOWN_ACCOUNT/.test((e as Error).message)) return null;
    throw e;
  }
}

export async function ftBalance(network: Network, token: string, accountId: string): Promise<bigint> {
  await pace.sleep(pace.ms);
  return BigInt(await view<string>(network, token, "ft_balance_of", { account_id: accountId }));
}

/** intents.near mt_batch_balance_of; an unknown account reads 0. */
export async function intentsBalances(network: Network, intents: string, accountId: string, tokenIds: string[]): Promise<bigint[]> {
  await pace.sleep(pace.ms);
  const r = await view<string[]>(network, intents, "mt_batch_balance_of", { account_id: accountId, token_ids: tokenIds });
  return r.map((x) => BigInt(x));
}

export async function intentsPublicKeys(network: Network, intents: string, accountId: string): Promise<string[]> {
  await pace.sleep(pace.ms);
  return (await view<string[]>(network, intents, "public_keys_of", { account_id: accountId })) ?? [];
}

/** `allowance: null` = full access key (or a function-call key without allowance cap). */
export async function accessKey(
  network: Network,
  accountId: string,
  publicKey: string,
): Promise<{ kind: "full" | "function-call"; allowance: bigint | null; receiver?: string; methods?: string[] } | null> {
  await pace.sleep(pace.ms);
  try {
    const { result } = await rpcCall<{ permission: any }>(network, "query", { request_type: "view_access_key", account_id: accountId, public_key: publicKey, finality: "final" });
    const p = result.permission;
    if (p === "FullAccess") return { kind: "full", allowance: null };
    const fc = p?.FunctionCall;
    if (!fc) return null;
    return { kind: "function-call", allowance: fc.allowance === null ? null : BigInt(fc.allowance), receiver: fc.receiver_id, methods: fc.method_names };
  } catch (e) {
    if (/UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT/.test((e as Error).message)) return null;
    throw e;
  }
}

export async function evmNative(chain: "base" | "arb", address: string): Promise<bigint> {
  return BigInt(await json(EVM_RPC[chain], { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }));
}

export async function evmUsdc(chain: "base" | "arb", address: string): Promise<bigint> {
  const data = "0x70a08231" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const r: string = await json(EVM_RPC[chain], {
    jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: chain === "base" ? USDC_BASE : USDC_ARB, data }, "latest"],
  });
  return r === "0x" ? 0n : BigInt(r);
}

/** lamports */
export async function solNative(address: string): Promise<bigint> {
  const r = await json(SOL_RPC, { jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] });
  return BigInt(r.value);
}

/** micro-USDC; an owner without a token account reads 0 (not an error). */
export async function solUsdc(address: string): Promise<bigint> {
  const r = await json(SOL_RPC, {
    jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [address, { mint: USDC_SOL_MINT }, { encoding: "jsonParsed" }],
  });
  let sum = 0n;
  for (const a of r?.value ?? []) sum += BigInt(a?.account?.data?.parsed?.info?.tokenAmount?.amount ?? "0");
  return sum;
}
