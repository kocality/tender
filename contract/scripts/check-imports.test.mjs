// node --test contract/scripts/check-imports.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-imports.mjs');
const dir = mkdtempSync(join(tmpdir(), 'check-imports-'));

// Minimal wasm module: one `() -> ()` type and one function import per name from module `env`.
export function wasmWithImports(names) {
  const enc = new TextEncoder();
  const leb = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
  const str = (s) => { const b = [...enc.encode(s)]; return [...leb(b.length), ...b]; };
  const section = (id, body) => [id, ...leb(body.length), ...body];
  const type = section(1, [1, 0x60, 0, 0]);
  const imports = names.flatMap((n) => [...str('env'), ...str(n), 0x00, 0x00]);
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...type, ...section(2, [...leb(names.length), ...imports])]);
}

let n = 0;
function check(names, ...flags) {
  const file = join(dir, `m${n++}.wasm`);
  writeFileSync(file, wasmWithImports(names));
  const r = spawnSync(process.execPath, [script, file, ...flags], { encoding: 'utf8' });
  return { file, code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('allows_listed', () => {
  const r = check(['storage_read', 'sha256']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^PASS 2 imports/);
});

test('rejects_deploy_contract', () => {
  const r = check(['storage_read', 'promise_batch_action_deploy_contract']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /FAIL forbidden: env\.promise_batch_action_deploy_contract/);
});

test('rejects_add_key', () => {
  const r = check(['promise_batch_action_add_key_with_full_access']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /FAIL forbidden: env\.promise_batch_action_add_key_with_full_access/);
});

test('rejects_delete_account', () => {
  const r = check(['promise_batch_action_delete_account']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /FAIL forbidden: env\.promise_batch_action_delete_account/);
});

test('rejects_use_global_contract', () => {
  const r = check(['promise_batch_action_use_global_contract']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /FAIL forbidden: env\.promise_batch_action_use_global_contract/);
});

test('rejects_add_gas_key', () => {
  const r = check(['promise_batch_action_add_gas_key_with_function_call']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /FAIL forbidden: env\.promise_batch_action_add_gas_key_with_function_call/);
});

// Everything `pnpm verify` check #5 rejects (cli/src/lib/wasm.ts FORBIDDEN_IMPORT_RE) must be forbidden here too.
test('forbids_every_verify_import_family', () => {
  const names = [
    'promise_batch_action_add_key_with_full_access',
    'promise_batch_action_add_key_with_function_call',
    'promise_batch_action_add_gas_key_with_full_access',
    'promise_batch_action_add_gas_key_with_function_call',
    'promise_batch_action_deploy_contract',
    'promise_batch_action_use_global_contract',
    'promise_batch_action_use_global_contract_by_account_id',
    'promise_batch_action_deploy_global_contract',
    'promise_batch_action_deploy_global_contract_by_account_id',
    'promise_batch_action_delete_account',
  ];
  const r = check(names, '--json');
  assert.equal(r.code, 2);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.forbidden, [...names].sort());
  assert.deepEqual(out.unknown, []);
});

// X12F-01: on_key checks the MPC key with the sha3_256 and BLS12-381 host functions. Only these
// six were added; the rest of the BLS family (multiexp, G2 sums, map to G2) stays unknown.
test('allows_x12f01_key_check_host_functions', () => {
  const names = [
    'sha3_256',
    'bls12381_p1_sum',
    'bls12381_p1_decompress',
    'bls12381_p2_decompress',
    'bls12381_map_fp_to_g1',
    'bls12381_pairing_check',
  ];
  const r = check(names);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^PASS 6 imports/);
  for (const n of ['bls12381_g1_multiexp', 'bls12381_p2_sum', 'bls12381_map_fp2_to_g2', 'sha3_512']) {
    const u = check([n]);
    assert.equal(u.code, 1, n);
  }
});

test('rejects_unknown', () => {
  const r = check(['storage_read', 'ecrecover']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /FAIL unknown: env\.ecrecover/);
});

test('json_shape', () => {
  const r = check(['sha256', 'storage_read', 'ecrecover', 'promise_batch_action_delete_key'], '--json');
  assert.equal(r.code, 2);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out).sort(), ['bytes', 'file', 'forbidden', 'imports', 'result', 'sha256', 'unknown']);
  assert.equal(out.file, r.file);
  assert.equal(typeof out.bytes, 'number');
  assert.match(out.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(out.imports, ['ecrecover', 'promise_batch_action_delete_key', 'sha256', 'storage_read']);
  assert.equal(out.result, 'FAIL');
  assert.deepEqual(out.forbidden, ['promise_batch_action_delete_key']);
  assert.deepEqual(out.unknown, ['ecrecover']);
});

// CI-10: build-wasms.sh must show why check-imports failed (it used to send stderr to /dev/null).
test('build_wasms_prints_forbidden_import', () => {
  const sh = readFileSync(join(dirname(script), 'build-wasms.sh'), 'utf8');
  const line = sh.split('\n').find((l) => l.includes('check-imports.mjs'));
  const root = mkdtempSync(join(tmpdir(), 'build-wasms-'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'target/near'), { recursive: true });
  copyFileSync(script, join(root, 'scripts/check-imports.mjs'));
  writeFileSync(join(root, 'target/near/tender.wasm'), wasmWithImports(['promise_batch_action_deploy_contract']));
  const r = spawnSync('bash', ['-c', `set -euo pipefail; ${line}`], { cwd: root, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /promise_batch_action_deploy_contract/);
});
