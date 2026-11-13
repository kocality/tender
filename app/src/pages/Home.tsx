import { useEffect } from 'react';
import { Loading, ReadError } from '../components/Feedback';
import { Rich } from '../components/Rich';
import { PublicList, RoleList, TopLimits } from '../components/Trust';
import { config } from '../config';
import { HOME, heroSalePhrase, networkStatus, twinHeading } from '../copy';
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
  const noneOpen = sales.length > 0 && !sales.some((s) => s.state === 'Open' && nowNs < s.closeNs);
  // The heading promises only what the sales on screen did (a missed sale is named only when one exists).
  const head = missing
    ? { before: 'Two real sales, once the contract is', accent: 'live.', after: '', lead: `When the sale contract is live on NEAR ${config.network}, ${HOME.missingLead}` }
    : twinHeading(sales, config.demoFailSales, nowNs, config.network);
  return (
    <>
      <Hero missing={missing} sales={sales} nowNs={nowNs} />
      <HowItWorks />
      <section className="sec" id="live" aria-labelledby="live-title">
        <div className="wrap">
          <div className="sec-head">
            <p className="eyebrow">02 · Real sales</p>
            <h2 id="live-title">
              {head.before} <span className="hl">{head.accent}</span>
              {head.after ? ` ${head.after}` : ''}
            </h2>
            <p className="lead">{head.lead}</p>
          </div>
          <ReadError error={error} stale={data !== null} />
          {loading && !data ? <Loading what="sales" /> : null}
          {data ? <TwinView bundles={data} nowNs={nowNs} checks={checks} /> : null}
          {noneOpen ? (
            <p className="next-step">
              <span>{HOME.noOpenSale}</span>
              <a className="btn btn-sm" href="#/try">
                Try signing (free)
              </a>
            </p>
          ) : null}
        </div>
      </section>
      <TrustBand />
      <PathRows bundles={data} nowNs={nowNs} checks={checks} />
    </>
  );
}

