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
}

export async function loadSaleBundle(id: string): Promise<SaleBundle> {
  const sale = await getSale(id);
  if (!sale) return { id, sale, bids: [] };
  const [bids, result, keyRequestBlock] = await Promise.all([
    getAllBids(id),
    sale.state === 'Finalized' ? getResult(id).catch(() => null) : Promise.resolve(null),
    sale.key ? getKeyLog().then((log) => log.filter((k) => k.sale === id).at(-1)?.block ?? null).catch(() => null) : Promise.resolve(null),
  ]);
  return { id, sale, bids, result, keyRequestBlock };
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
