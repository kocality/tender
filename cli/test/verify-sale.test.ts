import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { bytesToB64 } from '@tender/seal';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { DEMO_BIDDERS, SIM_USDC, buildWorld, demoSaleInputs, fakeRpc } from '../src/lib/sim.js';
import { runSaleChecks } from '../src/lib/verify-sale.js';
import { TESTED_INTENTS_CODE_HASH, resolveNetwork } from '../src/lib/config.js';
import { repoRoot } from '../src/lib/paths.js';
import { Rpc } from '../src/lib/rpc.js';
import { deploy, fakeHttp, moduleImporting, runVerify, writeEvidence } from './verify-helpers.js';

const SOL2 = DEMO_BIDDERS[4]!.bidder;

/** demo-sale-1 plus a seventh bid that is never revealed (Penalized at finalize). */
function worldWithSeventh() {
  const d = demoSaleInputs();
  return buildWorld({ state: 'Finalized', seed: '01', bids: [...d.bids, { bidder: SOL2, origin: 'sol', B: 2_000_000n, p: 3_000_000n, q: 1_000_000n, revealed: false }] });
}

describe('verify --sale', () => {
  for (const mode of ['identity', 'generator', 'plain'] as const) {
    it(`happy path (Finalized, no evidence file, ${mode})`, async () => {
      const w = buildWorld({ state: 'Finalized', mode, seed: '01' });
      const r = await runVerify(w);
      expect(r.code).toBe(0);
      expect(r.out[0]).toMatch(/^Tender verify · sale 1 · v1\.tenderseal\.near · mainnet · block 224000000 \(2026-11-10T12:00:00Z\)$/);
      expect(r.out[1]).toBe('rpc https://fake.rpc · archival https://archival-rpc.mainnet.fastnear.com');
      const checks = r.out.slice(2, -1);
      expect(checks).toHaveLength(27);
      expect(checks.filter((l) => l.startsWith('FAIL'))).toEqual([]);
      expect(checks.filter((l) => l.startsWith('n/a')).map((l) => l.split(' ')[1])).toEqual(['#23', '#24', '#25']);
      expect(checks.filter((l) => l.startsWith('WARN')).map((l) => l.split(' ')[1])).toEqual(['#6', '#22']);
      expect(r.out.at(-1)).toBe('22/24 checks passed (2 warnings)');
      expect(r.line(26)).toBe('PASS #26 upstream-code — intents.near code_hash BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk = the tested intents 0.4.5 wasm · v1.signer 3.18.0 = tested version');
      expect(r.line(27)).toBe('PASS #27 token-decimals — ft_metadata: wrap.near 24 decimals = sale decimals 24 · quote token 6 decimals');
      expect(r.line(2)).toBe(
        'PASS #2 mpc-network — v1.signer 3.18.0 · threshold 11 of 16 (live) · key epoch 16, participant ids issued 22 (next_id): resharing does not revoke old shares, so the threshold counts former share holders too · TEE accounts 17 · allowed images 1',
      );
      expect(r.line(15)).toBe('PASS #15 clearing-price — P* = 3.60 USDC/NEAR (recomputed = get_result)');
      expect(r.line(12)).toContain('6/6 decrypt');
      expect(r.line(13)).toContain('6/6 match');
      expect(r.line(3)).toMatch(/^PASS #3 code-hash — \S+ = sha256\(.*tender\.wasm\) https:\/\/nearblocks\.io\/address\/v1\.tenderseal\.near$/);
      if (mode === 'plain') expect(r.line(11)).toContain('off-chain pairing; no on-chain PV in plain mode');
    });
  }

  it('tampered P_star → #15 FAIL, exit 1', async () => {
    const w = buildWorld({ state: 'Finalized' });
    w.result!.p_star = '3600001';
    const r = await runVerify(w);
    expect(r.status(15)).toBe('FAIL');
    expect(r.code).toBe(1);
  });

  it('access key present → #4 FAIL', async () => {
    const w = buildWorld({ state: 'Finalized' });
    w.accessKeys = ['ed25519:11111111111111111111111111111111'];
    const r = await runVerify(w);
    expect(r.status(4)).toBe('FAIL');
  });

  it('forbidden import (add_gas_key) → #5 FAIL', async () => {
    const w = buildWorld({ state: 'Finalized' });
    const file = deploy(w, moduleImporting(['promise_batch_create', 'promise_batch_action_add_gas_key_with_full_access']));
    const r = await runVerify(w, { wasmFile: file });
    expect(r.status(3)).toBe('PASS');
    expect(r.line(5)).toContain('FAIL #5 wasm-imports — forbidden host functions imported: promise_batch_action_add_gas_key_with_full_access');
  });

  it('local wasm differs from the deployed code → #3 FAIL; missing wasm → #3/#5 WARN', async () => {
    const w = buildWorld({ state: 'Finalized' });
    const file = deploy(w);
    w.codeHash = '22222222222222222222222222222222';
    expect((await runVerify(w, { wasmFile: file })).status(3)).toBe('FAIL');
    const r = await runVerify(w, { wasmFile: '/nonexistent/tender.wasm' });
    expect([r.status(3), r.status(5)]).toEqual(['WARN', 'WARN']);
  });

  it('decryptable+matching bid marked Penalized → #14 FAIL', async () => {
    const w = buildWorld({ state: 'Finalized' });
    w.bids[5]!.state = 'Penalized';
    const r = await runVerify(w);
    expect(r.line(14)).toContain('FAIL #14 reveal-states — #5 decrypts and matches its commitment but is Penalized');
  });

  it('copy attack bid Penalized → #13 lists it, #14 PASS', async () => {
    const w = worldWithSeventh();
    w.bids[6]!.ct = w.bids[0]!.ct;
    w.bids[6]!.cm = w.bids[0]!.cm;
    expect(w.bids[6]!.state).toBe('Penalized');
    const r = await runVerify(w);
    expect(r.line(13)).toBe('PASS #13 plaintext-matches-commitment — 6/7 match · commitment mismatch (e.g. a copied ct + cm): #6');
    expect(r.status(14)).toBe('PASS');
    expect(r.status(16)).toBe('PASS');
    expect(r.out.filter((l) => l.startsWith('FAIL'))).toEqual([]);
  });

  it('random 160 B ct Penalized → #12 reports invalid U, no throw', async () => {
    const w = worldWithSeventh();
    w.bids[6]!.ct = bytesToB64(randomBytes(160));
    const r = await runVerify(w);
    expect(r.line(12)).toMatch(/^PASS #12 ciphertexts-decrypt — 6\/7 decrypt · cannot decrypt: #6 (invalid U point|FO check failed)$/);
    expect(r.status(14)).toBe('PASS');
    expect(r.code).toBe(0);
  });

  it('self-revealed garbage ct → #12/#14 WARN (last look); revealed by a third party → WARN too, exit 0 (CRYPTO-02, S-07)', async () => {
    const d = demoSaleInputs();
    const w = buildWorld({ state: 'Finalized', bids: [...d.bids, { bidder: SOL2, origin: 'sol', B: 2_000_000n, p: 3_000_000n, q: 1_000_000n }] });
    w.bids[6]!.ct = bytesToB64(new Uint8Array(160).fill(0x41));
    let r = await runVerify(w);
    expect(r.line(12)).toMatch(/^WARN #12 ciphertexts-decrypt — 6\/7 decrypt; Revealed but not decryptable: #6 /);
    expect(r.line(14)).toContain('WARN #14 reveal-states — #6 Revealed by its own bidder, but its ciphertext does not open to the revealed bid (could reveal after the key)');
    expect(r.code).toBe(0);
    w.bids[6]!.revealed_by = 'keeper.near';
    r = await runVerify(w);
    expect(r.line(14)).toContain('#6 Revealed by keeper.near, but its ciphertext does not open');
    expect([r.status(12), r.status(14), r.code]).toEqual(['WARN', 'WARN', 0]);
  });

  for (const q of [2_000_001n, 0n]) {
    it(`bid sealed with q = ${q} (outside 1..B) left Penalized → #14 PASS, listed as not revealable (S-02, CRYPTO-03)`, async () => {
      const d = demoSaleInputs();
      const w = buildWorld({ state: 'Finalized', bids: [...d.bids, { bidder: SOL2, origin: 'sol', B: 2_000_000n, p: 3_700_000n, q, revealed: false }] });
      expect(w.bids[6]!.state).toBe('Penalized');
      const r = await runVerify(w);
      expect(r.line(13)).toContain('7/7 match');
      expect(r.line(14)).toMatch(/^PASS #14 reveal-states — 6 Revealed, 1 Penalized, 0 Sealed; .* · q outside 1\.\.B, not revealable: #6$/);
      expect(r.code).toBe(0);
    });
  }

  it('Penalized bid: the pool is kept by the contract → #17/#19 PASS; a shared pool or a missing pool balance → FAIL', async () => {
    const w = worldWithSeventh();
    w.bids[6]!.ct = bytesToB64(new Uint8Array(160).fill(0x41)); // an option bid nobody can reveal
    expect(w.result!.penalty_pool).toBe('200000');
    let r = await runVerify(w);
    expect(r.line(17)).toContain('+ penalty pool 0.20; tokens in = out; the pool is kept by the contract (paid to nobody), 0 to the seller');
    expect(r.line(19)).toContain('owed includes 0.20 USDC of penalty pools kept by the contract');
    expect([r.status(16), r.status(17), r.status(19), r.code]).toEqual(['PASS', 'PASS', 'PASS', 0]);
    w.balances[SIM_USDC] = 199_999n;
    r = await runVerify(w);
    expect(r.line(19)).toMatch(/^FAIL #19 escrow-balance — deficit: nep141:\S+ holds 199999 < owed 200000/);
    w.balances[SIM_USDC] = 200_000n;
    // the old rule: the pool recycled to the revealed bids
    w.bids[0]!.penalty_share = '200000';
    w.bids[0]!.paid.usdc = String(BigInt(w.bids[0]!.paid.usdc) + 200_000n);
    r = await runVerify(w);
    expect(r.line(17)).toContain('Σ penalty share 200000 ≠ 0 (the pool must go to nobody)');
    expect(r.status(16)).toBe('FAIL');
  });

  it('a revealed bid from a sub-account of the seller → #17 PASS names it (SC-03); a bid from the seller itself → #17 FAIL (SC-01)', async () => {
    const d = demoSaleInputs();
    expect(d.bids[3]!.bidder).toBe('bidder.tenderseal.near'); // the team-funded NEAR bidder
    let r = await runVerify(buildWorld({ state: 'Finalized' }));
    expect(r.line(17)).toMatch(/^PASS #17 conservation — .*, 0 to the seller · bids from sub-accounts of the seller tenderseal\.near \(only it can create them\): #3 bidder\.tenderseal\.near$/);
    d.bids[3]!.bidder = 'tenderseal.near';
    r = await runVerify(buildWorld({ state: 'Finalized', bids: d.bids }));
    expect(r.line(17)).toBe('FAIL #17 conservation — bid #3 comes from the seller account tenderseal.near (the contract refunds those as seller_bid)');
    expect(r.code).toBe(1);
  });

  it('intents.near or v1.signer upgraded since the tests ran → #26 WARN, exit 0 (X12-10)', async () => {
    const w = buildWorld({ state: 'Finalized' });
    w.intentsCodeHash = '22222222222222222222222222222222';
    w.mpcVersion = '3.19.0';
    const r = await runVerify(w);
    expect(r.line(26)).toBe(
      'WARN #26 upstream-code — intents.near code_hash 22222222222222222222222222222222 ≠ tested BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk (upgraded since the tests ran); v1.signer 3.19.0 ≠ tested 3.18.0',
    );
    expect(r.code).toBe(0);
  });

  it('the pinned intents code hash is the vendored wasm the sandbox tests run (X12-10)', () => {
    const hex = readFileSync(join(repoRoot(), 'contract/tests/res/defuse-0.4.5.wasm.sha256'), 'utf8').split(/\s+/)[0]!;
    expect(bs58.encode(hexToBytes(hex))).toBe(TESTED_INTENTS_CODE_HASH);
  });

  it('declared decimals ≠ ft_metadata → #27 FAIL; quote token not 6 → FAIL; no ft_metadata → WARN (X12-03)', async () => {
    const w = buildWorld({ state: 'Finalized' });
    w.tokenDecimals['wrap.near'] = 18;
    let r = await runVerify(w);
    expect(r.line(27)).toBe('FAIL #27 token-decimals — wrap.near ft_metadata 18 decimals ≠ sale decimals 24 (prices and amounts are scaled wrong)');
    expect(r.code).toBe(1);
    w.tokenDecimals['wrap.near'] = 24;
    w.tokenDecimals[SIM_USDC.slice('nep141:'.length)] = 18;
    r = await runVerify(w);
    expect(r.line(27)).toMatch(/^FAIL #27 token-decimals — quote token \S+ ft_metadata 18 decimals ≠ 6$/);
    delete w.tokenDecimals['wrap.near'];
    w.tokenDecimals[SIM_USDC.slice('nep141:'.length)] = 6;
    r = await runVerify(w);
    expect(r.line(27)).toMatch(/^WARN #27 token-decimals — wrap\.near ft_metadata unavailable \(.+\); sale decimals 24 unchecked · quote token 6 decimals$/);
    expect(r.code).toBe(0);
  });

  it('payout in flight (pending) → #19 PASS without counting it, #20 WARN (S-07)', async () => {
    const w = buildWorld({ state: 'Finalized' });
    w.bids[2]!.paid.ok = false;
    w.bids[2]!.paid.pending = true;
    w.sale.payouts_done -= 1;
    const r = await runVerify(w);
    expect(r.line(19)).toContain('1 payout(s) in flight, not counted');
    expect(r.status(19)).toBe('PASS');
    expect(r.line(20)).toBe('WARN #20 payouts — 6/7 payouts ok; in flight (sent, callback not run yet): #2; run again in a minute');
  });

  it('request in flight for over 1 h → #21 FAIL (dead request); a fresh one → PASS (DUP-C02)', async () => {
    const w = buildWorld({ state: 'Open', nowNs: 1_794_312_000n * 1_000_000_000n });
    w.sale.close_ns = String(w.block.timestamp_ns - 7_200_000_000_000n);
    w.sale.in_flight = true;
    w.sale.state = 'Opening';
    w.sale.key_requests = 1;
    w.config.key_log_len = '1';
    w.keyLog = [{ i: '0', sale: w.sale.id, block: '223900000', ns: String(w.block.timestamp_ns - 3_599_000_000_000n), outcome: 'Pending', resolved_block: null }];
    let r = await runVerify(w);
    expect(r.status(21)).toBe('PASS');
    w.keyLog[0]!.ns = String(w.block.timestamp_ns - 3_600_000_000_000n);
    r = await runVerify(w);
    expect(r.line(21)).toContain('request #0 in flight since');
    expect(r.line(21)).toContain('is dead (its on_key failed): call open again, or cancel after close + 24 h');
    expect(r.status(21)).toBe('FAIL');
  });

  it('time rules (#10): a bid stored at close, a wrong reveal deadline or an early cancel → FAIL (X12-06)', async () => {
    let w = buildWorld({ state: 'Finalized' });
    let r = await runVerify(w);
    expect(r.line(10)).toContain('bids before close, key requested after close, reveal deadline = key + max(reveal_secs, 24 h)');
    expect(r.status(10)).toBe('PASS');
    w.bids[2]!.ns = w.sale.close_ns;
    r = await runVerify(w);
    expect(r.line(10)).toMatch(/^FAIL #10 key-after-close — bid #2 stored at or after close/);
    w = buildWorld({ state: 'Finalized' });
    w.sale.reveal_deadline_ns = String(BigInt(w.sale.reveal_deadline_ns!) - 1n);
    expect((await runVerify(w)).line(10)).toContain('reveal_deadline_ns');
    w = buildWorld({ state: 'Finalized' });
    w.keyLog[0]!.ns = String(BigInt(w.sale.close_ns) - 1n);
    expect((await runVerify(w)).line(10)).toContain('key request #0 at');
    w = buildWorld({ state: 'Cancelled' });
    r = await runVerify(w);
    expect(r.line(10)).toMatch(/^PASS #10 key-after-close — no key; bids before close; cancelled at .* ≥ close$/);
    w.sale.key_requests = 1; // rule (b) only: close + 24 h, but the sim cancels 2 min after close
    r = await runVerify(w);
    expect(r.line(10)).toMatch(/^FAIL #10 key-after-close — no key; cancelled at .* before close \+ 24 h$/);
  });

  it('key_log has 2 entries (Err, Ok) and key_requests=2 → #21 PASS; a missing entry → FAIL', async () => {
    const w = buildWorld({ state: 'Finalized' });
    const ok = w.keyLog[0]!;
    w.keyLog = [
      { i: '0', sale: w.sale.id, block: '223899990', ns: String(BigInt(ok.ns) - 60_000_000_000n), outcome: 'Err', resolved_block: '223899995' },
      { ...ok, i: '1' },
    ];
    w.sale.key_requests = 2;
    w.config.key_log_len = '2';
    let r = await runVerify(w);
    expect(r.line(21)).toContain('PASS #21 key-ledger — 2 requests for this sale (Err, Ok) = key_requests');
    // X12F-01: an Err entry is an MPC error or an answer that failed on_key's pairing check against the pinned key
    expect(r.line(21)).toContain(" · Err = the MPC answered with an error or with a key that on_key refused (unparseable, or failing the pairing check against the pinned key); nothing was stored");
    w.sale.key_requests = 3;
    r = await runVerify(w);
    expect(r.status(21)).toBe('FAIL');
  });

  it('Cancelled key_requests=0 → #23 never-requested label; =1 → #23 WARN; never "sealed forever"', async () => {
    const w = buildWorld({ state: 'Cancelled' });
    let r = await runVerify(w);
    expect(r.line(23)).toBe('PASS #23 cancelled-sealed — Cancelled · 0 key requests · never requested (sealed unless the MPC threshold colludes)');
    expect(r.status(17)).toBe('PASS');
    expect(r.status(20)).toBe('PASS');
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).not.toMatch(/sealed forever/i);
    w.sale.key_requests = 1;
    r = await runVerify(w);
    expect(r.line(23)).toBe('WARN #23 cancelled-sealed — cancelled after 1 requests: may be decryptable');
    expect(r.out.join('\n')).not.toMatch(/sealed forever/i);
  });

  it('balance surplus → #19 PASS with surplus note; deficit → #19 FAIL', async () => {
    const w = buildWorld({ state: 'Finalized' });
    w.balances[SIM_USDC] = 5n;
    let r = await runVerify(w);
    expect(r.line(19)).toContain('surplus 5: unsolicited transfers');
    expect(r.status(19)).toBe('PASS');
    const open = buildWorld({ state: 'Open' });
    r = await runVerify(open);
    expect(r.status(19)).toBe('PASS');
    open.balances[SIM_USDC] = BigInt(open.sale.escrow_total) - 1n;
    r = await runVerify(open);
    expect(r.line(19)).toMatch(/^FAIL #19 escrow-balance — deficit: nep141:17208628\S+ holds 20999999 < owed 21000000 /);
  });

  it('payout ok=false → #20 FAIL (and #19 needs the unpaid amount)', async () => {
    const w = buildWorld({ state: 'Finalized' });
    w.bids[2]!.paid.ok = false;
    w.sale.payouts_done -= 1;
    const r = await runVerify(w);
    expect(r.line(20)).toBe('FAIL #20 payouts — payouts pending 6/7: call finalize again (unpaid: #2)');
    expect(r.status(19)).toBe('FAIL');
  });

  it('NearBlocks 429 → #22 WARN, exit 0; matching count → #22 PASS', async () => {
    const w = buildWorld({ state: 'Finalized' });
    let r = await runVerify(w);
    expect(r.line(22)).toContain('WARN #22 nearblocks-receipts — NearBlocks HTTP 429: rate limited');
    expect(r.code).toBe(0);
    r = await runVerify(w, { http: fakeHttp(w, { receipts: 1 }) });
    expect(r.status(22)).toBe('PASS');
  });

  it('Keyed inside the reveal window with an unrevealed bid → #14 WARN; outside → FAIL', async () => {
    const d = demoSaleInputs();
    const w = buildWorld({ state: 'Keyed', bids: d.bids.map((b, i) => (i === 4 ? { ...b, revealed: false } : b)) });
    w.sale.reveal_deadline_ns = String(w.block.timestamp_ns + 3_600_000_000_000n);
    let r = await runVerify(w);
    expect(r.line(14)).toMatch(/^WARN #14 reveal-states — reveal window open until .*: 1 decryptable bid\(s\) still Sealed/);
    expect([r.status(15), r.status(17), r.status(20)]).toEqual(['n/a', 'n/a', 'n/a']);
    w.sale.reveal_deadline_ns = String(w.block.timestamp_ns - 1n);
    r = await runVerify(w);
    expect(r.status(14)).toBe('FAIL');
  });

  it('evidence rows: 1Click SUCCESS and archival tx found → #24/#25 PASS; unknown tx → WARN', async () => {
    const w = buildWorld({ state: 'Finalized' });
    const rows = [{ sale: '1', step: 'bid', tx_hash: 'H1', signer_id: 'relayer.near', deposit_address: '0xabc', network: 'mainnet' }];
    const ev = writeEvidence(rows);
    const base = fakeRpc(w);
    const rpcFetch = (async (input: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: { tx_hash: string } };
      if (body.method === 'EXPERIMENTAL_tx_status') {
        const ans = body.params.tx_hash === 'H1' ? { result: { status: { SuccessValue: '' } } } : { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' }, data: 'unknown' } };
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'tender', ...ans }), { status: 200 });
      }
      return base(input as string, init as RequestInit);
    }) as typeof fetch;
    let r = await runVerify(w, { evidenceFile: ev, rpcFetch, http: fakeHttp(w, { oneclick: { '0xabc': 'SUCCESS' } }) });
    expect(r.status(24)).toBe('PASS');
    expect(r.status(25)).toBe('PASS');
    r = await runVerify(w, { evidenceFile: writeEvidence([{ ...rows[0], tx_hash: 'H2' }]), rpcFetch });
    expect(r.status(24)).toBe('WARN');
    expect(r.status(25)).toBe('WARN');
    expect(r.code).toBe(0);
  });

  it('a bid tx that succeeded at top level but was refunded by Tender → #25 WARN (S-05)', async () => {
    const w = buildWorld({ state: 'Finalized' });
    const ev = (event: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard: 'tender', version: '1.0.0', event, data: [data] })}`;
    const logs: Record<string, string[]> = {
      H1: [ev('bid', { sale: '1', idx: 0 })],
      H2: [ev('refund', { reason: 'closed', op: 'bid' })],
      H3: [ev('payout', { sale: '1', idx: 0, ok: false })],
    };
    const base = fakeRpc(w);
    const rpcFetch = (async (input: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: { tx_hash: string } };
      if (body.method === 'EXPERIMENTAL_tx_status') {
        const result = { status: { SuccessValue: '' }, receipts_outcome: [{ outcome: { logs: ['other log'] } }, { outcome: { logs: logs[body.params.tx_hash] } }] };
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'tender', result }), { status: 200 });
      }
      return base(input as string, init as RequestInit);
    }) as typeof fetch;
    const row = { sale: '1', step: 'bid', tx_hash: 'H1', signer_id: 'relayer.near', network: 'mainnet' };
    expect((await runVerify(w, { evidenceFile: writeEvidence([row]), rpcFetch })).status(25)).toBe('PASS');
    let r = await runVerify(w, { evidenceFile: writeEvidence([{ ...row, tx_hash: 'H2' }]), rpcFetch });
    expect(r.line(25)).toContain('bid H2: failure (refund closed), expected success');
    r = await runVerify(w, { evidenceFile: writeEvidence([{ ...row, step: 'finalize', tx_hash: 'H3' }]), rpcFetch });
    expect(r.status(25)).toBe('WARN');
    expect((await runVerify(w, { evidenceFile: writeEvidence([{ ...row, tx_hash: 'H2', expected: 'failure' }]), rpcFetch })).status(25)).toBe('PASS');
  });

  it('#25 names the dup_bid / bid_seq refunds, and a row with `reason` must be refunded for exactly that reason (DOUBLE-PLAN D1/D4)', async () => {
    const w = buildWorld({ state: 'Finalized' });
    const ev = (event: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard: 'tender', version: '1.0.0', event, data: [data] })}`;
    const cm = 'ab'.repeat(32);
    const logs: Record<string, string[]> = {
      D1: [ev('refund', { reason: 'dup_bid', sender_id: 'a.near', token_id: 't', amount: '5', op: 'bid', cm, have: 1, idx: 0 })],
      D2: [ev('refund', { reason: 'bid_seq', sender_id: 'a.near', token_id: 't', amount: '5', op: 'bid', cm, have: 2, idx: null })],
      D3: [ev('refund', { reason: 'closed', sender_id: 'a.near', token_id: 't', amount: '5', op: 'bid' })],
      D4: [ev('bid', { sale: '1', idx: 2, bidder: 'a.near', escrow: '5', origin: null, cm, nth: 1 })],
    };
    const base = fakeRpc(w);
    const rpcFetch = (async (input: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: { tx_hash: string } };
      if (body.method === 'EXPERIMENTAL_tx_status') {
        const result = { status: { SuccessValue: '' }, receipts_outcome: [{ outcome: { logs: logs[body.params.tx_hash] } }] };
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'tender', result }), { status: 200 });
      }
      return base(input as string, init as RequestInit);
    }) as typeof fetch;
    const row = { sale: '1', step: 'bid-again', tx_hash: 'D1', signer_id: 'relayer.near', network: 'mainnet' };
    let r = await runVerify(w, { evidenceFile: writeEvidence([row, { ...row, tx_hash: 'D2' }]), rpcFetch });
    expect(r.line(25)).toContain('bid-again D1: failure (refund dup_bid: the same sealed bid is already stored as #0), expected success');
    expect(r.line(25)).toContain("bid-again D2: failure (refund bid_seq: the signer had 2 stored bids, not the seq it was sealed for), expected success");
    const want = { ...row, expected: 'failure', reason: 'dup_bid' };
    r = await runVerify(w, { evidenceFile: writeEvidence([want]), rpcFetch });
    expect(r.line(25)).toBe('PASS #25 archival-tx — 1/1 recorded transactions found with the recorded outcome');
    r = await runVerify(w, { evidenceFile: writeEvidence([{ ...want, tx_hash: 'D3' }]), rpcFetch });
    expect(r.line(25)).toContain('bid-again D3: failure (refund closed), expected failure (refund dup_bid)');
    r = await runVerify(w, { evidenceFile: writeEvidence([{ ...want, tx_hash: 'D4' }]), rpcFetch });
    expect(r.line(25)).toContain('bid-again D4: success, expected failure (refund dup_bid)');
  });

  it('#9 FAILs when one bidder has the same sealed bid stored twice (the contract refunds that as dup_bid)', async () => {
    const w = buildWorld({ state: 'Open' });
    const [b0, b1] = w.bids;
    b1!.bidder = b0!.bidder;
    b1!.cm = b0!.cm;
    w.sale.bidders -= 1;
    const r = await runVerify(w);
    expect(r.line(9)).toBe(`FAIL #9 bid-count — same sealed bid stored twice for ${b0!.bidder}: #0 = #1 (the contract refunds a copy as dup_bid)`);
    b1!.cm = 'cd'.repeat(32); // two different bids from one bidder are allowed
    expect((await runVerify(w)).status(9)).toBe('PASS');
  });

  it('all RPC providers down → exit 2', async () => {
    const w = buildWorld({ state: 'Finalized' });
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const r = await runVerify(w, { rpcFetch: down });
    expect(r.code).toBe(2);
    expect(r.err[0]).toMatch(/^ERROR: could not read state from any RPC provider; try --rpc <url>/);
  });

  it('unknown sale → exit 1; usage errors → exit 2', async () => {
    const w = buildWorld({ state: 'Finalized' });
    const r = await runVerify(w, { args: ['--sale', '9'] });
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['sale 9 not found on v1.tenderseal.near']);
    await expect(runVerify(w, { args: ['--sale', '1', '--keys'] })).rejects.toThrow('give exactly one of --sale N or --keys');
  });

  it('views read at one pinned block', async () => {
    const w = buildWorld({ state: 'Finalized' });
    const base = fakeRpc(w);
    const seen: unknown[] = [];
    const spy = (async (input: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
      if (body.method === 'query') seen.push(body.params.block_id ?? body.params.finality);
      return base(input as string, init as RequestInit);
    }) as typeof fetch;
    const r = await runVerify(w, { rpcFetch: spy });
    expect(r.code).toBe(0);
    expect(seen.length).toBeGreaterThan(10);
    expect(new Set(seen)).toEqual(new Set([224_000_000]));
  });

  it('--rebuild: equal hash → #6 PASS, different → FAIL, no tools → WARN', async () => {
    const w = buildWorld({ state: 'Finalized' });
    w.sourceMetadata = { version: '1.0.0', build_info: { source_code_snapshot: 'git+https://github.com/o/tender?rev=0123456789abcdef0123456789abcdef01234567' } };
    const file = deploy(w);
    const net = resolveNetwork({ contract: w.contract, rpc: 'https://fake.rpc' });
    const rpc = new Rpc(net.rpc, { fetchImpl: fakeRpc(w) });
    const run = async (rebuild: Parameters<typeof runSaleChecks>[0]['rebuild']) =>
      (
        await runSaleChecks({
          net,
          saleId: 1n,
          rpc,
          archival: rpc,
          block: w.block,
          wasm: { path: file, bytes: null },
          evidence: { path: 'none', rows: null },
          repoMpk: w.mpk,
          fetchImpl: fakeHttp(w),
          ...(rebuild ? { rebuild } : {}),
        })
      ).find((c) => c.n === 6)!;
    expect((await run(undefined)).detail).toContain('source git+https://github.com/o/tender?rev=0123456789');
    expect((await run(async () => ({ kind: 'hash', codeHash: w.codeHash, rev: '0123456789abcdef' }))).status).toBe('PASS');
    expect((await run(async () => ({ kind: 'hash', codeHash: '2222', rev: '0123456789abcdef' }))).status).toBe('FAIL');
    expect((await run(async () => ({ kind: 'unavailable', reason: 'docker not found' }))).status).toBe('WARN');
  });
});
