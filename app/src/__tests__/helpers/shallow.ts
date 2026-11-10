import type { ReactElement, ReactNode } from 'react';

// A shallow renderer for tests without a DOM. Hooks keep their values in one slot list (all hook calls of the one
// component under test, in order), effects do not run, and the element tree the component returns is searched for the
// buttons and child components to "click". Used through `vi.mock('react', ...)`; see wizard-flow.test.tsx.

export const rt = { slots: [] as unknown[], i: 0, effects: [] as (() => void | (() => void))[] };

/** Runs the effects of the latest render (they are collected, not run, while rendering). */
export const runEffects = () => rt.effects.splice(0).map((fn) => fn());

export const shallowHooks = {
  useState: (init: unknown) => {
    const k = rt.i++;
    if (!(k in rt.slots)) rt.slots[k] = typeof init === 'function' ? (init as () => unknown)() : init;
    return [rt.slots[k], (v: unknown) => void (rt.slots[k] = typeof v === 'function' ? (v as (s: unknown) => unknown)(rt.slots[k]) : v)];
  },
  useRef: (init: unknown) => {
    const k = rt.i++;
    if (!(k in rt.slots)) rt.slots[k] = { current: init };
    return rt.slots[k];
  },
  useMemo: (f: () => unknown) => f(),
  useEffect: (fn: () => void | (() => void)) => void rt.effects.push(fn),
  useCallback: (f: unknown) => f,
};

/** Every element in the tree, depth first. */
export function* walk(node: ReactNode): Generator<ReactElement> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (node && typeof node === 'object' && 'props' in node) {
    yield node as ReactElement;
    yield* walk((node as ReactElement<{ children?: ReactNode }>).props.children);
  }
}

export const textOf = (node: ReactNode): string =>
  Array.isArray(node)
    ? node.map(textOf).join('')
    : typeof node === 'string' || typeof node === 'number'
      ? String(node)
      : node && typeof node === 'object' && 'props' in node
        ? textOf((node as ReactElement<{ children?: ReactNode }>).props.children)
        : '';

export const settle = () => new Promise((r) => setTimeout(r, 0));
