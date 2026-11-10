import { cancelledLabel } from '../copy';
import type { Sale } from './views';

const DAY_NS = 86_400n * 1_000_000_000n;
const IN_FLIGHT_TIMEOUT_NS = 3_600n * 1_000_000_000n; // contract IN_FLIGHT_TIMEOUT_SECS

export interface OpenConditions {
  closed: boolean;
  escrowOk: boolean;
  biddersOk: boolean;
  canOpen: boolean;
  canCancel: boolean;
  /** Why cancel is available: public conditions failed at close, or 24 h passed after close with no key and nothing in flight. */
  cancelReason: 'conditions_not_met' | 'no_key_after_24h' | null;
  /** C-02: the key request got no answer for an hour; open and cancel end it. */
  requestDead: boolean;
}

/**
 * C13 / C19 as the contract applies them, on chain time. Cancel is only offered on an Open sale: a Cancelled or
 * Finalized sale is terminal. `requestNs` = chain time of the in-flight key request (key ledger); unknown = it is live.
 */
export function openConditions(sale: Sale, nowNs: bigint, requestNs?: bigint | null): OpenConditions {
  const closed = nowNs >= sale.closeNs;
  const escrowOk = sale.escrowTotal >= sale.minEscrow;
  const biddersOk = sale.bidders >= sale.minBidders;
  const requestDead = sale.inFlight && requestNs != null && nowNs >= requestNs + IN_FLIGHT_TIMEOUT_NS;
  const isOpen = sale.state === 'Open' || (requestDead && sale.state === 'Opening');
  const noKeyNoFlight = sale.key === null && (!sale.inFlight || requestDead);
  const canOpen = isOpen && closed && escrowOk && biddersOk && noKeyNoFlight;
  const failedAtClose = isOpen && closed && (!escrowOk || !biddersOk) && sale.keyRequests === 0;
  const timedOut = isOpen && nowNs >= sale.closeNs + DAY_NS && noKeyNoFlight;
  return {
    closed,
    escrowOk,
    biddersOk,
    canOpen,
    canCancel: failedAtClose || timedOut,
    cancelReason: failedAtClose ? 'conditions_not_met' : timedOut ? 'no_key_after_24h' : null,
    requestDead,
  };
}

/** Key status text for a Cancelled sale; `null` for every other state. */
export function keyStatusLabel(sale: Sale): string | null {
  return cancelledLabel(sale.state, sale.keyRequests);
}
