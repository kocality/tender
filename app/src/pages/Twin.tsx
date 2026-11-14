import { CipherWall } from '../components/CipherWall';
import { Rail } from '../components/Rail';
import { Rich } from '../components/Rich';
import { STATE_TONE, SaleCard } from '../components/SaleCard';
import { StatTile } from '../components/StatTile';
import { StatusPill } from '../components/StatusPill';
import { useReveal } from '../components/Reveal';
import { config } from '../config';
import { HOME, OPEN_RULE, TIMELINE_NODES, VERIFY_KEYS_LINE, cancelledLabel, openCheckLine, timelineStage, twinVerdict } from '../copy';
import { formatCountdown, formatNsUtc, formatPrice } from '../lib/format';
import type { SaleBundle } from '../lib/loaders';
import type { OpenCheck } from '../lib/openCheck';
import type { Sale } from '../lib/views';

/** "Both close in 02:14:09 · …" while a twin sale still takes bids; one line per sale when their close times differ. */
function ClockLine({ sales, nowNs }: { sales: Sale[]; nowNs: bigint }) {
  const sameClose = sales.every((s) => s.closeNs === sales[0]!.closeNs);
  const groups = sameClose ? [{ who: sales.length > 1 ? 'Both' : `Sale #${sales[0]!.id}`, closeNs: sales[0]!.closeNs }] : sales.map((s) => ({ who: `Sale #${s.id}`, closeNs: s.closeNs }));
  return (
    <div className="clock-line">
      {groups
        .filter((g) => g.closeNs > nowNs)
        .map((g) => (
          <p key={g.who} className="mono small">
            {`${g.who} ${g.who === 'Both' ? 'close' : 'closes'} in `}
            <span className="countdown" aria-live="off">
              {formatCountdown(g.closeNs - nowNs)}
            </span>
            {` · ${formatNsUtc(g.closeNs)}`}
          </p>
        ))}
    </div>
  );
}

/** The pill's word on a twin card; its colour is the sale page's (STATE_TONE), so a state looks the same everywhere. */
const PILL: Record<Sale['state'], string> = {
  Open: 'Taking bids',
  Opening: 'Key requested',
  Keyed: 'Opened',
  Finalized: 'Finalized',
  Cancelled: 'Cancelled',
};

/** The four numbers of a twin card, all read from the chain. The last one depends on where the sale is. */
function tiles(b: SaleBundle, sale: Sale): { value: string; label: string; glow?: boolean }[] {
  const out: { value: string; label: string; glow?: boolean }[] = [
    { value: formatPrice(sale.escrowTotal), label: 'USDC deposited' },
    { value: String(sale.bidders), label: sale.bidders === 1 ? 'bidder' : 'bidders' },
    { value: String(sale.keyRequests), label: sale.keyRequests === 1 ? 'key request' : 'key requests' },
  ];
  if (sale.state === 'Finalized' && b.result?.pStar != null) out.push({ value: formatPrice(b.result.pStar), label: 'clearing price', glow: true });
  else if (sale.state === 'Cancelled') {
    // Every payout of a cancelled sale is a refund.
    if (sale.payoutsTotal > 0) out.push({ value: `${Math.floor((sale.payoutsDone * 100) / sale.payoutsTotal)}%`, label: 'refunded' });
  } else out.push({ value: String(sale.bids), label: sale.bids === 1 ? 'sealed bid' : 'sealed bids' });
  return out;
}

function railLabel(sale: Sale, nowNs: bigint): string {
  const { at, branch } = timelineStage(sale, nowNs);
  if (branch) return `Sealed, closed, checked, then cancelled: ${branch}`;
  return `Step ${at + 1} of 5: ${TIMELINE_NODES[at]}`;
}

