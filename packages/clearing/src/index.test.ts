// Every golden vector in fixtures/clearing/*.json (shared with contract/src/clearing.rs). The directory is scanned,
// the count is not fixed. Until WS1 commits that directory, the temporary test-fixtures/*.local.json copy runs instead.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { clear, fromFixture } from './index.js';

const shared = fileURLToPath(new URL('../../../fixtures/clearing/', import.meta.url));
const local = fileURLToPath(new URL('../test-fixtures/', import.meta.url));
const useShared = existsSync(shared) && readdirSync(shared).some((f) => f.endsWith('.json'));
const dir = useShared ? shared : local;
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort();

describe(useShared ? 'fixtures/clearing' : 'test-fixtures (temporary, fixtures/clearing not committed yet)', () => {
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
