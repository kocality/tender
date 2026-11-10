import { useMemo, useState } from 'react';
import { Loading, ReadError } from '../components/Feedback';
import { CancelledCard } from '../components/CancelledCard';
import { CipherWall } from '../components/CipherWall';
import { Countdown } from '../components/Countdown';
import { DecryptPanel } from '../components/DecryptPanel';
import { OpenPanel } from '../components/OpenPanel';
import { ResultTable } from '../components/ResultTable';
import { RevealPanel } from '../components/RevealPanel';
import { SaleCard } from '../components/SaleCard';
import { SupplyDemandChart } from '../components/SupplyDemandChart';
import { OPEN_RULE } from '../copy';
import { useChainClock } from '../lib/chainClock';
import type { DecryptResult } from '../lib/decrypt';
import { loadSaleBundle, type SaleBundle } from '../lib/loaders';
import { recompute } from '../lib/results';
import { usePolling } from '../lib/usePolling';
import { getConfig, type Config } from '../lib/views';

export function SaleView({
  bundle,
  nowNs,
  cfg = null,
  cfgError = null,
  onRetryCfg,
}: {
  bundle: SaleBundle;
  nowNs: bigint;
  cfg?: Config | null;
  /** The failed `get_config` read, when there is one: Decrypt needs the config, so a retry is offered. */
  cfgError?: string | null;
  onRetryCfg?: () => void;
}) {
  const { id, sale, bids, result = null } = bundle;
  const [decrypted, setDecrypted] = useState<DecryptResult | null>(null);
  const recomputed = useMemo(() => (sale && sale.state === 'Finalized' && result ? recompute(sale, bids, result) : null), [sale, bids, result]);
  return (
    <div>
      <SaleCard id={id} sale={sale} nowNs={nowNs} asH1 actions={sale ? <OpenPanel sale={sale} nowNs={nowNs} keyRequestBlock={bundle.keyRequestBlock} /> : undefined}>
        {sale ? (
          <div style={{ marginTop: 12 }}>
            <Countdown closeNs={sale.closeNs} nowNs={nowNs} />
          </div>
        ) : null}
      </SaleCard>
      {sale ? (
        <>
          {sale.key ? <DecryptPanel sale={sale} bids={bids} cfg={cfg} cfgError={cfgError} onRetryCfg={onRetryCfg} result={decrypted} onResult={setDecrypted} /> : null}
          <RevealPanel sale={sale} bids={bids} decrypted={decrypted} nowNs={nowNs} />
          {sale.state === 'Finalized' && result ? (
            <>
              <ResultTable sale={sale} bids={bids} result={result} recomputed={recomputed} />
              <SupplyDemandChart sale={sale} bids={bids} pStar={result.pStar} />
            </>
          ) : null}
          <CancelledCard sale={sale} bids={bids} />
          <h2>Ciphertext wall</h2>
          <CipherWall bids={bids} />
          <p className="muted small">{OPEN_RULE}</p>
          <p className="small">
            {sale.state === 'Open' ? (
              <>
                <a href={`#/bid/${id}`}>Place a sealed bid</a> ·{' '}
              </>
            ) : null}
            <a href="#/keys">Key ledger</a>
          </p>
        </>
      ) : null}
    </div>
  );
}

export function Sale({ id }: { id: string }) {
  const { nowNs } = useChainClock();
  const { data, error, loading } = usePolling(() => loadSaleBundle(id), 5000, [id]);
  const [cfgTry, setCfgTry] = useState(0);
  const { data: cfg, error: cfgError } = usePolling(getConfig, 0, [cfgTry]);
  return (
    <>
      <ReadError error={error} stale={data !== null} />
      {loading && !data ? <Loading what="sale" /> : null}
      {data ? <SaleView key={id} bundle={data} nowNs={nowNs} cfg={cfg} cfgError={cfgError} onRetryCfg={() => setCfgTry((n) => n + 1)} /> : null}
    </>
  );
}
