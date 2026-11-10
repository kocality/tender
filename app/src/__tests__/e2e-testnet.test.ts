/// <reference types="node" />
// Testnet end to end, in Node, against the testnet copy of the stack (own Intents 0.4.5 copy, keyless Tender contract,
// real v1.signer-prod.testnet CKD). Runs only with E2E_TESTNET=1, after app/scripts/e2e-testnet-setup.sh has written the
// E2E_* ids (source its env file first). Raw outputs go to E2E_OUT_DIR (default: the OS temp dir).
// Wallets are random keys in this process (an ed25519 key as a Phantom stand-in, a secp256k1 key through viem's
// personal_sign as a MetaMask stand-in). No browser, no extension, no mainnet.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  blockTimestampNs,
  erc191FromWallet,
  evmSignerId,
  fromBase64,
  fromHex,
  mtBalanceOf,
  payloadString,
  rawEd25519FromWallet,
  simulateIntents,
  solanaSignerId,
  type MultiPayload,
} from '@tender/intents';
import { config } from '../config';
import { validateBid } from '../lib/bidFlow';
import { buildBidPayload } from '../lib/bidPayload';
import { decryptSale } from '../lib/decrypt';
import { receiptCheck } from '../lib/ledger';
import { loadKeys, loadSaleBundle } from '../lib/loaders';
import { confirmBid, pollBid, relay } from '../lib/relay';
import { recompute } from '../lib/results';
import { batches, revealable, toRevealItems } from '../lib/revealFilter';
import { sealForSale } from '../lib/sealBid';
import { buildSelfReveal } from '../lib/selfReveal';
import { getAllBids, getConfig, getSale, type Bid } from '../lib/views';

const RUN = process.env.E2E_TESTNET === '1';
const WAIT_CLOSE = process.env.E2E_WAIT_CLOSE === '1';
const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k} (source the env file written by e2e-testnet-setup.sh)`);
  return v;
};
const OUT_DIR = process.env.E2E_OUT_DIR ?? join(tmpdir(), 'tender-e2e');
const out = (name: string, text: string) => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${stamp}-${name}`), text);
};
const RELAY_URL = process.env.E2E_RELAYER_URL ?? 'http://localhost:8787/relay';
const FUND_MICRO = 3_100_000n; // 3 USDC escrow + 0.1 USDC left for the gasless reveal's 1 micro-USDC
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').slice(0, 13) + 'Z';

const log: string[] = [];
const note = (line: string) => {
  log.push(line);
  console.log(line);
};
const txIn = (out: string): string[] => [...out.matchAll(/Transaction ID: ([1-9A-HJ-NP-Za-km-z]{43,44})/g)].map((m) => m[1]!);

function nearCall(receiver: string, method: string, args: object, gas: string, deposit = '0 NEAR'): string {
  const r = spawnSync(
    'near',
    ['contract', 'call-function', 'as-transaction', receiver, method, 'json-args', JSON.stringify(args), 'prepaid-gas', gas, 'attached-deposit', deposit,
      'sign-as', env('E2E_TEAM'), 'network-config', 'testnet', 'sign-with-legacy-keychain', 'send'],
    { encoding: 'utf8', maxBuffer: 16 << 20 },
  );
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.status !== 0) throw new Error(`${method}: near exited ${r.status}\n${out.slice(-600)}`);
  if (/Failure|panicked/i.test(out)) throw new Error(`${method} failed:\n${out.split('\n').filter((l) => /Failure|panicked|Error/i.test(l)).join('\n')}`);
  const hash = txIn(out).at(-1);
  if (!hash) throw new Error(`${method}: no tx hash in near output`);
  return hash;
}

function fundTestnet(signerId: string, micro: bigint): string[] {
  const r = spawnSync('bash', ['scripts/fund-testnet.sh', signerId, micro.toString()], {
    cwd: new URL('../..', import.meta.url).pathname,
    encoding: 'utf8',
    maxBuffer: 16 << 20,
    env: { ...process.env, TESTNET_TEAM_ACCOUNT: env('E2E_TEAM'), TESTNET_USDC_ID: env('E2E_USDC'), TESTNET_INTENTS_ID: env('E2E_INTENTS') },
  });
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.status !== 0) throw new Error(`fund-testnet.sh failed:\n${out.slice(-600)}`);
  return txIn(out);
}

async function untilTrue<T>(what: string, timeoutMs: number, intervalMs: number, probe: () => Promise<T | null | undefined | false>): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

