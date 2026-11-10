// verify report lines (V4): `PASS #3 code-hash — <detail> <link>`, then `N/M checks passed (W warnings)`.
export type Status = 'PASS' | 'WARN' | 'FAIL' | 'n/a';

export interface Check {
  n: number;
  name: string;
  status: Status;
  detail: string;
  link?: string;
}

export function formatCheck(c: Check): string {
  return `${c.status} #${c.n} ${c.name} — ${c.detail}${c.link ? ` ${c.link}` : ''}`;
}

/** M counts every check that is not n/a, N the PASS ones. */
export function summaryLine(checks: Check[]): string {
  const applicable = checks.filter((c) => c.status !== 'n/a').length;
  const passed = checks.filter((c) => c.status === 'PASS').length;
  const warnings = checks.filter((c) => c.status === 'WARN').length;
  return `${passed}/${applicable} checks passed (${warnings} warning${warnings === 1 ? '' : 's'})`;
}

export function printChecks(checks: Check[], out: (line: string) => void = (l) => console.log(l)): void {
  for (const c of checks) out(formatCheck(c));
  out(summaryLine(checks));
}

export const exitCode = (checks: Check[]): number => (checks.some((c) => c.status === 'FAIL') ? 1 : 0);