/** Two sales side by side: numbers read from the chain, the words one click away in each card's "More". Pure, so it can be rendered in tests. */
export function TwinView({
  bundles,
  nowNs,
  checks = {},
  stale = false,
}: {
  bundles: SaleBundle[];
  nowNs: bigint;
  checks?: Record<string, OpenCheck>;
  /** The latest re-read failed: the numbers on screen are the last ones read, and the caption says so. */
  stale?: boolean;
}) {
  const sales = bundles.flatMap((b) => (b.sale ? [b.sale] : []));
  const noneOpen = sales.length > 0 && !sales.some((s) => s.state === 'Open' && nowNs < s.closeNs);
  // The notes that cover both cards sit in the first card's fold.
  const first = bundles.find((b) => b.sale)?.id;
  return (
    <div className="twin-view">
      {sales.some((s) => s.closeNs > nowNs) ? <ClockLine sales={sales} nowNs={nowNs} /> : null}
      {sales.length === 0 ? <p className="muted small">No sale created yet.</p> : null}
      <div className="twins">
        {bundles.map((b, i) =>
          b.sale ? (
            <TwinCard key={b.id} bundle={b} sale={b.sale} nowNs={nowNs} check={checks[b.id]} notes={b.id === first} last={i === bundles.length - 1} noneOpen={noneOpen} />
          ) : (
            <SaleCard key={b.id} id={b.id} sale={null} nowNs={nowNs} />
          ),
        )}
      </div>
      <p className="chain-note small">
        <span className={stale ? 'dot' : 'dot live'} aria-hidden="true" />
        {stale ? `Last read from NEAR ${config.network}` : `${HOME.liveCaption} ${config.network}`}
        {' · '}
        <a href="#/trust?at=check">
          Evidence<span aria-hidden="true">{' →'}</span>
        </a>
        {' · '}
        <a href="#/sales">
          All sales<span aria-hidden="true">{' →'}</span>
        </a>
      </p>
    </div>
  );
}

function TwinCard({
  bundle,
  sale,
  nowNs,
  check,
  notes,
  last,
  noneOpen,
}: {
  bundle: SaleBundle;
  sale: Sale;
  nowNs: bigint;
  check?: OpenCheck;
  notes: boolean;
  last: boolean;
  noneOpen: boolean;
}) {
  const ref = useReveal<HTMLElement>();
  const { at, branch } = timelineStage(sale, nowNs);
  const word = PILL[sale.state];
  const label = cancelledLabel(sale.state, sale.keyRequests);
  const takesBids = sale.state === 'Open' && nowNs < sale.closeNs;
  const n = bundle.bids.length;
  return (
    <article className="twin" ref={ref} aria-labelledby={`twin-${bundle.id}`}>
      <div className="twin-head">
        <h3 id={`twin-${bundle.id}`}>{`Sale #${sale.id}`}</h3>
        <StatusPill tone={STATE_TONE[sale.state]}>{word}</StatusPill>
        {config.teamAccounts.includes(sale.seller) ? <span className="pill quiet">team-funded demo sale (us)</span> : null}
      </div>
      <Rail at={at} complete={sale.state === 'Finalized'} failed={branch !== null} label={railLabel(sale, nowNs)} />
      <div className="stats">
        {tiles(bundle, sale).map((t) => (
          <StatTile key={t.label} value={t.value} label={t.label} glow={t.glow} />
        ))}
      </div>
      {/* The strongest proof on the card, at rest: this browser opened every bid and each matched (details in More). */}
      {check && check.total > 0 && check.opened === check.total ? (
        <p className="result ok twin-check small">{`Checked in your browser: ${check.opened}/${check.total} match`}</p>
      ) : null}
      <div className="twin-foot">
        <details className="fold">
          <summary>More</summary>
          <p className="small">{twinVerdict(sale, nowNs)}</p>
          {label ? <p className="small">{label}</p> : null}
          {config.demoFailSales.includes(bundle.id) ? <p className="small">Team demo: this sale was configured by us to miss its open thresholds.</p> : null}
          {check ? (
            <p className="small">
              {openCheckLine(check)}
              {check.lastLook.length > 0 ? (
                <>
                  {' '}
                  <a href="#/trust">
                    The limit<span aria-hidden="true">{' →'}</span>
                  </a>
                </>
              ) : null}
            </p>
          ) : null}
          <p className="small muted">{`The ${n} sealed ${n === 1 ? 'bid' : 'bids'}, as stored on chain:`}</p>
          <CipherWall bids={bundle.bids} />
          {notes ? (
            <>
              <p className="small">{OPEN_RULE}</p>
              <p className="small">
                <Rich text={VERIFY_KEYS_LINE} /> · <a href="#/keys">Key ledger</a>
              </p>
              <p className="small muted">{`NEAR ${config.network}${config.earlierBuild ? ', on an earlier build of the contract than the one we lock' : ''}. ${HOME.liveNote}`}</p>
            </>
          ) : null}
          {last && noneOpen ? <p className="small muted">{HOME.noOpenSale}</p> : null}
        </details>
        <span className="twin-links">
          {takesBids ? (
            <a className="btn btn-sm primary" href={`#/bid/${bundle.id}`} aria-label={`Bid, sale ${bundle.id}`}>
              Bid
            </a>
          ) : null}
          {/* The accessible name starts with the visible words (WCAG 2.5.3), then says which sale. */}
          <a className="btn btn-sm" href={`#/sale/${bundle.id}`} aria-label={`Open sale page, sale ${bundle.id}`}>
            Open sale<span aria-hidden="true">{' →'}</span>
          </a>
        </span>
      </div>
    </article>
  );
}
