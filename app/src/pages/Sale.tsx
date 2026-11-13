import { useMemo, useState, type ReactNode } from 'react';
import { config } from '../config';
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
import { NEAR_INTENTS, OPEN_RULE, PENALTY_RULE } from '../copy';
import { priceUnitLabel } from '../lib/amounts';
import { useChainClock } from '../lib/chainClock';
import type { DecryptResult } from '../lib/decrypt';
import { formatNsUtc, formatPrice, formatUnits, formatUsdc, tokenSymbol } from '../lib/format';
import { loadSaleBundle, type SaleBundle } from '../lib/loaders';
import { recompute, refundOf } from '../lib/results';
import { usePolling } from '../lib/usePolling';
import { getConfig, type Bid, type Config, type Sale as SaleT, type SaleResult } from '../lib/views';

/** One fact under each node of the sale's timeline. */
function timelineFacts(sale: SaleT): (string | null)[] {
  const k = sale.keyRequests;
  const blocks = sale.key ? ', key released' : '';
  return [
    `${sale.bids} ${sale.bids === 1 ? 'bid' : 'bids'}, ${formatUsdc(sale.escrowTotal)} USDC deposited`,
    formatNsUtc(sale.closeNs),
    `${formatUsdc(sale.escrowTotal)} ${sale.escrowTotal >= sale.minEscrow ? '≥' : '<'} ${formatUsdc(sale.minEscrow)} USDC · ${sale.bidders} ${sale.bidders >= sale.minBidders ? '≥' : '<'} ${sale.minBidders} bidders`,
    sale.state === 'Cancelled' ? null : k > 0 ? `key requested ${k}×${blocks}` : null,
    sale.state === 'Finalized' ? `${sale.payoutsDone} of ${sale.payoutsTotal} payouts made` : null,
  ];
}

/** The finalized sale in one strip: the price every winner paid, and where the money went. */
function Outcome({ sale, bids, result }: { sale: SaleT; bids: Bid[]; result: SaleResult }) {
  const name = tokenSymbol(sale.token);
  const refunded = bids.reduce((a, b) => a + refundOf(b), 0n);
  return (
    <section className="card pad outcome" aria-label="Outcome">
      <h2>Outcome</h2>
      {result.pStar === null ? (
        <p>No bid reached the reserve, so nothing was sold and every bid was refunded.</p>
      ) : (
        <>
          <dl className="outcome-grid">
            <div>
              <dt>Every winner paid</dt>
              <dd className="price-big mono">{formatPrice(result.pStar)}</dd>
              <dd className="small muted">{priceUnitLabel(name, sale.lotExp)}</dd>
            </div>
            <div>
              <dt>Sold</dt>
              <dd className="mono">
                {formatUnits(result.sold, sale.decimals)} {name}
              </dd>
            </div>
            <div>
              <dt>Seller receives</dt>
              <dd className="mono">{formatUsdc(result.sellerUsdc)} USDC</dd>
            </div>
            <div>
              <dt>Back to bidders</dt>
              <dd className="mono">{formatUsdc(refunded)} USDC</dd>
              <dd className="small muted">unspent deposits</dd>
            </div>
          </dl>
          <p className="small muted" style={{ marginBottom: 0 }}>
            The bids were sorted from the highest price down until the whole supply was covered. The last price still needed became the price for every winner.
          </p>
        </>
      )}
    </section>
  );
}

