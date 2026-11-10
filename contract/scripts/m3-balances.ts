// Testnet rehearsal step 12: recompute the sale's clearing with @tender/clearing and compare it,
// value by value, with the contract's get_result / get_bids and with every Intents balance.
// Reads the public rehearsal state file (accounts, deposits). Run from the repo root:
//   node_modules/.bin/tsx contract/scripts/m3-balances.ts contract/scripts/out/m3-state.json
import { readFileSync } from 'node:fs';
import { clear, type ClearBid } from '../../packages/clearing/src/index.ts';

const statePath = process.argv[2];
if (!statePath) throw new Error('usage: m3-balances.ts <m3-state.json>');
const st = JSON.parse(readFileSync(statePath, 'utf8'));
const rpc: string = process.env.TESTNET_RPC ?? 'https://test.rpc.fastnear.com';
const { v1, intents, usdc, wnear, tender: seller, bidders } = st.accounts as Record<string, any>;
const sale: string = st.sale.id;

async function view(account: string, method: string, args: object): Promise<any> {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') },
    }),
  });
  const j: any = await res.json();
  if (j.error || j.result?.error) throw new Error(`${account}.${method}: ${JSON.stringify(j.error ?? j.result.error)}`);
  return JSON.parse(Buffer.from(j.result.result).toString('utf8'));
}
const mt = async (who: string, token: string): Promise<bigint> => BigInt(await view(intents, 'mt_balance_of', { account_id: who, token_id: `nep141:${token}` }));

let fails = 0;
function check(name: string, got: bigint | string | null, want: bigint | string | null) {
  const ok = String(got) === String(want);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (expected ${want})`}`);
}

const s = await view(v1, 'get_sale', { id: sale });
const bids: any[] = await view(v1, 'get_bids', { id: sale, from: 0, limit: 64 });
const result = await view(v1, 'get_result', { id: sale });
const input: ClearBid[] = bids.map((b) => ({
  idx: b.idx, B: BigInt(b.escrow), p: b.p === null ? null : BigInt(b.p), q: b.q === null ? null : BigInt(b.q), state: b.state,
}));
// The contract stores the final state (Penalized) after finalize; the clearing input treats it like Sealed.
const local = clear({ S: BigInt(s.supply), decimals: s.decimals, lot_exp: s.lot_exp, reserve: BigInt(s.reserve) }, input);

check('state', s.state, 'Finalized');
check(`payouts ${s.payouts_done}/${s.payouts_total}`, s.payouts_done, s.payouts_total);
check('p_star', result.p_star, local.P_star);
check('seller_usdc', result.seller_usdc, local.seller_usdc);
check('seller_tokens_back', result.seller_tokens_back, local.seller_tokens_back);
check('token_dust', result.token_dust, local.dust);
for (const b of bids) {
  check(`bid ${b.idx} alloc`, b.alloc, local.alloc[b.idx]);
  check(`bid ${b.idx} spend`, b.spend, local.spend[b.idx]);
  check(`bid ${b.idx} paid.usdc = refund`, b.paid.usdc, local.refund[b.idx]);
  check(`bid ${b.idx} paid.tokens = alloc`, b.paid.tokens, local.alloc[b.idx]);
  check(`bid ${b.idx} paid.ok`, b.paid.ok, true);
}
check('seller_payout.ok', s.seller_payout.ok, true);

// Intents balances: deposit − escrow + refund (USDC), alloc (wNEAR); seller: deposit − supply + back, seller_usdc.
for (const who of bidders as { id: string; usdc_deposit: string }[]) {
  const mine = bids.filter((b) => b.bidder === who.id);
  const escrow = mine.reduce((a, b) => a + BigInt(b.escrow), 0n);
  const refund = mine.reduce((a, b) => a + local.refund[b.idx], 0n);
  const alloc = mine.reduce((a, b) => a + local.alloc[b.idx], 0n);
  check(`${who.id} USDC`, await mt(who.id, usdc), BigInt(who.usdc_deposit) - escrow + refund);
  check(`${who.id} wNEAR`, await mt(who.id, wnear), alloc);
}
check(`${seller} USDC`, await mt(seller, usdc), local.seller_usdc);
check(`${seller} wNEAR`, await mt(seller, wnear), BigInt(st.seller_wnear_deposit) - BigInt(s.supply) + local.seller_tokens_back);
check(`${v1} USDC`, await mt(v1, usdc), 0n);
check(`${v1} wNEAR`, await mt(v1, wnear), 0n);

console.log(fails === 0 ? 'balances: all match' : `balances: ${fails} mismatches`);
process.exit(fails === 0 ? 0 : 1);
