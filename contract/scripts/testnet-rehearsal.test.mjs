// node --test contract/scripts/testnet-rehearsal.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const sh = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'testnet-rehearsal.sh'), 'utf8');
// The ntx() function of the script, run on its own with a fake `near` on PATH.
const ntx = sh.slice(sh.indexOf('ntx() {'), sh.indexOf('\n}\n', sh.indexOf('ntx() {')) + 3);
const HASH = 'E9dH2buEaK5bT5UdjwKsK3BJZBAYV1dnv7LNHZCBCr6b';

// The fake near-cli prints line N of `outputs` on its Nth call; a line starting with "!" fails.
function runNtx(outputs) {
  const dir = mkdtempSync(join(tmpdir(), 'ntx-'));
  writeFileSync(join(dir, 'outputs'), outputs.join('\n') + '\n');
  writeFileSync(join(dir, 'near'), `#!/usr/bin/env bash
n=$(( $(cat "${dir}/count" 2>/dev/null || echo 0) + 1 )); echo $n > "${dir}/count"
line=$(sed -n "\${n}p" "${dir}/outputs")
case "$line" in "!"*) echo "\${line#!}"; exit 1;; *) echo "$line";; esac
`);
  chmodSync(join(dir, 'near'), 0o755);
  const body = `set -euo pipefail; LOGS=${dir}; setj() { :; }; ${ntx}\nntx step1 tokens x send-near y '1 NEAR'`;
  const r = spawnSync('bash', ['-c', body], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NTX_RETRY_SECS: '0' },
  });
  return { ...r, calls: Number(readFileSync(join(dir, 'count'), 'utf8')) };
}

// T-04: an RPC rate-limit refusal (nothing sent, no tx hash) is retried instead of stopping the run.
test('retries_rate_limit_before_send', () => {
  const r = runNtx(['!Error: this client has exceeded the rate limit', `Transaction ID: ${HASH}`]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls, 2);
  assert.match(r.stdout, new RegExp(`step1 tx ${HASH}`));
});

// A failure after a tx was sent is never retried (it could send twice).
test('no_retry_after_send', () => {
  const r = runNtx([`!Transaction ID: ${HASH} rate limit`, `Transaction ID: ${HASH}`]);
  assert.equal(r.status, 1);
  assert.equal(r.calls, 1);
});
