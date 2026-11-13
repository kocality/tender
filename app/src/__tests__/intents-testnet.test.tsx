import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import bids1 from '../__fixtures__/views/bids-1.json';
import sale0 from '../__fixtures__/views/sale-0-cancelled.json';
import sale1 from '../__fixtures__/views/sale-1-keyed.json';
import { parseBid, parseSale } from '../lib/views';

// Testnet has no intents.near: a testnet build talks to the project's own copy (JUDGES row T11). Wherever the app names
// NEAR Intents on testnet it says so; on mainnet the name stays as it is.

const LABEL = 'NEAR Intents (our testnet copy)';
const COPY_ID = 'intents-09bdfe.testnet';
const TESTNET = { VITE_NETWORK: 'testnet', VITE_INTENTS_CONTRACT_ID: COPY_ID };
const text = (html: string) => html.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'").replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
/** Every "NEAR Intents" that is not followed by the testnet label (or is not the footer sentence that explains it). */
const unlabelled = (s: string) => [...s.matchAll(/NEAR Intents(?! \(our testnet copy\)| here is our own testnet copy)/g)].map((m) => s.slice(Math.max(0, m.index! - 40), m.index! + 50));

async function pages(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.stubGlobal('window', { location: { hash: '#/' }, addEventListener: () => {}, removeEventListener: () => {} });
  const { Layout } = await import('../components/Layout');
  const { Trust } = await import('../pages/Trust');
  const { Try } = await import('../pages/Try');
  const { HomeView } = await import('../pages/Home');
  const { SaleView } = await import('../pages/Sale');
  const { CancelledCard } = await import('../components/CancelledCard');
  const errors = await import('../lib/errors');
  const copy = await import('../copy');
  const keyed = parseSale(sale1);
  const cancelled = parseSale(sale0);
  const bids = bids1.map(parseBid);
  const NOW = keyed.closeNs + 60_000_000_000n;
  const html = [
    renderToString(<Layout current="/">{null}</Layout>),
    renderToString(<Trust />),
    renderToString(<Try />),
    renderToString(<HomeView data={[{ id: '1', sale: keyed, bids }, { id: '0', sale: cancelled, bids: [bids[0]!] }]} error={null} loading={false} nowNs={NOW} />),
    renderToString(<SaleView bundle={{ id: '0', sale: cancelled, bids: [bids[0]!] }} nowNs={NOW} />),
    renderToString(<CancelledCard sale={cancelled} bids={[bids[0]!]} />),
  ].map(text);
  const strings = [
    copy.PENALTY_RULE,
    copy.TRY_RESULT.notRegistered,
    ...copy.RELY_ON.map((r) => r.plain),
    ...copy.TOP_LIMITS.map((l) => l.text),
    ...['invalid_signature', 'public_key_not_registered', 'invalid_nonce', 'other'].map((k) => errors.humanError(k)),
  ];
  return { html, strings };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('NEAR Intents on testnet', () => {
  test('every page and message that names NEAR Intents labels it as our testnet copy', async () => {
    const { html, strings } = await pages(TESTNET);
    const all = [...html, ...strings];
    expect(all.join(' ')).toContain(LABEL);
    expect(all.flatMap(unlabelled)).toEqual([]);
    expect(all.join(' ')).not.toContain('(our testnet copy) ('); // the label never runs into a second bracket
  });

  test('the footer, on every page, names the copy and says what it runs', async () => {
    const { html } = await pages(TESTNET);
    expect(html[0]).toContain(`NEAR Intents here is our own testnet copy, ${COPY_ID}, running the same intents 0.4.5 contract code.`);
  });

  test('on mainnet the name is unchanged and no page mentions a testnet copy', async () => {
    const { html, strings } = await pages({ VITE_NETWORK: 'mainnet' });
    const all = [...html, ...strings].join(' ');
    expect(all).toContain('NEAR Intents');
    expect(all).not.toMatch(/testnet copy/);
  });
});

// 1Click is mainnet only (JUDGES P1): on testnet the sale page and the cancelled card must not promise a withdrawal to another chain.
describe('Withdraw wording follows the network', () => {
  async function money(env: Record<string, string>) {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    vi.stubGlobal('window', { location: { hash: '#/' }, addEventListener: () => {}, removeEventListener: () => {} });
    const { SaleView } = await import('../pages/Sale');
    const { CancelledCard } = await import('../components/CancelledCard');
    const cancelled = parseSale(sale0);
    const bids = [parseBid(bids1[0]!)];
    const nowNs = cancelled.closeNs + 60_000_000_000n;
    return [renderToString(<SaleView bundle={{ id: '0', sale: cancelled, bids }} nowNs={nowNs} />), renderToString(<CancelledCard sale={cancelled} bids={bids} />)].map(text);
  }

  test('testnet says withdrawals to other chains are mainnet-only and funds stay in the testnet copy', async () => {
    const [page, card] = await money(TESTNET);
    for (const t of [page!, card!]) {
      expect(t).toContain(`Withdrawals to other chains work on mainnet through 1Click; on testnet your funds stay in ${LABEL}.`);
      expect(t).not.toMatch(/Base, Arbitrum or Solana|moves it to/);
    }
  });

  test('the Withdraw page lead says cross-chain withdrawal is mainnet-only on testnet', async () => {
    vi.resetModules();
    for (const [k, v] of Object.entries(TESTNET)) vi.stubEnv(k, v);
    vi.stubGlobal('window', { location: { hash: '#/' }, addEventListener: () => {}, removeEventListener: () => {} });
    const { Withdraw } = await import('../pages/Withdraw');
    const t = text(renderToString(<Withdraw />));
    expect(t).toContain(`Withdrawals to other chains work on mainnet through 1Click; on testnet your funds stay in ${LABEL}.`);
    expect(t).not.toContain('sends them back to your wallet');
    expect(t).not.toContain('Base, Arbitrum or Solana');
  });

  test('the Withdraw page mainnet lead is unchanged', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_NETWORK', 'mainnet');
    vi.stubGlobal('window', { location: { hash: '#/' }, addEventListener: () => {}, removeEventListener: () => {} });
    const { Withdraw } = await import('../pages/Withdraw');
    const t = text(renderToString(<Withdraw />));
    expect(t).toContain('This page sends them back to your wallet on Base, Arbitrum or Solana.');
    expect(t).toContain('It moves tokens from your NEAR Intents account');
  });

  test('mainnet wording is unchanged', async () => {
    const [page, card] = await money({ VITE_NETWORK: 'mainnet' });
    expect(page).toContain('Withdraw moves it to a wallet on Base, Arbitrum or Solana. 1Click fees are not refunded.');
    expect(card).toContain('Withdraw moves it to another chain; 1Click fees are not refunded.');
  });
});

describe('one home for the name', () => {
  const src = join(__dirname, '..');
  const files = readdirSync(src, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && /\.tsx?$/.test(d.name) && !d.parentPath.includes('__tests__'))
    .map((d) => join(d.parentPath, d.name));
  test('no UI string spells "NEAR Intents" outside the label and the testnet sentence in copy.ts', () => {
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*\*|\{\/\*)/.test(line) || !line.includes('NEAR Intents')) return;
          if (f.endsWith('copy.ts') && (line.includes('export const NEAR_INTENTS') || line.includes('NEAR Intents here is our own testnet copy'))) return;
          hits.push(`${f.slice(src.length + 1)}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
