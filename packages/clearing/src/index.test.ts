// Every golden vector in fixtures/clearing/*.json (shared with contract/src/clearing.rs). The directory is scanned,
// the count is not fixed.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { clear, fromFixture } from './index.js';

const dir = fileURLToPath(new URL('../../../fixtures/clearing/', import.meta.url));
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort();

describe('fixtures/clearing', () => {
  it('has at least one fixture', () => expect(files.length).toBeGreaterThan(0));
  for (const f of files) {
    it(f, () => {
      const { sale, bids, expected } = fromFixture(JSON.parse(readFileSync(dir + f, 'utf8')));
      const got = clear(sale, bids);
      for (const k of Object.keys(expected) as (keyof typeof expected)[]) {
        expect(got[k], `${f}: ${k}`).toEqual(expected[k]);
      }
    });
  }
});
