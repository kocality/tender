import { CipherWall } from '../components/CipherWall';
import { Countdown } from '../components/Countdown';
import { OpenPanel } from '../components/OpenPanel';
import { SaleCard } from '../components/SaleCard';
import { config } from '../config';
import { OPEN_RULE, VERIFY_KEYS_LINE } from '../copy';
import { useChainClock } from '../lib/chainClock';
import { loadSaleBundle, type SaleBundle } from '../lib/loaders';
import { usePolling } from '../lib/usePolling';

/** Two sales side by side, one shared countdown (or two when their close times differ). Pure, so it can be rendered in tests. */
export function TwinView({ bundles, nowNs }: { bundles: SaleBundle[]; nowNs: bigint }) {
  const sales = bundles.flatMap((b) => (b.sale ? [b.sale] : []));
  const sameClose = sales.length > 0 && sales.every((s) => s.closeNs === sales[0]!.closeNs);
  return (
    <div>
      <h1>Sealed token sales</h1>
      <div className="card" style={{ marginBottom: 16 }}>
        {sales.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No sale created yet.
          </p>
        ) : sameClose ? (
          <Countdown closeNs={sales[0]!.closeNs} nowNs={nowNs} />
        ) : (
          <div className="row" style={{ gap: 32 }}>
            {sales.map((s) => (
              <Countdown key={s.id} closeNs={s.closeNs} nowNs={nowNs} label={`Sale #${s.id}`} />
            ))}
          </div>
        )}
      </div>
      <div className="grid-2">
        {bundles.map((b) => (
          <SaleCard key={b.id} id={b.id} sale={b.sale} nowNs={nowNs} actions={b.sale ? <OpenPanel sale={b.sale} nowNs={nowNs} keyRequestBlock={b.keyRequestBlock} /> : undefined}>
            {b.sale ? (
              <>
                <h3 style={{ marginTop: 12 }}>Ciphertext wall</h3>
                <CipherWall bids={b.bids} />
                <p className="small">
                  <a href={`#/sale/${b.id}`}>Open sale page</a>
                </p>
              </>
            ) : null}
          </SaleCard>
        ))}
      </div>
      <p className="muted small" style={{ marginTop: 16 }}>
        {OPEN_RULE}
      </p>
      <p className="small">
        <code>{VERIFY_KEYS_LINE.replace(/`/g, '')}</code> · <a href="#/keys">Key ledger</a>
      </p>
    </div>
  );
}

export function Twin() {
  const { nowNs } = useChainClock();
  const [a, b] = config.twinSales;
  const { data, error, loading } = usePolling(() => Promise.all([loadSaleBundle(a), loadSaleBundle(b)]), 5000, [a, b]);
  return (
    <>
      {error ? <p className="note">Could not read {config.tenderContractId}: {error}</p> : null}
      {loading && !data ? <p className="muted">Loading sales…</p> : null}
      {data ? <TwinView bundles={data} nowNs={nowNs} /> : null}
    </>
  );
}
