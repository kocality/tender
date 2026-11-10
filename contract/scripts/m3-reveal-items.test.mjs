// node --test contract/scripts/m3-reveal-items.test.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'm3-reveal-items.mjs');

// RPC stand-in: get_bids of sale 0 holds one bid (cm "aa…", bidder b.testnet).
function rpc() {
  const bids = [{ idx: 0, bidder: 'b.testnet', cm: 'aa'.repeat(32) }];
  const server = createServer((_req, res) => {
    const result = [...Buffer.from(JSON.stringify(bids))];
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { result } }));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

function run(args) {
  return new Promise((ok) => {
    execFile(process.execPath, [script, ...args], (err, stdout, stderr) => ok({ code: err ? err.code : 0, stdout, stderr }));
  });
}

// X12-02: a secret file left by a re-run of seal:bid (or a refunded bid) matches no bid; it is
// skipped with a warning instead of failing the whole reveal.
test('skips_unmatched_bid_file', async () => {
  const server = await rpc();
  const dir = mkdtempSync(join(tmpdir(), 'reveal-items-'));
  const file = (name, cm) => writeFileSync(join(dir, name), JSON.stringify({
    sale: '0', contract: 'v1.t.testnet', signer: 'b.testnet', cm, p: '3600000', q: '1000000', salt: '11'.repeat(16),
  }));
  file('a-match.json', 'aa'.repeat(32));
  file('b-orphan.json', 'bb'.repeat(32));
  const rpcUrl = `http://127.0.0.1:${server.address().port}`;
  const args = ['--network', 'testnet', '--contract', 'v1.t.testnet', '--sale', '0', '--rpc', rpcUrl];
  const r = await run([...args, '--bids-glob', join(dir, '*.json')]);
  const none = await run([...args, '--bids-glob', join(dir, 'b-*.json')]);
  server.close();
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).items, [{ idx: 0, p: '3600000', q: '1000000', salt: '11'.repeat(16) }]);
  assert.match(r.stderr, /skip .*b-orphan\.json/);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /no bid file matches a bid of sale 0/);
});
