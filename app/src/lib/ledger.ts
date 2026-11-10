import { config } from '../config';
import type { KeyReq } from './views';

export interface Receipt {
  receiptId: string;
  txHash: string;
  blockHeight: bigint;
  predecessor: string;
  receiver: string;
}

export interface LedgerRow {
  entry: KeyReq;
  receipt: Receipt | null;
}

/** A receipt belongs to a ledger entry when it lands in the entry's block or up to 3 blocks later. */
const MATCH_WINDOW = 3n;

/**
 * One NearBlocks request for the contract's `request_app_private_key` receipts. Only calls the contract itself made to
 * the MPC contract count: anyone can call the method on either account, and those receipts are not ledger entries.
 * Any failure (rate limit, network, unexpected shape) returns `null`: the page then shows the contract's own ledger with
 * an "unavailable" warning.
 */
export async function fetchNearblocksReceipts(contractId: string, mpcId: string = config.mpcContractId): Promise<Receipt[] | null> {
  try {
    const url = `${config.nearblocksApiUrl}/accounts/${contractId}/receipts?method=request_app_private_key&limit=100`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const receipts = parseReceipts(await res.json());
    return receipts?.filter((r) => r.predecessor === contractId && r.receiver === mpcId) ?? null;
  } catch {
    return null;
  }
}

export function parseReceipts(body: unknown): Receipt[] | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const out: Receipt[] = [];
  for (const r of data) {
    const o = r as Record<string, unknown>;
    const block = (o.block as { block_height?: unknown } | undefined)?.block_height;
    if (typeof o.receipt_id !== 'string' || (typeof block !== 'number' && typeof block !== 'string')) return null;
    out.push({
      receiptId: o.receipt_id,
      txHash: typeof o.transaction_hash === 'string' ? o.transaction_hash : '',
      blockHeight: BigInt(block),
      predecessor: typeof o.predecessor_account_id === 'string' ? o.predecessor_account_id : '',
      receiver: typeof o.receiver_account_id === 'string' ? o.receiver_account_id : '',
    });
  }
  return out;
}

/** Pairs every ledger entry with the earliest unused receipt whose block is in [entry.block, entry.block + 3]. */
export function matchLedger(keyLog: KeyReq[], receipts: Receipt[] | null): LedgerRow[] {
  const used = new Set<string>();
  return keyLog.map((entry) => {
    const hit =
      receipts?.find(
        (r) => !used.has(r.receiptId) && r.blockHeight >= entry.block && r.blockHeight <= entry.block + MATCH_WINDOW,
      ) ?? null;
    if (hit) used.add(hit.receiptId);
    return { entry, receipt: hit };
  });
}

export type ReceiptCheck = 'match' | 'mismatch' | 'unavailable';

/** `match`: every ledger entry has a receipt and no receipt is left over. */
export function receiptCheck(rows: LedgerRow[], receipts: Receipt[] | null): ReceiptCheck {
  if (receipts === null) return 'unavailable';
  const matched = rows.filter((r) => r.receipt !== null).length;
  return matched === rows.length && matched === receipts.length ? 'match' : 'mismatch';
}
