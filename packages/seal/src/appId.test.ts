import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { appId } from './index.js';

describe('appId', () => {
  it('sale identity of v1.tenderseal.near', () => {
    expect(bytesToHex(appId('v1.tenderseal.near', 'tender/1/00112233445566778899aabbccddeeff'))).toBe(
      'c5db6e292be1b0b76a58ab571e4fb28b013b798f63b142cc29954d90b667c8f1',
    );
  });

  it('S2 spike identity of tenderseal.near', () => {
    expect(bytesToHex(appId('tenderseal.near', 'tender-spike/s2/0011223344556677'))).toBe(
      'e85988f4ac00512f7e608bb88418ae11bca6f01192dd3a2331e182fa42c6cc0d',
    );
  });

  it('depends on the calling account', () => {
    const p = 'tender/2/00';
    expect(bytesToHex(appId('tenderseal.near', p))).not.toBe(bytesToHex(appId('v1.tenderseal.near', p)));
  });
});
