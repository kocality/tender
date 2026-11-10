import { describe, expect, it } from 'vitest';
import { resolveNetwork } from '../../src/lib/config.js';
import { accountUrl, blockUrl, txUrl } from '../../src/lib/explorer.js';
import { formatTokens, formatUsdc, parseDecimal, priceUnit, stringifyJson, utcFromNs } from '../../src/lib/format.js';

describe('format', () => {
  it('parseDecimal', () => {
    expect(parseDecimal('3.9', 6)).toBe(3_900_000n);
    expect(parseDecimal('5', 6)).toBe(5_000_000n);
    expect(parseDecimal('0.000001', 6)).toBe(1n);
    expect(() => parseDecimal('3.9999999', 6)).toThrow('more than 6 decimal places');
    expect(() => parseDecimal('-1', 6)).toThrow('not a decimal');
    expect(() => parseDecimal('1e6', 6)).toThrow('not a decimal');
  });

  it('formatUsdc keeps at least 2 decimals and never rounds', () => {
    expect(formatUsdc(3_600_000n)).toBe('3.60');
    expect(formatUsdc(800_001n)).toBe('0.800001');
    expect(formatUsdc(10_800_001n)).toBe('10.800001');
    expect(formatUsdc(0n)).toBe('0.00');
  });

  it('formatTokens', () => {
    expect(formatTokens(1111111111111111111111111n, 24)).toBe('1.111111111111111111111111');
    expect(formatTokens(3n * 10n ** 24n, 24)).toBe('3');
    expect(formatTokens(0n, 24)).toBe('0');
  });

  it('utcFromNs', () => {
    expect(utcFromNs(1_794_312_000_000_000_000n)).toBe('2026-11-10T12:00:00Z');
    expect(utcFromNs('1794312000123456789')).toBe('2026-11-10T12:00:00Z');
  });

  it('priceUnit', () => {
    expect(priceUnit({ token: 'nep141:wrap.near', lot_exp: 0 })).toBe('USDC/NEAR');
    expect(priceUnit({ token: 'nep141:jambo-1679.meme-cooking.near', lot_exp: 3 })).toBe('USDC per 1000 JAMBO');
    expect(priceUnit({ token: 'nep141:x.near', lot_exp: 0 })).toBe('USDC/nep141:x.near');
  });

  it('stringifyJson writes bigints as strings', () => {
    expect(stringifyJson({ a: 1n, b: [2n] })).toBe('{"a":"1","b":["2"]}');
  });

  it('explorer links', () => {
    expect(txUrl('mainnet', 'H')).toBe('https://nearblocks.io/txns/H');
    expect(accountUrl('testnet', 'a.testnet')).toBe('https://testnet.nearblocks.io/address/a.testnet');
    expect(blockUrl('mainnet', 5n)).toBe('https://nearblocks.io/blocks/5');
  });

  it('resolveNetwork: flag > env > default', () => {
    expect(resolveNetwork({}, {})).toMatchObject({ network: 'mainnet', contract: 'v1.tenderseal.near', mpc: 'v1.signer', rpc: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org'] });
    expect(resolveNetwork({}, { TENDER_CONTRACT_ID: 'rehearsal.tenderseal.near', NEAR_RPC_URL: 'https://env' })).toMatchObject({ contract: 'rehearsal.tenderseal.near', rpc: ['https://env'] });
    expect(resolveNetwork({ contract: 'flag.near', rpc: 'https://flag' }, { TENDER_CONTRACT_ID: 'env.near', NEAR_RPC_URL: 'https://env' })).toMatchObject({ contract: 'flag.near', rpc: ['https://flag'] });
    expect(() => resolveNetwork({ network: 'testnet' }, {})).toThrow('--contract is required on testnet');
    expect(resolveNetwork({ network: 'testnet', contract: 'v1.tender-abc.testnet' }, {})).toMatchObject({ mpc: 'v1.signer-prod.testnet' });
  });
});
