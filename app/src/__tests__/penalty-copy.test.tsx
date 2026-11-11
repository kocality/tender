/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { renderToString } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import bids1 from '../__fixtures__/views/bids-1.json';
import sale1 from '../__fixtures__/views/sale-1-keyed.json';
import sale1f from '../__fixtures__/views/sale-1-finalized.json';
import { BidForm } from '../components/BidForm';
import { ResultTable } from '../components/ResultTable';
import { RevealPanel } from '../components/RevealPanel';
import { PENALTY_RULE } from '../copy';
import { parseBid, parseResult, parseSale } from '../lib/views';

// The contract keeps the 10% of an unrevealed bid in its NEAR Intents balance and no Tender method pays it out (CRYPTO-01).
// No screen may say it goes to revealed bidders, or that no method at all can move it: intents.near's admin roles can move any Intents balance.

const keyed = parseSale(sale1);
const bids = bids1.map(parseBid);
const text = (html: string) => html.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'");
const NOW = keyed.closeNs + 60_000_000_000n;
const OLD_RULE = /revealed bidders|bidders who did|to the bidders|pro rata, never|no method can move|burned|forever/i;
const SHORT_FORM = "stays in the contract's NEAR Intents balance; no Tender method pays it to anyone, the seller included";

describe('the 10% penalty copy describes the current rule', () => {
  test('the rule names where the pool stays and who can still move it', () => {
    expect(PENALTY_RULE).toContain("stays in the contract's NEAR Intents balance");
    expect(PENALTY_RULE).toContain('No Tender method');
    expect(PENALTY_RULE).toContain('admin roles');
    expect(PENALTY_RULE).not.toMatch(OLD_RULE);
  });

  test('Reveal panel: the rule, and the note for bids that cannot be revealed', () => {
    const decrypted = { keyOk: true, rows: [{ idx: 0, status: 'invalid_ct' as const }] };
    const html = text(renderToString(<RevealPanel sale={keyed} bids={bids} decrypted={decrypted} nowNs={NOW} />));
    expect(html).toContain(PENALTY_RULE);
    expect(html).toContain(`That 10% ${SHORT_FORM}`);
    expect(html).not.toMatch(OLD_RULE);
  });

  test('Result table: the pool stays in the contract', () => {
    const result = parseResult({ p_star: '3600000', sold: '1', seller_usdc: '1', seller_tokens_back: '0', token_dust: '0', penalty_pool: '200000', block: '2', ns: '2', cancelled: false })!;
    const html = text(renderToString(<ResultTable sale={parseSale(sale1f)} bids={bids} result={result} recomputed={null} />));
    expect(html).toContain("penalty pool 0.2 USDC (stays in the contract's Intents balance; no Tender method pays it out)");
    expect(html).not.toContain('penalty share');
    expect(html).not.toMatch(OLD_RULE);
  });

  test('Bid form: 10% stays in the contract, not paid to anyone', () => {
    const open = { ...keyed, state: 'Open' as const, key: null, closeNs: NOW + 3_600_000_000_000n };
    const html = text(renderToString(<BidForm sale={open} nowNs={NOW} disabled={false} onSubmit={() => {}} />));
    expect(html).toContain(`10% ${SHORT_FORM}`);
    expect(html).not.toMatch(OLD_RULE);
  });

  test('no component or copy file still carries the old rule', () => {
    const dirs = [new URL('../components/', import.meta.url), new URL('../pages/', import.meta.url)];
    const files = [new URL('../copy.ts', import.meta.url), ...dirs.flatMap((d) => readdirSync(d).map((f) => new URL(f, d)))];
    for (const f of files) expect(readFileSync(f, 'utf8'), f.pathname).not.toMatch(OLD_RULE);
  });
});
