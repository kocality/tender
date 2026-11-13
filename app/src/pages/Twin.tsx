import { CipherWall } from '../components/CipherWall';
import { OpenPanel } from '../components/OpenPanel';
import { Rich } from '../components/Rich';
import { SaleCard } from '../components/SaleCard';
import { config } from '../config';
import { HOME, OPEN_RULE, VERIFY_KEYS_LINE, openCheckLine } from '../copy';
import { formatCountdown, formatNsUtc } from '../lib/format';
import type { SaleBundle } from '../lib/loaders';
import type { OpenCheck } from '../lib/openCheck';
import type { Sale } from '../lib/views';

/** "Both close in 02:14:09 · …" before close, "Both closed …" after; one line per sale when their close times differ. */
function ClockLine({ sales, nowNs }: { sales: Sale[]; nowNs: bigint }) {
  const sameClose = sales.every((s) => s.closeNs === sales[0]!.closeNs);
  const groups = sameClose ? [{ who: sales.length > 1 ? 'Both' : `Sale #${sales[0]!.id}`, closeNs: sales[0]!.closeNs }] : sales.map((s) => ({ who: `Sale #${s.id}`, closeNs: s.closeNs }));
  return (
    <div className="clock-line">
      {groups.map((g) => (
        <p key={g.who} className="mono small">
          {g.closeNs > nowNs ? (
            <>
              {`${g.who} ${g.who === 'Both' ? 'close' : 'closes'} in `}
              <span className="countdown" aria-live="off">
                {formatCountdown(g.closeNs - nowNs)}
              </span>
              {` · ${formatNsUtc(g.closeNs)}`}
            </>
          ) : (
            <>
              {`${g.who} closed `}
              <span className="countdown">{formatNsUtc(g.closeNs)}</span>
            </>
          )}
        </p>
      ))}
    </div>
  );
}

/** Two sales side by side with a shared clock line. Pure, so it can be rendered in tests. */
export function TwinView({ bundles, nowNs, checks = {} }: { bundles: SaleBundle[]; nowNs: bigint; checks?: Record<string, OpenCheck> }) {
  const sales = bundles.flatMap((b) => (b.sale ? [b.sale] : []));
  return (
    <div className="twin-view">
      {sales.length > 0 ? <ClockLine sales={sales} nowNs={nowNs} /> : <p className="muted small">No sale created yet.</p>}
      <div className="grid-2">
        {bundles.map((b) => (
          <SaleCard
            key={b.id}
            id={b.id}
            sale={b.sale}
            nowNs={nowNs}
            verdict
            timeline="mini"
            actions={b.sale ? <OpenPanel sale={b.sale} nowNs={nowNs} keyRequestBlock={b.keyRequestBlock} keyRequestNs={b.keyRequestNs} /> : undefined}
          >
            {b.sale ? <TwinLinks bundle={b} sale={b.sale} nowNs={nowNs} check={checks[b.id]} /> : null}
          </SaleCard>
        ))}
      </div>
      <p className="muted small live-note">
        {`NEAR ${config.network}${config.earlierBuild ? ', on an earlier build of the contract than the one we lock' : ''}. ${HOME.liveNote}`}
      </p>
      <details className="fold">
        <summary>The exact rule, as the contract applies it</summary>
        <p className="small">{OPEN_RULE}</p>
        <p className="small">
          <Rich text={VERIFY_KEYS_LINE} /> · <a href="#/keys">Key ledger</a>
        </p>
      </details>
    </div>
  );
}

function TwinLinks({ bundle, sale, nowNs, check }: { bundle: SaleBundle; sale: Sale; nowNs: bigint; check?: OpenCheck }) {
  const opened = sale.state === 'Keyed' || sale.state === 'Finalized';
  return (
    <>
      {config.demoFailSales.includes(bundle.id) ? <p className="note">Team demo: this sale was configured by us to miss its open thresholds.</p> : null}
      {/* Said here, before the visitor presses Decrypt on the sale page and meets it there. */}
      {check ? (
        <p className={check.opened === check.total ? 'small check-line ok' : 'note check-line'}>
          {openCheckLine(check)}
          {check.lastLook.length > 0 ? (
            <>
              {' '}
              <a href="#/trust">
                The limit<span aria-hidden="true">{'\u00a0→'}</span>
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      <p className="links">
        {sale.state === 'Open' && nowNs < sale.closeNs ? <a href={`#/bid/${bundle.id}`}>Place a sealed bid →</a> : null}
        {/* The accessible name starts with the visible words (WCAG 2.5.3), then says which sale. */}
        <a href={`#/sale/${bundle.id}`} aria-label={`${opened ? 'Open the bids in your browser' : 'Open sale page'}, sale ${bundle.id}`}>
          {opened ? 'Open the bids in your browser →' : 'Open sale page →'}
        </a>
        {opened ? <a href="#/keys">See the key request →</a> : null}
      </p>
      <details className="fold">
        <summary>{`The ${bundle.bids.length} sealed ${bundle.bids.length === 1 ? 'bid' : 'bids'}, as stored on chain`}</summary>
        <CipherWall bids={bundle.bids} />
      </details>
    </>
  );
}
