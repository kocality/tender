// pnpm seal:bid — seal a bid locally with open-source code (no hosted bundle) and print the unsigned Intents payload.
// stdout: one JSON object with public fields only. p, q and the salt go to ~/.tender/bids/ (chmod 600), never stdout:
// with the salt, the low-entropy p and q could be brute-forced from cm.
// Both carry `seq` (the signer's stored bids when sealed) and the pinned Intents salt, so the printed payload, a
// paste into the app and the team script all sign this bid with one nonce (DOUBLE-PLAN rows 5-6).
import './lib/node-version.js';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  type BidOrigin,
  bidMsg,
  bidNonce,
  buildPayload,
  currentSalt,
  makeDeadline,
  nep413Message,
  payloadString,
  solanaSignerId,
  toBase64,
  transferIntent,
} from '@tender/intents';
import { MPC_DOMAIN2_PK, sealBid } from '@tender/seal';
import bs58 from 'bs58';
import { COMMON_USAGE, type Io, UsageError, consoleIo, parseCli, runMain } from './lib/args.js';
import { resolveNetwork } from './lib/config.js';
import { parseDecimal, tokenName, utcFromNs } from './lib/format.js';
import { Rpc } from './lib/rpc.js';
import { MpcViews, TenderViews } from './lib/views.js';

const USAGE = `usage: pnpm seal:bid --sale N --price P --size Q --escrow B --signer <id> [--origin base|arb|sol|near]
  [--seq N] [--no-payload] [--unsafe-fixed-salt --salt <32 hex>]
${COMMON_USAGE}
  --price: USDC per 10^lot_exp whole tokens · --size, --escrow: USDC (at most 6 decimals)
  --seq: the signer's stored bids in this sale (default: read from get_bids); the contract refunds the bid if it differs`;

const ORIGINS = ['base', 'arb', 'sol', 'near'] as const;
const MIN_ESCROW = 1_000_000n;
const MAX_ESCROW_TOTAL = 1_000_000_000_000n; // contract sale::MAX_ESCROW_TOTAL (C16)
const CLOSE_MARGIN_MS = 60_000; // the signed transfer expires a minute before close, so a late relay is never stored
const MIN_GAS = 30_000_000_000_000n;
const NEAR_ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export interface SealBidDeps {
  fetchImpl?: typeof fetch;
  /** Directory for the secret bid file (default ~/.tender/bids). */
  bidsDir?: string;
  /** The domain-2 key this repo trusts (default MPC_DOMAIN2_PK[network]). */
  expectedMpk?: string;
}

type SignerKind = 'evm' | 'implicit' | 'near';

/** Base58 that decodes to 32 bytes (a Solana address), else null. */
function solanaKeyHex(raw: string): string | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) return null;
  try {
    const b = bs58.decode(raw);
    return b.length === 32 ? solanaSignerId(b) : null;
  } catch {
    return null;
  }
}

/**
 * The signer as its Intents account id is spelled (A11, A12): only an EVM address is lowercased (checksum case);
 * any other uppercase input is refused, because uppercase changes cm and fails reveal. A Solana address is refused
 * with the 64-hex Intents id to use instead.
 */
export function normalizeSigner(raw: string): { signer: string; kind: SignerKind; changed: boolean } {
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) return { signer: raw.toLowerCase(), kind: 'evm', changed: raw.toLowerCase() !== raw };
  const sol = solanaKeyHex(raw);
  if (sol && /[A-Z]/.test(raw)) {
    throw new Error(`--signer "${raw}" looks like a Solana address; its NEAR Intents account is ${sol}: pass --signer ${sol}`);
  }
  if (/^[0-9a-f]{64}$/.test(raw)) return { signer: raw, kind: 'implicit', changed: false };
  if (NEAR_ACCOUNT_RE.test(raw)) return { signer: raw, kind: 'near', changed: false };
  throw new Error(`--signer "${raw}" is not an EVM address, a 64-hex implicit account or a NEAR account id (lowercase)`);
}

