/// <reference types="node" />
import { describe, expect, test } from 'vitest';
import { b58encode, fromBase64, fromHex, payloadString, rawEd25519FromWallet, simulateIntents, solanaSignerId, utf8 } from '@tender/intents';
import { config } from '../config';
import { OneClickError, quoteWithdraw, withdrawQuoteBody, type QuoteResponse, type StatusResponse } from '../lib/oneclick';
import { buildWithdrawPayload, followWithdraw, quoteProblem, txHashes, validateWithdraw, withdrawEvidence } from '../lib/withdrawFlow';
import { WITHDRAW_TARGETS, defaultRecipient, destinationTxUrl, recipientError, withdrawSources } from '../lib/withdrawRoutes';

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const SIGNER = '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a';
const DEPOSIT = '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd';
const BASE = WITHDRAW_TARGETS.find((t) => t.id === 'base-usdc')!;
const NOW = Date.UTC(2026, 10, 12, 0, 0, 0);

function quote(over: Partial<QuoteResponse['quote']> = {}): QuoteResponse {
  return {
    quote: { depositAddress: DEPOSIT, amountIn: '1000000', amountOut: '997498', minAmountOut: '987523', deadline: new Date(NOW + 1_800_000).toISOString(), ...over },
  };
}

describe('withdraw quote body', () => {
  const body = withdrawQuoteBody({ originAsset: USDC, destinationAsset: BASE.assetId, amount: 1_000_000n, signerId: SIGNER, recipient: SIGNER, dry: false, nowMs: NOW });
  test('fields are exactly the INTENTS to DESTINATION_CHAIN request', () => {
    expect(body).toEqual({
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: USDC,
      depositType: 'INTENTS',
      destinationAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
      amount: '1000000',
      refundTo: SIGNER,
      refundType: 'INTENTS',
      recipient: SIGNER,
      recipientType: 'DESTINATION_CHAIN',
      deadline: '2026-11-12T00:30:00.000Z',
    });
  });
  test('refunds go to the signer id and there is no confidentiality field', () => {
    expect(body.refundTo).toBe(SIGNER);
    expect(body).not.toHaveProperty('confidentiality');
  });
});

describe('the withdrawal Transfer', () => {
  test('pays exactly quote.amountIn to the deposit address, with no msg and no min_gas', async () => {
    const q = quote({ amountIn: '1234567' });
    const p = await buildWithdrawPayload({ signerId: SIGNER, depositAddress: q.quote.depositAddress!, tokenId: USDC, amountIn: BigInt(q.quote.amountIn), saltHex: '252812b3', nowMs: NOW });
    expect(p.signer_id).toBe(SIGNER);
    expect(p.intents).toHaveLength(1);
    const t = p.intents[0]!;
    expect(t.intent).toBe('transfer');
    expect(t.receiver_id).toBe(DEPOSIT);
    expect(t.tokens).toEqual({ [USDC]: q.quote.amountIn });
    expect(t).not.toHaveProperty('msg');
    expect(t).not.toHaveProperty('min_gas');
    expect(fromBase64(p.nonce)).toHaveLength(32);
  });
});

describe('recipient validation', () => {
  test('EVM addresses', () => {
    expect(recipientError('base', SIGNER)).toBeNull();
    expect(recipientError('arb', '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A')).toBeNull(); // EIP-55 checksum
    expect(recipientError('base', '0x123')).not.toBeNull();
    expect(recipientError('base', `0x${'g'.repeat(40)}`)).not.toBeNull();
    expect(recipientError('base', '')).not.toBeNull();
  });
  test('Solana addresses must be base58 of 32 bytes', () => {
    expect(recipientError('sol', b58encode(new Uint8Array(32).fill(7)))).toBeNull();
    expect(recipientError('sol', b58encode(new Uint8Array(31).fill(7)))).not.toBeNull();
    expect(recipientError('sol', b58encode(new Uint8Array(33).fill(7)))).not.toBeNull();
    expect(recipientError('sol', '0OIl-not-base58')).not.toBeNull();
    expect(recipientError('sol', SIGNER)).not.toBeNull();
  });
  test('default recipient is the wallet of the same chain family', () => {
    expect(defaultRecipient('base', { kind: 'evm', signerId: SIGNER })).toBe(SIGNER);
    expect(defaultRecipient('sol', { kind: 'evm', signerId: SIGNER })).toBe('');
    expect(defaultRecipient('sol', { kind: 'phantom', signerId: DEPOSIT, publicKey: 'PhantomBase58' })).toBe('PhantomBase58');
    expect(defaultRecipient('arb', { kind: 'phantom', signerId: DEPOSIT, publicKey: 'x' })).toBe('');
  });
});

