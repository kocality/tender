import type { ReactNode } from 'react';
import { config } from '../config';
import { twinVerdict } from '../copy';
import { priceUnitLabel } from '../lib/amounts';
import { formatPrice, formatUnits, formatUsdc, tokenLabel, tokenSymbol } from '../lib/format';
import { keyStatusLabel, openConditions } from '../lib/conditions';
import type { Sale } from '../lib/views';
import { ConditionBar } from './ConditionBar';
import { StatusPill, type Tone } from './StatusPill';
import { Timeline } from './Timeline';

const STATE_TONE: Record<Sale['state'], Tone> = {
  Open: 'accent',
  Opening: 'warn',
  Keyed: 'ok',
  Finalized: 'ok',
  Cancelled: 'neutral',
};

/** The state pill: the contract's state name, with a plain word where the name alone says little. */
function stateText(sale: Sale, nowNs: bigint): string {
  switch (sale.state) {
    case 'Open':
      return nowNs < sale.closeNs ? 'Open · taking bids' : 'Closed · waiting to be opened';
    case 'Keyed':
      return 'Keyed · key public';
    case 'Finalized':
      return 'Finalized · sold';
    default:
      return sale.state;
  }
}

/** The sale page's title: where the sale is, in words. */
export function saleHeadline(sale: Sale, nowNs: bigint): string {
  switch (sale.state) {
    case 'Open': {
      if (nowNs < sale.closeNs) return `Sale #${sale.id}: taking sealed bids`;
      const c = openConditions(sale, nowNs);
      return c.escrowOk && c.biddersOk ? `Sale #${sale.id}: closed, ready to open` : `Sale #${sale.id}: closed below its conditions`;
    }
    case 'Opening':
      return `Sale #${sale.id}: key requested`;
    case 'Keyed':
      return `Sale #${sale.id}: bids can be opened`;
    case 'Finalized':
      return `Sale #${sale.id}: sold at one price`;
    case 'Cancelled':
      return `Sale #${sale.id}: cancelled`;
  }
}

export function saleEyebrow(id: string): string {
  return `Sale #${id} · ${config.network}${config.earlierBuild ? ' · earlier build' : ''}`;
}

/** Header, public open conditions, key-request counter and a slot for the Open / Cancel buttons (WS3-T05). */
export function SaleCard({
  id,
  sale,
  nowNs,
  actions,
  children,
  asH1 = false,
  verdict = false,
  timeline,
}: {
  id: string;
  sale: Sale | null;
  nowNs: bigint;
  actions?: ReactNode;
  children?: ReactNode;
  /** The sale page has no other h1: the card title is it. */
  asH1?: boolean;
  /** The twin card: a sentence that says what the numbers mean. */
  verdict?: boolean;
  /** `mini` on twin cards; a list of one fact per node on the sale page. */
  timeline?: 'mini' | (string | null)[];
}) {
  if (!sale) {
    return (
      <section className="card sale-card" aria-label={`Sale ${id}`}>
        <p className="eyebrow">{saleEyebrow(id)}</p>
        {asH1 ? <h1 className="sale-title">{`Sale #${id} · not created yet`}</h1> : <h3 className="sale-title">{`Sale #${id} · not created yet`}</h3>}
        <p className="small muted" style={{ margin: 0 }}>
          Nothing is on chain for this sale id yet. The page checks again every few seconds.
        </p>
      </section>
    );
  }
  const cond = openConditions(sale, nowNs);
  const cancelled = keyStatusLabel(sale);
  const token = tokenSymbol(sale.token);
  const tokenId = tokenLabel(sale.token);
  return (
    <section className={asH1 ? 'card sale-card sale-head' : 'card sale-card'} aria-label={`Sale ${id}`}>
      <div className="sale-card-top">
        {/* On the sale page the h1 already names the sale: the eyebrow keeps only the network. */}
        <p className="eyebrow">{asH1 ? saleEyebrow(sale.id).replace(/^Sale #\d+ · /, '') : saleEyebrow(sale.id)}</p>
        <StatusPill tone={STATE_TONE[sale.state]}>{stateText(sale, nowNs)}</StatusPill>
      </div>
      {asH1 ? (
        <h1 className="sale-title">{saleHeadline(sale, nowNs)}</h1>
      ) : (
        <h3 className={verdict ? 'sr-only' : 'sale-title'}>Sale #{sale.id}</h3>
      )}
      {verdict ? <p className="verdict">{twinVerdict(sale, nowNs)}</p> : null}
      <p className="small muted facts">
        <span className="mono">
          {formatUnits(sale.supply, sale.decimals)} {token}
        </span>{' '}
        · minimum price (reserve) {formatPrice(sale.reserve)} {priceUnitLabel(token, sale.lotExp)} · {sale.bids} sealed {sale.bids === 1 ? 'bid' : 'bids'}
      </p>
      {token !== tokenId ? (
        <p className="small muted facts token-id">
          Token <span className="mono">{tokenId}</span>
        </p>
      ) : null}
      <p className="small muted facts">
        Seller <span className="mono">{sale.seller}</span>
        {/* Twin cards share one note under both cards that says the rest (Twin.tsx). */}
        {config.teamAccounts.includes(sale.seller) ? (verdict ? ' · team-funded demo sale (us)' : ' · team-funded demo sale: that is us, and we also run the keeper (the bot that reveals bids), the relayer (which pays the network fee for bids) and this page') : ''}
      </p>
      {timeline ? <Timeline sale={sale} nowNs={nowNs} mini={timeline === 'mini'} facts={timeline === 'mini' ? undefined : timeline} /> : null}
      <ConditionBar sale={sale} />
      {sale.state === 'Open' && cond.closed && (!cond.escrowOk || !cond.biddersOk) ? (
        <p className="note info">
          {`Open conditions not met: ${formatUsdc(sale.escrowTotal)} USDC deposited (needed ${formatUsdc(sale.minEscrow)}), ${sale.bidders} ${sale.bidders === 1 ? 'bidder' : 'bidders'} (needed ${sale.minBidders})`}
        </p>
      ) : null}
      {/* Once the key is out, the Open panel's "Key requested · released" line carries the count: one key element per card. */}
      {sale.key ? null : (
        <p className="small key-count">
          Key requests: <strong className="mono">{sale.keyRequests}</strong>
          {sale.inFlight ? ' · request in flight' : ''}
        </p>
      )}
      {cancelled ? <p className={sale.keyRequests === 0 ? 'result neutral' : 'result warn'}>{cancelled}</p> : null}
      {actions}
      {children}
    </section>
  );
}
