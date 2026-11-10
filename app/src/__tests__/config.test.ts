import { describe, expect, test } from 'vitest';
import { config } from '../config';
import { parseHash, titleFor } from '../router';

describe('RPC defaults (OPS-04)', () => {
  test('the deprecated rpc.mainnet.near.org is not a default fallback', () => {
    expect(config.rpcUrls.join(' ')).not.toContain('rpc.mainnet.near.org');
    expect(config.rpcUrls[0]).toBe('https://free.rpc.fastnear.com');
  });
});

describe('page titles (X12A-07)', () => {
  const t = (hash: string) => titleFor(parseHash(hash));
  test('every route has its own title', () => {
    const titles = ['#/', '#/sale/1', '#/sale/2', '#/bid/1', '#/try', '#/keys', '#/withdraw', '#/nope'].map(t);
    expect(new Set(titles).size).toBe(titles.length);
    expect(t('#/sale/7')).toContain('Sale #7');
    expect(t('#/bid/7')).toContain('Bid on sale #7');
  });
});
