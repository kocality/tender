import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { rt, runEffects } from './helpers/shallow';

// The App shell driven without a DOM through the shallow renderer in helpers/shallow.ts.
vi.mock('react', async (orig) => {
  const actual = await orig<typeof import('react')>();
  const { shallowHooks } = await import('./helpers/shallow');
  return { ...actual, default: actual, ...shallowHooks };
});

import { App } from '../App';

const listeners: Record<string, () => void> = {};
const focused: string[] = [];
const doc = { title: '', querySelector: (sel: string) => ({ focus: () => void focused.push(sel) }) };
const win = {
  location: { hash: '#/' },
  addEventListener: (type: string, fn: () => void) => void (listeners[type] = fn),
  removeEventListener: () => {},
};
const render = () => {
  rt.i = 0;
  rt.effects = [];
  return App();
};

beforeEach(() => {
  rt.slots = [];
  focused.length = 0;
  doc.title = '';
  win.location.hash = '#/';
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
});
afterEach(() => vi.unstubAllGlobals());

describe('route changes (X12A-07)', () => {
  test('the title names the page, and navigation moves focus to the page (not on the first load)', () => {
    render();
    runEffects();
    expect(doc.title).toBe('Sealed token sales · Tender');
    expect(focused).toEqual([]);
    win.location.hash = '#/bid/2';
    listeners.hashchange!();
    render();
    runEffects();
    expect(doc.title).toBe('Bid on sale #2 · Tender');
    expect(focused).toEqual(['main']);
  });
});
