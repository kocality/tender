import { fromBase64 } from '@tender/intents';
import { MIN_ESCROW } from './bidFlow';

// A bid sealed offline with `pnpm seal:bid`, pasted as its stdout JSON. Only {sale, ct, cm, escrow, origin} are used.

export interface PastedBid {
  ct: string;
  cm: string;
  escrow: bigint;
  origin: 'base' | 'arb' | 'sol' | 'near' | undefined;
  /** The JSON carried a `salt`: it is ignored and never sent. */
  saltIgnored: boolean;
  /** The signer the CLI sealed for, when the JSON says so. */
  signer: string | undefined;
}

export type PasteResult = { ok: true; bid: PastedBid } | { ok: false; error: string };

const ORIGINS = ['base', 'arb', 'sol', 'near'] as const;

export function parsePastedBid(text: string, saleId: string): PasteResult {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Not valid JSON. Paste the single JSON line printed by `pnpm seal:bid`.' };
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return { ok: false, error: 'Expected a JSON object.' };
  const o = j as Record<string, unknown>;
  if (String(o.sale) !== saleId) return { ok: false, error: `This bid is for sale ${String(o.sale)}, this page is sale ${saleId}.` };
  if (typeof o.ct !== 'string') return { ok: false, error: 'Missing ct.' };
  let ctLen = -1;
  try {
    ctLen = fromBase64(o.ct).length;
  } catch {
    // reported below
  }
  if (ctLen !== 160) return { ok: false, error: `ct must be base64 of 160 bytes, got ${ctLen < 0 ? 'invalid base64' : `${ctLen} bytes`}.` };
  if (typeof o.cm !== 'string' || !/^[0-9a-f]{64}$/.test(o.cm)) return { ok: false, error: 'cm must be 64 lowercase hex characters.' };
  let escrow: bigint;
  try {
    if (typeof o.escrow !== 'string' && typeof o.escrow !== 'number') throw new Error('missing');
    escrow = BigInt(o.escrow);
  } catch {
    return { ok: false, error: 'escrow must be a whole number of micro-USDC (as printed by `pnpm seal:bid`).' };
  }
  if (escrow < MIN_ESCROW) return { ok: false, error: 'escrow must be at least 1 USDC (1000000).' };
  const origin = ORIGINS.find((x) => x === o.origin);
  return {
    ok: true,
    bid: { ct: o.ct, cm: o.cm, escrow, origin, saltIgnored: o.salt !== undefined, signer: typeof o.signer === 'string' ? o.signer : undefined },
  };
}

/** The command that seals a bid for this signer; shown next to the paste box. */
export function sealCommand(saleId: string, signerId: string): string {
  return `pnpm seal:bid --sale ${saleId} --price <USDC per token lot> --size <USDC to spend> --escrow <USDC> --signer ${signerId}`;
}
