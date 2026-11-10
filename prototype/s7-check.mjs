// Gate S7: does NearBlocks v3 (independent indexer) show the CKD request receipt?
//   node s7-check.mjs --account <caller> --tx <hash> [--network mainnet|testnet] [--max-wait-s 600] [--interval-s 120] [--out <file>]
// At most max-wait/interval + 1 requests (keyless rate limit). Exit code: 0 found, 1 not found / error.
import fs from 'node:fs';

const API = { mainnet: 'https://api.nearblocks.io', testnet: 'https://api-testnet.nearblocks.io' };
const o = {};
for (let a = process.argv.slice(2), i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, '')] = a[i + 1];
const network = o.network ?? 'mainnet', maxWait = Number(o['max-wait-s'] ?? 600), interval = Number(o['interval-s'] ?? 120);
if (!o.account || !o.tx || !API[network]) { console.error('usage: node s7-check.mjs --account <caller> --tx <hash> [--network mainnet|testnet]'); process.exit(1); }
const url = `${API[network]}/v3/accounts/${o.account}/receipts?method=request_app_private_key&limit=100`;
const headers = process.env.NEARBLOCKS_API_KEY ? { Authorization: `Bearer ${process.env.NEARBLOCKS_API_KEY}` } : {};

const tries = Math.floor(maxWait / interval) + 1;
let out = { gate: 'S7', network, account: o.account, tx_hash: o.tx, query: url, found: false };
for (let i = 0; i < tries; i++) {
  if (i) await new Promise(r => setTimeout(r, interval * 1000));
  const queriedAt = Date.now();
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    const j = await r.json();
    if (!r.ok || j.errors) { out.warn = `HTTP ${r.status} ${JSON.stringify(j.errors ?? j).slice(0, 200)}`; console.log(`WARN ${out.warn}`); continue; }
    const hit = (j.data ?? []).find(d => d.transaction_hash === o.tx);
    console.log(`query ${i + 1}/${tries}: ${(j.data ?? []).length} receipts, ${hit ? 'match' : 'no match'}`);
    if (hit) {
      const delay = Math.round((queriedAt - Number(BigInt(hit.block.block_timestamp) / 1_000_000n)) / 1000);
      out = { ...out, found: true, receipt_id: hit.receipt_id, predecessor_account_id: hit.predecessor_account_id,
        receiver_account_id: hit.receiver_account_id, block_height: hit.block.block_height,
        block_timestamp: hit.block.block_timestamp, queried_at: new Date(queriedAt).toISOString(), delay_s: delay, queries: i + 1 };
      delete out.warn;
      console.log(`found receipt ${hit.receipt_id} in NearBlocks v3 (delay ${delay}s)`);
      break;
    }
  } catch (e) { out.warn = e.message; console.log(`WARN ${e.message}`); }
}
if (!out.found) { out.queries = tries; console.log(`not found in NearBlocks v3 after ${tries} queries`); }
if (o.out) { fs.writeFileSync(o.out, JSON.stringify(out, null, 1) + '\n'); console.log(`wrote ${o.out}`); }
process.exit(out.found ? 0 : 1);
