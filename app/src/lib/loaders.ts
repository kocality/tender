import { config } from '../config';
import { fetchNearblocksReceipts, matchLedger, type LedgerRow, type Receipt } from './ledger';
import { getAllBids, getAllSales, getKeyLog, getMpcVersion, getSale, type Bid, type Sale } from './views';

export interface SaleBundle {
  id: string;
  sale: Sale | null;
  bids: Bid[];
}

export async function loadSaleBundle(id: string): Promise<SaleBundle> {
  const sale = await getSale(id);
  const bids = sale ? await getAllBids(id) : [];
  return { id, sale, bids };
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
