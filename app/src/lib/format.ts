import { NEAR_USDC_TOKEN_ID, USDC_DECIMALS } from './constants';

/** 1234500n, 6 → "1.2345" (trailing zeros trimmed, at least an integer part). */
export function formatUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export function formatUsdc(value: bigint): string {
  return formatUnits(value, USDC_DECIMALS);
}

/** "nep141:wrap.near" → "wrap.near"; the NEAR-native USDC id → "USDC". */
export function tokenLabel(tokenId: string): string {
  if (tokenId === NEAR_USDC_TOKEN_ID) return 'USDC';
  return tokenId.replace(/^nep141:/, '');
}

export function shortId(s: string, head = 8, tail = 6): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** Chain timestamp (ns) → "2026-11-13 02:10:00 UTC". */
export function formatNsUtc(ns: bigint): string {
  return new Date(Number(ns / 1_000_000n)).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/** Remaining nanoseconds → "1d 02:03:04" / "00:00:07"; never negative. */
export function formatCountdown(remainingNs: bigint): string {
  const total = remainingNs <= 0n ? 0 : Number(remainingNs / 1_000_000_000n);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const hms = [h, m, s].map((x) => String(x).padStart(2, '0')).join(':');
  return d > 0 ? `${d}d ${hms}` : hms;
}