interface Placed {
  name: string;
  signerId: string;
  priceText: string;
  p: bigint;
  q: bigint;
  B: bigint;
  salt: Uint8Array;
  cm: string;
  idx: number;
  txs: { fund: string[]; relay: string };
  sign: (payloadStr: string) => Promise<MultiPayload>;
}
const placed: Placed[] = [];

async function newWallet(kind: 'ed25519' | 'evm'): Promise<{ signerId: string; sign: (s: string) => Promise<MultiPayload> }> {
  if (kind === 'evm') {
    const account = privateKeyToAccount(generatePrivateKey());
    return { signerId: evmSignerId(account.address), sign: async (s) => erc191FromWallet(s, await account.signMessage({ message: s })) };
  }
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const pkcs8 = new Uint8Array([...fromHex('302e020100300506032b657004220420'), ...seed]);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  const pk32 = fromBase64(jwk.x!.replace(/-/g, '+').replace(/_/g, '/') + '=');
  return {
    signerId: solanaSignerId(pk32),
    sign: async (s) => rawEd25519FromWallet(s, pk32, new Uint8Array(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(s)))),
  };
}

describe.skipIf(!RUN)('testnet end to end', () => {
  test('two bids from two wallets: fund, seal, sign, simulate, relay, stored as Sealed', async () => {
    const saleId = env('E2E_SALE_ID');
    expect(config.network).toBe('testnet');
    expect(config.tenderContractId).toBe(env('E2E_TENDER'));
    expect(config.intentsContractId).toBe(env('E2E_INTENTS'));

    const cfg = await getConfig();
    note(`config: version ${cfg.version} · app_pk_mode ${cfg.appPkMode} · mpc ${cfg.mpc} · quote ${cfg.quoteTokens[0]}`);
    const quoteToken = cfg.quoteTokens[0]!;
    expect(quoteToken).toBe(`nep141:${env('E2E_USDC')}`);
    const sale = await getSale(saleId);
    expect(sale?.state).toBe('Open');
    const nowNs = await blockTimestampNs(config.rpcUrls);
    note(`sale ${saleId}: path ${sale!.path} · close in ${Number((sale!.closeNs - nowNs) / 1_000_000_000n)} s`);

    const specs = [
      { name: 'A (raw_ed25519, Phantom stand-in)', kind: 'ed25519' as const, price: '3.5', size: '0.2', origin: 'sol' as const },
      { name: 'B (erc191, MetaMask stand-in)', kind: 'evm' as const, price: '4', size: '0.3', origin: 'base' as const },
    ];
    for (const s of specs) {
      const w = await newWallet(s.kind);
      const v = validateBid({ priceText: s.price, sizeText: s.size, escrowText: '3', sale: sale!, nowNs: await blockTimestampNs(config.rpcUrls) });
      if (!v.ok) throw new Error(v.errors.join('; '));

      const fund = fundTestnet(w.signerId, FUND_MICRO);
      const bal = await untilTrue('Intents balance', 60_000, 3_000, async () => {
        const b = await mtBalanceOf(config.rpcUrls, config.intentsContractId, w.signerId, quoteToken);
        return b >= FUND_MICRO ? b : null;
      });
      note(`${s.name}: signer ${w.signerId} · funded ${bal} micro-USDC · fund txs ${fund.join(',')}`);

      const sealed = sealForSale({ contractId: config.tenderContractId, sale: BigInt(saleId), mpk: cfg.mpcPublicKey, path: sale!.path, bidder: w.signerId, B: v.B, p: v.p, q: v.q });
      const payload = await buildBidPayload({ signerId: w.signerId, receiverId: config.tenderContractId, quoteToken, amount: v.B, sale: saleId, ct: sealed.ct, cm: sealed.cm, origin: s.origin });
      const mp = await w.sign(payloadString(payload));
      const sim = await simulateIntents(config.rpcUrls, config.intentsContractId, [mp]);
      expect(sim.ok, JSON.stringify(sim)).toBe(true);
      const { txHash } = await relay([mp], RELAY_URL);
      const stored = await confirmBid({ sale: saleId, bidder: w.signerId, cm: sealed.cm, timeoutMs: 90_000, intervalMs: 3_000 });
      expect(stored, 'bid was refunded by the contract').not.toBeNull();
      expect(stored).toMatchObject({ bidder: w.signerId, cm: sealed.cm, state: 'Sealed', escrow: v.B, origin: s.origin });
      note(`${s.name}: bid #${stored!.idx} stored · Sealed · relay tx ${txHash}`);
      placed.push({ name: s.name, signerId: w.signerId, priceText: s.price, p: v.p, q: v.q, B: v.B, salt: sealed.salt, cm: sealed.cm, idx: stored!.idx, txs: { fund, relay: txHash }, sign: w.sign });
    }

    const bids = await getAllBids(saleId);
    expect(bids.length).toBeGreaterThanOrEqual(2);
    const cur = await getSale(saleId);
    expect(cur!.bidders).toBeGreaterThanOrEqual(2);
    // the stored bid fields hold only ciphertext: neither price nor size appear before the reveal
    for (const b of bids) expect(b).toMatchObject({ state: 'Sealed', p: null, q: null });
    out(
      't04-testnet-bid.json',
      JSON.stringify({ tender: config.tenderContractId, sale: saleId, sale_state: cur!.state, bids: bids.map((b) => ({ ...b, escrow: b.escrow.toString(), block: b.block.toString(), ns: b.ns.toString(), alloc: undefined, spend: undefined, penalty: undefined, penaltyShare: undefined, paid: undefined })) }, null, 2),
    );
    out('e2e-bids.txt', log.join('\n') + '\n');
  }, 300_000);

  test.skipIf(!WAIT_CLOSE)('after close: open, real CKD, decrypt n/n, self-reveal, reveal all, finalize, result matches the recomputation', async () => {
    expect(placed.length, 'the bid test must run first in this process').toBe(2);
    const saleId = env('E2E_SALE_ID');
    const quoteToken = `nep141:${env('E2E_USDC')}`;
    const sale0 = (await getSale(saleId))!;

    await untilTrue('close', 15 * 60_000, 10_000, async () => ((await blockTimestampNs(config.rpcUrls)) >= sale0.closeNs ? true : null));
    const openTx = nearCall(config.tenderContractId, 'open', { sale: saleId }, '100 Tgas');
    note(`open tx ${openTx}`);
    const keyed = await untilTrue('Keyed (testnet MPC)', 10 * 60_000, 4_000, async () => {
      const s = await getSale(saleId);
      return s?.state === 'Keyed' ? s : null;
    });
    note(`key released: Keyed · key block ${keyed.key!.block} · reveal deadline ${keyed.revealDeadlineNs}`);

    // decrypt in the app's own module: every bid must come back ok
    const cfg = await getConfig();
    const decrypt = async () => decryptSale({ config: cfg, sale: keyed, bids: await getAllBids(saleId), contractId: config.tenderContractId, expectedMpk: cfg.mpcPublicKey });
    let dec = await decrypt();
    expect(dec.keyOk, dec.keyError).toBe(true);
    expect(dec.rows.map((r) => r.status)).toEqual(['ok', 'ok']);
    for (const r of dec.rows) {
      const mine = placed.find((p) => p.idx === r.idx)!;
      expect({ p: r.p, q: r.q }).toEqual({ p: mine.p, q: mine.q });
    }
    note(`decrypt: ${dec.rows.filter((r) => r.status === 'ok').length}/${dec.rows.length} ok, prices equal the ones sealed`);

    // A: gasless self-reveal through the relayer (1 micro-USDC transfer that the contract returns)
    const a = placed[0]!;
    const item = revealable(dec, await getAllBids(saleId)).find((i) => i.idx === a.idx)!;
    const payload = await buildSelfReveal({ signerId: a.signerId, contract: config.tenderContractId, quoteToken, sale: saleId, items: [{ idx: item.idx, p: item.p, q: item.q, salt: item.salt }] });
    const mp = await a.sign(payloadString(payload));
    const sim = await simulateIntents(config.rpcUrls, config.intentsContractId, [mp]);
    expect(sim.ok, JSON.stringify(sim)).toBe(true);
    const selfTx = (await relay([mp], RELAY_URL)).txHash;
    const revealedA = await pollBid((bids: Bid[]) => bids.find((b) => b.idx === a.idx && b.state === 'Revealed'), saleId, { timeoutMs: 90_000, intervalMs: 3_000 });
    expect(revealedA, 'self-reveal did not land').not.toBeNull();
    expect(revealedA).toMatchObject({ p: a.p, q: a.q });
    note(`self-reveal (gasless) of bid #${a.idx} · relay tx ${selfTx}`);

    // B: "Reveal all" with the filter and the 8-item batches the Reveal panel uses, sent with the team key
    dec = await decrypt();
    const todo = revealable(dec, await getAllBids(saleId));
    expect(todo.map((i) => i.idx)).toEqual([placed[1]!.idx]);
    const revealTxs = batches(todo).map((b) => nearCall(config.tenderContractId, 'reveal', { sale: saleId, items: toRevealItems(b) }, '150 Tgas'));
    note(`reveal all (${todo.length} left) tx ${revealTxs.join(',')}`);
    const all = await untilTrue('all Revealed', 60_000, 3_000, async () => {
      const bids = await getAllBids(saleId);
      return bids.every((b) => b.state === 'Revealed') ? bids : null;
    });
    expect(all).toHaveLength(2);

    // everything is revealed, so finalize needs no waiting for the reveal deadline
    const finalizeTx = nearCall(config.tenderContractId, 'finalize', { sale: saleId, max: 0 }, '300 Tgas');
    note(`finalize tx ${finalizeTx}`);
    const bundle = await untilTrue('Finalized with a result', 90_000, 3_000, async () => {
      const b = await loadSaleBundle(saleId);
      return b.sale?.state === 'Finalized' && b.result ? b : null;
    });
    expect(bundle.sale!.payoutsDone).toBe(bundle.sale!.payoutsTotal);
    const rc = recompute(bundle.sale!, bundle.bids, bundle.result!);
    expect(rc.diffs).toEqual([]);
    expect(rc.match).toBe(true);
    note(`finalized: P* ${bundle.result!.pStar} · sold ${bundle.result!.sold} · payouts ${bundle.sale!.payoutsDone}/${bundle.sale!.payoutsTotal} · recomputed in Node: match (${bundle.bids.length} bids, 0 diffs)`);
    for (const b of bundle.bids) note(`  bid #${b.idx} ${b.bidder.slice(0, 10)}… p ${b.p} q ${b.q} alloc ${b.alloc} spend ${b.spend} paid ok ${b.paid?.ok}`);

    out('e2e.txt', log.join('\n') + '\n');
  }, 1_500_000);

  // Read-only: the real views of a finished sale (default: the M3 rehearsal sale 0) go through the app's parsers.
  test('real testnet views of a finished sale: decrypt n/n, recompute equals get_result, key ledger matches NearBlocks', async () => {
    const id = process.env.E2E_FINISHED_SALE ?? '0';
    const lines: string[] = [];
    const say = (l: string) => {
      lines.push(l);
      console.log(l);
    };
    const bundle = await loadSaleBundle(id);
    expect(bundle.sale, `sale ${id} not found`).not.toBeNull();
    expect(bundle.sale!.state).toBe('Finalized');
    expect(bundle.result).not.toBeNull();
    const cfg = await getConfig();
    const dec = await decryptSale({ config: cfg, sale: bundle.sale!, bids: bundle.bids, contractId: config.tenderContractId, expectedMpk: cfg.mpcPublicKey });
    expect(dec.keyOk, dec.keyError).toBe(true);
    expect(dec.rows.every((r) => r.status === 'ok')).toBe(true);
    for (const r of dec.rows) {
      const b = bundle.bids[r.idx]!;
      expect({ p: r.p, q: r.q }).toEqual({ p: b.p, q: b.q }); // the decrypted plaintext equals what the reveal stored
    }
    say(`sale ${id}: ${bundle.sale!.state} · decrypt ${dec.rows.length}/${dec.rows.length} ok · payouts ${bundle.sale!.payoutsDone}/${bundle.sale!.payoutsTotal}`);
    const rc = recompute(bundle.sale!, bundle.bids, bundle.result!);
    expect(rc.diffs).toEqual([]);
    say(`sale ${id}: P* ${bundle.result!.pStar} · recomputed in Node equals get_result (0 diffs over ${bundle.bids.length} bids)`);

    const keys = await loadKeys();
    const check = receiptCheck(keys.rows, keys.receipts);
    say(`key ledger: ${keys.rows.length} entries · outcomes ${keys.rows.map((r) => `${r.entry.sale}:${r.entry.outcome}`).join(' ')} · NearBlocks receipts ${keys.receipts === null ? 'unavailable' : keys.receipts.length} · ${check} · MPC ${keys.mpc} ${keys.mpcVersion}`);
    expect(keys.rows.length).toBeGreaterThanOrEqual(1);
    expect(keys.rows.find((r) => r.entry.sale === id)?.entry.outcome).toBe('Ok');
    out('t05-m3-views.txt', lines.join('\n') + '\n');
  }, 120_000);
});
