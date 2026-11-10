export type Network = "mainnet" | "testnet";

// rpc.mainnet.near.org and rpc.testnet.near.org are deprecated: fastnear first, then live public providers (probed 2026-11-11).
// No other free archival node answered; the near.org archival nodes stay as the last archival URL.
export const RPC: Record<Network, { normal: string[]; archival: string[] }> = {
  mainnet: {
    normal: ["https://free.rpc.fastnear.com", "https://near.drpc.org", "https://rpc.shitzuapes.xyz"],
    archival: ["https://archival-rpc.mainnet.fastnear.com", "https://archival-rpc.mainnet.near.org"],
  },
  testnet: {
    normal: ["https://test.rpc.fastnear.com", "https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"],
    archival: ["https://archival-rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org"],
  },
};

export class RpcError extends Error {
  constructor(message: string, readonly fatal = false, readonly url?: string, readonly body?: unknown) {
    super(message);
    this.name = "RpcError";
  }
}

// Replaceable in tests so backoff does not slow them down.
export const rpcHooks = {
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

const BACKOFF_MS = [1000, 2000, 4000];
const ATTEMPTS_PER_URL = 3;
// The node does not have this block/transaction (non-archival window passed): try the next URL.
const MOVE_ON = /UNKNOWN_BLOCK|UNKNOWN_TRANSACTION|UNKNOWN_CHUNK|UNKNOWN_RECEIPT|GARBAGE_COLLECTED|DB Not Found/i;

/** Normal URLs first, then archival; `archival: true` uses the archival URLs only; `rpc` overrides everything. */
export async function rpcCall<T>(
  network: Network,
  method: string,
  params: unknown,
  opts: { archival?: boolean; rpc?: string } = {},
): Promise<{ result: T; url: string }> {
  const urls = opts.rpc ? [opts.rpc] : opts.archival ? RPC[network].archival : [...RPC[network].normal, ...RPC[network].archival];
  let last: unknown = new RpcError(`no RPC URL for ${network}`);
  for (const url of urls) {
    for (let attempt = 0; attempt < ATTEMPTS_PER_URL; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "tender", method, params }),
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 429 || res.status >= 500) throw new RpcError(`HTTP ${res.status} from ${url}`, false, url);
        if (!res.ok) {
          last = new RpcError(`HTTP ${res.status} from ${url}`, false, url);
          break; // 4xx: this node will not answer, next URL
        }
        const body = (await res.json()) as { result?: T; error?: unknown };
        if (body.error !== undefined) {
          const text = JSON.stringify(body.error);
          if (MOVE_ON.test(text)) {
            last = new RpcError(`${url}: ${text}`, false, url, body.error);
            break; // next URL
          }
          throw new RpcError(`${method} failed at ${url}: ${text}`, true, url, body.error);
        }
        return { result: body.result as T, url };
      } catch (e) {
        if (e instanceof RpcError && e.fatal) throw e;
        last = e;
        if (attempt < ATTEMPTS_PER_URL - 1) await rpcHooks.sleep(BACKOFF_MS[attempt] ?? 1000);
      }
    }
  }
  throw last instanceof Error ? last : new RpcError(String(last));
}

/** call_function at `finality: final`, or at `blockId` (height) when given. Decodes the JSON result (`null` for an empty one). */
export async function view<T>(
  network: Network,
  contract: string,
  method: string,
  args: object,
  opts: { blockId?: number; rpc?: string } = {},
): Promise<T> {
  const params = {
    request_type: "call_function",
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    ...(opts.blockId !== undefined ? { block_id: opts.blockId } : { finality: "final" }),
  };
  const { result } = await rpcCall<{ result?: number[]; error?: string }>(network, "query", params, { rpc: opts.rpc });
  if (result.error) throw new RpcError(`view ${contract}.${method}: ${result.error}`, true);
  const text = Buffer.from(result.result ?? []).toString("utf8");
  return (text === "" ? null : JSON.parse(text)) as T;
}

/** EXPERIMENTAL_tx_status, wait_until FINAL, normal chain first, then archival. */
export async function txStatus(
  network: Network,
  txHash: string,
  senderId: string,
  opts: { rpc?: string } = {},
): Promise<{ result: any; url: string; source: "rpc" | "archival" }> {
  const { result, url } = await rpcCall<any>(
    network,
    "EXPERIMENTAL_tx_status",
    { tx_hash: txHash, sender_account_id: senderId, wait_until: "FINAL" },
    { rpc: opts.rpc },
  );
  return { result, url, source: RPC[network].archival.includes(url) ? "archival" : "rpc" };
}

export async function blockHeight(network: Network, blockHash: string, opts: { rpc?: string } = {}): Promise<number> {
  const { result } = await rpcCall<{ header: { height: number } }>(network, "block", { block_id: blockHash }, { rpc: opts.rpc });
  return result.header.height;
}

/** base64 SuccessValue -> utf8. Accepts the whole tx result or just its `status`. */
export function decodeSuccessValue(status: any): string | null {
  const s = status?.status ?? status;
  const v = s?.SuccessValue;
  if (typeof v !== "string" || v === "") return null;
  return Buffer.from(v, "base64").toString("utf8");
}
