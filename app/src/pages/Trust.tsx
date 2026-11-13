import { PublicList, RoleList } from '../components/Trust';
import { Rich } from '../components/Rich';
import { config } from '../config';
import { MORE_LIMITS, PRIVACY_PLAIN, RELY_ON, SELLER_STEPS, TOP_LIMITS, TRUST_LINE } from '../copy';

/** Who can see a bid, what that rests on, and every limit: README "Trust and limits" in plain words, with the detail one click away. */
export function Trust() {
  return (
    <div className="wrap page">
      <header className="page-head">
        <p className="eyebrow">Trust and limits</p>
        <h1>Who can see your bid.</h1>
        <p className="lead">Your price and amount are sealed until the sale&apos;s key is released. Here is who could read them before that, what that rests on, and what Tender does not protect against.</p>
        <p className="plain-callout">
          <Rich text={PRIVACY_PLAIN} />
        </p>
        <details className="fold tech">
          <summary>The exact wording, for the technical reader</summary>
          <p className="trust-line">
            <Rich text={TRUST_LINE} />
          </p>
        </details>
      </header>

      <section className="trust-sec" aria-labelledby="t-roles">
        <p className="eyebrow">01 · By role</p>
        <h2 id="t-roles">Who sees what, and when.</h2>
        <p className="muted measure">Everyone involved in a sale, and what each of them can read before the key is released.</p>
        <div className="card pad roles-light">
          <RoleList />
        </div>
      </section>

      <section className="trust-sec" aria-labelledby="t-public">
        <p className="eyebrow">02 · By piece of data</p>
        <h2 id="t-public">Sealed, and public from the start.</h2>
        <p className="muted measure">What stays sealed until the key is released, and what anyone can see from the moment you bid.</p>
        <div className="cols-2">
          <div className="card pad">
            <p className="eyebrow">Sealed until the key is released</p>
            <ul className="public-list">
              <li>
                <span>Each bid&apos;s price</span>
                <span className="sealed">sealed</span>
              </li>
              <li>
                <span>Each bid&apos;s size: the most the bidder will spend</span>
                <span className="sealed">sealed</span>
              </li>
              <li>
                <span>The salt: random bytes that make two equal bids look different</span>
                <span className="sealed">sealed</span>
              </li>
            </ul>
            <p className="small muted card-foot">After release everything is public: that is how anyone can recompute the price.</p>
          </div>
          <div className="card pad">
            <p className="eyebrow">Public from the start</p>
            <PublicList />
          </div>
        </div>
      </section>

      <section className="trust-sec" aria-labelledby="t-rely">
        <p className="eyebrow">03 · Assumptions</p>
        <h2 id="t-rely">What you rely on.</h2>
        <p className="muted measure">One line each: what has to hold, and what happens if it does not.</p>
        <ol className="rows">
          {RELY_ON.map((r) => (
            <li key={r.plain}>
              <strong>
                <Rich text={r.plain} />
              </strong>
              <p className="muted small">
                If it breaks: <Rich text={r.breaks} />
              </p>
            </li>
          ))}
        </ol>
        {/* One disclosure for the whole list keeps the page short on phones; the README rows are verbatim inside. */}
        <details className="fold tech">
          <summary>The same {RELY_ON.length} lines in technical words</summary>
          <ol className="rows tech-rows">
            {RELY_ON.map((r) => (
              <li key={r.technical} className="small">
                {r.technical}
              </li>
            ))}
          </ol>
        </details>
      </section>

      <section className="trust-sec" aria-labelledby="t-limits">
        <p className="eyebrow">{`04 · Limits · ${TOP_LIMITS.length + MORE_LIMITS.length}`}</p>
        <h2 id="t-limits">What Tender does not protect against.</h2>
        <p className="muted measure">
          What an attacker can still do, and what we do not claim. The mechanics are in the protocol notes, <code>docs/protocol.md</code> in the source code.
        </p>
        <ol className="rows limits-all">
          {[...TOP_LIMITS, ...MORE_LIMITS].map((l) => (
            <li key={l.title}>
              {/* Open: the three a visitor reads first, and the counterweight to "its key was never asked for". */}
              <details className="fold" open={TOP_LIMITS.includes(l) || l === MORE_LIMITS[1]}>
                <summary>{l.title}</summary>
                <p className="small">
                  <Rich text={l.text} />
                </p>
              </details>
            </li>
          ))}
        </ol>
      </section>

      <section className="trust-sec" aria-labelledby="t-sellers">
        <p className="eyebrow">05 · Sellers</p>
        <h2 id="t-sellers">For sellers.</h2>
        <p className="muted measure">There is no seller page. Sale creation is restricted to the team:</p>
        <ol className="numbered measure">
          {SELLER_STEPS.map((s) => (
            <li key={s}>
              <Rich text={s} />
            </li>
          ))}
        </ol>
      </section>

      <section className="trust-sec" aria-labelledby="t-check">
        <p className="eyebrow">06 · Proof</p>
        <h2 id="t-check">Check it yourself.</h2>
        <p className="muted measure">Do not trust this page? You do not have to: everything it shows can be checked against the chain.</p>
        <ul className="check-list">
          <li>
            The contract on the explorer:{' '}
            <a className="mono" href={`${config.explorerUrl}/address/${config.tenderContractId}`} target="_blank" rel="noreferrer">
              {config.tenderContractId}
            </a>
          </li>
          <li>
            Every key request: <a href="#/keys">Key ledger</a>
          </li>
          <li>
            For developers, on your own machine: <code>pnpm verify --keys</code> rechecks every key request, <code>pnpm verify --sale N</code> rechecks one sale,
            and <code>pnpm seal:bid</code> seals a bid without this page.
          </li>
          <li>
            Every claim and its proof:{' '}
            {config.repoUrl ? (
              <a href={`${config.repoUrl}/blob/main/JUDGES.md`} target="_blank" rel="noreferrer">
                JUDGES.md
              </a>
            ) : (
              <>
                <code>JUDGES.md</code>, in the source code
              </>
            )}
          </li>
        </ul>
      </section>
    </div>
  );
}
