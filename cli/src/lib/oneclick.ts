// 1Click deposit status (evidence for a bid's origin chain). Never throws.
export const ONECLICK_API = 'https://1click.chaindefuser.com';

export async function fetchStatus(
  depositAddress: string,
  { base = ONECLICK_API, fetchImpl = fetch }: { base?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ status: string } | { warn: string }> {
  try {
    const res = await fetchImpl(`${base}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return { warn: 'deposit address not found' };
    if (!res.ok) return { warn: `1Click HTTP ${res.status}` };
    const j = (await res.json()) as { status?: string };
    return typeof j.status === 'string' ? { status: j.status } : { warn: '1Click: no status in response' };
  } catch (e) {
    return { warn: `1Click unreachable: ${(e as Error).message}` };
  }
}
