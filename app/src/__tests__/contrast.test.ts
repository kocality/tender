/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

// WCAG AA (4.5:1 for text) over the colour tokens of styles.css, light and dark. Parsed from the stylesheet itself so a
// changed token that breaks contrast fails here.
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]!] = m[2]!;
  return out;
}

function blockAfter(marker: string): string {
  const start = css.indexOf(marker);
  if (start === -1) throw new Error(`styles.css has no ${marker}`);
  const open = css.indexOf('{', start);
  return css.slice(open, css.indexOf('}', open));
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

// [text token, background token]
const PAIRS: [string, string][] = [
  ['text', 'bg'],
  ['text', 'surface'],
  ['text', 'surface-2'],
  ['muted', 'bg'],
  ['muted', 'surface'],
  ['muted', 'surface-2'],
  ['accent', 'bg'],
  ['accent', 'surface'],
  ['accent-text', 'accent'],
  ['ok', 'ok-bg'],
  ['ok', 'surface'],
  ['warn', 'warn-bg'],
  ['bad', 'bad-bg'],
  ['bad', 'surface'],
  ['text', 'bad-bg'],
];

describe('colour contrast', () => {
  const themes: Record<string, Record<string, string>> = {
    light: tokens(blockAfter(':root {')),
    'dark (system)': tokens(blockAfter(":root:not([data-theme='light']) {")),
    'dark (forced)': tokens(blockAfter(":root[data-theme='dark'] {")),
  };

  test('the two dark blocks carry the same tokens', () => {
    expect(themes['dark (system)']).toEqual(themes['dark (forced)']);
  });

  for (const [name, t] of Object.entries(themes)) {
    test(`${name}: every text pair reaches 4.5:1`, () => {
      expect(Object.keys(t).length).toBeGreaterThanOrEqual(14); // the parser found the whole token block
      const low = PAIRS.map(([fg, bg]) => ({ fg, bg, r: ratio(t[fg]!, t[bg]!) })).filter((x) => x.r < 4.5);
      expect(low).toEqual([]);
    });
  }
});

describe('stylesheet rules the polish card needs', () => {
  test('record mode hides debug panels and sets the 18 px root font', () => {
    expect(css).toMatch(/:root\[data-rec='1'\] \.debug-only\s*\{\s*display: none !important;/);
    expect(css).toMatch(/:root\[data-rec='1'\],\s*:root\[data-rec='1'\] body\s*\{\s*font-size: 18px;/);
  });

  test('reduced motion switches animation off and focus rings exist', () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*animation: none !important/);
    expect(css).toMatch(/button:focus-visible,[\s\S]*outline: 2px solid var\(--accent\)/);
  });
});
