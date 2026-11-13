import { useEffect, type ReactNode } from 'react';
import { ChainGlyph } from '../components/ChainGlyph';
import { EyeGrid } from '../components/EyeGrid';
import { ExampleSale } from '../components/ExampleSale';
import { Loading, ReadError } from '../components/Feedback';
import { NetworkBadge, popoverHandlers } from '../components/NetworkBadge';
import { useDoneOnView, useReveal } from '../components/Reveal';
import { RoleList } from '../components/Trust';
import { config } from '../config';
import { HERO_EXAMPLE, HOME, OPEN_RULE, twinHeading } from '../copy';
import DecryptedText from '../fx/DecryptedText';
import StatusMark from '../fx/StatusMark';
import { isNotDeployed } from '../lib/errors';
import { useChainClock } from '../lib/chainClock';
import { loadSaleBundle, type SaleBundle } from '../lib/loaders';
import { useOpenChecks, type OpenCheck } from '../lib/openCheck';
import { onSectionLinkClick, scrollToSection } from '../lib/sections';
import { usePolling } from '../lib/usePolling';
import type { Sale } from '../lib/views';
import { TwinView } from './Twin';

/** The landing page; the twin sales are polled every 5 s. `at` names a section to scroll to (`#/?at=live`). */
export function Home({ at }: { at: string }) {
  const { nowNs } = useChainClock();
  const [a, b] = config.twinSales;
  const { data, error, loading } = usePolling(() => Promise.all([loadSaleBundle(a), loadSaleBundle(b)]), 5000, [a, b]);
  const ready = data !== null;
  useEffect(() => {
    if (!at) return;
    // After layout, and again once the sales are in (they change the height of everything above the later sections).
    const id = requestAnimationFrame(() => scrollToSection(at));
    return () => cancelAnimationFrame(id);
  }, [at, ready]);
  const checks = useOpenChecks(data);
  return <HomeView data={data} error={error} loading={loading} nowNs={nowNs} checks={checks} />;
}

/** The whole landing page for one read of the twin sales. Pure, so it can be rendered in tests. */
export function HomeView({
  data,
  error,
  loading,
  nowNs,
  checks = {},
}: {
  data: SaleBundle[] | null;
  error: string | null;
  loading: boolean;
  nowNs: bigint;
  /** What this browser found when it opened the bids of each keyed twin sale (lib/openCheck.ts). */
  checks?: Record<string, OpenCheck>;
}) {
  // No contract to read on this network (yet): the section says so instead of promising live sales.
  const missing = data === null && error !== null && isNotDeployed(error);
  const sales = (data ?? []).flatMap((b) => (b.sale ? [b.sale] : []));
  const open = sales.find((s) => s.state === 'Open' && nowNs < s.closeNs);
  // The heading promises only what the sales on screen did (a missed sale is named only when one exists); before the
  // first read it claims nothing about them.
  const head = missing
    ? { before: 'Two real sales, once the contract is', accent: 'live.', after: '', lead: HOME.missingLead }
    : data === null
      ? { before: 'Two sales,', accent: 'read from the chain.', after: '', lead: `Reading both from NEAR ${config.network}.` }
      : twinHeading(sales, config.demoFailSales, nowNs, config.network);
  return (
    <>
      <Hero open={open} missing={missing} />
      <Bento />
      <section className="sec" id="live" aria-labelledby="live-title">
        <div className="wrap">
          <SecHead id="live-title" lead={head.lead}>
            {head.before} <span className="hl">{head.accent}</span>
            {head.after ? (head.after.startsWith(',') ? head.after : ` ${head.after}`) : ''}
          </SecHead>
          <ReadError error={error} stale={data !== null} />
          {loading && !data ? <Loading what="sales" tall /> : null}
          {data ? <TwinView bundles={data} nowNs={nowNs} checks={checks} stale={error !== null} /> : null}
        </div>
      </section>
      <TryBand sales={sales} open={open} />
    </>
  );
}

function SecHead({ id, lead, children }: { id: string; lead: string; children: ReactNode }) {
  const ref = useReveal<HTMLDivElement>();
  return (
    <div className="sec-head" ref={ref}>
      <h2 id={id}>{children}</h2>
      <p className="lead">{lead}</p>
    </div>
  );
}

function Hero({ open, missing }: { open: Sale | undefined; missing: boolean }) {
  const [before, after] = HOME.title.split('showing');
  return (
    <section className="hero" id="example" aria-labelledby="hero-title">
      <div className="hero-glow" aria-hidden="true" />
      <div className="wrap hero-in">
        <NetworkBadge missing={missing} />
        <h1 className="display" id="hero-title">
          {before}
          <span className="seal-word">showing</span>
          {after}
        </h1>
        <p className="lead">{HOME.sentence}</p>
        <div className="hero-cta">
          {open ? (
            <a className="btn primary" href={`#/bid/${open.id}`}>
              {HOME.ctaBid}
            </a>
          ) : missing ? (
            // No sales to see yet: the button goes where something already works.
            <a className="btn primary" href="#/try">
              {HOME.ctaTry}
            </a>
          ) : (
            <a className="btn primary" href="#/?at=live" onClick={onSectionLinkClick}>
              {HOME.ctaSales}
            </a>
          )}
        </div>
        <ExampleSale />
        <p className="hero-caveat small">
          {HOME.heroCaveat}{' '}
          <a href="#/trust">
            {HOME.heroWhy}
            <span aria-hidden="true">{' →'}</span>
          </a>
        </p>
      </div>
    </section>
  );
}

