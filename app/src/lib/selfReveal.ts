import { buildPayload, buildVersionedNonce, currentSalt, makeDeadline, revealMsg, transferIntent, type DefusePayload, type RevealItem } from '@tender/intents';
import { config } from '../config';

/**
 * Gasless self-reveal: one Intents Transfer of 1 micro-USDC to the contract with `msg = {op: reveal, sale, items}`.
 * The contract checks the items against the commitments, reveals them and returns the 1 micro-USDC.
 */
export async function buildSelfReveal(o: {
  signerId: string;
  contract: string;
  quoteToken: string;
  sale: string;
  items: RevealItem[];
  saltHex?: string;
  nowMs?: number;
}): Promise<DefusePayload> {
  const saltHex = o.saltHex ?? (await currentSalt(config.rpcUrls, config.intentsContractId));
  const { deadlineMs, deadlineIso } = makeDeadline(o.nowMs);
  return buildPayload({
    signerId: o.signerId,
    verifyingContract: config.intentsContractId,
    deadlineIso,
    nonce: buildVersionedNonce({ saltHex, deadlineMs }),
    intents: [transferIntent({ receiverId: o.contract, tokenId: o.quoteToken, amount: 1n, msg: revealMsg({ sale: o.sale, items: o.items }) })],
  });
}
