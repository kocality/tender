import type { ReactNode } from 'react';
import { TRUST_LINE } from '../copy';

const NAV: [string, string, string][] = [
  ['/', '#/', 'Twin sales'],
  ['/try', '#/try', 'Try signing (free)'],
  ['/keys', '#/keys', 'Key ledger'],
  ['/withdraw', '#/withdraw', 'Withdraw'],
];

export function Layout({ current, children }: { current: string; children: ReactNode }) {
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/">
          Tender
        </a>
        <nav className="nav" aria-label="Main">
          {NAV.map(([path, href, label]) => (
            <a key={path} href={href} aria-current={current === path ? 'page' : undefined}>
              {label}
            </a>
          ))}
        </nav>
      </header>
      <p className="trust">{TRUST_LINE}</p>
      <main tabIndex={-1}>{children}</main>
    </div>
  );
}
