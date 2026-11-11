import { fromBase64, toBase64 } from '@tender/intents';
import { MIN_ESCROW } from './bidFlow';

// A bid sealed offline with `pnpm seal:bid`, pasted as its stdout JSON. Only {sale, ct, cm, escrow, origin, seq, intents_salt} are used.

export interface PastedBid {
  ct: string;
  cm: string;
  escrow: bigint;
  origin: 'base' | 'arb' | 'sol' | 'near' | undefined;
  /** The JSON carried a `salt`: it is ignored and never sent. */
  saltIgnored: boolean;
  /** The signer the CLI sealed for (required: only paste output you produced yourself, for your own account). */
  signer: string;
  /** The account's stored bids in the sale when the CLI sealed this bid (the contract refunds the bid if the count differs when it lands). */
  seq: number;
  /** The Intents salt the CLI pinned, so a paste, the printed payload and the team script all sign this bid with one nonce. */
  intentsSalt: string;
}

/** The deployment this page talks to; the ciphertext only opens under the contract and network it was sealed for. */
export interface PasteTarget {
  contract: string;
  network: 'mainnet' | 'testnet';
}

export type PasteResult = { ok: true; bid: PastedBid } | { ok: false; error: string };

const ORIGINS = ['base', 'arb', 'sol', 'near'] as const;

/** The transfer inside the printed `payload` must move exactly the pasted escrow to the contract. */
function payloadMismatch(payload: unknown, escrow: bigint, contract: string): string | null {
  if (typeof payload !== 'string') return null; // --no-payload
  try {
    const intent = (JSON.parse(payload) as { intents?: { receiver_id?: unknown; tokens?: Record<string, unknown> }[] }).intents?.[0];
    const amounts = Object.values(intent?.tokens ?? {}).map((a) => BigInt(a as string));
    if (intent?.receiver_id !== contract || amounts.length !== 1 || amounts[0] !== escrow) {
      return 'The payload in this JSON does not transfer the escrow to this contract. Re-run `pnpm seal:bid` and paste its output unchanged.';
    }
  } catch {
    return 'The payload in this JSON cannot be read. Re-run `pnpm seal:bid` and paste its output unchanged.';
  }
  return null;
}

export function parsePastedBid(text: string, saleId: string, target: PasteTarget): PasteResult {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Not valid JSON. Paste the single JSON line printed by `pnpm seal:bid`.' };
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return { ok: false, error: 'Expected a JSON object.' };
  const o = j as Record<string, unknown>;
  if (String(o.sale) !== saleId) return { ok: false, error: `This bid is for sale ${String(o.sale)}, this page is sale ${saleId}.` };
  if (o.contract !== target.contract || o.network !== target.network) {
    return {
      ok: false,
      error: `This bid was sealed for ${String(o.contract)} on ${String(o.network)}, but this page uses ${target.contract} on ${target.network}. Re-run \`pnpm seal:bid --network ${target.network}\` for this sale.`,
    };
  }
  if (typeof o.signer !== 'string' || o.signer === '') return { ok: false, error: 'Missing signer. Paste only the output of `pnpm seal:bid --signer <your account>` that you produced yourself.' };
  // A file from the old seal:bid has neither: it would sign this bid with a random nonce, so pasting it and relaying the printed payload would escrow it twice.
  const OLD = 'This file has no `seq` or `intents_salt`: it came from an older `pnpm seal:bid`. Please re-run `pnpm seal:bid` and paste its new output.';
  if (o.seq === undefined || o.intents_salt === undefined) return { ok: false, error: OLD };
  if (typeof o.seq !== 'number' || !Number.isInteger(o.seq) || o.seq < 0 || o.seq > 0xffff) return { ok: false, error: 'seq must be a whole number between 0 and 65535 (as printed by `pnpm seal:bid`).' };
  if (typeof o.intents_salt !== 'string' || !/^[0-9a-f]{8}$/.test(o.intents_salt)) return { ok: false, error: 'intents_salt must be 8 lowercase hex characters (as printed by `pnpm seal:bid`).' };
  if (typeof o.ct !== 'string') return { ok: false, error: 'Missing ct.' };
  // The contract decodes with strict base64 (STANDARD, padded): text that decodes here but does not re-encode to itself would be refunded as bad_ct.
  let ctLen = -1;
  try {
    const raw = fromBase64(o.ct);
    if (toBase64(raw) === o.ct) ctLen = raw.length;
  } catch {
    // reported below
  }
  if (ctLen !== 160) return { ok: false, error: `ct must be canonical base64 (standard alphabet, padded) of 160 bytes, got ${ctLen < 0 ? 'invalid base64' : `${ctLen} bytes`}.` };
  if (typeof o.cm !== 'string' || !/^[0-9a-f]{64}$/.test(o.cm)) return { ok: false, error: 'cm must be 64 lowercase hex characters.' };
  let escrow: bigint;
  try {
    if (typeof o.escrow !== 'string' && typeof o.escrow !== 'number') throw new Error('missing');
    escrow = BigInt(o.escrow);
  } catch {
    return { ok: false, error: 'escrow must be a whole number of micro-USDC (as printed by `pnpm seal:bid`).' };
  }
  if (escrow < MIN_ESCROW) return { ok: false, error: 'escrow must be at least 1 USDC (1000000).' };
  const mismatch = payloadMismatch(o.payload, escrow, target.contract);
  if (mismatch) return { ok: false, error: mismatch };
  const origin = ORIGINS.find((x) => x === o.origin);
  return {
    ok: true,
    bid: { ct: o.ct, cm: o.cm, escrow, origin, saltIgnored: o.salt !== undefined, signer: o.signer, seq: o.seq, intentsSalt: o.intents_salt },
  };
}

/** The command that seals a bid for this signer; shown next to the paste box. */
export function sealCommand(saleId: string, signerId: string): string {
  return `pnpm seal:bid --sale ${saleId} --price <USDC per token lot> --size <USDC to spend> --escrow <USDC> --signer ${signerId}`;
}
