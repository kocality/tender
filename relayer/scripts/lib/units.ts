// Amounts are never floats: decimal strings in, bigint out.

export function toUnits(dec: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error(`bad decimals: ${decimals}`);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(dec.trim());
  if (!m) throw new Error(`not a decimal amount: "${dec}"`);
  const whole = m[1] ?? "0";
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`"${dec}" has more than ${decimals} decimal places`);
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

export function fromUnits(v: bigint, decimals: number): string {
  if (v < 0n) return `-${fromUnits(-v, decimals)}`;
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function nearToYoctoStr(near: string): string {
  return toUnits(near, 24).toString();
}
