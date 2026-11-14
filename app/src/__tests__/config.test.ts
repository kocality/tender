import { afterEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config';
import configView from '../__fixtures__/views/config.json';
import { parseConfig } from '../lib/views';
import { parseHash, titleFor } from '../router';

const MAINNET_RPCS = ['https://free.rpc.fastnear.com', 'https://near.drpc.org', 'https://rpc.shitzuapes.xyz'];
const TESTNET_RPCS = ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org', 'https://testnet-rpc.intea.rs'];
const domain = (u: string) => new URL(u).hostname.split('.').slice(-2).join('.');

async function configFor(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return (await import('../config')).config;
}
afterEach(() => vi.unstubAllEnvs());

describe('RPC defaults (OPS-04)', () => {
  test('the deprecated rpc.mainnet.near.org is not a default fallback', () => {
    expect(config.rpcUrls.join(' ')).not.toContain('rpc.mainnet.near.org');
    expect(config.rpcUrls[0]).toBe('https://free.rpc.fastnear.com');
  });
  test('mainnet reads have three independent providers by default', () => {
    expect(config.rpcUrls).toEqual(MAINNET_RPCS);
    expect(new Set(config.rpcUrls.map(domain)).size).toBeGreaterThanOrEqual(3);
  });
  test('testnet has its own three providers and never reads mainnet or the deprecated near.org nodes', async () => {
    const c = await configFor({ VITE_NETWORK: 'testnet' });
    expect(c.rpcUrls).toEqual(TESTNET_RPCS);
    expect(c.rpcUrls.join(' ')).not.toMatch(/\/\/rpc\.(mainnet|testnet)\.near\.org/);
  });
  test('an explicit VITE_NEAR_RPC_URL goes first and the defaults still follow it, without duplicates', async () => {
    const c = await configFor({ VITE_NEAR_RPC_URL: 'https://near.drpc.org' });
    expect(c.rpcUrls).toEqual(['https://near.drpc.org', 'https://free.rpc.fastnear.com', 'https://rpc.shitzuapes.xyz']);
  });
});

describe('page titles (X12A-07)', () => {
  const t = (hash: string) => titleFor(parseHash(hash));
  test('every route has its own title', () => {
    const titles = ['#/', '#/sales', '#/sale/1', '#/sale/2', '#/bid/1', '#/try', '#/keys', '#/withdraw', '#/nope'].map(t);
    expect(new Set(titles).size).toBe(titles.length);
    expect(t('#/sale/7')).toContain('Sale #7');
    expect(t('#/bid/7')).toContain('Bid on sale #7');
  });
});

describe('app public key mode (CRYPTO-07)', () => {
  test('the config fixture reports generator, the mode v1 is born with', () => {
    expect(parseConfig(configView).appPkMode).toBe('generator');
  });
});
