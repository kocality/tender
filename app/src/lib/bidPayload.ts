import {
  bidMsg,
  buildPayload,
  buildVersionedNonce,
  currentSalt,
  makeDeadline,
  toBase64,
  toHex,
  transferIntent,
  viewCall,
  type BidOrigin,
  type DefusePayload,
} from '@tender/intents';
import { config } from '../config';
import { NEAR_USDC_TOKEN_ID } from './constants';

export const TRY_ESCROW = 1_000_000n; // 1 USDC, the same size the real wizard would sign for a minimal bid

export interface TryBidInput {
  signerId: string;
  receiverId: string;
  quoteToken: string;
  sale?: string;
  origin?: BidOrigin;
  /** Tests pass a fixed salt to skip the live read. Production always reads `current_salt` right before signing. */
  saltHex?: string;
  nowMs?: number;
}

/**
 * A realistic but unfundable bid payload for the free "Try signing" check: random ciphertext and commitment of the
 * right sizes (160 B / 32 B), the real message shape, a live salt and a 10 minute deadline. It is never relayed.
 */
export async function buildTryBid(input: TryBidInput): Promise<DefusePayload> {
  const saltHex = input.saltHex ?? (await currentSalt(config.rpcUrls, config.intentsContractId));
  const { deadlineMs, deadlineIso } = makeDeadline(input.nowMs);
  const ct = crypto.getRandomValues(new Uint8Array(160));
  const cm = crypto.getRandomValues(new Uint8Array(32));
  return buildPayload({
    signerId: input.signerId,
    verifyingContract: config.intentsContractId,
    deadlineIso,
    nonce: buildVersionedNonce({ saltHex, deadlineMs }),
    intents: [
      transferIntent({
        receiverId: input.receiverId,
        tokenId: input.quoteToken,
        amount: TRY_ESCROW,
        msg: bidMsg({ sale: input.sale ?? '0', ct: toBase64(ct), cm: toHex(cm), origin: input.origin }),
      }),
    ],
  });
}

export interface BidPayloadInput {
  signerId: string;
  /** The Tender contract that receives the transfer. */
  receiverId: string;
  quoteToken: string;
  /** Escrow B in micro-USDC. */
  amount: bigint;
  sale: string;
  ct: string;
  cm: string;
  origin?: BidOrigin;
  saltHex?: string;
  nowMs?: number;
}

/**
 * The one Intents Transfer that places a sealed bid: B of the quote token to the contract with `msg = {op: bid, ...}`.
 * The salt is read live right before signing (a stale one fails with `invalid salt`) and the deadline is 10 minutes.
 */
export async function buildBidPayload(input: BidPayloadInput): Promise<DefusePayload> {
  const saltHex = input.saltHex ?? (await currentSalt(config.rpcUrls, config.intentsContractId));
  const { deadlineMs, deadlineIso } = makeDeadline(input.nowMs);
  return buildPayload({
    signerId: input.signerId,
    verifyingContract: config.intentsContractId,
    deadlineIso,
    nonce: buildVersionedNonce({ saltHex, deadlineMs }),
    intents: [
      transferIntent({
        receiverId: input.receiverId,
        tokenId: input.quoteToken,
        amount: input.amount,
        msg: bidMsg({ sale: input.sale, ct: input.ct, cm: input.cm, origin: input.origin }),
      }),
    ],
  });
}

/** The sale's quote token read live from get_config(); the mainnet USDC id when the contract is not deployed yet. */
export async function liveQuoteToken(): Promise<string> {
  try {
    const c = await viewCall<{ quote_tokens?: string[] }>(config.rpcUrls, config.tenderContractId, 'get_config', {}, { backoffMs: [0] });
    return c.quote_tokens?.[0] ?? NEAR_USDC_TOKEN_ID;
  } catch {
    return NEAR_USDC_TOKEN_ID;
  }
}
