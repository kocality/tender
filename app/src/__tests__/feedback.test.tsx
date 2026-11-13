import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Loading, NotFound, ReadError } from '../components/Feedback';
import { SaleCard } from '../components/SaleCard';
import type { KeysData } from '../lib/loaders';
import { HomeView } from '../pages/Home';
import { Keys, KeysView } from '../pages/Keys';

describe('loading, error and empty states', () => {
  afterEach(() => vi.unstubAllGlobals());
  test('loading placeholder is a status region that can be read (not aria-busy)', () => {
    const html = renderToString(<Loading what="sales" />);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('aria-busy');
    expect(html).toContain('Loading sales…');
  });

  test('an unreachable RPC says "RPC unavailable, retrying" and keeps old data on screen', () => {
    const html = renderToString(<ReadError error="Failed to fetch" stale />);
    expect(html).toContain('RPC unavailable, retrying');
    expect(html).toContain('Showing the last data that was read.');
    expect(html).toContain('debug-only'); // the raw cause is hidden in record mode
    expect(renderToString(<ReadError error="https://free.rpc.fastnear.com: HTTP 502" />)).toContain('RPC unavailable, retrying');
  });

  test('a page that does not poll does not promise a retry', () => {
    const html = renderToString(<ReadError error="Failed to fetch" retrying={false} />);
    expect(html).not.toContain('retrying');
    expect(html).toContain('Reload the page');
  });

  test('a contract-level failure names the contract instead', () => {
    const html = renderToString(<ReadError error={'wasm execution failed with error: HostError(GuestPanic { panic_msg: "x" })'} />);
    expect(html).toContain('Could not read');
    expect(html).not.toContain('RPC unavailable');
  });

  test('a contract that is not deployed gets a plain empty state with a way forward; the raw RPC answer is folded', () => {
    const raw = 'https://free.rpc.fastnear.com: {"name":"HANDLER_ERROR","cause":{"name":"UNKNOWN_ACCOUNT"},"data":"account v1.tenderseal.near does not exist while viewing"}';
    const html = renderToString(<ReadError error={raw} />);
    expect(html).toContain('The sale contract is not live on NEAR');
    expect(html).toContain('href="#/try"');
    expect(html).toMatch(/<details[^>]*debug-only[^>]*><summary>Technical details<\/summary>/);
    expect(html.indexOf('UNKNOWN_ACCOUNT')).toBeGreaterThan(html.indexOf('Technical details'));
    expect(html).not.toContain('RPC unavailable');
  });

  test('the home page does not promise live sales when the contract is missing', () => {
    const raw = 'UNKNOWN_ACCOUNT: account v1.tenderseal.near does not exist while viewing';
    const html = renderToString(<HomeView data={null} error={raw} loading={false} nowNs={0n} />).replace(/<!-- -->/g, '');
    expect(html).toMatch(/once the contract is <span[^>]*>live\.<\/span>/);
    expect(html).not.toContain('Both endings,');
    expect(html).toContain('the sale contract is not live yet'); // the hero status line says so too
  });

  test('a failed read of the key ledger keeps the page title and its explanation', () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('UNKNOWN_ACCOUNT');
    });
    const html = renderToString(<Keys />);
    expect(html).toContain('<h1>Key ledger</h1>');
    expect(html).toContain('A sale that missed its public conditions has no');
  });

  test('no error renders nothing', () => {
    expect(renderToString(<ReadError error={null} />)).toBe('');
  });

  test('not found offers the way back', () => {
    const html = renderToString(<NotFound what="sale" />);
    expect(html).toContain('Not found');
    expect(html).toContain('There is no sale at this address.');
    expect(html).toContain('href="#/"');
  });

  test('a sale that is not created yet explains itself', () => {
    const html = renderToString(<SaleCard id="3" sale={null} nowNs={0n} />);
    expect(html).toContain('Sale #3 · not created yet');
    expect(html).toContain('checks again every few seconds');
  });

  test('an empty key ledger says what that means', () => {
    const data: KeysData = { mpc: 'v1.signer', mpcVersion: null, rows: [], receipts: [], sales: [] };
    const html = renderToString(<KeysView data={data} />);
    expect(html).toContain('No key request recorded yet');
    expect(html).toContain('MPC network');
  });
});
