import { useEffect, useState } from 'react';
import { config } from '../config';
import { decryptSale, revealedWithoutCiphertext, type DecryptResult } from './decrypt';
import type { SaleBundle } from './loaders';
import { getConfig, type Bid, type Config } from './views';

/** What this browser found when it opened a sale's bids with the released key. */
export interface OpenCheck {
  total: number;
  /** Bids that decrypt and match the commitment their bidder stored. */
  opened: number;
  /** Revealed bids whose ciphertext does not open to what was revealed: the last-look case. */
  lastLook: number[];
  /** Bids that do not open and were not revealed (they can lose 10%). */
  closed: number[];
}

export function summarizeCheck(bids: Pick<Bid, 'idx' | 'state' | 'p' | 'q'>[], result: DecryptResult): OpenCheck | null {
  if (!result.keyOk) return null;
  const rows = new Map(result.rows.map((r) => [r.idx, r]));
  const lastLook = bids.filter((b) => revealedWithoutCiphertext(b, rows.get(b.idx))).map((b) => b.idx);
  const closed = bids.filter((b) => b.state !== 'Revealed' && rows.get(b.idx)?.status !== 'ok').map((b) => b.idx);
  return { total: bids.length, opened: result.rows.filter((r) => r.status === 'ok').length, lastLook, closed };
}

let cfg: Promise<Config> | null = null;

/**
 * Opens the bids of every twin sale whose key is public, in this browser, once per sale and key, so the home page can
 * say up front what the sale page will show. Nothing is sent anywhere; a failed read leaves the card without the line.
 */
export function useOpenChecks(bundles: SaleBundle[] | null): Record<string, OpenCheck> {
  const [checks, setChecks] = useState<Record<string, OpenCheck>>({});
  const keyed = (bundles ?? []).filter((b) => b.sale?.key && b.bids.length > 0);
  const sig = keyed.map((b) => `${b.id}:${b.sale!.key!.block}:${b.bids.length}:${b.bids.filter((x) => x.state === 'Revealed').length}`).join('|');
  useEffect(() => {
    if (keyed.length === 0) return;
    let alive = true;
    void (async () => {
      try {
        cfg ??= getConfig().catch((e: unknown) => {
          cfg = null;
          throw e;
        });
        const c = await cfg;
        for (const b of keyed) {
          const r = await decryptSale({ config: c, sale: b.sale!, bids: b.bids, contractId: config.tenderContractId });
          const s = summarizeCheck(b.bids, r);
          if (alive && s) setChecks((m) => ({ ...m, [b.id]: s }));
        }
      } catch {
        // No line on the card; the sale page still has its own Decrypt button.
      }
    })();
    return () => {
      alive = false;
    };
    // `sig` names everything the check depends on; the bundles themselves are new objects on every poll.
  }, [sig]);
  return checks;
}
