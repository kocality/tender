import { afterEach, describe, expect, test, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { b58encode, buildPayload, buildVersionedNonce, transferIntent } from '@tender/intents';
import nearManifest from '../wallets/near-manifest.json';

const near = vi.hoisted(() => ({ options: null as unknown, wallet: null as unknown }));

vi.mock('@hot-labs/near-connect', () => ({
  NearConnector: class {
    whenManifestLoaded = Promise.resolve();
    constructor(options: unknown) {
      near.options = options;
    }
    async connect() {
      return near.wallet;
    }
  },
}));

import { callFunction, connectNear, getNearConnector } from '../wallets/near';
import { connectPhantom } from '../wallets/phantom';
import { connectEvm } from '../wallets/evm';

afterEach(() => vi.unstubAllGlobals());

const payload = (signerId: string) =>
  buildPayload({
    signerId,
    verifyingContract: 'intents.near',
    deadlineIso: '2026-11-13T02:10:00.000Z',
    nonce: buildVersionedNonce({ saltHex: '252812b3', deadlineMs: Date.parse('2026-11-13T02:10:00.000Z'), random15: new Uint8Array(15) }),
    intents: [transferIntent({ receiverId: 'v1.tenderseal.near', tokenId: 'nep141:x', amount: 1n })],
  });

describe('NEAR wallet signs as the connected account (X12A-02)', () => {
  test('signerId is passed to signMessage, and a signature from another account is refused', async () => {
    const signMessage = vi.fn(async () => ({ accountId: 'bob.near', publicKey: 'ed25519:k', signature: 'c2ln' }));
    near.wallet = { getAccounts: async () => [{ accountId: 'alice.near', publicKey: 'ed25519:k' }], signMessage };
    const signer = await connectNear();
    await expect(signer.sign(payload('alice.near'))).rejects.toThrow(/bob\.near.*alice\.near/);
    expect(signMessage).toHaveBeenCalledWith(expect.objectContaining({ signerId: 'alice.near' }));
  });
  test('transactions are sent for the connected account too', async () => {
    const signAndSendTransaction = vi.fn(async () => ({}));
    near.wallet = { getAccounts: async () => [{ accountId: 'alice.near' }], signAndSendTransaction };
    await connectNear();
    await callFunction('v1.tenderseal.near', 'open', { sale: '1' }, 100);
    expect(signAndSendTransaction).toHaveBeenCalledWith(expect.objectContaining({ signerId: 'alice.near', receiverId: 'v1.tenderseal.near' }));
  });
});

describe('Phantom account switch (X12-I1)', () => {
  test('sign() refuses before asking Phantom when the active key is no longer the connected one', async () => {
    const pk1 = b58encode(new Uint8Array(32).fill(1));
    const pk2 = b58encode(new Uint8Array(32).fill(2));
    const provider = {
      isPhantom: true,
      publicKey: { toString: () => pk1 } as { toString(): string } | null,
      connect: async () => ({ publicKey: { toString: () => pk1 } }),
      signMessage: vi.fn(async () => ({ signature: new Uint8Array(64) })),
    };
    vi.stubGlobal('window', { phantom: { solana: provider } });
    const signer = await connectPhantom();
    provider.publicKey = { toString: () => pk2 };
    await expect(signer.sign(payload(signer.signerId))).rejects.toThrow(/switched account/);
    expect(provider.signMessage).not.toHaveBeenCalled();
  });
});

describe('MetaMask account switch (X12A-02)', () => {
  const connected = privateKeyToAccount(`0x${'11'.repeat(32)}`);
  const other = privateKeyToAccount(`0x${'22'.repeat(32)}`);
  const providerSigningWith = (signer: typeof connected) => ({
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_requestAccounts') return [connected.address];
      if (method === 'personal_sign') return signer.signMessage({ message: { raw: params![0] as `0x${string}` } });
      throw new Error(`unexpected ${method}`);
    },
  });
  const withWallet = (signer: typeof connected) =>
    vi.stubGlobal('window', {
      ethereum: providerSigningWith(signer),
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    });

  test('a signature made by another account is refused', async () => {
    withWallet(other);
    const signer = await connectEvm('base');
    await expect(signer.sign(payload(signer.signerId))).rejects.toThrow(/signed as 0x.*not 0x/);
  });
  test('the connected account\'s own signature goes through', async () => {
    withWallet(connected);
    const signer = await connectEvm('base');
    expect((await signer.sign(payload(signer.signerId))).standard).toBe('erc191');
  });
});

describe('NEAR wallet manifest is pinned (X12-02 supply)', () => {
  test('the connector gets a manifest object, never the mutable default', () => {
    getNearConnector();
    const options = near.options as { manifest?: unknown };
    expect(typeof options.manifest).toBe('object');
    expect(options.manifest).toBe(nearManifest);
  });
  test('every executor is a 40-hex commit URL or same-origin; none reads a branch', () => {
    expect(nearManifest.wallets.length).toBeGreaterThan(0);
    for (const w of nearManifest.wallets) {
      expect(w.executor, w.id).not.toContain('refs/heads/');
      const pinned = /\/[0-9a-f]{40}\//.test(w.executor);
      const sameOrigin = w.executor.startsWith('/');
      expect(pinned || sameOrigin, w.id).toBe(true);
      // the connector caches executor code under id:version, so a re-pin must change the version
      const sha = /\/([0-9a-f]{40})\//.exec(w.executor)?.[1];
      if (sha) expect(w.version, w.id).toContain(`+${sha.slice(0, 7)}`);
    }
  });
  test('every wallet can sign messages, and none needs WalletConnect (no project id is configured)', () => {
    for (const w of nearManifest.wallets) {
      expect(w.features.signMessage, w.id).toBe(true);
      expect((w.permissions as { walletConnect?: boolean }).walletConnect, w.id).toBeFalsy();
    }
  });
});
