import { Account, FailoverRpcError, FailoverRpcProvider, JsonRpcProvider, baseEncode, type Provider, type Signer } from "near-api-js";
import { InvalidNonceError } from "near-api-js/rpc-errors";

// Relayer runtime: near-api-js and Node built-ins only (D4-03), no @tender/* imports.

export type Network = "mainnet" | "testnet";
type KeyPairString = `ed25519:${string}`;

// rpc.mainnet.near.org and rpc.testnet.near.org are deprecated (they answer -429 DEPRECATED under load): fastnear first, then two independent public providers.
export const RPCS: Record<Network, string[]> = {
  mainnet: ["https://free.rpc.fastnear.com", "https://near.drpc.org", "https://rpc.shitzuapes.xyz"],
  testnet: ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org", "https://testnet-rpc.intea.rs"],
};

/** The contract panicked: `panicMsg` is its own text (for example "insufficient balance or overflow"). */
export class ViewPanic extends Error {
  constructor(readonly panicMsg: string) {
    super(panicMsg);
    this.name = "ViewPanic";
  }
}

/**
 * FailoverRpcProvider wraps every error, an InvalidNonce included, in a FailoverRpcError, so Account never sees the
 * InvalidNonceError that makes it drop its cached nonce and retry. A nonce is not a provider fault: hand it through.
 */
export class NonceAwareFailoverProvider extends FailoverRpcProvider {
  override async sendTransactionUntil(...args: Parameters<FailoverRpcProvider["sendTransactionUntil"]>) {
    try {
      return await super.sendTransactionUntil(...args);
    } catch (e) {
      const nonce = e instanceof FailoverRpcError ? e.errors.find((x) => x instanceof InvalidNonceError) : undefined;
      throw nonce ?? e;
    }
  }
}

export function makeProvider(network: Network, urls: string[] = RPCS[network]): FailoverRpcProvider {
  return new NonceAwareFailoverProvider(urls.map((url) => new JsonRpcProvider({ url }, { retries: 3 }))); // a 503 moves to the next URL in about a second, not after 12 backed-off tries (about 86 s, past the 60 s function limit)
}

/**
 * A transaction's hash is fixed when it is signed, before any RPC sees it. Pass `signer` to `signAndSendTransaction`:
 * `hashes` then lists every transaction signed (an InvalidNonce retry signs again), so a send whose answer is lost can still be looked up.
 */
export function recordSigned(account: Account): { signer: Signer | undefined; hashes: string[] } {
  const hashes: string[] = [];
  const base: any = account.getSigner();
  const signer = base && new Proxy(base, {
    get: (t, k) => k === "signTransaction"
      ? async (tx: unknown) => {
        const r = await t.signTransaction(tx);
        hashes.push(baseEncode(r.txHash));
        return r;
      }
      : typeof t[k] === "function" ? t[k].bind(t) : t[k],
  });
  return { signer, hashes };
}

export function makeAccount(accountId: string, keyPairString: KeyPairString, network: Network, urls?: string[], provider: Provider = makeProvider(network, urls)): Account {
  return new Account(accountId, provider, keyPairString);
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

/** The access key does not exist on chain (a rotated or wrong key); any other failure is an RPC problem, not an answer. */
export class UnknownAccessKey extends Error {
  constructor(accountId: string, publicKey: string) {
    super(`access key ${publicKey} of ${accountId} does not exist`);
    this.name = "UnknownAccessKey";
  }
}

export interface AccessKeyInfo { kind: "FullAccess" | "FunctionCall"; allowance: bigint | null; receiverId?: string; methodNames?: string[] }

/** view_access_key. Throws UnknownAccessKey when the key is not on chain, a plain Error when no node answers. */
export async function accessKeyInfo(urls: string[], accountId: string, publicKey: string): Promise<AccessKeyInfo> {
  let r: any;
  try {
    r = await rpc(urls, "query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey });
  } catch (e) {
    if (/UNKNOWN_ACCESS_KEY/.test((e as Error).message)) throw new UnknownAccessKey(accountId, publicKey);
    throw e;
  }
  if (typeof r.error === "string") {
    if (/does not exist/.test(r.error)) throw new UnknownAccessKey(accountId, publicKey);
    throw new Error(`view_access_key: ${r.error.slice(0, 300)}`);
  }
  const p = r.permission;
  if (p === "FullAccess") return { kind: "FullAccess", allowance: null };
  const fc = p?.FunctionCall;
  if (!fc) throw new Error("view_access_key: unknown permission shape");
  return { kind: "FunctionCall", allowance: fc.allowance === null || fc.allowance === undefined ? null : BigInt(fc.allowance), receiverId: fc.receiver_id, methodNames: fc.method_names };
}

const YOCTO_PER_STORAGE_BYTE = 10n ** 19n;

/** Balance minus the storage stake, in yocto: what the account can actually burn on gas. */
export async function spendableBalance(urls: string[], accountId: string): Promise<bigint> {
  const r = await rpc(urls, "query", { request_type: "view_account", finality: "final", account_id: accountId });
  const free = BigInt(r.amount) - BigInt(r.storage_usage) * YOCTO_PER_STORAGE_BYTE;
  return free > 0n ? free : 0n;
}
