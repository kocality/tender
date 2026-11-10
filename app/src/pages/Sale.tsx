import { CipherWall } from '../components/CipherWall';
import { Countdown } from '../components/Countdown';
import { SaleCard } from '../components/SaleCard';
import { config } from '../config';
import { OPEN_RULE } from '../copy';
import { useChainClock } from '../lib/chainClock';
import { loadSaleBundle, type SaleBundle } from '../lib/loaders';
import { usePolling } from '../lib/usePolling';

export function SaleView({ bundle, nowNs }: { bundle: SaleBundle; nowNs: bigint }) {
  const { id, sale, bids } = bundle;
  return (
    <div>
      <SaleCard id={id} sale={sale} nowNs={nowNs}>
        {sale ? (
          <div style={{ marginTop: 12 }}>
            <Countdown closeNs={sale.closeNs} nowNs={nowNs} />
          </div>
        ) : null}
      </SaleCard>
      {sale ? (
        <>
          <h2>Ciphertext wall</h2>
          <CipherWall bids={bids} />
          <p className="muted small">{OPEN_RULE}</p>
          <p className="small">
            <a href={`#/bid/${id}`}>Place a sealed bid</a> · <a href="#/keys">Key ledger</a>
          </p>
        </>
      ) : null}
    </div>
  );
}

export function Sale({ id }: { id: string }) {
  const { nowNs } = useChainClock();
  const { data, error, loading } = usePolling(() => loadSaleBundle(id), 5000, [id]);
  return (
    <>
      {error ? <p className="note">Could not read {config.tenderContractId}: {error}</p> : null}
      {loading && !data ? <p className="muted">Loading sale…</p> : null}
      {data ? <SaleView bundle={data} nowNs={nowNs} /> : null}
    </>
  );
}
