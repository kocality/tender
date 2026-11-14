import type { ReactNode } from 'react';
import { config } from '../config';
import { HOME } from '../copy';
import { useContractMissing } from '../lib/contractStatus';
import { onSectionLinkClick } from '../lib/sections';
import { LockTxLink, NetworkBadge, popoverHandlers } from './NetworkBadge';

/** [key, href, label]: the key is the route pattern, or `at:<section>` for a section of the home page. */
const NAV: [string, string, string][] = [
  ['/sales', '#/sales', 'Sales'],
  ['/trust', '#/trust', 'Trust'],
];

export function Layout({ current, children }: { current: string; children: ReactNode }) {
  // A sale page sits under the list of sales.
  const here = (key: string) => (current === key || (key === '/sales' && current === '/sale/:id') ? ('page' as const) : undefined);
  // While the sale contract is not live, the nav says so instead of promising sales.
  const missing = useContractMissing() === true;
  const nav = NAV.map(([key, href, label]): [string, string, string] => [key, href, missing && key === '/sales' ? 'Sales (soon)' : label]);
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
            <LockTxLink />
          </nav>
          <div className="topbar-end">
            <span className="topbar-net">
              <NetworkBadge />
            </span>
            {/* The primary action keeps its look everywhere; on the Try page itself aria-current marks it. */}
            <a className="btn primary btn-sm try-cta" href="#/try" aria-current={here('/try')}>
              {HOME.ctaTry}
            </a>
            <details className="menu" {...popoverHandlers}>
              <summary aria-label="More: key ledger, withdraw, source">
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </summary>
              {/* A hash link does not reload the page: close the menu on the way out. */}
              <nav aria-label="More" onClick={(e) => e.currentTarget.closest('details')?.removeAttribute('open')}>
                <span className="menu-phone">
                  {nav.map(([key, href, label]) => (
                    <a key={key} href={href} aria-current={here(key)} onClick={onSectionLinkClick}>
                      {label}
                    </a>
                  ))}
                  <LockTxLink />
                </span>
                <a href="#/keys" aria-current={here('/keys')}>
                  Key ledger
                </a>
                <a href="#/withdraw" aria-current={here('/withdraw')}>
                  Withdraw
                </a>
                {config.repoUrl ? (
                  <a href={config.repoUrl} target="_blank" rel="noreferrer">
                    Source code
                  </a>
                ) : null}
                {/* In the app, so it works whether or not the repository is public: the explorer, the key ledger and the checks. */}
                <a href="#/trust?at=check">Evidence for judges</a>
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
          <span className="brand">
            <span className="mark" aria-hidden="true" />
            Tender
          </span>
          <NetworkBadge up />
          <nav className="footer-links" aria-label="Footer">
            <a href="#/trust">Trust</a>
            <a href="#/keys">Key ledger</a>
            <a href="#/withdraw">Withdraw</a>
            <a href="#/trust?at=check">Evidence</a>
            {config.repoUrl ? (
              <a href={config.repoUrl} target="_blank" rel="noreferrer">
                Source
              </a>
            ) : null}
          </nav>
        </div>
      </footer>
    </div>
  );
}
