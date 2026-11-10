import { afterEach, describe, expect, test, vi } from 'vitest';
import { blockTimestampNs, finalBlockHeight, viewCall } from '../src/index.js';

afterEach(() => vi.unstubAllGlobals());

const UNKNOWN_ACCOUNT = {
  jsonrpc: '2.0',
  id: 'tender',
  error: {
    name: 'HANDLER_ERROR',
    cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: 'v1.tenderseal.near' } },
    code: -32000,
    message: 'Server error',
    data: 'account v1.tenderseal.near does not exist while viewing',
  },
};

describe('rpcCall', () => {
  test('a JSON-RPC error the node answered is thrown at once: no retry, no fallback, the cause survives', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === 'http://one.invalid' ? Response.json(UNKNOWN_ACCOUNT) : new Response('THIS ENDPOINT IS DEPRECATED', { status: 429 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const err = await viewCall(['http://one.invalid', 'http://two.invalid'], 'v1.tenderseal.near', 'get_config', {}).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('does not exist');
    expect((err as Error).message).not.toContain('429');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a transport failure is still retried and falls through to the next URL', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'http://one.invalid') return new Response('down', { status: 502 });
      return Response.json({ jsonrpc: '2.0', id: 'tender', result: { header: { timestamp_nanosec: '1700000000000000000' } } });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await blockTimestampNs(['http://one.invalid', 'http://two.invalid'], { backoffMs: [0, 0] })).toBe(1_700_000_000_000_000_000n);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 2 attempts on the first URL, then the second answers
  });

  test('an INTERNAL_ERROR is a node problem, not an answer: the next URL is tried', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === 'http://one.invalid'
        ? Response.json({ jsonrpc: '2.0', id: 'tender', error: { name: 'INTERNAL_ERROR', code: -32000, message: 'Server error', data: 'timeout' } })
        : Response.json({ jsonrpc: '2.0', id: 'tender', result: { header: { timestamp_nanosec: '5' } } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await blockTimestampNs(['http://one.invalid', 'http://two.invalid'], { backoffMs: [0] })).toBe(5n);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('block selection', () => {
  const bodies = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body) as { method: string; params: Record<string, unknown> });

  test('a view can be pinned to a block height instead of the latest final block', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ jsonrpc: '2.0', id: 'tender', result: { result: Array.from(new TextEncoder().encode('"ok"')) } })));
    expect(await viewCall(['http://one.invalid'], 'c.near', 'm', {}, { blockId: 777 })).toBe('ok');
    expect(bodies()[0]!.params).toMatchObject({ block_id: 777 });
    expect(bodies()[0]!.params).not.toHaveProperty('finality');
    await viewCall(['http://one.invalid'], 'c.near', 'm', {});
    expect(bodies()[1]!.params).toMatchObject({ finality: 'final' });
  });

  test('block time can be read at the head (optimistic) and the final height on its own', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ jsonrpc: '2.0', id: 'tender', result: { header: { height: 42, timestamp_nanosec: '9' } } })));
    expect(await blockTimestampNs(['http://one.invalid'], { finality: 'optimistic' })).toBe(9n);
    expect(await finalBlockHeight(['http://one.invalid'])).toBe(42);
    expect(bodies().map((b) => b.params.finality)).toEqual(['optimistic', 'final']);
  });
});
