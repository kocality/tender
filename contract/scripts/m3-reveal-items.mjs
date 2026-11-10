#!/usr/bin/env node
// Builds the `reveal` arguments for one sale from the local secret bid files that
// `pnpm seal:bid` writes (~/.tender/bids/*.json, chmod 600). No dependencies.
//
// Each file gives {cm, p, q, salt}; the contract's get_bids view maps cm -> idx.
// Prints {"sale":"N","items":[{"idx":n,"p":"…","q":"…","salt":"<32 hex>"}]} on stdout.
// Exit 1 if a file matches no bid of the sale, or if a file's sale/contract differ.
//
// Usage: node contract/scripts/m3-reveal-items.mjs --network testnet|mainnet --contract <id> --sale N \
//          --bids-glob "$HOME/.tender/bids/testnet-<contract>-sale0-*.json" [--rpc <url>]
import { globSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const RPC = { testnet: 'https://test.rpc.fastnear.com', mainnet: 'https://free.rpc.fastnear.com' };

const { values: v } = parseArgs({
  options: {
    network: { type: 'string' },
    contract: { type: 'string' },
    sale: { type: 'string' },
    'bids-glob': { type: 'string' },
    rpc: { type: 'string' },
  },
});
const die = (msg) => {
  console.error(msg);
  process.exit(1);
};
if (!v.network || !RPC[v.network] || !v.contract || !/^\d+$/.test(v.sale ?? '') || !v['bids-glob']) {
  die('usage: m3-reveal-items.mjs --network testnet|mainnet --contract <id> --sale N --bids-glob <glob> [--rpc <url>]');
}

async function view(method, args) {
  const res = await fetch(v.rpc ?? RPC[v.network], {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: v.contract,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      },
    }),
  });
  const j = await res.json();
  if (j.error || j.result?.error) die(`${method}: ${JSON.stringify(j.error ?? j.result.error)}`);
  return JSON.parse(Buffer.from(j.result.result).toString('utf8'));
}

const files = globSync(v['bids-glob']).sort();
if (files.length === 0) die(`no bid files match ${v['bids-glob']}`);

const byCm = new Map();
for (let from = 0; ; from += 64) {
  const page = await view('get_bids', { id: v.sale, from, limit: 64 });
  for (const b of page) byCm.set(b.cm, b);
  if (page.length < 64) break;
}

const items = [];
for (const f of files) {
  const s = JSON.parse(readFileSync(f, 'utf8'));
  if (s.sale !== v.sale || s.contract !== v.contract) die(`${f}: sale ${s.sale} on ${s.contract}, expected sale ${v.sale} on ${v.contract}`);
  const bid = byCm.get(s.cm);
  if (!bid) die(`${f}: commitment ${s.cm} matches no bid of sale ${v.sale}`);
  if (bid.bidder !== s.signer) die(`${f}: bid ${bid.idx} belongs to ${bid.bidder}, file says ${s.signer}`);
  items.push({ idx: bid.idx, p: s.p, q: s.q, salt: s.salt });
}
items.sort((a, b) => a.idx - b.idx);
console.log(JSON.stringify({ sale: v.sale, items }));
