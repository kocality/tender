// NEAR JSON-RPC with failover (V2): 3 attempts per provider with 1/2/4 s backoff, then the next provider.
// HTTP 429 moves to the next provider at once (OPS-04); only the last provider backs off on it.
// Only transient errors are retried (P-8); deterministic ones (unknown account, contract panic) throw at once.

export type RpcErrorKind = 'transient' | 'permanent';

export class RpcError extends Error {
  readonly kind: RpcErrorKind;
  readonly provider: string;
  /** NEAR error cause name when the node gave one (UNKNOWN_ACCOUNT, UNKNOWN_TRANSACTION, …). */
  readonly cause_name: string | undefined;
  /** HTTP status when the provider answered with one. */
  readonly status: number | undefined;
  constructor(message: string, kind: RpcErrorKind, provider: string, causeName?: string, status?: number) {
    super(message);
    this.name = 'RpcError';
    this.kind = kind;
    this.provider = provider;
    this.cause_name = causeName;
    this.status = status;
  }
}

export interface RpcOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const BACKOFF_MS = [1000, 2000, 4000] as const;
const TRANSIENT_CAUSES = new Set(['TIMEOUT_ERROR']);
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface JsonRpcError {
  name?: string;
  cause?: { name?: string; info?: unknown };
  message?: string;
  data?: unknown;
}

export class Rpc {
  readonly urls: string[];
  lastProvider = '';
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(urls: string[], opts: RpcOptions = {}) {
    if (urls.length === 0) throw new Error('no RPC URL');
    this.urls = urls;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.sleep = opts.sleep ?? realSleep;
  }

  private async once(url: string, method: string, params: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'tender', method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new RpcError(`${url}: ${(e as Error).message}`, 'transient', url);
    }
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      throw new RpcError(`${url}: HTTP ${res.status}`, 'transient', url, undefined, res.status);
    }
    if (!res.ok) throw new RpcError(`${url}: HTTP ${res.status}`, 'permanent', url);
    let j: { result?: unknown; error?: JsonRpcError };
    try {
      j = (await res.json()) as typeof j;
    } catch (e) {
      throw new RpcError(`${url}: bad JSON (${(e as Error).message})`, 'transient', url);
    }
    if (j.error) {
      const cause = j.error.cause?.name ?? j.error.name;
      const detail = typeof j.error.data === 'string' ? j.error.data : JSON.stringify(j.error.data ?? j.error.message);
      const kind: RpcErrorKind = cause && TRANSIENT_CAUSES.has(cause) ? 'transient' : 'permanent';
      throw new RpcError(`${cause ?? 'RPC error'}: ${detail}`, kind, url, cause);
    }
    // Older nodes report a contract panic in a view as result.error (a string): deterministic.
    const r = j.result as { error?: unknown } | undefined;
    if (r && typeof r.error === 'string') throw new RpcError(r.error, 'permanent', url, 'FunctionCallError');
    return j.result;
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    let last: RpcError | undefined;
    for (const [u, url] of this.urls.entries()) {
      for (const [a, wait] of BACKOFF_MS.entries()) {
        try {
          const out = await this.once(url, method, params);
          this.lastProvider = url;
          return out as T;
        } catch (e) {
          if (!(e instanceof RpcError)) throw e;
          last = e;
          // Deterministic answers are the same everywhere. An HTTP 4xx is about this provider: try the next one.
          if (e.kind === 'permanent') {
            if (e.cause_name !== undefined) throw e;
            break;
          }
          // Rate limited: another provider answers sooner than this one after a backoff.
          if (e.status === 429 && u < this.urls.length - 1) break;
          const lastAttempt = u === this.urls.length - 1 && a === BACKOFF_MS.length - 1;
          if (!lastAttempt) await this.sleep(wait);
        }
      }
    }
    throw last ?? new RpcError('no provider answered', 'transient', '');
  }

  private static at(block?: bigint): Record<string, unknown> {
    return block === undefined ? { finality: 'final' } : { block_id: Number(block) };
  }

  /** call_function view; returns the parsed JSON result (P-20). */
  async view<T>(account: string, method: string, args: object, block?: bigint): Promise<T> {
    const r = await this.call<{ result: number[] }>('query', {
      request_type: 'call_function',
      account_id: account,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      ...Rpc.at(block),
    });
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result))) as T;
  }

  viewAccount(id: string, block?: bigint): Promise<{ amount: string; locked: string; code_hash: string; storage_usage: number; block_height: number }> {
    return this.call('query', { request_type: 'view_account', account_id: id, ...Rpc.at(block) });
  }

  viewAccessKeyList(id: string, block?: bigint): Promise<{ keys: { public_key: string; access_key: unknown }[]; block_height: number }> {
    return this.call('query', { request_type: 'view_access_key_list', account_id: id, ...Rpc.at(block) });
  }

  async finalBlock(): Promise<{ height: bigint; timestamp_ns: bigint; hash: string }> {
    const b = await this.call<{ header: { height: number; timestamp_nanosec: string; hash: string } }>('block', { finality: 'final' });
    return { height: BigInt(b.header.height), timestamp_ns: BigInt(b.header.timestamp_nanosec), hash: b.header.hash };
  }

  txStatus(hash: string, sender: string): Promise<unknown> {
    return this.call('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: sender, wait_until: 'NONE' });
  }
}