describe('routes', () => {
  test('sources are the quote token, wNEAR and JAMBO, without duplicates', () => {
    expect(withdrawSources(USDC).map((s) => [s.symbol, s.decimals])).toEqual([['USDC', 6], ['wNEAR', 24], ['JAMBO', 18]]);
    expect(withdrawSources('nep141:wrap.near').map((s) => s.tokenId)).toEqual(['nep141:wrap.near', 'nep141:jambo-1679.meme-cooking.near']);
  });
  test('targets and explorers', () => {
    expect(WITHDRAW_TARGETS.map((t) => t.id)).toEqual(['base-usdc', 'arb-usdc', 'sol-usdc', 'sol']);
    expect(WITHDRAW_TARGETS.find((t) => t.id === 'sol')).toMatchObject({ assetId: 'nep141:sol.omft.near', decimals: 9 });
    expect(destinationTxUrl('base', '0xab')).toBe('https://basescan.org/tx/0xab');
    expect(destinationTxUrl('arb', '0xab')).toBe('https://arbiscan.io/tx/0xab');
    expect(destinationTxUrl('sol', 'sig')).toBe('https://solscan.io/tx/sig');
  });
});

describe('form and quote checks', () => {
  const usdc = withdrawSources(USDC)[0]!;
  const wnear = withdrawSources(USDC)[1]!;
  test('amount is read in the token decimals and capped by the balance', () => {
    expect(validateWithdraw({ amountText: '1', source: usdc, balance: 3_000_000n, chain: 'base', recipient: SIGNER })).toEqual({ ok: true, amount: 1_000_000n });
    expect(validateWithdraw({ amountText: '0.5', source: wnear, balance: 10n ** 24n, chain: 'sol', recipient: b58encode(new Uint8Array(32).fill(1)) })).toEqual({ ok: true, amount: 5n * 10n ** 23n });
    expect(validateWithdraw({ amountText: '3.000001', source: usdc, balance: 3_000_000n, chain: 'base', recipient: SIGNER }).ok).toBe(false);
    expect(validateWithdraw({ amountText: '0', source: usdc, balance: 3_000_000n, chain: 'base', recipient: SIGNER }).ok).toBe(false);
    expect(validateWithdraw({ amountText: '1.0000001', source: usdc, balance: 3_000_000n, chain: 'base', recipient: SIGNER }).ok).toBe(false);
    expect(validateWithdraw({ amountText: '1', source: usdc, balance: 3_000_000n, chain: 'sol', recipient: SIGNER }).ok).toBe(false);
  });
  test('a quote is rejected when it is expired, over balance or has no deposit address', () => {
    expect(quoteProblem(quote(), 1_000_000n, NOW)).toBeNull();
    expect(quoteProblem(quote(), 999_999n, NOW)).toMatch(/above your Intents balance/);
    expect(quoteProblem(quote({ deadline: new Date(NOW - 1000).toISOString() }), 1_000_000n, NOW)).toMatch(/expired/);
    expect(quoteProblem(quote({ depositAddress: undefined }), 1_000_000n, NOW)).toMatch(/no deposit address/);
  });
});

describe('status and evidence', () => {
  test('txHashes accepts strings and {hash} objects', () => {
    expect(txHashes(['0xa', { hash: '0xb', explorerUrl: 'u' }, { nope: 1 }, null, ''])).toEqual(['0xa', '0xb']);
    expect(txHashes(undefined)).toEqual([]);
  });
  test('evidence JSON has the five recorded fields', () => {
    const status: StatusResponse = { status: 'SUCCESS', swapDetails: { nearTxHashes: ['n1', 'n2'], destinationChainTxHashes: [{ hash: '0xdest', explorerUrl: 'x' }] } };
    expect(withdrawEvidence({ depositAddress: DEPOSIT, status, relayTx: 'relayhash' })).toEqual({
      step: 'withdraw',
      deposit_address: DEPOSIT,
      near_tx_hashes: ['n1', 'n2'],
      destination_tx: '0xdest',
      relay_tx: 'relayhash',
    });
  });
});

