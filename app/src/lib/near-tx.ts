import type { RevealItem } from '@tender/intents';
import { config } from '../config';
import { callFunction } from '../wallets/near';

// Calls through the connected NEAR wallet. open, cancel and reveal are not payable (deposit 0): attaching a yocto would panic.

export const OPEN_GAS_TGAS = 100;
export const CANCEL_GAS_TGAS = 300;
export const REVEAL_GAS_TGAS = 150;
export const REVEAL_BATCH = 8;

/** Transaction hash from whatever the wallet returned (a FinalExecutionOutcome, or a wallet specific wrapper). */
export function txHashOf(outcome: unknown): string | null {
  const o = outcome as { transaction?: { hash?: unknown }; transaction_outcome?: { id?: unknown }; transactions?: { hash?: unknown }[]; txHash?: unknown } | null;
  const candidates = [o?.transaction?.hash, o?.transaction_outcome?.id, o?.transactions?.[0]?.hash, o?.txHash];
  const hit = candidates.find((c): c is string => typeof c === 'string' && c !== '');
  return hit ?? null;
}

export async function openSale(id: string): Promise<string | null> {
  return txHashOf(await callFunction(config.tenderContractId, 'open', { sale: id }, OPEN_GAS_TGAS, '0'));
}

export async function cancelSale(id: string): Promise<string | null> {
  return txHashOf(await callFunction(config.tenderContractId, 'cancel', { sale: id }, CANCEL_GAS_TGAS, '0'));
}

/** One `reveal` call with up to 8 items: a single invalid item makes the whole batch panic, so callers filter first. */
export async function revealBatch(id: string, items: RevealItem[]): Promise<string | null> {
  return txHashOf(await callFunction(config.tenderContractId, 'reveal', { sale: id, items }, REVEAL_GAS_TGAS, '0'));
}

/** Named NEAR accounts register their key with Intents once before any nep413 intent (1 yoctoNEAR). */
export async function addIntentsKey(publicKey: string): Promise<string | null> {
  return txHashOf(await callFunction(config.intentsContractId, 'add_public_key', { public_key: publicKey }, 30, '1'));
}
