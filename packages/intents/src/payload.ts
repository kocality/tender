import { toBase64 } from './encoding.js';
import type { DefusePayload, TransferIntent } from './types.js';

export type BidOrigin = 'base' | 'arb' | 'sol' | 'near';

export interface RevealItem {
  idx: number;
  p: string; // u64 decimal string
  q: string; // u64 decimal string
  salt: string; // 32 hex
}

const DEFAULT_MIN_GAS = 30_000_000_000_000n;

/** C7 bid msg; key order op, sale, ct, cm, origin. `origin` is self-declared, UI badge only. */
export function bidMsg({ sale, ct, cm, origin }: { sale: string | bigint; ct: string; cm: string; origin?: BidOrigin }): string {
  return JSON.stringify({ op: 'bid', sale: String(sale), ct, cm, origin });
}

/** C17 gasless self-reveal msg. */
export function revealMsg({ sale, items }: { sale: string | bigint; items: RevealItem[] }): string {
  return JSON.stringify({
    op: 'reveal',
    sale: String(sale),
    items: items.map(({ idx, p, q, salt }) => ({ idx, p, q, salt })),
  });
}

/** Intents `Transfer`; `min_gas` is set (default 30 Tgas) only when `msg` makes it a notifying transfer. */
export function transferIntent({
  receiverId,
  tokenId,
  amount,
  msg,
  minGas,
}: {
  receiverId: string;
  tokenId: string;
  amount: bigint;
  msg?: string;
  minGas?: bigint;
}): TransferIntent {
  if (amount <= 0n) throw new Error(`transfer amount must be positive, got ${amount}`);
  const intent: TransferIntent = { intent: 'transfer', receiver_id: receiverId, tokens: { [tokenId]: amount.toString() } };
  if (msg !== undefined) {
    intent.msg = msg;
    intent.min_gas = (minGas ?? DEFAULT_MIN_GAS).toString();
  }
  return intent;
}

export function buildPayload({
  signerId,
  verifyingContract,
  deadlineIso,
  nonce,
  intents,
}: {
  signerId: string;
  verifyingContract: string;
  deadlineIso: string;
  nonce: Uint8Array;
  intents: TransferIntent[];
}): DefusePayload {
  if (nonce.length !== 32) throw new Error(`nonce must be 32 bytes, got ${nonce.length}`);
  return { signer_id: signerId, verifying_contract: verifyingContract, deadline: deadlineIso, nonce: toBase64(nonce), intents };
}

/** The string signed by erc191 and raw_ed25519; key order matches the intents-sdk viem signer. */
export function payloadString(p: DefusePayload): string {
  return JSON.stringify({
    signer_id: p.signer_id,
    verifying_contract: p.verifying_contract,
    deadline: p.deadline,
    nonce: p.nonce,
    intents: p.intents,
  });
}

/** nep413 `message`: only deadline, intents, signer_id (nonce and recipient live in the envelope). */
export function nep413Message(p: DefusePayload): string {
  return JSON.stringify({ deadline: p.deadline, intents: p.intents, signer_id: p.signer_id });
}