export async function main(argv: string[], io: Io = consoleIo, deps: SealBidDeps = {}): Promise<number> {
  const v = parseCli(argv, {
    sale: { type: 'string' },
    price: { type: 'string' },
    size: { type: 'string' },
    escrow: { type: 'string' },
    signer: { type: 'string' },
    origin: { type: 'string' },
    seq: { type: 'string' },
    salt: { type: 'string' },
    'unsafe-fixed-salt': { type: 'boolean' },
    'no-payload': { type: 'boolean' },
  });
  if (v.help) {
    io.out(USAGE);
    return 0;
  }
  for (const k of ['sale', 'price', 'size', 'escrow', 'signer'] as const) if (!v[k]) throw new UsageError(`--${k} is required`);
  if (!/^\d+$/.test(v.sale!)) throw new UsageError('--sale must be a sale id');
  if (v.origin !== undefined && !(ORIGINS as readonly string[]).includes(v.origin)) throw new UsageError(`--origin must be one of ${ORIGINS.join('|')}`);
  if (v.salt !== undefined && !v['unsafe-fixed-salt']) {
    throw new UsageError('--salt needs --unsafe-fixed-salt: a known or reused salt lets anyone recover p and q from cm (tests only)');
  }
  if (v.salt !== undefined && !/^[0-9a-fA-F]{32}$/.test(v.salt)) throw new UsageError('--salt must be 32 hex characters');
  if (v.seq !== undefined && !(/^\d{1,5}$/.test(v.seq) && Number(v.seq) <= 65_535)) throw new UsageError('--seq must be a whole number 0..65535');
  const fail = (m: string) => {
    io.err(`error: ${m}`);
    return 1;
  };

  let p: bigint, q: bigint, B: bigint;
  let who: ReturnType<typeof normalizeSigner>;
  try {
    p = parseDecimal(v.price!, 6);
    q = parseDecimal(v.size!, 6);
    B = parseDecimal(v.escrow!, 6);
    who = normalizeSigner(v.signer!);
  } catch (e) {
    return fail((e as Error).message);
  }
  if (who.changed) io.err(`warning: signer lowercased to ${who.signer} (the Intents account id is lowercase; uppercase would change cm and fail reveal)`);
  if (v.salt !== undefined) io.err('warning: --unsafe-fixed-salt: this salt is not random; with it, p and q can be recovered from the public cm');
  if (B < MIN_ESCROW) return fail('--escrow must be at least 1 USDC');
  if (q < 1n || q > B) return fail('--size must be at least 0.000001 and at most --escrow');
  if (p < 1n) return fail('--price must be positive');
  const saleId = BigInt(v.sale!);
  const origin = v.origin as BidOrigin | undefined;

  const net = resolveNetwork({ network: v.network, contract: v.contract, rpc: v.rpc, archivalRpc: v['archival-rpc'] });
  const rpc = new Rpc(net.rpc, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
  const views = new TenderViews(rpc, net.contract);
  const head = await rpc.finalBlock();
  const [config, sale] = await Promise.all([views.config(head.height), views.sale(saleId, head.height)]);
  if (!sale) return fail(`sale ${saleId} not found on ${net.contract}`);
  const mine = (await views.bids(saleId, head.height)).filter((b) => b.bidder === who.signer).map((b) => `#${b.idx}`);
  const live = await new MpcViews(rpc, config.mpc).publicKey(Number(config.domain_id), head.height);
  const repo = deps.expectedMpk ?? MPC_DOMAIN2_PK[net.network];
  if (config.mpc_public_key !== live || live !== repo) {
    return fail(`MPC key mismatch, refusing to seal: contract ${config.mpc_public_key} · ${config.mpc} live ${live} · repo ${repo}`);
  }
  const closeMs = Number(BigInt(sale.close_ns) / 1_000_000n);
  if (sale.state !== 'Open' || Number(head.timestamp_ns / 1_000_000n) >= closeMs - CLOSE_MARGIN_MS) {
    return fail(`sale closed or closing within a minute (state ${sale.state}, closes ${utcFromNs(sale.close_ns)})`);
  }
  // The contract would refund these bids, and a refunded ciphertext stays in public tx history (X12P-02).
  if (sale.in_flight) return fail('the key request is in flight: the sale no longer takes bids');
  if (sale.bids >= sale.max_bids) return fail(`sale is full (${sale.bids}/${sale.max_bids} bids)`);
  if (BigInt(sale.escrow_total) + B > MAX_ESCROW_TOTAL) return fail(`escrow cap: ${sale.escrow_total} + ${B} > ${MAX_ESCROW_TOTAL} micro-USDC`);
  const unitTokens = `${10n ** BigInt(sale.lot_exp)} ${tokenName(sale.token)}`;
  io.err(`p = ${p} micro-USDC per ${unitTokens} · q = ${q} micro-USDC · escrow = ${B} micro-USDC`);
  if (p < BigInt(sale.reserve)) {
    io.err(`warning: below reserve (${sale.reserve}): refunded in full once it is revealed (left unrevealed while another bid is revealed, 10% stays in the contract); still counts toward open conditions`);
  }

  const sealed = sealBid({
    mpk: config.mpc_public_key,
    contract: net.contract,
    path: sale.path,
    sale: saleId,
    bidder: who.signer,
    B,
    p,
    q,
    ...(v.salt ? { salt: hexToBytes(v.salt.toLowerCase()) } : {}),
  });
  // seq: the contract stores this bid only while the signer has exactly `seq` bids here (refund `bid_seq` otherwise).
  const seq = v.seq === undefined ? mine.length : Number(v.seq);
  if (mine.length && v.seq === undefined) {
    io.err(`warning: ${who.signer} already has ${mine.length} bid${mine.length === 1 ? '' : 's'} in sale ${saleId} (${mine.join(', ')}): this seals an additional bid (seq ${seq})`);
  }
  if (seq !== mine.length) io.err(`warning: --seq ${seq} ≠ ${mine.length} stored bid${mine.length === 1 ? '' : 's'} of ${who.signer}: the contract refunds this bid (bid_seq) unless the count is ${seq} when it lands`);
  const msg = bidMsg({ sale: saleId, ct: sealed.ct_b64, cm: sealed.cm_hex, ...(origin ? { origin } : {}), seq });
  if (new TextEncoder().encode(msg).length > 512) return fail('bid msg exceeds 512 bytes');
  // The Intents salt is pinned here, with the bid: a re-sign of this bid keeps its nonce while the salt stays valid.
  const intentsSalt = await currentSalt(net.rpc, config.intents);
  const nonceBytes = bidNonce({ saltHex: intentsSalt, closeNs: BigInt(sale.close_ns), contract: net.contract, sale: saleId, signer: who.signer, cm: sealed.cm_hex });
  const nonce = toBase64(nonceBytes);

  // Secret part: only on this machine, never on stdout.
  const dir = deps.bidsDir ?? join(homedir(), '.tender', 'bids');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${net.network}-${net.contract}-sale${saleId}-${who.signer}-${sealed.cm_hex.slice(0, 8)}.json`);
  const secret = {
    sale: saleId.toString(),
    contract: net.contract,
    network: net.network,
    signer: who.signer,
    ct: sealed.ct_b64,
    cm: sealed.cm_hex,
    escrow: B.toString(),
    origin: origin ?? null,
    seq,
    intents_salt: intentsSalt,
    nonce,
    p: p.toString(),
    q: q.toString(),
    salt: sealed.salt_hex,
  };
  writeFileSync(file, JSON.stringify(secret, null, 1) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  io.err(`keep this file until reveal: ${file}`);

  let payload: string | null = null;
  if (v['no-payload']) {
    io.err('payload: null (--no-payload)');
  } else {
    // Chain time, not the local clock: a slow clock would sign an expired payload, a fast one a long-lived one.
    // The payload deadline (≤ close − 60 s) never passes the nonce deadline (close − 60 s).
    const nowMs = Number(head.timestamp_ns / 1_000_000n);
    const { deadlineIso } = makeDeadline(nowMs, Math.min(600_000, closeMs - CLOSE_MARGIN_MS - nowMs));
    const intent = transferIntent({ receiverId: net.contract, tokenId: sale.quote_token, amount: B, msg, minGas: MIN_GAS });
    const pl = buildPayload({ signerId: who.signer, verifyingContract: config.intents, deadlineIso, nonce: nonceBytes, intents: [intent] });
    // A NEAR account signs nep413, implicit 64-hex ones too when they come from a NEAR wallet (--origin near).
    if (who.kind === 'near' || (who.kind === 'implicit' && origin === 'near')) {
      payload = nep413Message(pl);
      io.err(`nep413: message = payload, nonce (base64) = ${pl.nonce}, recipient = ${config.intents}`);
    } else {
      payload = payloadString(pl);
      io.err(`${who.kind === 'evm' ? 'erc191' : 'raw_ed25519'}: sign the payload string as is`);
    }
    io.err(`sign within 10 minutes (deadline ${deadlineIso.replace(/\.\d{3}Z$/, 'Z')})`);
    io.err('sign and relay this payload OR paste this JSON in the app: both are the same bid (one nonce), only one can run');
  }

  io.out(
    JSON.stringify({
      sale: saleId.toString(),
      contract: net.contract,
      network: net.network,
      signer: who.signer,
      ct: sealed.ct_b64,
      cm: sealed.cm_hex,
      escrow: B.toString(),
      origin: origin ?? null,
      seq,
      intents_salt: intentsSalt,
      nonce,
      msg,
      payload,
    }),
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, USAGE);
