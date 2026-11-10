import { renderToString } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Loading, NotFound, ReadError } from '../components/Feedback';
import { SaleCard } from '../components/SaleCard';
import type { KeysData } from '../lib/loaders';
import { KeysView } from '../pages/Keys';

describe('loading, error and empty states', () => {
  test('loading placeholder is announced as busy', () => {
    const html = renderToString(<Loading what="sales" />);
    expect(html).toContain('aria-busy="true"');
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
