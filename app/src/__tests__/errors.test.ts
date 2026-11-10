import { ViewPanic, viewCall } from '@tender/intents';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { recoveryFor } from '../lib/bidFlow';
import { WALLET_BUSY, WALLET_DECLINED, humanError, humanStatus, isRpcUnavailable, isUserRejection } from '../lib/errors';
import { OneClickError } from '../lib/oneclick';
import { RelayError } from '../lib/relay';
import { walletErrorMessage } from '../wallets/types';

const INTENTS_KINDS = [
  'insufficient_balance',
  'invalid_signature',
  'public_key_not_registered',
  'deadline_expired',
  'deadline_gt_nonce',
  'nonce_used',
  'nonce_expired',
  'invalid_nonce',
  'invalid_salt',
  'wrong_verifying_contract',
] as const;
const RELAY_KINDS = ['busy', 'unconfigured', 'unavailable'] as const;
const ONECLICK_STATUSES = ['KNOWN_DEPOSIT_TX', 'PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED'] as const;

describe('humanError tables', () => {
  test('every Intents error kind and relay outcome has its own sentence with a next step', () => {
    const seen = new Set<string>();
    for (const k of [...INTENTS_KINDS, ...RELAY_KINDS]) {
      const text = humanError(k, 'raw panic text');
      expect(text, k).not.toBe(k);
      expect(text, k).not.toContain('raw panic text');
      expect(text.endsWith('.'), k).toBe(true);
      seen.add(text);
    }
    expect(seen.size).toBe(INTENTS_KINDS.length + RELAY_KINDS.length);
  });

  test("kind 'other' shows the raw detail, and a generic line when there is none", () => {
    expect(humanError('other', 'something odd')).toBe('something odd');
    expect(humanError('other')).toContain('Reload the page');
  });

  test('every 1Click status has a sentence; an unknown status is returned as it is', () => {
    for (const s of ONECLICK_STATUSES) expect(humanStatus(s), s).not.toBe(s);
    expect(humanStatus('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(humanStatus('constructor')).toBe('constructor');
  });

  test('1Click HTTP errors', () => {
    expect(humanError(new OneClickError('1Click 429: slow down', 429))).toContain('rate-limiting');
    expect(humanError(new OneClickError('1Click 503: x', 503))).toContain('unavailable');
    expect(humanError(new OneClickError('1Click 400: amount too low', 400))).toContain('amount too low');
  });
});

describe('wallet rejection', () => {
  test('MetaMask 4001, viem wrapper, Phantom and NEAR wallet texts', () => {
    const metamask = Object.assign(new Error('MetaMask Message Signature: User denied message signature.'), { code: 4001 });
    const viemLike = Object.assign(new Error('User rejected the request.\n\nDetails: User rejected'), { name: 'UserRejectedRequestError' });
    const wrapped = Object.assign(new Error('Request failed'), { cause: { code: 4001, message: 'x' } });
    for (const e of [metamask, viemLike, wrapped, { code: 4001, message: 'User rejected the request.' }, 'User rejected the request', new Error('User cancelled the action')]) {
      expect(isUserRejection(e)).toBe(true);
      expect(humanError(e)).toBe(WALLET_DECLINED);
      expect(walletErrorMessage(e)).toBe(WALLET_DECLINED);
    }
  });

  test('a pending wallet request and ordinary errors', () => {
    expect(humanError({ code: -32002, message: 'Request of type personal_sign already pending' })).toBe(WALLET_BUSY);
    expect(isUserRejection(new Error('Sale cancelled by seller'))).toBe(false);
    expect(humanError(new Error('No EVM wallet found. Install MetaMask and reload.'))).toBe('No EVM wallet found. Install MetaMask and reload.');
    expect(humanError(undefined)).toContain('Try again');
  });
});

describe('other failures', () => {
  test('RelayError follows its kind; a ViewPanic names the panic; a contract panic from a wallet is explained', () => {
    expect(humanError(new RelayError('Relayer busy, retry in 30 s', 'busy'))).toContain('30 seconds');
    expect(humanError(new RelayError('boom', 'other'))).toBe('boom');
    expect(humanError(new ViewPanic('bad sale id', 'raw'))).toContain('bad sale id');
    const text = humanError(new Error('Smart contract panicked: request in flight'));
    expect(text).toContain('request in flight');
    expect(text).toContain('Reload');
  });

  test('network failures say so instead of leaking the transport error', () => {
    for (const m of ['Failed to fetch', 'https://x.rpc: HTTP 502', 'The operation timed out.']) {
      expect(humanError(new Error(m)), m).toContain('not answering');
    }
    expect(humanError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toContain('not answering');
  });

  test('recoveryFor keeps its routes and uses the same sentences', () => {
    expect(recoveryFor('insufficient_balance', 'insufficient balance or overflow')).toEqual({ to: 'fund', message: humanError('insufficient_balance') });
    expect(recoveryFor('nonce_used', 'nonce was already used')).toEqual({ to: 'fail', message: humanError('nonce_used') });
    expect(recoveryFor('deadline_expired', 'deadline has expired').to).toBe('sign_again');
  });
});

describe('polled reads', () => {
  test('transport problems are RPC unavailable, contract problems are not', () => {
    expect(isRpcUnavailable('Failed to fetch')).toBe(true);
    expect(isRpcUnavailable('https://free.rpc.fastnear.com: HTTP 500')).toBe(true);
    expect(isRpcUnavailable("https://rpc: wasm execution failed with error: HostError(GuestPanic { panic_msg: \"x\" })")).toBe(false);
    expect(isRpcUnavailable('https://rpc: "account v1.x does not exist while viewing"')).toBe(false);
  });
});

describe('a dead RPC URL (the real error from the intents RPC client)', () => {
  test('connection refused is "RPC unavailable" and reads as a network failure', async () => {
    const err = await viewCall(['http://127.0.0.1:9'], 'v1.tenderseal.near', 'get_config', {}, { backoffMs: [1] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(isRpcUnavailable(msg)).toBe(true);
    expect(humanError(err)).toContain('not answering');
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('a missing contract is not "RPC unavailable" (X12F-02)', () => {
  test('UNKNOWN_ACCOUNT from the node surfaces at once with its own text', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === 'http://one.invalid'
        ? Response.json({ jsonrpc: '2.0', id: 'tender', error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' }, code: -32000, message: 'Server error', data: 'account v1.tenderseal.near does not exist while viewing' } })
        : new Response('THIS ENDPOINT IS DEPRECATED', { status: 429 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const err = (await viewCall(['http://one.invalid', 'http://two.invalid'], 'v1.tenderseal.near', 'get_config', {}).catch((e: Error) => e)) as Error;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isRpcUnavailable(err.message)).toBe(false); // the page says "Could not read <contract>", not "RPC unavailable, retrying"
  });
});
