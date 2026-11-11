import { RpcAnswer, rpcRequest } from './rpc.js';

// What became of a transaction the relayer signed for one payload, read from its receipts: Tender's own `bid` / `refund`
// event says stored or refunded, with the reason. "The nonce was used" alone never says that (Tender's receipt runs later and may refund).

export type TxOutcome =
  | { kind: 'stored'; idx: number; cm?: string; nth?: number }
  | { kind: 'refunded'; reason: string; cm?: string; have?: number; idx?: number | null }
  | { kind: 'failed'; error: string } // the transaction failed inside intents.near (nonce used, deadline, balance): nothing moved
  | { kind: 'running' }; // included but its receipts are still executing, or Tender's receipt is not in the answer yet

interface TxResult {
  final_execution_status?: string;
  status?: unknown;
  transaction?: { receiver_id?: string };
  receipts_outcome?: { outcome?: { executor_id?: string; logs?: string[] } }[];
}

interface TenderEvent {
  event: string;
  data: Record<string, unknown>;
}

function tenderEvents(res: TxResult, tender: string): TenderEvent[] {
  const out: TenderEvent[] = [];
  for (const r of res.receipts_outcome ?? []) {
    if (r.outcome?.executor_id !== tender) continue;
    for (const l of r.outcome.logs ?? []) {
      if (!l.startsWith('EVENT_JSON:')) continue;
      try {
        const v = JSON.parse(l.slice('EVENT_JSON:'.length)) as { standard?: string; event?: string; data?: Record<string, unknown>[] };
        if (v.standard === 'tender' && typeof v.event === 'string' && v.data?.[0]) out.push({ event: v.event, data: v.data[0] });
      } catch {
        // not a Tender event
      }
    }
  }
  return out;
}

const num = (x: unknown): number | undefined => (typeof x === 'number' ? x : undefined);

/** Pure: the outcome of one transaction result for the bid of `signer`. */
export function classifyTx(res: TxResult, tender: string, signer: string): TxOutcome {
  const events = tenderEvents(res, tender);
  for (const e of events) {
    if (e.event === 'bid' && e.data.bidder === signer) {
      return { kind: 'stored', idx: Number(e.data.idx), ...(typeof e.data.cm === 'string' ? { cm: e.data.cm } : {}), ...(num(e.data.nth) !== undefined ? { nth: num(e.data.nth)! } : {}) };
    }
    if (e.event === 'refund' && e.data.op === 'bid' && e.data.sender_id === signer) {
      return {
        kind: 'refunded',
        reason: String(e.data.reason),
        ...(typeof e.data.cm === 'string' ? { cm: e.data.cm } : {}),
        ...(num(e.data.have) !== undefined ? { have: num(e.data.have)! } : {}),
        ...(e.data.idx === null ? { idx: null } : num(e.data.idx) !== undefined ? { idx: num(e.data.idx)! } : {}),
      };
    }
  }
  const finished = res.final_execution_status === 'FINAL' || res.final_execution_status === 'EXECUTED' || res.final_execution_status === 'EXECUTED_OPTIMISTIC';
  if (!finished) return { kind: 'running' };
  const failure = (res.status as { Failure?: unknown } | undefined)?.Failure;
  if (failure !== undefined) return { kind: 'failed', error: JSON.stringify(failure).slice(0, 200) };
  // intents.near succeeded and Tender's receipt ran, but nothing was logged: its mt_on_transfer failed and NEP-245 returned the escrow.
  const touchedTender = (res.receipts_outcome ?? []).some((r) => r.outcome?.executor_id === tender);
  return touchedTender && events.length === 0 ? { kind: 'refunded', reason: 'unlogged' } : { kind: 'running' };
}

/**
 * The transaction as the first provider that knows it reports it, `null` when no provider knows it (it may still land, or never will).
 * A provider that cannot answer at all throws: that is not an answer.
 */
export async function fetchTx(rpcUrls: string[], hash: string, senderId: string): Promise<TxResult | null> {
  try {
    return (await rpcRequest(rpcUrls, 'tx', { tx_hash: hash, sender_account_id: senderId, wait_until: 'NONE' }, { backoffMs: [0] })) as TxResult;
  } catch (e) {
    if (!(e instanceof RpcAnswer) && e instanceof Error && e.message.includes('UNKNOWN_TRANSACTION')) return null;
    throw e;
  }
}
