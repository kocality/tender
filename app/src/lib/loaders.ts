import { finalBlockHeight } from '@tender/intents';
import { config } from '../config';
import { fetchNearblocksReceipts, matchLedger, type LedgerRow, type Receipt } from './ledger';
import { getAllBids, getAllSales, getKeyLog, getMpcVersion, getResult, getSale, type Bid, type Sale, type SaleResult } from './views';

export interface SaleBundle {
  id: string;
  sale: Sale | null;
  bids: Bid[];
  /** Stored clearing result; only read once the sale is Finalized. */
  result?: SaleResult | null;
  /** Block of the sale's latest key request, for "key released after k blocks". */
  keyRequestBlock?: bigint | null;
  /** Chain time of the pending key request while one is in flight (C-02: dead after an hour). */
  keyRequestNs?: bigint | null;
}

/** One final height for every view of a bundle: sale, bids, result and key log describe the same block, not three different ones. */
export async function loadSaleBundle(id: string): Promise<SaleBundle> {
  const at = await finalBlockHeight(config.rpcUrls);
  const sale = await getSale(id, at);
  if (!sale) return { id, sale, bids: [] };
  const [bids, result, keyRequest] = await Promise.all([
    getAllBids(id, at),
    sale.state === 'Finalized' ? getResult(id, at).catch(() => null) : Promise.resolve(null),
    sale.key || sale.inFlight ? getKeyLog(at).then((log) => log.filter((k) => k.sale === id).at(-1) ?? null).catch(() => null) : Promise.resolve(null),
  ]);
  return { id, sale, bids, result, keyRequestBlock: sale.key ? (keyRequest?.block ?? null) : null, keyRequestNs: sale.inFlight ? (keyRequest?.ns ?? null) : null };
}

export interface SaleRow {
  sale: Sale;
  /** Stored clearing result; only read for a Finalized sale. */
  result: SaleResult | null;
}

/** Every sale, with the clearing result of each Finalized one (for its P*). */
export async function loadSales(): Promise<SaleRow[]> {
  const sales = await getAllSales();
  return Promise.all(sales.map(async (sale) => ({ sale, result: sale.state === 'Finalized' ? await getResult(sale.id).catch(() => null) : null })));
}

export interface KeysData {
  mpc: string;
  mpcVersion: string | null;
  rows: LedgerRow[];
  /** `null` = NearBlocks unavailable (rate limit or network); the contract's own ledger is still shown. */
  receipts: Receipt[] | null;
  sales: Sale[];
}

export async function loadKeys(): Promise<KeysData> {
  const [mpcVersion, keyLog, sales, receipts] = await Promise.all([
    getMpcVersion().catch(() => null),
    getKeyLog(),
    getAllSales(),
    fetchNearblocksReceipts(config.tenderContractId), // one request per page load, never polled (V3)
  ]);
  return { mpc: config.mpcContractId, mpcVersion, rows: matchLedger(keyLog, receipts), receipts, sales };
}
