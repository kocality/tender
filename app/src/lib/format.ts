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

/** For display at size: 1800001n, 6 → "1.80" (half up, `dp` places, never more than the token has); the exact value goes in a title. */
export function formatRounded(value: bigint, decimals: number, dp = 2): string {
  if (decimals <= dp || value < 0n) return formatUnits(value, decimals);
  const step = 10n ** BigInt(decimals - dp);
  const r = (value + step / 2n) / step;
  const base = 10n ** BigInt(dp);
  return `${r / base}.${(r % base).toString().padStart(dp, '0')}`;
}

export function formatUsdc(value: bigint): string {
  return formatUnits(value, USDC_DECIMALS);
}

/** "nep141:wrap.near" → "wrap.near"; the NEAR-native USDC id → "USDC". */
export function tokenLabel(tokenId: string): string {
  if (tokenId === NEAR_USDC_TOKEN_ID) return 'USDC';
  return tokenId.replace(/^nep141:/, '');
}

/**
 * A short name for a sale token where the account id says what it is: wNEAR ("wrap.near", or a testnet "wnear.*" copy)
 * and meme.cooking tokens ("jambo-1679.meme-cooking.near" → "JAMBO"). Anything else keeps its account id. Pages show the
 * full id next to it (mono line or title).
 */
export function tokenSymbol(tokenId: string): string {
  const id = tokenLabel(tokenId);
  if (/^(wrap\.(near|testnet)|wnear\.)/.test(id)) return 'wNEAR';
  const meme = /^([a-z][a-z0-9]*)-\d+\.meme-cooking\.(near|testnet)$/.exec(id);
  return meme ? meme[1]!.toUpperCase() : id;
}

/** A USDC price, always with at least two decimals: 3900000n → "3.90", 174000n → "0.174". */
export function formatPrice(value: bigint): string {
  const s = formatUsdc(value);
  const dot = s.indexOf('.');
  if (dot === -1) return `${s}.00`;
  return s.length - dot - 1 < 2 ? `${s}0` : s;
}

/** Long ids shortened in the middle. A named NEAR account keeps its first and last labels whole ("bidder1.…testnet"), so no word is cut. */
export function shortId(s: string, head = 8, tail = 6): string {
  if (s.length <= head + tail + 1) return s;
  const labels = s.split('.');
  if (labels.length > 2) {
    const first = labels[0]!;
    const last = labels[labels.length - 1]!;
    if (first.length <= head + 4 && last.length <= tail + 4) return `${first}.…${last}`;
  }
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
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
