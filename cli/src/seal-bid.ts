// pnpm seal:bid — seal a bid locally with open-source code (no hosted bundle) and print the unsigned Intents payload.
// stdout: one JSON object with public fields only. p, q and the salt go to ~/.tender/bids/ (chmod 600), never stdout:
// with the salt, the low-entropy p and q could be brute-forced from cm.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  type BidOrigin,
  bidMsg,
  buildPayload,
  buildVersionedNonce,
  currentSalt,
  makeDeadline,
  nep413Message,
  payloadString,
  transferIntent,
} from '@tender/intents';
import { MPC_DOMAIN2_PK, sealBid } from '@tender/seal';
import { COMMON_USAGE, type Io, UsageError, consoleIo, parseCli, runMain } from './lib/args.js';
import { resolveNetwork } from './lib/config.js';
import { parseDecimal, tokenName, utcFromNs } from './lib/format.js';
import { Rpc } from './lib/rpc.js';
import { MpcViews, TenderViews } from './lib/views.js';

const USAGE = `usage: pnpm seal:bid --sale N --price P --size Q --escrow B --signer <id> [--origin base|arb|sol|near]
  [--salt <32 hex>] [--no-payload]
${COMMON_USAGE}
  --price: USDC per 10^lot_exp whole tokens · --size, --escrow: USDC (at most 6 decimals)`;

const ORIGINS = ['base', 'arb', 'sol', 'near'] as const;
const MIN_ESCROW = 1_000_000n;
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

/** Lowercase the signer the way the Intents account id is spelled (A11, A12); uppercase changes cm and fails reveal. */
export function normalizeSigner(raw: string): { signer: string; kind: SignerKind; changed: boolean } {
  const lower = raw.toLowerCase();
  const changed = lower !== raw;
  if (/^0x[0-9a-f]{40}$/.test(lower)) return { signer: lower, kind: 'evm', changed };
  if (/^[0-9a-f]{64}$/.test(lower)) return { signer: lower, kind: 'implicit', changed };
  if (NEAR_ACCOUNT_RE.test(lower)) return { signer: lower, kind: 'near', changed };
  throw new Error(`--signer "${raw}" is not an EVM address, a 64-hex implicit account or a NEAR account id`);
}

export async function main(argv: string[], io: Io = consoleIo, deps: SealBidDeps = {}): Promise<number> {
  const v = parseCli(argv, {
    sale: { type: 'string' },
    price: { type: 'string' },
    size: { type: 'string' },
    escrow: { type: 'string' },
    signer: { type: 'string' },
    origin: { type: 'string' },
    salt: { type: 'string' },
    'no-payload': { type: 'boolean' },
  });
  if (v.help) {
    io.out(USAGE);
    return 0;
  }
  for (const k of ['sale', 'price', 'size', 'escrow', 'signer'] as const) if (!v[k]) throw new UsageError(`--${k} is required`);
  if (!/^\d+$/.test(v.sale!)) throw new UsageError('--sale must be a sale id');
  if (v.origin !== undefined && !(ORIGINS as readonly string[]).includes(v.origin)) throw new UsageError(`--origin must be one of ${ORIGINS.join('|')}`);
  if (v.salt !== undefined && !/^[0-9a-fA-F]{32}$/.test(v.salt)) throw new UsageError('--salt must be 32 hex characters');
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
  const live = await new MpcViews(rpc, config.mpc).publicKey(Number(config.domain_id), head.height);
  const repo = deps.expectedMpk ?? MPC_DOMAIN2_PK[net.network];
  if (config.mpc_public_key !== live || live !== repo) {
    return fail(`MPC key mismatch, refusing to seal: contract ${config.mpc_public_key} · ${config.mpc} live ${live} · repo ${repo}`);
  }
  if (sale.state !== 'Open' || head.timestamp_ns >= BigInt(sale.close_ns)) {
    return fail(`sale closed (state ${sale.state}, closes ${utcFromNs(sale.close_ns)})`);
  }
  const unitTokens = `${10n ** BigInt(sale.lot_exp)} ${tokenName(sale.token)}`;
  io.err(`p = ${p} micro-USDC per ${unitTokens} · q = ${q} micro-USDC · escrow = ${B} micro-USDC`);
  if (p < BigInt(sale.reserve)) io.err(`warning: below reserve (${sale.reserve}): fully refunded, still counts toward open conditions`);

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
  const msg = bidMsg({ sale: saleId, ct: sealed.ct_b64, cm: sealed.cm_hex, ...(origin ? { origin } : {}) });
  if (new TextEncoder().encode(msg).length > 512) return fail('bid msg exceeds 512 bytes');

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
    const saltHex = await currentSalt(net.rpc, config.intents);
    const { deadlineMs, deadlineIso } = makeDeadline();
    const nonce = buildVersionedNonce({ saltHex, deadlineMs });
    const intent = transferIntent({ receiverId: net.contract, tokenId: sale.quote_token, amount: B, msg, minGas: MIN_GAS });
    const pl = buildPayload({ signerId: who.signer, verifyingContract: config.intents, deadlineIso, nonce, intents: [intent] });
    if (who.kind === 'near') {
      payload = nep413Message(pl);
      io.err(`nep413: message = payload, nonce (base64) = ${pl.nonce}, recipient = ${config.intents}`);
    } else {
      payload = payloadString(pl);
      io.err(`${who.kind === 'evm' ? 'erc191' : 'raw_ed25519'}: sign the payload string as is`);
    }
    io.err(`sign within 10 minutes (deadline ${deadlineIso.replace(/\.\d{3}Z$/, 'Z')})`);
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
      msg,
      payload,
    }),
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, USAGE);
