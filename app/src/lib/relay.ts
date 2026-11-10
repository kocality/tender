import { classifyIntentsError, type IntentsErrorKind, type MultiPayload } from '@tender/intents';
import { config } from '../config';
import { getAllBids, type Bid } from './views';

export class RelayError extends Error {
  constructor(
    message: string,
    readonly kind: IntentsErrorKind | 'busy' | 'unconfigured' | 'unavailable',
    readonly txHash?: string,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

/**
 * Hand signed payloads to the relayer, which simulates and then calls execute_intents. A 400 `simulate_failed` carries
 * the Intents panic text in `detail`; it is classified here so the wizard can route the user.
 */
export async function relay(signed: MultiPayload[], url: string = config.relayerUrl): Promise<{ txHash: string }> {
  if (!url) throw new RelayError('No relayer is configured (VITE_RELAYER_URL). Run `pnpm relay:local` or relay the signed payload yourself.', 'unconfigured');
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed }) });
  } catch {
    throw new RelayError('The relayer is not reachable. Run `pnpm relay:local` or relay the signed payload yourself.', 'unavailable');
  }
  const body = (await res.json().catch(() => ({}))) as { txHash?: string; error?: string; detail?: string };
  if (res.ok && body.txHash) return { txHash: body.txHash };
  if (res.status === 429) throw new RelayError('Relayer busy, retry in 30 s', 'busy');
  const detail = body.detail ?? body.error ?? `relayer answered ${res.status}`;
  if (res.status === 400 && body.error === 'simulate_failed') throw new RelayError(detail, classifyIntentsError(detail));
  // A relayer-side failure (502 upstream, 503 low allowance) says nothing about the signed payload: the user may try again.
  if (res.status >= 500) throw new RelayError(detail, 'unavailable', body.txHash);
  throw new RelayError(detail, classifyIntentsError(detail), body.txHash);
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * After a relay the contract may still refund the transfer (late, bid limit reached, ...): look for the stored bid.
 * Polls every 5 s. `null` = the reads worked and the bid was not there; `'unknown'` = the last read failed, so the
 * absence proves nothing (a rate-limited RPC must not read as a refund).
 */
export async function pollBid(
  find: (bids: Bid[]) => Bid | undefined,
  id: string,
  opts: { timeoutMs?: number; intervalMs?: number; load?: (id: string) => Promise<Bid[]> } = {},
): Promise<Bid | null | 'unknown'> {
  const { timeoutMs = 90_000, intervalMs = 5000, load = getAllBids } = opts;
  const end = Date.now() + timeoutMs;
  for (;;) {
    let readOk = true;
    const hit = find(
      await load(id).catch(() => {
        readOk = false;
        return [];
      }),
    );
    if (hit) return hit;
    if (Date.now() + intervalMs > end) return readOk ? null : 'unknown';
    await wait(intervalMs);
  }
}

/** The stored bid for this signer and commitment, `null` when it is not there, `'unknown'` when the last read failed. */
export function confirmBid(o: { sale: string; bidder: string; cm: string; timeoutMs?: number; intervalMs?: number; load?: (id: string) => Promise<Bid[]> }): Promise<Bid | null | 'unknown'> {
  return pollBid((bids) => bids.find((b) => b.bidder === o.bidder && b.cm === o.cm), o.sale, o);
}
