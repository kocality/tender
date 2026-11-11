import { viewCall, type RpcOptions } from './rpc.js';

/** Live `current_salt` (8 hex). Read before every signature: a stale salt fails with `invalid salt`. */
export async function currentSalt(rpc: string[], intentsId: string): Promise<string> {
  const salt = await viewCall<string>(rpc, intentsId, 'current_salt', {});
  if (!/^[0-9a-f]{8}$/.test(salt)) throw new Error(`unexpected current_salt: ${salt}`);
  return salt;
}

export async function mtBalanceOf(rpc: string[], intentsId: string, accountId: string, tokenId: string): Promise<bigint> {
  return BigInt(await viewCall<string>(rpc, intentsId, 'mt_balance_of', { account_id: accountId, token_id: tokenId }));
}

export async function mtBatchBalanceOf(
  rpc: string[],
  intentsId: string,
  accountId: string,
  tokenIds: string[],
): Promise<bigint[]> {
  const r = await viewCall<string[]>(rpc, intentsId, 'mt_batch_balance_of', { account_id: accountId, token_ids: tokenIds });
  return r.map((x) => BigInt(x));
}

/** Named NEAR accounts must register their key with `add_public_key` before signing nep413 (F12). */
export async function hasPublicKey(rpc: string[], intentsId: string, accountId: string, publicKey: string): Promise<boolean> {
  return viewCall<boolean>(rpc, intentsId, 'has_public_key', { account_id: accountId, public_key: publicKey });
}

/** Whether `nonce` (base64) of `accountId` was already executed. Read at one block (`blockId`) together with other views. */
export async function isNonceUsed(rpc: string[], intentsId: string, accountId: string, nonceB64: string, opts?: RpcOptions): Promise<boolean> {
  return viewCall<boolean>(rpc, intentsId, 'is_nonce_used', { account_id: accountId, nonce: nonceB64 }, opts);
}

/** Whether `salt` (8 hex) is still accepted: the current salt or one the DAO has not invalidated. */
export async function isValidSalt(rpc: string[], intentsId: string, saltHex: string, opts?: RpcOptions): Promise<boolean> {
  return viewCall<boolean>(rpc, intentsId, 'is_valid_salt', { salt: saltHex }, opts);
}
