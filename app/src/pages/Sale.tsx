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
import { ConditionBar } from '../components/ConditionBar';
import { NetworkBadge } from '../components/NetworkBadge';
import { STATE_TONE, SaleCard, saleHeadline, stateText } from '../components/SaleCard';
import { StatTile } from '../components/StatTile';
import { StatusPill } from '../components/StatusPill';
import { BlockLink } from '../components/TxLink';
import { SupplyDemandChart } from '../components/SupplyDemandChart';
import { Timeline } from '../components/Timeline';
import { NEAR_INTENTS, OPEN_RULE, PENALTY_RULE, WITHDRAW_TESTNET } from '../copy';
import { priceUnitLabel } from '../lib/amounts';
import { openConditions } from '../lib/conditions';
import { useChainClock } from '../lib/chainClock';
import type { DecryptResult } from '../lib/decrypt';
import { formatNsUtc, formatPrice, formatRounded, formatUnits, formatUsdc, tokenLabel, tokenSymbol } from '../lib/format';
import { loadSaleBundle, type SaleBundle } from '../lib/loaders';
import { recompute, refundOf } from '../lib/results';
import { usePolling } from '../lib/usePolling';
import { getConfig, type Bid, type Config, type Sale as SaleT, type SaleResult } from '../lib/views';

/** One fact under each node of the sale's timeline; the Opened node carries the key's block, with its explorer link. */
function timelineFacts(sale: SaleT, keyRequestBlock?: bigint | null): ReactNode[] {
  const k = sale.keyRequests;
  const key = sale.key;
  const opened = key ? (
    <>
      {`Key requested ${k}×, released at block `}
      <BlockLink block={key.block.toString()} />
      {keyRequestBlock != null ? `, ${key.block - keyRequestBlock} blocks after the request` : ''}
    </>
  ) : k > 0 ? (
    `key requested ${k}×`
  ) : null;
  return [
    `${sale.bids} ${sale.bids === 1 ? 'bid' : 'bids'}, ${formatUsdc(sale.escrowTotal)} USDC deposited`,
    formatNsUtc(sale.closeNs),
    `${formatUsdc(sale.escrowTotal)} ${sale.escrowTotal >= sale.minEscrow ? '≥' : '<'} ${formatUsdc(sale.minEscrow)} USDC · ${sale.bidders} ${sale.bidders >= sale.minBidders ? '≥' : '<'} ${sale.minBidders} bidders`,
    sale.state === 'Cancelled' ? null : opened,
    sale.state === 'Finalized' ? `${sale.payoutsDone} of ${sale.payoutsTotal} payouts made` : null,
  ];
}

/** The finalized sale in four numbers read from the chain: the price every winner paid, and where the money went. */
function Outcome({ sale, bids, result }: { sale: SaleT; bids: Bid[]; result: SaleResult }) {
  const name = tokenSymbol(sale.token);
  const refunded = bids.reduce((a, b) => a + refundOf(b), 0n);
  if (result.pStar === null) {
    return (
      <section className="card pad outcome" aria-label="Outcome">
        <p style={{ margin: 0 }}>No bid reached the reserve, so nothing was sold and every bid was refunded.</p>
      </section>
    );
  }
  return (
    <section className="outcome-tiles" aria-label="Outcome">
      <StatTile value={formatPrice(result.pStar)} unit={priceUnitLabel(name, sale.lotExp)} label="every winner paid" glow />
      <StatTile value={formatRounded(result.sold, sale.decimals)} exact={formatUnits(result.sold, sale.decimals)} unit={name} label="sold" />
      <StatTile value={formatRounded(result.sellerUsdc, 6)} exact={formatUsdc(result.sellerUsdc)} unit="USDC" label="seller receives" />
      <StatTile value={formatRounded(refunded, 6)} exact={formatUsdc(refunded)} unit="USDC" label="refunded to bidders" />
    </section>
  );
}

