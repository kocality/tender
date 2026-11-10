import { toBase64, utf8 } from './encoding.js';

/** A contract panic during a view call. Deterministic, so it is never retried. */
export class ViewPanic extends Error {
  readonly panicMsg: string;
  constructor(panicMsg: string, raw: string) {
    super(raw);
    this.name = 'ViewPanic';
    this.panicMsg = panicMsg;
  }
}

/** The node answered with a deterministic JSON-RPC error (for example UNKNOWN_ACCOUNT). Another URL or another try gives the same answer. */
export class RpcAnswer extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcAnswer';
  }
}

/** Handler errors that depend on the node's own chain state (a lagging or pruned node), not on the request. */
const NODE_STATE_CAUSES = ['UNKNOWN_BLOCK', 'NOT_SYNCED_YET', 'NO_SYNCED_BLOCKS', 'GARBAGE_COLLECTED_BLOCK'];

/** Errors a node reports about the request (HANDLER_ERROR, REQUEST_VALIDATION_ERROR); INTERNAL_ERROR, timeouts and node-state causes are node problems. */
function isAnswer(error: unknown): boolean {
  const e = error as { name?: unknown; cause?: { name?: unknown } } | null;
  if (NODE_STATE_CAUSES.includes(String(e?.cause?.name))) return false;
  return e?.name === 'HANDLER_ERROR' || e?.name === 'REQUEST_VALIDATION_ERROR';
}

export interface RpcOptions {
  /** Waits after each failed attempt; its length is the attempt count per URL. Default 1/2/4 s (V2). */
  backoffMs?: readonly number[];
  /** Read the state at this block instead of the latest final block, so several views describe the same moment. */
  blockId?: number;
}

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000] as const;
const REQUEST_TIMEOUT_MS = 15_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RpcResponse {
  error?: unknown;
  result?: unknown;
}

/**
 * JSON-RPC call with the V2 policy: each URL up to 3 attempts (1/2/4 s backoff), then the next URL. An answer the node
 * gave about the request itself (contract panic, missing account) is thrown at once.
 */
async function rpcCall(rpcUrls: string[], method: string, params: unknown, opts?: RpcOptions): Promise<unknown> {
  if (rpcUrls.length === 0) throw new Error('no RPC URL given');
  const backoff = opts?.backoffMs ?? DEFAULT_BACKOFF_MS;
  let lastError: unknown;
  for (const [u, url] of rpcUrls.entries()) {
    for (const [a, wait] of backoff.entries()) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'tender', method, params }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        const j = (await res.json()) as RpcResponse;
        if (j.error !== undefined) {
          const text = `${url}: ${JSON.stringify(j.error)}`;
          throw isAnswer(j.error) ? new RpcAnswer(text) : new Error(text);
        }
        const result = j.result as { error?: unknown } | undefined;
        if (typeof result?.error === 'string') {
          const m = /panic_msg: "(.*)"/.exec(result.error);
          if (m) throw new ViewPanic(m[1]!, result.error);
          throw new Error(`${url}: ${result.error}`);
        }
        return j.result;
      } catch (e) {
        if (e instanceof ViewPanic || e instanceof RpcAnswer) throw e;
        lastError = e;
        const last = u === rpcUrls.length - 1 && a === backoff.length - 1;
        if (!last) await sleep(wait);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** `query/call_function` at `finality: "final"`; returns the parsed JSON result. */
export async function viewCall<T>(
  rpcUrls: string[],
  accountId: string,
  method: string,
  args: unknown,
  opts?: RpcOptions,
): Promise<T> {
  const result = (await rpcCall(
    rpcUrls,
    'query',
    {
      request_type: 'call_function',
      ...(opts?.blockId === undefined ? { finality: 'final' } : { block_id: opts.blockId }),
      account_id: accountId,
      method_name: method,
      args_base64: toBase64(utf8(JSON.stringify(args))),
    },
    opts,
  )) as { result: number[] };
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result))) as T;
}

/**
 * Timestamp (ns) of the latest final block, or of the head with `finality: 'optimistic'`. The final block trails the
 * head by about 3 s, which makes a clock built from it run slow.
 */
export async function blockTimestampNs(rpcUrls: string[], opts?: RpcOptions & { finality?: 'final' | 'optimistic' }): Promise<bigint> {
  const block = (await rpcCall(rpcUrls, 'block', { finality: opts?.finality ?? 'final' }, opts)) as {
    header: { timestamp_nanosec: string };
  };
  return BigInt(block.header.timestamp_nanosec);
}

/** Height of the latest final block. */
export async function finalBlockHeight(rpcUrls: string[], opts?: RpcOptions): Promise<number> {
  const block = (await rpcCall(rpcUrls, 'block', { finality: 'final' }, opts)) as { header: { height: number } };
  return block.header.height;
}
