// NearBlocks API v3 (independent indexer). One request only: the keyless tier rate-limits after a few (P-9).
// v1/v2 are switched off on 2026-11-22, so only v3 is used. Errors become a warning, never a throw.

export interface KeyReceipt {
  receipt_id: string;
  transaction_hash: string;
  block_height: string;
  block_timestamp: string;
}

export type KeyReceiptsResult =
  | { ok: true; count: number; receipts: KeyReceipt[]; truncated: boolean }
  | { ok: false; warn: string };

interface V3Receipt {
  receipt_id: string;
  transaction_hash: string;
  predecessor_account_id: string;
  receiver_account_id: string;
  block: { block_height: string | number; block_timestamp: string };
}

/** CKD requests `account` sent to `mpc`, as NearBlocks indexed them (lower bound when `truncated`). */
export async function fetchKeyReceipts({
  base,
  account,
  mpc,
  apiKey,
  fetchImpl = fetch,
}: {
  base: string;
  account: string;
  mpc: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<KeyReceiptsResult> {
  const url = `${base}/v3/accounts/${account}/receipts?method=request_app_private_key&limit=100`;
  try {
    const res = await fetchImpl(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json().catch(() => null)) as { data?: V3Receipt[] | null; meta?: { next_page?: string | null }; errors?: { message: string }[] } | null;
    if (!res.ok) return { ok: false, warn: `NearBlocks HTTP ${res.status}${j?.errors?.[0] ? `: ${j.errors[0].message}` : ''}` };
    if (!j || j.errors || !Array.isArray(j.data)) {
      return { ok: false, warn: `NearBlocks error: ${j?.errors?.map((e) => e.message).join('; ') ?? 'unexpected response'}` };
    }
    const receipts = j.data
      .filter((d) => d.predecessor_account_id === account && d.receiver_account_id === mpc)
      .map((d) => ({
        receipt_id: d.receipt_id,
        transaction_hash: d.transaction_hash,
        block_height: String(d.block.block_height),
        block_timestamp: String(d.block.block_timestamp),
      }));
    return { ok: true, count: receipts.length, receipts, truncated: Boolean(j.meta?.next_page) };
  } catch (e) {
    return { ok: false, warn: `NearBlocks unreachable: ${(e as Error).message}` };
  }
}
