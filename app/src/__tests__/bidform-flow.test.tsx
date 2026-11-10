import type { ReactElement } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import sale1 from '../__fixtures__/views/sale-1-keyed.json';
import { rt, textOf, walk } from './helpers/shallow';

// The bid form driven without a DOM through the shallow renderer in helpers/shallow.ts.
vi.mock('react', async (orig) => {
  const actual = await orig<typeof import('react')>();
  const { shallowHooks } = await import('./helpers/shallow');
  return { ...actual, default: actual, ...shallowHooks };
});

import { BidForm } from '../components/BidForm';
import { parseSale } from '../lib/views';

const NS = 1_000_000_000n;
const NOW = 1_800_000_000n * NS;
const sale = { ...parseSale(sale1), state: 'Open' as const, key: null, reserve: 3_000_000n, closeNs: NOW + 3600n * NS };
const onSubmit = vi.fn();
const focus = { price: vi.fn(), size: vi.fn(), escrow: vi.fn() };

const render = (): ReactElement => {
  rt.i = 0;
  return BidForm({ sale, nowNs: NOW, disabled: false, onSubmit }) as ReactElement;
};
const input = (id: string) => [...walk(render())].find((e) => e.type === 'input' && (e.props as { id?: string }).id === id)!;
const type = (id: string, value: string) => (input(id).props as { onChange: (ev: unknown) => void }).onChange({ target: { value } });
const submit = () => [...walk(render())].find((e) => e.type === 'form')!.props.onSubmit({ preventDefault() {} });
const alerts = () => [...walk(render())].filter((e) => (e.props as { role?: string }).role === 'alert');

beforeEach(() => {
  rt.slots = [];
  onSubmit.mockReset();
  Object.values(focus).forEach((f) => f.mockReset());
  render(); // creates the refs; give them something to focus
  const refs = rt.slots.filter((x) => typeof x === 'object' && x !== null && 'current' in x) as { current: unknown }[];
  (['price', 'size', 'escrow'] as const).forEach((name, i) => (refs[i]!.current = { focus: focus[name] }));
});

describe('invalid input is announced and focused (X12A-05)', () => {
  test('a rejected submit focuses the first bad field and marks it invalid with its error id', () => {
    submit();
    expect(focus.price).toHaveBeenCalledTimes(1);
    expect((input('bid-price').props as Record<string, unknown>)['aria-invalid']).toBe(true);
    expect((input('bid-price').props as Record<string, unknown>)['aria-describedby']).toBe('bid-price-error');
    expect(alerts().some((a) => (a.props as { id?: string }).id === 'bid-price-error' && textOf(a).startsWith('Price'))).toBe(true);
  });
  test('submitting the same invalid input again is a new alert node, so it is announced again', () => {
    submit();
    const first = alerts().map((a) => a.key);
    submit();
    const second = alerts().map((a) => a.key);
    expect(first.length).toBeGreaterThan(0);
    expect(second).not.toEqual(first);
  });
});

describe('a warned bid is read before it goes on (QA-07)', () => {
  test('a below-reserve bid is held for a second click, the same click then submits it', () => {
    type('bid-price', '2.5'); // reserve is 3
    type('bid-size', '3');
    type('bid-escrow', '5');
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textOf(render())).toContain('Below reserve');
    expect(textOf(render())).toContain('Continue anyway');
    submit();
    expect(onSubmit).toHaveBeenCalledWith({ p: 2_500_000n, q: 3_000_000n, B: 5_000_000n });
  });
  test('a bid without warnings goes straight through', () => {
    type('bid-price', '3,6'); // decimal comma (QA-05)
    type('bid-size', '3');
    type('bid-escrow', '5');
    submit();
    expect(onSubmit).toHaveBeenCalledWith({ p: 3_600_000n, q: 3_000_000n, B: 5_000_000n });
  });
});