/** The top of a sale page: the network, the sale in a few words, five steps with one chain fact each, and the actions anyone can take. */
function SaleHead({ bundle, sale, nowNs }: { bundle: SaleBundle; sale: SaleT; nowNs: bigint }) {
  const cond = openConditions(sale, nowNs);
  const takesBids = sale.state === 'Open' && nowNs < sale.closeNs;
  return (
    <header className="sale-hero" aria-label={`Sale ${sale.id}`}>
      <NetworkBadge />
      <div className="sale-hero-row">
        <div>
          <h1>{saleHeadline(sale, nowNs)}</h1>
          <p className="pills">
            <StatusPill tone={STATE_TONE[sale.state]}>{stateText(sale, nowNs)}</StatusPill>
            {config.teamAccounts.includes(sale.seller) ? <span className="pill quiet">team-funded demo sale (us)</span> : null}
            {config.demoFailSales.includes(sale.id) ? <span className="pill quiet">configured by us to miss its open thresholds</span> : null}
            <span className="pill quiet mono">{`${takesBids ? 'closes' : 'closed'} ${formatNsUtc(sale.closeNs)}`}</span>
          </p>
        </div>
        {sale.keyRequests > 0 ? (
          <a className="btn" href="#/keys">
            Key ledger<span aria-hidden="true">{'\u00a0→'}</span>
          </a>
        ) : null}
      </div>
      <Timeline sale={sale} nowNs={nowNs} facts={timelineFacts(sale, bundle.keyRequestBlock)} />
      {sale.state === 'Open' ? <ConditionBar sale={sale} /> : null}
      {sale.state === 'Open' && cond.closed && (!cond.escrowOk || !cond.biddersOk) ? (
        <p className="note info">
          {`Open conditions not met: ${formatUsdc(sale.escrowTotal)} USDC deposited (needed ${formatUsdc(sale.minEscrow)}), ${sale.bidders} ${sale.bidders === 1 ? 'bidder' : 'bidders'} (needed ${sale.minBidders})`}
        </p>
      ) : null}
      <OpenPanel sale={sale} nowNs={nowNs} keyRequestNs={bundle.keyRequestNs} />
      {takesBids ? (
        <div className="sale-clock">
          <Countdown closeNs={sale.closeNs} nowNs={nowNs} />
          <a className="btn primary" href={`#/bid/${sale.id}`}>
            Place a sealed bid
          </a>
        </div>
      ) : null}
    </header>
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
        <a href="#/sales">← Sales</a>
      </p>
      {notice}
      {sale ? <SaleHead bundle={bundle} sale={sale} nowNs={nowNs} /> : null}
      {sale && finalized ? <Outcome sale={sale} bids={bids} result={result} /> : null}
      <div className={sale ? 'sale-layout' : undefined}>
        <div className="sale-main">
          {sale ? null : <SaleCard id={id} sale={null} nowNs={nowNs} asH1 />}
          {sale ? (
            <>
              <CancelledCard sale={sale} bids={bids} />
              {sale.key ? <DecryptPanel sale={sale} bids={bids} cfg={cfg} cfgError={cfgError} onRetryCfg={onRetryCfg} result={decrypted} onResult={setDecrypted} /> : null}
              <RevealPanel sale={sale} bids={bids} decrypted={decrypted} nowNs={nowNs} />
              {finalized ? (
                <>
                  <ResultTable sale={sale} bids={bids} result={result} recomputed={recomputed} decrypted={decrypted} />
                  <section className="card pad" aria-label="Demand and supply">
                    <h2>Demand</h2>
                    <SupplyDemandChart sale={sale} bids={bids} pStar={result.pStar} />
                    <details className="fold">
                      <summary>How the price is set</summary>
                      <p className="small">
                        Each step is a bid, highest price first. Where the bids together want the whole supply, the price is set: the last price still needed
                        becomes the price for every winner.
                      </p>
                    </details>
                  </section>
                </>
              ) : null}
              <div className="card folds">
                <details className="fold">
                  <summary>{`Sealed data on chain (${bids.length} ${bids.length === 1 ? 'bid' : 'bids'})`}</summary>
                  <CipherWall bids={bids} />
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
  const token = tokenSymbol(sale.token);
  return (
    <aside className="sale-aside">
      <section className="card pad side">
        <h2 className="sub">Public from the start</h2>
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
          <dt>For sale</dt>
          <dd className="mono">
            {formatUnits(sale.supply, sale.decimals)} {token}
          </dd>
          <dt>Minimum price</dt>
          <dd className="mono">
            {formatPrice(sale.reserve)} {priceUnitLabel(token, sale.lotExp)}
          </dd>
        </dl>
        <details className="fold">
          <summary>Seller, token and what stayed sealed</summary>
          <p className="small">
            Seller <span className="mono">{sale.seller}</span>
            {config.teamAccounts.includes(sale.seller)
              ? ': that is us, and we also run the keeper (the bot that reveals bids), the relayer (which pays the network fee for bids) and this page.'
              : '.'}{' '}
            Token <span className="mono">{tokenLabel(sale.token)}</span>.
          </p>
          <p className="small">
            {sale.key
              ? 'Prices and sizes were not public until the key was released.'
              : sale.state === 'Cancelled' && sale.keyRequests === 0
                ? 'The key was never requested. The sealed bids stay on chain (sealed unless the MPC threshold colludes).'
                : 'Prices and sizes stay sealed until the key is released.'}
          </p>
        </details>
      </section>
      <section className="card pad side">
        <h2 className="sub">Details</h2>
        <details className="fold">
          <summary>Who could read the bids</summary>
          <p className="small">
            Before the key is released, reading a bid would take 11 of the parties that hold or ever held a piece of NEAR&apos;s key, working together (11 of 16
            nodes on 2026-11-10; <code>pnpm verify</code> prints today&apos;s count), or a bad version of the page the bidder sealed with.{' '}
            <a href="#/trust">Who can see your bid →</a>
          </p>
        </details>
        <details className="fold">
          <summary>Where refunds and tokens go</summary>
          <p className="small">
            If you bid in this sale, your refund or tokens land in your {NEAR_INTENTS} account. {WITHDRAW_TESTNET ?? (
              <>
                <a href="#/withdraw">Withdraw</a> moves it to a wallet on Base, Arbitrum or Solana. 1Click fees are not refunded.
              </>
            )}
          </p>
        </details>
        <details className="fold">
          <summary>open(), as the contract applies it</summary>
          <p className="small">{OPEN_RULE}</p>
        </details>
      </section>
      <section className="card pad side">
        <h2 className="sub">Check it</h2>
        <p className="small" style={{ margin: 0 }}>
          <code>{`pnpm verify --sale ${sale.id}`}</code>
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
        <a href="#/sales">← Sales</a>
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