function Hero({ missing, sales, nowNs }: { missing: boolean; sales: Sale[]; nowNs: bigint }) {
  const status = networkStatus(config.network, missing);
  return (
    <section className="hero">
      <div className="wrap hero-in">
        <div>
          <p className="eyebrow">{HOME.eyebrow}</p>
          <h1 className="display">{HOME.title}</h1>
          <p className="lead">{HOME.lead}</p>
          <ol className="steps3">
            {HOME.steps.map((s, i) => (
              <li key={s}>
                <span className="n mono">{`0${i + 1}`}</span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
          <p className="hero-caveat small">
            {HOME.heroCaveat}{' '}
            <a href="#/trust">
              Who can see your bid<span aria-hidden="true">{'\u00a0→'}</span>
            </a>
          </p>
          <div className="hero-cta">
            <a className="btn primary" href="#/?at=how" onClick={onSectionLinkClick}>
              Follow one sale <span aria-hidden="true">↓</span>
            </a>
            <a className="arrow-link" href="#/?at=try" onClick={onSectionLinkClick}>
              Judging? The 60-second path <span aria-hidden="true">↓</span>
            </a>
          </div>
          {sales.length > 0 ? (
            // The real sales, one line, above the fold: the worked example below is illustrated, these are read from the chain.
            <p className="hero-live small">
              <span className="dot live" aria-hidden="true" />
              <span>
                <strong>{`Live on NEAR ${config.network}:`}</strong> {sales.map((s) => heroSalePhrase(s, nowNs)).join(' · ')}.{' '}
                <a href="#/?at=live" onClick={onSectionLinkClick}>
                  See {sales.length === 1 ? 'it' : 'both'}
                  <span aria-hidden="true">{'\u00a0↓'}</span>
                </a>
              </span>
            </p>
          ) : null}
          <p className="status-line small">
            <span className="dot" aria-hidden="true" />
            <span>
              <strong>{status.label}</strong> · {status.text}
            </span>
          </p>
        </div>
        <aside className="card cast" aria-label="The people in the story">
          <p className="cast-line small">{HOME.castLine}</p>
          <p className="eyebrow cast-head">In this example</p>
          {HOME.cast.map((p) => (
            <div key={p.name} className="person">
              <span className={p.tag === 'Seller' ? 'av seller' : 'av'} aria-hidden="true">
                {p.initial}
              </span>
              <div>
                <span className="who">{p.name}</span>
                <span className="chip">{p.tag}</span>
                <p>{p.line}</p>
              </div>
            </div>
          ))}
          <div className="peek">
            <p className="eyebrow">What Sam sees of Bea&apos;s bid</p>
            <dl className="kv-rows">
              <dt>Deposit</dt>
              <dd className="mono">5.00 USDC</dd>
              <dt>Price</dt>
              <dd>
                <span className="sealed">sealed</span>
              </dd>
              <dt>Amount</dt>
              <dd>
                <span className="sealed">sealed</span>
              </dd>
            </dl>
          </div>
        </aside>
      </div>
    </section>
  );
}

function Meter({ label, value, pct, ok = false }: { label: string; value: string; pct: number; ok?: boolean }) {
  return (
    <div className="cond">
      <div className="cond-label small">
        <span>{label}</span>
        <span className="mono">{value}</span>
      </div>
      <div className={ok ? 'bar met' : 'bar'} aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** The drawn part of each chapter: a fragment of what the app shows at that point of the story. */
const FRAGMENTS = [
  <div className="frag" key="1">
    <div className="frag-head">
      <span className="frag-title">Sale #1 · 3 NEAR</span>
      <span className="pill accent">Taking bids</span>
    </div>
    <dl className="kv-rows">
      <dt>Minimum price</dt>
      <dd className="mono">3.00 USDC / NEAR</dd>
    </dl>
    <Meter label="Deposits" value="0 USDC · 5 needed" pct={0} />
    <Meter label="Bidders" value="0 · 3 needed" pct={0} />
  </div>,
  <div className="cmp" key="2">
    <div className="h">In a public sale</div>
    <div className="h">In Tender</div>
    <div className="dim">
      Sam sees Bea&apos;s price: <span className="mono">3.90</span>
    </div>
    <div>
      Sam sees Bea&apos;s deposit: <span className="mono">5 USDC</span>
    </div>
    <div className="dim">He copies Bea, or snipes at the end</div>
    <div>
      He bids his own value: <span className="mono">3.20</span>
    </div>
  </div>,
  <div className="frag" key="3">
    <div className="frag-head">
      <span className="frag-title">Sale #1 · closed</span>
      <span className="pill ok">Conditions met</span>
    </div>
    <Meter label="Deposits" value="21 USDC · 5 needed" pct={100} ok />
    <Meter label="Bidders" value="6 · 3 needed" pct={100} ok />
    <dl className="kv-rows" style={{ marginTop: 12 }}>
      <dt>Key requested</dt>
      <dd className="mono">1 time</dd>
      <dt>Key</dt>
      <dd>released, public</dd>
    </dl>
  </div>,
  <div className="frag" key="4">
    <div className="frag-head">
      <span className="frag-title">Every winner pays</span>
      <span className="price-big mono">3.60</span>
    </div>
    <table className="mini-table">
      <thead>
        <tr>
          <th>Bidder</th>
          <th className="r">Bid</th>
          <th className="r">Gets</th>
          <th className="r">Back</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Bea</td>
          <td className="r mono">3.90</td>
          <td className="r mono">1.11 NEAR</td>
          <td className="r mono">1.00</td>
        </tr>
        <tr>
          <td>Sam</td>
          <td className="r mono">3.20</td>
          <td className="r mono">0</td>
          <td className="r mono">3.00</td>
        </tr>
        <tr>
          <td className="muted" colSpan={4}>
            4 more bids
          </td>
        </tr>
      </tbody>
    </table>
    <dl className="kv-rows" style={{ marginTop: 8 }}>
      <dt>Priya receives</dt>
      <dd className="mono">about 10.80 USDC</dd>
    </dl>
  </div>,
];

function HowItWorks() {
  return (
    <section className="sec" id="how" aria-labelledby="how-title">
      <div className="wrap">
        <div className="sec-head">
          <p className="eyebrow">01 · How it works</p>
          <h2 id="how-title">
            {HOME.howTitle} <span className="hl">{HOME.howAccent}</span>
          </h2>
          <p className="lead">{HOME.howLead}</p>
        </div>
        <div className="chapters">
          {HOME.chapters.map((c, i) => (
            <article key={c.title} className="card chapter">
              <div className="txt">
                <p className="eyebrow">{c.eyebrow}</p>
                <h3>{c.title}</h3>
                <p>
                  <Rich text={c.text} />
                </p>
                {'aside' in c ? (
                  <p className="chapter-aside">
                    <em>{c.aside}</em>
                  </p>
                ) : null}
              </div>
              <div className="vis">{FRAGMENTS[i]}</div>
            </article>
          ))}
        </div>
        <p className="footnote">
          <Rich text={HOME.storyNote} />
        </p>
      </div>
    </section>
  );
}

function TrustBand() {
  return (
    <section className="sec band" id="trust" aria-labelledby="trust-title">
      <div className="wrap">
        <div className="sec-head">
          <p className="eyebrow">03 · Who can see your bid</p>
          <h2 id="trust-title">
            {HOME.trustTitle} <span className="hl">{HOME.trustAccent}</span>
          </h2>
          <p className="lead">{HOME.trustLead}</p>
        </div>
        <div className="trust-grid">
          <RoleList />
          <div>
            <p className="eyebrow">Public from the start</p>
            <PublicList />
            <p className="small band-muted">{HOME.publicNote}</p>
          </div>
        </div>
        <div className="limits">
          <div>
            <p className="eyebrow band-warn">Limits</p>
            <h3>The honest limits.</h3>
            <TopLimits />
          </div>
          <div>
            <a className="btn ghost" href="#/trust">
              Full trust table and all 11 limits →
            </a>
            <p className="check small">
              <Rich text={HOME.checkLine} />{' '}
              <a href="#/keys">
                Key ledger<span aria-hidden="true">{'\u00a0→'}</span>
              </a>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/** What to expect on the sale page, said before the visitor presses Decrypt there. */
function pathCheckNote(c: OpenCheck): string {
  if (c.opened === c.total) return `Expect all ${c.total} to open.`;
  const ids = (xs: number[]) => xs.map((i) => `#${i}`).join(', ');
  const parts = [`Expect ${c.opened} of ${c.total} to open.`];
  if (c.lastLook.length > 0) parts.push(`${c.lastLook.length === 1 ? 'Bid' : 'Bids'} ${ids(c.lastLook)} ${c.lastLook.length === 1 ? 'was' : 'were'} revealed from the owner's own copy after the key was out, so ${c.lastLook.length === 1 ? 'its sealed copy does' : 'their sealed copies do'} not open: the last-look case in our limits.`);
  if (c.closed.length > 0) parts.push(`${c.closed.length === 1 ? 'Bid' : 'Bids'} ${ids(c.closed)} ${c.closed.length === 1 ? 'does' : 'do'} not open and ${c.closed.length === 1 ? 'was' : 'were'} not revealed.`);
  return parts.join(' ');
}

function PathRows({ bundles, nowNs, checks }: { bundles: SaleBundle[] | null; nowNs: bigint; checks: Record<string, OpenCheck> }) {
  const sales = (bundles ?? []).flatMap((b) => (b.sale ? [b.sale] : []));
  const open = sales.find((s) => s.state === 'Open' && nowNs < s.closeNs);
  const opened = sales.find((s) => s.state === 'Keyed' || s.state === 'Finalized');
  // "Never asked for" is only true of a Cancelled sale with no key request.
  const cancelled = sales.find((s) => s.state === 'Cancelled' && s.keyRequests === 0);
  const check = opened ? checks[opened.id] : undefined;
  const rows: { title: string; text: string; href: string; button: string; primary?: boolean; more?: { href: string; label: string } }[] = [
    {
      title: 'Sign a bid with your own wallet.',
      text: 'MetaMask, Phantom or a NEAR wallet signs the same message a real bid uses. NEAR Intents (the NEAR contract that holds balances your own wallet controls) checks the signature and stops there: free, nothing is sent.',
      href: '#/try',
      button: 'Try signing (free)',
      primary: true,
    },
    ...(opened
      ? [
          {
            title: `Open the bids of Sale #${opened.id} yourself.`,
            text: `Its key is public. Press "Decrypt all bids in this browser": your browser opens the bids, checks each against what its bidder stored, and recomputes the price.${check ? ` ${pathCheckNote(check)}` : ''}`,
            href: `#/sale/${opened.id}`,
            button: `Open Sale #${opened.id}`,
            more: check && check.lastLook.length > 0 ? { href: '#/trust', label: 'Read the last-look limit' } : undefined,
          },
        ]
      : []),
    ...(cancelled
      ? [
          {
            title: 'See the sale that never opened.',
            text: 'Same rules, but it missed its public conditions, so its key was never asked for. Every bid was refunded.',
            href: `#/sale/${cancelled.id}`,
            button: `Open Sale #${cancelled.id}`,
          },
        ]
      : []),
    ...(open
      ? [
          {
            title: 'Bid on an open sale.',
            text: `Seal a price, put down a deposit of 1 USDC or more from your own chain, sign once. ${config.network === 'testnet' ? 'Test tokens only.' : 'This moves real USDC.'}`,
            href: `#/bid/${open.id}`,
            button: 'Place a sealed bid',
          },
        ]
      : []),
    // The ledger has something to show only once a key was asked for.
    ...(sales.some((s) => s.keyRequests > 0)
      ? [
          {
            title: 'Count the key requests.',
            text: 'One line for every time the contract asked for a sale key, written on chain before the request. A sale with no line: the contract never asked for its key. Each line links to the NearBlocks explorer.',
            href: '#/keys',
            button: 'Key ledger',
          },
        ]
      : []),
  ];
  return (
    <section className="sec" id="try" aria-labelledby="try-title">
      <div className="wrap">
        <div className="sec-head">
          <p className="eyebrow">04 · The 60-second path</p>
          <h2 id="try-title">{HOME.tryTitle}</h2>
          <p className="lead">{HOME.tryLead}</p>
        </div>
        <ol className="path">
          {rows.map((r, i) => (
            <li key={r.title}>
              <span className="path-time mono">{String(i + 1).padStart(2, '0')}</span>
              <div>
                <strong>{r.title}</strong>
                <p>{r.text}</p>
                {r.more ? (
                  <p className="small">
                    <a href={r.more.href}>
                      {r.more.label}
                      <span aria-hidden="true">{' →'}</span>
                    </a>
                  </p>
                ) : null}
              </div>
              <a className={r.primary ? 'btn primary' : 'btn'} href={r.href}>
                {r.button}
              </a>
            </li>
          ))}
        </ol>
        <div className="path-foot small">
          <span className="path-foot-head">For developers, on your own machine:</span>
          <ul className="cmd-list" aria-label="Commands">
            <li>
              <code>pnpm demo:local</code>
            </li>
            <li>
              <code>pnpm verify --keys</code>
            </li>
            <li>
              <code>pnpm seal:bid</code>
            </li>
          </ul>
          {config.repoUrl ? (
            <a href={`${config.repoUrl}#try-it-free-no-wallet`} target="_blank" rel="noreferrer">
              Every step, in the README<span aria-hidden="true">{' →'}</span>
            </a>
          ) : (
            <span className="muted">Every step is in the README of the source code, section &quot;Try it (free, no wallet)&quot;.</span>
          )}
        </div>
      </div>
    </section>
  );
}
