/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

// X12-03 supply: the SDK oracle pulls ~1700 modules from ~160 packages and would run them with the privileges of whoever
// runs `pnpm -r test`. It stays available (ORACLE=1) but must not load by default.
describe('the SDK oracle is opt-in', () => {
  const src = readFileSync(new URL('./payload-oracle.test.ts', import.meta.url), 'utf8');
  test('the SDK is required only when ORACLE=1', () => {
    expect(src).toMatch(/const ORACLE = process\.env\.ORACLE === '1'/);
    expect(src).toMatch(/ORACLE \? createRequire\(import\.meta\.url\)\('@defuse-protocol\/intents-sdk'\) : null/);
    expect(src.match(/createRequire\(import\.meta\.url\)/g)).toHaveLength(1);
  });
  test('its tests are skipped without it', () => {
    expect(src).toMatch(/describe\.skipIf\(!ORACLE\)\(/);
  });
});