function Tile({ className, title, line, visual, children }: { className: string; title: string; line?: string; visual: ReactNode; children?: ReactNode }) {
  const ref = useReveal<HTMLElement>();
  return (
    <article className={`tile ${className}`} ref={ref}>
      <div className="vis">{visual}</div>
      <div className="txt">
        <h3>{title}</h3>
        {line ? <p>{line}</p> : null}
        {children}
      </div>
    </article>
  );
}

const Lock = () => (
  <svg className="lock" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <rect x="3" y="7" width="10" height="7" rx="2" fill="currentColor" />
    <path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

/** Tile 3: two public meters reach their thresholds, then the mark turns to "key requested". No numbers: it is a diagram. */
function GateVisual() {
  const [ref, done] = useDoneOnView<HTMLDivElement>(900);
  return (
    <div className={done ? 'gate met' : 'gate'} ref={ref}>
      {['Deposits', 'Bidders'].map((m) => (
        <div className="meter" key={m}>
          <span className="meter-l">{m}</span>
          <span className="meter-bar" aria-hidden="true">
            <span />
            <i className="tick" />
          </span>
        </div>
      ))}
      <StatusMark status={done ? 'done' : 'pending'} label={done ? 'key requested' : undefined} size={18} fontSize={13} />
    </div>
  );
}

/** Tile 4: the hero example's three bids by price; the two at or above 3.60 buy the supply, the dashed line is that one price. */
function PriceVisual() {
  const [ref, done] = useDoneOnView<HTMLDivElement>(200);
  const bars = HERO_EXAMPLE.bids.map((b) => Number(b.price)).sort((x, y) => y - x);
  const h = (p: number) => Math.round((p - 2.9) * 75);
  const lineY = 100 - h(Number(HERO_EXAMPLE.clearing));
  return (
    <div className={done ? 'clearing in' : 'clearing'} ref={ref}>
      <svg viewBox="0 0 280 110" aria-hidden="true">
        {bars.map((p, i) => (
          <rect key={i} x={22 + i * 84} y={100 - h(p)} width="68" height={h(p)} rx="5" className={p >= Number(HERO_EXAMPLE.clearing) ? 'sold' : 'unsold'} />
        ))}
        <line className="pline" x1="0" x2="280" y1={lineY} y2={lineY} />
      </svg>
      {/* The example's price, static and tagged: a moving number on this page is always one read from the chain. */}
      <span className="big mono">
        {HERO_EXAMPLE.clearing}
        <span className="tag">example</span>
      </span>
    </div>
  );
}

function Bento() {
  const t = HOME.bento;
  return (
    <section className="sec" id="how" aria-labelledby="how-title">
      <div className="wrap">
        <SecHead id="how-title" lead={HOME.howLead}>
          {HOME.howTitle}
        </SecHead>
        <div className="bento">
          <Tile
            className="t-seal"
            title={t.seal.title}
            line={t.seal.line}
            visual={
              <div className="mini">
                <span className="row lit">
                  <span>Deposit</span>
                  <span className="v mono">5.00</span>
                </span>
                <span className="row">
                  <span>Price</span>
                  <span className="v mono">
                    <Lock />
                    <DecryptedText text="" revealed={false} sealedLength={4} sealedLabel="sealed" />
                  </span>
                </span>
              </div>
            }
          />
          <Tile
            className="t-chains"
            title={t.chains.title}
            line={config.network === 'testnet' ? t.chains.testnet : t.chains.line}
            visual={
              <span className="chains" role="img" aria-label="Base, Arbitrum, Solana or NEAR, into USDC">
                {['base', 'arb', 'sol', 'near'].map((c) => (
                  <ChainGlyph key={c} chain={c} />
                ))}
                <span className="arrow" aria-hidden="true">
                  →
                </span>
                <span className="usdc" aria-hidden="true">
                  $
                </span>
              </span>
            }
          />
          <Tile className="t-gate" title={t.gate.title} line={t.gate.line} visual={<GateVisual />}>
            <details className="fold tile-pop" onKeyDown={popoverHandlers.onKeyDown}>
              <summary>Exact rule</summary>
              <p className="small">{OPEN_RULE}</p>
            </details>
          </Tile>
          <Tile className="t-price" title={t.price.title} line={t.price.line} visual={<PriceVisual />} />
          <Tile className="t-roles wide" title={t.roles.title} visual={<EyeGrid />}>
            <details className="fold tile-pop" onKeyDown={popoverHandlers.onKeyDown}>
              <summary>Why each one</summary>
              <RoleList phoneShort />
            </details>
            <p className="small tile-link">
              <a href="#/trust">
                All 11 limits<span aria-hidden="true">{' →'}</span>
              </a>
            </p>
          </Tile>
        </div>
      </div>
    </section>
  );
}

/** Section 03: three ways to check it in a minute; each button appears only when there is something behind it. */
function TryBand({ sales, open }: { sales: Sale[]; open: Sale | undefined }) {
  const ref = useReveal<HTMLDivElement>();
  const opened = sales.find((s) => s.state === 'Keyed' || s.state === 'Finalized');
  return (
    <section className="sec" id="try" aria-labelledby="try-title">
      <div className="wrap">
        <div className="cta" ref={ref}>
          <h2 id="try-title">{HOME.tryTitle}</h2>
          <div className="hero-cta">
            <a className="btn primary" href="#/try">
              {HOME.ctaTry}
            </a>
            {open ? (
              <a className="btn" href={`#/bid/${open.id}`}>
                Bid on an open sale
              </a>
            ) : opened ? (
              <a className="btn" href={`#/sale/${opened.id}`}>
                {`Open sale #${opened.id}'s bids`}
              </a>
            ) : null}
            {/* The ledger has something to show only once a key was asked for. */}
            {sales.some((s) => s.keyRequests > 0) ? (
              <a className="btn" href="#/keys">
                Count the key requests
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
