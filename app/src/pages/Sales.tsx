import { ConditionBar } from '../components/ConditionBar';
import { Loading, ReadError } from '../components/Feedback';
import { STATE_TONE, stateText } from '../components/SaleCard';
import { StatTile } from '../components/StatTile';
import { StatusPill } from '../components/StatusPill';
import { config } from '../config';
import { cancelledLabel } from '../copy';
import { priceUnitLabel } from '../lib/amounts';
import { useChainClock } from '../lib/chainClock';
import { formatNsUtc, formatPrice, formatUnits, tokenSymbol } from '../lib/format';
import { loadSales, type SaleRow } from '../lib/loaders';
import { usePolling } from '../lib/usePolling';

/** `#/sales`: every sale on the contract, newest first; polled every 10 s. */
export function Sales() {
  const { nowNs } = useChainClock();
  const { data, error, loading } = usePolling(loadSales, 10000, []);
  return <SalesView rows={data} error={error} loading={loading} nowNs={nowNs} />;
}

/** The list of sales for one read. Pure, so it can be rendered in tests. */
export function SalesView({ rows, error, loading, nowNs }: { rows: SaleRow[] | null; error: string | null; loading: boolean; nowNs: bigint }) {
  // Ids are counters: the highest is the newest.
  const sorted = [...(rows ?? [])].sort((a, b) => (BigInt(b.sale.id) > BigInt(a.sale.id) ? 1 : -1));
  const n = sorted.length;
  const team = sorted.filter((r) => config.teamAccounts.includes(r.sale.seller)).length;
  const teamLine = n === 0 || team === 0 ? '' : team === n ? ' All are team-funded demo sales so far.' : ` ${team} of them are team-funded demo sales (us).`;
  return (
    <div className="wrap page">
      <header className="page-head">
        <p className="eyebrow">{`All sales · ${config.network}`}</p>
        <h1>{`Sales on NEAR ${config.network}.`}</h1>
        {rows ? (
          <p className="lead">
            {`${n} ${n === 1 ? 'sale' : 'sales'} on `}
            <span className="mono">{config.tenderContractId}</span>
            {`${n > 1 ? ', newest first' : ''}.${teamLine}`}
          </p>
        ) : null}
      </header>
      <ReadError error={error} stale={rows !== null} compact />
      {loading && !rows ? <Loading what="sales" /> : null}
      {rows && n === 0 ? (
        <div className="card pad empty-state" role="status">
          <p className="empty-title">{`No sales on NEAR ${config.network} yet.`}</p>
          <p className="muted">The page checks again every few seconds.</p>
        </div>
      ) : null}
      {n > 0 ? (
        <div className="twins sales-list">
          {sorted.map((r) => (
            <SaleItem key={r.sale.id} row={r} nowNs={nowNs} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SaleItem({ row, nowNs }: { row: SaleRow; nowNs: bigint }) {
  const { sale, result } = row;
  const token = tokenSymbol(sale.token);
  const takesBids = sale.state === 'Open' && nowNs < sale.closeNs;
  const label = cancelledLabel(sale.state, sale.keyRequests);
  const pStar = sale.state === 'Finalized' ? (result?.pStar ?? null) : null;
  return (
    <article className="twin" aria-labelledby={`sale-${sale.id}`}>
      <div className="twin-head">
        <h2 id={`sale-${sale.id}`}>
          <a href={`#/sale/${sale.id}`}>{`Sale #${sale.id}`}</a>
        </h2>
        <StatusPill tone={STATE_TONE[sale.state]}>{stateText(sale, nowNs)}</StatusPill>
        {config.teamAccounts.includes(sale.seller) ? <span className="pill quiet">team-funded demo sale (us)</span> : null}
        {config.demoFailSales.includes(sale.id) ? <span className="pill quiet">configured by us to miss its open thresholds</span> : null}
      </div>
      <p className="small muted facts">
        <span className="mono">
          {formatUnits(sale.supply, sale.decimals)} {token}
        </span>
        {` · minimum price ${formatPrice(sale.reserve)} ${priceUnitLabel(token, sale.lotExp)}`}
      </p>
      <p className="small muted facts mono">{`${takesBids ? 'closes' : 'closed'} ${formatNsUtc(sale.closeNs)}`}</p>
      <ConditionBar sale={sale} />
      <div className="stats sales-stats">
        <StatTile value={String(sale.bids)} label={sale.bids === 1 ? 'sealed bid' : 'sealed bids'} />
        <StatTile value={String(sale.keyRequests)} label={sale.keyRequests === 1 ? 'key request' : 'key requests'} />
        {pStar !== null ? <StatTile value={formatPrice(pStar)} label="clearing price" glow /> : null}
      </div>
      {label ? <p className={sale.keyRequests === 0 ? 'result neutral' : 'result warn'}>{label}</p> : null}
      <div className="twin-foot">
        <span className="twin-links">
          {takesBids ? (
            <a className="btn btn-sm primary" href={`#/bid/${sale.id}`} aria-label={`Bid, sale ${sale.id}`}>
              Bid
            </a>
          ) : null}
          <a className="btn btn-sm" href={`#/sale/${sale.id}`} aria-label={`Open sale page, sale ${sale.id}`}>
            Open sale<span aria-hidden="true">{' →'}</span>
          </a>
        </span>
      </div>
    </article>
  );
}
