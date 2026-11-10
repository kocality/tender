import type { ReactNode } from 'react';
import { formatUnits, formatUsdc, tokenLabel } from '../lib/format';
import { keyStatusLabel, openConditions } from '../lib/conditions';
import type { Sale } from '../lib/views';
import { ConditionBar } from './ConditionBar';
import { StatusPill, type Tone } from './StatusPill';

const STATE_TONE: Record<Sale['state'], Tone> = {
  Open: 'ok',
  Opening: 'warn',
  Keyed: 'ok',
  Finalized: 'neutral',
  Cancelled: 'bad',
};

/** Header, public open conditions, key-request counter and a slot for the Open / Cancel buttons (WS3-T05). */
export function SaleCard({
  id,
  sale,
  nowNs,
  actions,
  children,
}: {
  id: string;
  sale: Sale | null;
  nowNs: bigint;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  if (!sale) {
    return (
      <section className="card" aria-label={`Sale ${id}`}>
        <h2 style={{ marginTop: 0 }}>{`Sale #${id} · not created yet`}</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Nothing is on chain for this sale id yet. The page checks again every few seconds.
        </p>
      </section>
    );
  }
  const cond = openConditions(sale, nowNs);
  const cancelled = keyStatusLabel(sale);
  return (
    <section className="card" aria-label={`Sale ${id}`}>
      <div className="row">
        <h2 style={{ margin: 0 }}>Sale #{sale.id}</h2>
        <StatusPill tone={STATE_TONE[sale.state]}>{sale.state}</StatusPill>
      </div>
      <p className="small muted" style={{ margin: '4px 0 12px' }}>
        {formatUnits(sale.supply, sale.decimals)} {tokenLabel(sale.token)} · reserve {formatUsdc(sale.reserve)} USDC · {sale.bids} sealed bids
      </p>
      <ConditionBar sale={sale} />
      {sale.state === 'Open' && cond.closed && (!cond.escrowOk || !cond.biddersOk) ? (
        <p className="note">
          {`Open conditions not met: escrow ${formatUsdc(sale.escrowTotal)} / ${formatUsdc(sale.minEscrow)} USDC, bidders ${sale.bidders} / ${sale.minBidders}`}
        </p>
      ) : null}
      <p className="small">
        key requests: <strong>{sale.keyRequests}</strong>
        {sale.inFlight ? ' · request in flight' : ''}
      </p>
      {cancelled ? <p className="result bad">{cancelled}</p> : null}
      {actions}
      {children}
    </section>
  );
}
