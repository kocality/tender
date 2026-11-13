import type { ReactNode } from 'react';
import { config } from '../config';
import { PRIVACY_PLAIN, TRUST_LINE, networkStatus } from '../copy';
import { useContractMissing } from '../lib/contractStatus';
import { onSectionLinkClick } from '../lib/sections';
import { Rich } from './Rich';

/** [key, href, label]: the key is the route pattern, or `at:<section>` for a section of the home page. */
const NAV: [string, string, string][] = [
  ['at:how', '#/?at=how', 'How it works'],
  ['at:live', '#/?at=live', 'Real sales'],
  ['/trust', '#/trust', 'Who can see your bid'],
  ['/keys', '#/keys', 'Key ledger'],
];

export function Layout({ current, children }: { current: string; children: ReactNode }) {
  const here = (key: string) => (current === key ? ('page' as const) : undefined);
  const missing = useContractMissing();
  const status = networkStatus(config.network, missing);
  // While the sale contract is not live, the nav says so instead of promising sales.
  const nav = NAV.map(([key, href, label]): [string, string, string] => [key, href, missing && key === 'at:live' ? 'Real sales (soon)' : label]);
  return (
    <div className="shell">
      <a className="skip-link" href="#main" onClick={(e) => {
        // A hash router owns location.hash: move focus by hand instead of navigating.
        e.preventDefault();
        document.getElementById('main')?.focus();
      }}>
        Skip to content
      </a>
      <header className="topbar">
        <div className="wrap topbar-in">
          <a className="brand" href="#/">
            <span className="mark" aria-hidden="true" />
            Tender
          </a>
          <nav className="nav" aria-label="Main">
            {nav.map(([key, href, label]) => (
              <a key={key} href={href} aria-current={here(key)} onClick={onSectionLinkClick}>
                {label}
              </a>
            ))}
          </nav>
          <div className="topbar-end">
            <a className="nav-quiet" href="#/withdraw" aria-current={here('/withdraw')}>
              Withdraw
            </a>
            {/* On the Try page itself the button would point at the page you are on: it steps back to a quiet style. */}
            <a className={current === '/try' ? 'btn btn-sm' : 'btn primary btn-sm'} href="#/try" aria-current={here('/try')}>
              Try signing (free)
            </a>
            <details
              className="menu"
              onKeyDown={(e) => {
                if (e.key !== 'Escape' || !e.currentTarget.open) return;
                e.currentTarget.open = false;
                e.currentTarget.querySelector('summary')?.focus();
              }}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) e.currentTarget.open = false;
              }}
            >
              <summary>Menu</summary>
              {/* A hash link does not reload the page: close the menu on the way out. */}
              <nav aria-label="Menu" onClick={(e) => e.currentTarget.closest('details')?.removeAttribute('open')}>
                {nav.map(([key, href, label]) => (
                  <a key={key} href={href} aria-current={here(key)} onClick={onSectionLinkClick}>
                    {label}
                  </a>
                ))}
                <a href="#/withdraw" aria-current={here('/withdraw')}>
                  Withdraw
                </a>
              </nav>
            </details>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <footer className="footer">
        <div className="wrap footer-in">
          <div>
            <p className="status-line">
              <span className="dot" aria-hidden="true" />
              <span>
                <strong>{`${status.label}.`}</strong> {status.footer}
              </span>
            </p>
            <details className="footer-trust">
              <summary>How private is this, exactly?</summary>
              <p>
                <Rich text={PRIVACY_PLAIN} /> <a href="#/trust">Who can see your bid →</a>
              </p>
              <details className="fold tech">
                <summary>The exact wording</summary>
                <p>
                  <Rich text={TRUST_LINE} />
                </p>
              </details>
            </details>
          </div>
          <nav className="footer-links" aria-label="Footer">
            <a href="#/trust">Who can see your bid</a>
            <a href="#/keys">Key ledger</a>
            <a href="#/withdraw">Withdraw</a>
            {config.repoUrl ? (
              <>
                <a href={config.repoUrl} target="_blank" rel="noreferrer">
                  Source code
                </a>
                <a href={`${config.repoUrl}/blob/main/JUDGES.md`} target="_blank" rel="noreferrer">
                  Evidence for judges
                </a>
              </>
            ) : null}
          </nav>
        </div>
      </footer>
    </div>
  );
}
