// Shared by the verify tests: a tiny wasm module, the CLI runner over the fake world, fake NearBlocks / 1Click.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { World } from '../src/lib/sim.js';
import { fakeRpc } from '../src/lib/sim.js';
import { main } from '../src/verify.js';
import { codeHashB58 } from '../src/lib/wasm.js';

const te = new TextEncoder();
const leb = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const str = (s: string) => [...leb(te.encode(s).length), ...te.encode(s)];
const section = (id: number, body: number[]) => [id, ...leb(body.length), ...body];

/** A minimal module importing `env.<name>: () -> ()` for each name. */
export function moduleImporting(names: string[]): Uint8Array<ArrayBuffer> {
  const types = section(1, [1, 0x60, 0, 0]);
  const imports = section(2, [...leb(names.length), ...names.flatMap((n) => [...str('env'), ...str(n), 0x00, 0x00])]);
  return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...types, ...imports]);
}

export const GOOD_WASM = moduleImporting(['promise_batch_create', 'promise_batch_action_function_call_weight', 'promise_batch_action_transfer']);

/** Writes `wasm` to a temp file and makes the world's deployed code hash match it. */
export function deploy(world: World, wasm: Uint8Array = GOOD_WASM): string {
  const dir = mkdtempSync(join(tmpdir(), 'verify-'));
  const file = join(dir, 'tender.wasm');
  writeFileSync(file, wasm);
  world.codeHash = codeHashB58(wasm);
  return file;
}

export function writeEvidence(rows: object[]): string {
  const file = join(mkdtempSync(join(tmpdir(), 'verify-ev-')), 'mainnet.json');
  writeFileSync(file, JSON.stringify(rows));
  return file;
}

/** NearBlocks: `receipts` request receipts from the world's contract (null = HTTP 429). 1Click: `oneclick` statuses. */
export function fakeHttp(world: World, { receipts = null as number | null, oneclick = {} as Record<string, string> } = {}): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (url.includes('/v3/accounts/')) {
      if (receipts === null) return new Response(JSON.stringify({ data: null, errors: [{ message: 'rate limited' }] }), { status: 429 });
      const data = Array.from({ length: receipts }, (_, i) => ({
        receipt_id: `r${i}`,
        transaction_hash: `t${i}`,
        predecessor_account_id: world.contract,
        receiver_account_id: world.mpc,
        block: { block_height: 1 + i, block_timestamp: '1' },
      }));
      return new Response(JSON.stringify({ data, meta: { next_page: null } }), { status: 200 });
    }
    if (url.includes('/v0/status')) {
      const addr = decodeURIComponent(url.split('depositAddress=')[1] ?? '');
      const s = oneclick[addr];
      return s ? new Response(JSON.stringify({ status: s }), { status: 200 }) : new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

export interface RunOpts {
  args?: string[];
  wasmFile?: string;
  evidenceFile?: string;
  http?: typeof fetch;
  rpcFetch?: typeof fetch;
}

export async function runVerify(world: World, o: RunOpts = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (l: string) => void out.push(l), err: (l: string) => void err.push(l) };
  const args = o.args ?? [
    '--sale',
    world.sale.id,
    '--wasm',
    o.wasmFile ?? deploy(world),
    '--evidence',
    o.evidenceFile ?? join(tmpdir(), 'tender-no-such-evidence.json'),
  ];
  const code = await main([...args, '--contract', world.contract, '--network', world.network, '--rpc', 'https://fake.rpc'], io, {
    fetchImpl: o.rpcFetch ?? fakeRpc(world),
    httpFetch: o.http ?? fakeHttp(world),
    sleep: async () => {},
    repoMpk: world.mpk,
  });
  const line = (n: number) => out.find((l) => new RegExp(`^(PASS|WARN|FAIL|n/a) #${n} `).test(l)) ?? '';
  return { code, out, err, line, status: (n: number) => line(n).split(' ')[0] };
}
