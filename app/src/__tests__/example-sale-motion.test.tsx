import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { rt, runEffects } from './helpers/shallow';

// The example card's timing, driven without a DOM through the shallow renderer in helpers/shallow.ts: under reduced
// motion it schedules nothing; with motion it plays once to its last phase and stops (nothing loops).
vi.mock('react', async (orig) => {
  const actual = await orig<typeof import('react')>();
  const { shallowHooks } = await import('./helpers/shallow');
  return { ...actual, default: actual, ...shallowHooks };
});

import { ExampleSale } from '../components/ExampleSale';

const render = (props = {}) => {
  rt.i = 0;
  rt.effects = [];
  return ExampleSale(props) as ReactElement<{ className: string }>;
};

beforeEach(() => {
  rt.slots = [];
  vi.useFakeTimers();
  vi.stubGlobal('IntersectionObserver', class {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('example card timing', () => {
  test('reduced motion: the last phase at once, and no timer is ever set', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    expect(render().props.className).toContain('phase-settled');
    runEffects();
    expect(vi.getTimerCount()).toBe(0);
    expect(render().props.className).toContain('phase-settled');
  });

  test('with motion it plays once to "settled" and then holds: no timer is left', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    expect(render().props.className).toContain('phase-sealed');
    runEffects(); // no element to observe in a shallow render: it starts at once
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    vi.runAllTimers();
    expect(vi.getTimerCount()).toBe(0);
    expect(render().props.className).toContain('phase-settled');
  });

  test('the cancelled ending stops at "cancelled"', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    render({ ending: 'cancelled' });
    runEffects();
    vi.runAllTimers();
    expect(render({ ending: 'cancelled' }).props.className).toContain('phase-cancelled');
  });
});