export function SaleView({
  bundle,
  nowNs,
  cfg = null,
  cfgError = null,
  onRetryCfg,
  notice = null,
}: {
  bundle: SaleBundle;
  nowNs: bigint;
  cfg?: Config | null;
  /** The failed `get_config` read, when there is one: Decrypt needs the config, so a retry is offered. */
  cfgError?: string | null;
  onRetryCfg?: () => void;
  /** A failed re-read while older data stays on the page. */
  notice?: ReactNode;
}) {
  const { id, sale, bids, result = null } = bundle;
  const [decrypted, setDecrypted] = useState<DecryptResult | null>(null);
  const recomputed = useMemo(() => (sale && sale.state === 'Finalized' && result ? recompute(sale, bids, result) : null), [sale, bids, result]);
  const finalized = sale?.state === 'Finalized' && result;
  return (
    <div className="wrap page">
      <p className="crumb">
        <a href="#/?at=live">← Real sales</a>
      </p>
      {notice}
      <div className={sale ? 'sale-layout' : undefined}>
        <div className="sale-main">
          <SaleCard
            id={id}
            sale={sale}
            nowNs={nowNs}
            asH1
            timeline={sale ? timelineFacts(sale) : undefined}
            actions={sale ? <OpenPanel sale={sale} nowNs={nowNs} keyRequestBlock={bundle.keyRequestBlock} keyRequestNs={bundle.keyRequestNs} /> : undefined}
          >
            {sale?.state === 'Open' && nowNs < sale.closeNs ? (
              <div className="sale-clock">
                <Countdown closeNs={sale.closeNs} nowNs={nowNs} />
                <a className="btn primary" href={`#/bid/${id}`}>
                  Place a sealed bid
                </a>
              </div>
            ) : null}
          </SaleCard>
          {sale ? (
            <>
              <CancelledCard sale={sale} bids={bids} />
              {finalized ? <Outcome sale={sale} bids={bids} result={result} /> : null}
              {sale.key ? <DecryptPanel sale={sale} bids={bids} cfg={cfg} cfgError={cfgError} onRetryCfg={onRetryCfg} result={decrypted} onResult={setDecrypted} /> : null}
              <RevealPanel sale={sale} bids={bids} decrypted={decrypted} nowNs={nowNs} />
              {finalized ? (
                <>
                  <ResultTable sale={sale} bids={bids} result={result} recomputed={recomputed} decrypted={decrypted} />
                  <section className="card pad" aria-label="Demand and supply">
                    <h2>Demand against supply</h2>
                    <p className="small muted" style={{ margin: 0 }}>
                      Each step is a bid, highest price first. Where the bids together want the whole supply, the price is set.
                    </p>
                    <SupplyDemandChart sale={sale} bids={bids} pStar={result.pStar} />
                  </section>
                </>
              ) : null}
              <div className="card folds">
                <details className="fold">
                  <summary>{`Sealed data on chain (${bids.length} ${bids.length === 1 ? 'bid' : 'bids'})`}</summary>
                  <CipherWall bids={bids} />
                </details>
                <details className="fold">
                  <summary>The open rule, as the contract applies it</summary>
                  <p className="small">{OPEN_RULE}</p>
                </details>
                <details className="fold">
                  <summary>Reveal and the 10% penalty</summary>
                  <p className="small">{PENALTY_RULE}</p>
                </details>
              </div>
            </>
          ) : null}
        </div>
        {sale ? <SaleAside sale={sale} /> : null}
      </div>
    </div>
  );
}

function SaleAside({ sale }: { sale: SaleT }) {
  return (
    <aside className="sale-aside">
      <section className="card pad">
        <p className="eyebrow">Public from the start</p>
        <dl className="kv-rows">
          <dt>Deposits</dt>
          <dd className="mono">
            {formatUsdc(sale.escrowTotal)} USDC · needed {formatUsdc(sale.minEscrow)}
          </dd>
          <dt>Bidders</dt>
          <dd className="mono">
            {sale.bidders} · needed {sale.minBidders}
          </dd>
          <dt>Bids</dt>
          <dd className="mono">
            {sale.bids} · max {sale.maxBids}
          </dd>
          <dt>Closes</dt>
          <dd className="mono">{formatNsUtc(sale.closeNs)}</dd>
        </dl>
        <p className="small muted" style={{ marginBottom: 0 }}>
          {sale.key
            ? 'Prices and sizes were not public until the key was released.'
            : sale.state === 'Cancelled' && sale.keyRequests === 0
              ? 'The key was never requested. The sealed bids stay on chain (sealed unless the MPC threshold colludes).'
              : 'Prices and sizes stay sealed until the key is released.'}
        </p>
      </section>
      <section className="card pad">
        <p className="eyebrow">Your money</p>
        <p className="small" style={{ margin: 0 }}>
          If you bid in this sale, your refund or tokens land in your {NEAR_INTENTS} account. <a href="#/withdraw">Withdraw</a> moves it to a wallet on Base, Arbitrum or Solana.
          1Click fees are not refunded.
        </p>
      </section>
      <section className="card pad">
        <p className="eyebrow">Who could see the bids before this</p>
        <p className="small" style={{ margin: 0 }}>
          Before the key is released, reading a bid would take 11 of the parties that hold or ever held a piece of NEAR&apos;s key, working together (11 of 16
          nodes on 2026-11-10; <code>pnpm verify</code> prints today&apos;s count), or a bad version of the page the bidder sealed with.{' '}
          <a href="#/trust">Who can see your bid →</a>
        </p>
      </section>
    </aside>
  );
}

export function Sale({ id }: { id: string }) {
  const { nowNs } = useChainClock();
  const { data, error, loading } = usePolling(() => loadSaleBundle(id), 5000, [id]);
  const [cfgTry, setCfgTry] = useState(0);
  const { data: cfg, error: cfgError } = usePolling(getConfig, 0, [cfgTry]);
  if (data) {
    return (
      <SaleView
        key={id}
        bundle={data}
        nowNs={nowNs}
        cfg={cfg}
        cfgError={cfgError}
        onRetryCfg={() => setCfgTry((n) => n + 1)}
        notice={error ? <ReadError error={error} stale /> : null}
      />
    );
  }
  return (
    <div className="wrap page">
      <p className="crumb">
        <a href="#/?at=live">← Real sales</a>
      </p>
      <header className="page-head">
        <p className="eyebrow">{`Sale #${id} · ${config.network}`}</p>
        <h1>{`Sale #${id}`}</h1>
      </header>
      <ReadError error={error} compact />
      {loading ? <Loading what="sale" /> : null}
    </div>
  );
}
