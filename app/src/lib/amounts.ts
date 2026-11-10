import { USDC_DECIMALS } from './constants';

const U64_MAX = (1n << 64n) - 1n;

/** "3.6", 6 → 3600000n. Decimal text only, no floats; more fraction digits than `decimals` is an error, never rounded. */
export function parseUnits(text: string, decimals: number): bigint {
  const s = text.trim();
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) throw new Error('Enter a number such as 3.6');
  const [whole = '', frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`At most ${decimals} decimal places`);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/**
 * The bid price p: micro-USDC per 10^lot_exp whole tokens (C10). The user types "USDC per {10^lot_exp} token", so
 * the scaling is only a USDC conversion; `lotExp` decides the label (see `priceUnitLabel`).
 */
export function priceToP(priceText: string, _lotExp: number): bigint {
  const p = parseUnits(priceText, USDC_DECIMALS);
  if (p <= 0n) throw new Error('Price must be above zero');
  if (p > U64_MAX) throw new Error('Price is too large');
  return p;
}

/** "USDC per 1,000 JAMBO" for lot_exp 3, "USDC per NEAR" for lot_exp 0. */
export function priceUnitLabel(tokenName: string, lotExp: number): string {
  const lot = 10 ** lotExp;
  return lot === 1 ? `USDC per ${tokenName}` : `USDC per ${lot.toLocaleString('en-US')} ${tokenName}`;
}
