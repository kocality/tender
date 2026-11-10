import { describe, expect, it } from 'vitest';
import { type Check, exitCode, formatCheck, printChecks } from '../../src/lib/report.js';

describe('report', () => {
  it('V4 line format', () => {
    expect(
      formatCheck({ n: 3, name: 'code-hash', status: 'PASS', detail: 'CpGX… = sha256(contract/res/tender.wasm)', link: 'https://nearblocks.io/address/v1.tenderseal.near' }),
    ).toBe('PASS #3 code-hash — CpGX… = sha256(contract/res/tender.wasm) https://nearblocks.io/address/v1.tenderseal.near');
    expect(formatCheck({ n: 24, name: 'payouts', status: 'n/a', detail: 'sale not finalized' })).toBe('n/a #24 payouts — sale not finalized');
  });

  it('22/25 checks passed (3 warnings), n/a lines printed but not counted', () => {
    const checks: Check[] = [
      ...Array.from({ length: 22 }, (_, i) => ({ n: i + 1, name: `c${i + 1}`, status: 'PASS' as const, detail: 'ok' })),
      ...[23, 24, 25].map((n) => ({ n, name: `w${n}`, status: 'WARN' as const, detail: 'archival unavailable' })),
      { n: 26, name: 'na', status: 'n/a', detail: 'not applicable' },
    ];
    const lines: string[] = [];
    printChecks(checks, (l) => lines.push(l));
    expect(lines).toHaveLength(27);
    expect(lines.at(-1)).toBe('22/25 checks passed (3 warnings)');
    expect(exitCode(checks)).toBe(0);
    expect(exitCode([...checks, { n: 27, name: 'x', status: 'FAIL', detail: 'mismatch' }])).toBe(1);
  });

  it('singular warning', () => {
    const lines: string[] = [];
    printChecks([{ n: 1, name: 'a', status: 'WARN', detail: '' }], (l) => lines.push(l));
    expect(lines.at(-1)).toBe('0/1 checks passed (1 warning)');
  });
});
