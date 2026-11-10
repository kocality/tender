import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Rpc, RpcError } from '../../src/lib/rpc.js';
import { IntentsViews, MpcViews } from '../../src/lib/views.js';

const fixture = (f: string) => readFileSync(new URL(`../fixtures/rpc/${f}`, import.meta.url), 'utf8');
const ok = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

/** fetch stub: answers by URL from a queue of handlers; records each call's URL. */
function script(handlers: ((url: string) => Response | Promise<Response>)[]) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const h = handlers.shift();
    if (!h) throw new Error('no more scripted responses');
    return h(url);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('Rpc', () => {
  it('fails over after 3 attempts with 1/2/4 s backoff', async () => {
    const waits: number[] = [];
    const { calls, fetchImpl } = script([
      () => new Response('', { status: 429 }),
      () => new Response('', { status: 503 }),
      () => {
        throw new TypeError('fetch failed');
      },
      () => new Response('', { status: 429 }),
      () => ok(fixture('signer-version.json')),
    ]);
    const rpc = new Rpc(['https://a', 'https://b'], { fetchImpl, sleep: async (ms) => void waits.push(ms) });
    expect(await new MpcViews(rpc, 'v1.signer').version()).toBe('3.18.0');
    expect(calls).toEqual(['https://a', 'https://a', 'https://a', 'https://b', 'https://b']);
    expect(waits).toEqual([1000, 2000, 4000, 1000]);
    expect(rpc.lastProvider).toBe('https://b');
  });

  it('waits [1000,2000,4000,1000,2000] and throws when every attempt is transient', async () => {
    const waits: number[] = [];
    const { calls, fetchImpl } = script(Array.from({ length: 6 }, () => () => new Response('', { status: 502 })));
    const rpc = new Rpc(['https://a', 'https://b'], { fetchImpl, sleep: async (ms) => void waits.push(ms) });
    await expect(rpc.call('status', [])).rejects.toMatchObject({ kind: 'transient' });
    expect(calls).toHaveLength(6);
    expect(waits).toEqual([1000, 2000, 4000, 1000, 2000]);
  });

  it('does not retry UNKNOWN_ACCOUNT', async () => {
    const waits: number[] = [];
    const { calls, fetchImpl } = script([() => ok(fixture('unknown-account.json'))]);
    const rpc = new Rpc(['https://a', 'https://b'], { fetchImpl, sleep: async (ms) => void waits.push(ms) });
    const e = await rpc.viewAccount('v1.tenderseal.near').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RpcError);
    expect(e).toMatchObject({ kind: 'permanent', cause_name: 'UNKNOWN_ACCOUNT' });
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('retries a JSON-RPC TIMEOUT_ERROR', async () => {
    const waits: number[] = [];
    const { calls, fetchImpl } = script([
      () => ok(JSON.stringify({ jsonrpc: '2.0', id: 'tender', error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' }, data: 'timeout' } })),
      () => ok(fixture('signer-access-keys.json')),
    ]);
    const rpc = new Rpc(['https://a'], { fetchImpl, sleep: async (ms) => void waits.push(ms) });
    expect((await rpc.viewAccessKeyList('v1.signer')).keys).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([1000]);
  });

  it('moves to the next provider without waiting on HTTP 403', async () => {
    const waits: number[] = [];
    const { calls, fetchImpl } = script([() => new Response('', { status: 403 }), () => ok(fixture('signer-version.json'))]);
    const rpc = new Rpc(['https://a', 'https://b'], { fetchImpl, sleep: async (ms) => void waits.push(ms) });
    expect(await rpc.view('v1.signer', 'version', {})).toBe('3.18.0');
    expect(calls).toEqual(['https://a', 'https://b']);
    expect(waits).toEqual([]);
  });

  it('reads a block-pinned view (block_id) and the recorded MPC views', async () => {
    const bodies: unknown[] = [];
    const answers = [fixture('signer-state.json'), fixture('signer-public-key-2.json'), fixture('intents-mt-batch-balance.json')];
    const fetchImpl = (async (_u: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return ok(answers.shift()!);
    }) as unknown as typeof fetch;
    const rpc = new Rpc(['https://a'], { fetchImpl });
    const mpc = new MpcViews(rpc, 'v1.signer');
    expect(await mpc.state(223888346n)).toEqual({ status: 'Running', threshold: 11, participants: 16 });
    expect(await mpc.publicKey(2)).toMatch(/^bls12381g2:24mhN4Rn/);
    expect(await new IntentsViews(rpc, 'intents.near').mtBatchBalanceOf('tenderseal.near', ['a', 'b'])).toEqual([0n, 0n]);
    expect((bodies[0] as { params: Record<string, unknown> }).params).toMatchObject({ block_id: 223888346, method_name: 'state' });
    expect((bodies[1] as { params: Record<string, unknown> }).params).toMatchObject({ finality: 'final' });
  });
});
