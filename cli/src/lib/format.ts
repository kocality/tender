// Integer-only amounts (P-5): money is never a JS number.

/** "3.9" → 3_900_000n for decimals = 6. More fractional digits than `decimals` is an error. */
export function parseDecimal(s: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`not a decimal number: "${s}"`);
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`"${s}" has more than ${decimals} decimal places`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

function fixed(v: bigint, decimals: number, minFrac: number): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const int = (a / base).toString();
  let frac = decimals > 0 ? (a % base).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  if (frac.length < minFrac) frac = frac.padEnd(minFrac, '0');
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/** micro-USDC → "3.60", "0.800001" (at least 2 decimals, no trailing zeros beyond). */
export const formatUsdc = (micro: bigint): string => fixed(micro, 6, 2);

/** Token base units → whole tokens, trailing zeros dropped. */
export const formatTokens = (base: bigint, decimals: number): string => fixed(base, decimals, 0);

/** ns since epoch → ISO 8601 UTC, whole seconds ("2026-11-17T12:00:00Z"). */
export function utcFromNs(ns: bigint | string): string {
  const ms = BigInt(ns) / 1_000_000n;
  return new Date(Number(ms)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const TOKEN_NAMES: Record<string, string> = {
  'nep141:wrap.near': 'NEAR',
  'nep141:jambo-1679.meme-cooking.near': 'JAMBO',
};

export const tokenName = (token: string): string => TOKEN_NAMES[token] ?? token;

/** Unit of p: micro-USDC per 10^lot_exp whole tokens. */
export function priceUnit(sale: { token: string; lot_exp: number }): string {
  const name = tokenName(sale.token);
  return sale.lot_exp === 0 ? `USDC/${name}` : `USDC per ${10n ** BigInt(sale.lot_exp)} ${name}`;
}

/** JSON.stringify that writes bigints as decimal strings. */
export function stringifyJson(v: unknown, space?: number): string {
  return JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x), space);
}
