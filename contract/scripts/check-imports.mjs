#!/usr/bin/env node
// Wasm host-import check. Run before every deploy.
// Adapted from defdone/annon contracts/annon/check-imports.mjs @43b230ce (Apache-2.0). Modified by Tender contributors.
//
// A new near-sdk can link host functions mainnet doesn't have yet (deploy fails with
// "Link Error"), and some host functions would let the locked contract change its own code or
// keys. So: every import must be on the allow-list, and a forbidden prefix fails even if someone
// adds it to the allow-list.
//
// Usage: node contract/scripts/check-imports.mjs <file.wasm> [--json]
// Exit codes: 0 PASS, 1 unknown import (or non-env module), 2 forbidden import.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Classic host functions, all present at protocol 88 (nearcore 2.14.0).
const ALLOWED = new Set([
  'attached_deposit',
  'block_index',
  'block_timestamp',
  'current_account_id',
  'predecessor_account_id',
  'signer_account_id',
  'input',
  'log_utf8',
  'panic_utf8',
  'prepaid_gas',
  'used_gas',
  'account_balance',
  'storage_usage',
  'storage_read',
  'storage_write',
  'storage_remove',
  'storage_has_key',
  'read_register',
  'register_len',
  'value_return',
  'sha256',
  'random_seed',
  'promise_batch_create',
  'promise_batch_then',
  'promise_batch_action_function_call_weight',
  'promise_return',
  'promise_result',
  'promise_results_count',
]);

// Never allowed: these can change the account's code, keys or existence (lock claim, K7).
const FORBIDDEN_PREFIXES = [
  'promise_batch_action_add_key',
  'promise_batch_action_add_gas_key',
  'promise_batch_action_deploy_contract',
  'promise_batch_action_delete_account',
  'promise_batch_action_deploy_global_contract',
  'promise_batch_action_use_global_contract',
  'promise_batch_action_stake',
  'promise_batch_action_delete_key',
];

const args = process.argv.slice(2);
const json = args.includes('--json');
const file = args.find((a) => a !== '--json');
if (!file) {
  console.error('usage: node contract/scripts/check-imports.mjs <file.wasm> [--json]');
  process.exit(1);
}

const bytes = readFileSync(file);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes));

const label = (i) => (i.module === 'env' ? i.name : `${i.module}.${i.name}`);
const isForbidden = (i) => FORBIDDEN_PREFIXES.some((p) => i.name.startsWith(p));

const forbidden = imports.filter(isForbidden).map(label).sort();
const unknown = imports
  .filter((i) => !isForbidden(i) && (i.module !== 'env' || !ALLOWED.has(i.name)))
  .map(label)
  .sort();
const names = imports.map(label).sort();
const pass = forbidden.length === 0 && unknown.length === 0;

if (json) {
  console.log(
    JSON.stringify({
      file,
      bytes: bytes.length,
      sha256,
      imports: names,
      result: pass ? 'PASS' : 'FAIL',
      forbidden,
      unknown,
    }),
  );
} else {
  const full = (n) => (n.includes('.') ? n : `env.${n}`);
  for (const n of forbidden) console.error(`FAIL forbidden: ${full(n)}`);
  for (const n of unknown) console.error(`FAIL unknown: ${full(n)}`);
  if (pass) {
    console.log(`PASS ${names.length} imports`);
    for (const n of names) console.log(`  ${n}`);
  }
}

process.exit(forbidden.length ? 2 : unknown.length ? 1 : 0);
