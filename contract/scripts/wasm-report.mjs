#!/usr/bin/env node
// Wasm, gas and storage report for evidence/wasm.json. No dependencies.
// Inputs (run from contract/):
//   scripts/out/imports.json  node scripts/check-imports.mjs target/near/tender.wasm --json
//   scripts/out/gas.json      cargo test --test sandbox gas_report -- --ignored --nocapture
// Usage: node scripts/wasm-report.mjs > ../evidence/wasm.json
// Release wasm: node scripts/wasm-report.mjs --reproducible <commit> > ../evidence/wasm.json
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const contractDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(resolve(contractDir, p), 'utf8'));

const imports = read('scripts/out/imports.json');
const gas = read('scripts/out/gas.json');
const repro = process.argv.indexOf('--reproducible');
const commit = repro === -1 ? undefined : process.argv[repro + 1];
if (repro !== -1 && !/^[0-9a-f]{40}$/.test(commit ?? '')) {
  console.error('--reproducible needs the 40-hex build commit');
  process.exit(1);
}
const wasmPath = resolve(contractDir, imports.file);
const bytes = readFileSync(wasmPath);
const digest = createHash('sha256').update(bytes).digest();

// The three inputs must describe the same wasm.
if (digest.toString('hex') !== imports.sha256 || imports.sha256 !== gas.wasm_sha256) {
  console.error(
    `stale input: wasm ${digest.toString('hex')}, imports.json ${imports.sha256}, gas.json ${gas.wasm_sha256}`,
  );
  process.exit(1);
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(buf) {
  let n = BigInt(`0x${buf.toString('hex')}`);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

// C25: ceil(bytes / 100 000) + 1.5 NEAR.
const c25 = Math.ceil(bytes.length / 100_000) + 1.5;

console.log(
  JSON.stringify(
    {
      built_utc: statSync(wasmPath).mtime.toISOString(),
      build: commit ? 'reproducible-wasm' : 'non-reproducible-wasm',
      commit,
      bytes: bytes.length,
      sha256: imports.sha256,
      code_hash_b58: base58(digest),
      imports: imports.imports,
      check_imports: imports.result,
      c25_initial_balance_near: c25.toString(),
      gas_tgas: gas.gas_tgas,
      storage_bytes: gas.storage_bytes,
      measured_with: `sandbox nearcore 2.14.0, intents.near 0.4.5 wasm, mock MPC; ${gas.bids} bids in one sale`,
    },
    null,
    1,
  ),
);