describe('followWithdraw', () => {
  const noSleep = async () => {};
  test('polls until SUCCESS and reports each status', async () => {
    const seq: StatusResponse[] = [{ status: 'PENDING_DEPOSIT' }, { status: 'PROCESSING' }, { status: 'SUCCESS' }];
    const seen: string[] = [];
    let i = 0;
    const out = await followWithdraw({ depositAddress: DEPOSIT, fetchStatus: async () => seq[i++]!, sleep: noSleep, onStatus: (s) => seen.push(s.status) });
    expect(out.status).toBe('SUCCESS');
    expect(seen).toEqual(['PENDING_DEPOSIT', 'PROCESSING', 'SUCCESS']);
  });
  test('two 404s are tolerated, the third in a row is an error', async () => {
    let n = 0;
    const ok = await followWithdraw({
      depositAddress: DEPOSIT,
      sleep: noSleep,
      fetchStatus: async () => {
        if (n++ < 2) throw new OneClickError('1Click 404: not found', 404);
        return { status: 'SUCCESS' };
      },
    });
    expect(ok.status).toBe('SUCCESS');
    await expect(
      followWithdraw({ depositAddress: DEPOSIT, sleep: noSleep, fetchStatus: async () => { throw new OneClickError('1Click 404: not found', 404); } }),
    ).rejects.toThrow(/404 three times/);
  });
  test('a success between 404s resets the count; REFUNDED ends the poll', async () => {
    const steps: (number | StatusResponse)[] = [404, 404, { status: 'PROCESSING' }, 404, 404, { status: 'REFUNDED' }];
    let i = 0;
    const out = await followWithdraw({
      depositAddress: DEPOSIT,
      sleep: noSleep,
      fetchStatus: async () => {
        const s = steps[i++]!;
        if (typeof s === 'number') throw new OneClickError('1Click 404: nf', s);
        return s;
      },
    });
    expect(out.status).toBe('REFUNDED');
  });
});

// Free dry quotes against the real 1Click API (no deposit address is created).
describe.skipIf(!process.env.LIVE)('live 1Click dry withdrawal quote', () => {
  test('Intents USDC 1.0 to Base: amountOut above 0.99 USDC', async () => {
    const q = await quoteWithdraw({ originAsset: USDC, destinationAsset: BASE.assetId, amount: 1_000_000n, signerId: SIGNER, recipient: SIGNER, dry: true });
    expect(BigInt(q.quote.amountOut)).toBeGreaterThan(990_000n);
    expect(BigInt(q.quote.amountIn)).toBe(1_000_000n);
  }, 30_000);
  test('wNEAR to SOL dry quote parses with 24 to 9 decimals', async () => {
    const sol = WITHDRAW_TARGETS.find((t) => t.id === 'sol')!;
    const q = await quoteWithdraw({ originAsset: 'nep141:wrap.near', destinationAsset: sol.assetId, amount: 10n ** 24n, signerId: SIGNER, recipient: b58encode(new Uint8Array(32).fill(9)), dry: true });
    expect(BigInt(q.quote.amountOut)).toBeGreaterThan(0n);
  }, 30_000);
  test('a signed withdrawal Transfer passes signature, nonce and salt checks on mainnet (unfunded: insufficient_balance)', async () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey('pkcs8', new Uint8Array([...fromHex('302e020100300506032b657004220420'), ...seed]), { name: 'Ed25519' }, true, ['sign']);
    const jwk = await crypto.subtle.exportKey('jwk', key);
    const pk32 = fromBase64(jwk.x!.replace(/-/g, '+').replace(/_/g, '/') + '=');
    const signerId = solanaSignerId(pk32);
    const payload = await buildWithdrawPayload({ signerId, depositAddress: DEPOSIT, tokenId: USDC, amountIn: 1_000_000n });
    const str = payloadString(payload);
    const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key, utf8(str)));
    const sim = await simulateIntents(config.rpcUrls, config.intentsContractId, [rawEd25519FromWallet(str, pk32, sig)]);
    expect(sim.ok).toBe(false);
    if (!sim.ok) expect(sim.kind).toBe('insufficient_balance');
  }, 30_000);
});

describe('EVM recipient checksum (X12-02 unicode, X12A-04)', () => {
  const good = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'; // EIP-55 reference vector
  const typo = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'; // last letter's case flipped
  test('a mixed-case address with a broken checksum is rejected on Base and Arbitrum', () => {
    expect(recipientError('base', typo)).toMatch(/checksum/i);
    expect(recipientError('arb', typo)).not.toBeNull();
  });
  test('the correct checksum and the all-lowercase form are accepted', () => {
    expect(recipientError('base', good)).toBeNull();
    expect(recipientError('base', good.toLowerCase())).toBeNull();
  });
});
