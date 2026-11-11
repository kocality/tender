import { describe, expect, test, vi } from 'vitest';
import { classifyTx, fetchTx } from '../src/index.js';

const TENDER = 'v1.tenderseal.near';
const SIGNER = '0xabc';
const ev = (event: string, d: unknown) => `EVENT_JSON:${JSON.stringify({ standard: 'tender', version: '1.0.0', event, data: [d] })}`;
const tx = (logs: string[], opts: { status?: unknown; done?: boolean; executors?: string[] } = {}) => ({
  final_execution_status: opts.done === false ? 'INCLUDED' : 'FINAL',
  status: opts.status ?? { SuccessValue: '' },
  transaction: { receiver_id: 'intents.near' },
  receipts_outcome: [
    { outcome: { executor_id: 'intents.near', logs: [] } },
    ...(opts.executors ?? [TENDER]).map((e) => ({ outcome: { executor_id: e, logs } })),
  ],
});

describe('classifyTx reads what Tender logged for one relayed transaction', () => {
  test('a bid event for this signer is stored, with its commitment and slot', () => {
    expect(classifyTx(tx([ev('bid', { sale: '1', idx: 4, bidder: SIGNER, escrow: '5', origin: 'base', cm: 'ab', nth: 1 })]), TENDER, SIGNER)).toEqual({ kind: 'stored', idx: 4, cm: 'ab', nth: 1 });
  });
  test('a refund of a bid names the reason and, for dup_bid and bid_seq, the commitment and the count', () => {
    expect(classifyTx(tx([ev('refund', { reason: 'bid_seq', sender_id: SIGNER, op: 'bid', cm: 'ab', have: 2, idx: null })]), TENDER, SIGNER)).toEqual({ kind: 'refunded', reason: 'bid_seq', cm: 'ab', have: 2, idx: null });
    expect(classifyTx(tx([ev('refund', { reason: 'closed', sender_id: SIGNER, op: 'bid' })]), TENDER, SIGNER)).toEqual({ kind: 'refunded', reason: 'closed' });
  });
  test('another account or a reveal refund is not this signer bid', () => {
    expect(classifyTx(tx([ev('refund', { reason: 'closed', sender_id: '0xother', op: 'bid' })]), TENDER, SIGNER).kind).toBe('running');
    expect(classifyTx(tx([ev('refund', { reason: 'x', sender_id: SIGNER, op: 'reveal' })]), TENDER, SIGNER).kind).toBe('running');
  });
  test('a transaction that failed inside intents.near moved nothing', () => {
    expect(classifyTx(tx([], { status: { Failure: { ActionError: { kind: 'FunctionCallError' } } }, executors: [] }), TENDER, SIGNER).kind).toBe('failed');
  });
  test('a transaction still executing is running, and so is one whose Tender receipt is not in yet', () => {
    expect(classifyTx(tx([], { done: false }), TENDER, SIGNER).kind).toBe('running');
    expect(classifyTx(tx([], { executors: [] }), TENDER, SIGNER).kind).toBe('running');
  });
  test('Tender receipt ran but logged nothing: the escrow came back through intents.near (unlogged refund)', () => {
    expect(classifyTx(tx([]), TENDER, SIGNER)).toEqual({ kind: 'refunded', reason: 'unlogged' });
  });
});

describe('fetchTx', () => {
  const unknown = { jsonrpc: '2.0', id: 'tender', error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION', info: {} }, code: -32000, message: 'Server error' } };
  test('a transaction no provider knows is null; one a later provider knows is returned', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(unknown)));
    expect(await fetchTx(['http://a.invalid', 'http://b.invalid'], 'H', 'relayer.near')).toBeNull();
    const f = vi.fn(async (url: string, _init?: { body: string }) => (url === 'http://a.invalid' ? Response.json(unknown) : Response.json({ jsonrpc: '2.0', id: 'tender', result: { final_execution_status: 'FINAL' } })));
    vi.stubGlobal('fetch', f);
    expect(await fetchTx(['http://a.invalid', 'http://b.invalid'], 'H', 'relayer.near')).toMatchObject({ final_execution_status: 'FINAL' });
    expect((JSON.parse((f.mock.calls[0]![1]!).body) as { params: unknown }).params).toEqual({ tx_hash: 'H', sender_account_id: 'relayer.near', wait_until: 'NONE' });
    vi.unstubAllGlobals();
  });
  test('a node that cannot answer is an error, not "unknown"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 502 })));
    await expect(fetchTx(['http://a.invalid'], 'H', 'relayer.near')).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});
