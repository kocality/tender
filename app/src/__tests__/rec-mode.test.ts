import { describe, expect, test } from 'vitest';
import { applyRec, recFromUrl, resolveRec } from '../lib/recMode';

function memoryStore(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    dump: () => Object.fromEntries(m),
  };
}

describe('recFromUrl', () => {
  test('hash query, plain query, off switch and silence', () => {
    expect(recFromUrl('#/?rec=1')).toBe(true);
    expect(recFromUrl('#/sale/1?x=2&rec=1')).toBe(true);
    expect(recFromUrl('#/', '?rec=1')).toBe(true);
    expect(recFromUrl('#/?rec=0')).toBe(false);
    expect(recFromUrl('#/')).toBeNull();
    expect(recFromUrl('#/?rec=yes')).toBeNull();
  });
});

describe('resolveRec', () => {
  test('rec=1 turns it on and remembers; later routes without the query stay in record mode', () => {
    const store = memoryStore();
    expect(resolveRec('#/?rec=1', '', store)).toBe(true);
    expect(store.dump()).toEqual({ 'tender:rec': '1' });
    expect(resolveRec('#/sale/1', '', store)).toBe(true);
  });

  test('rec=0 turns it off and forgets', () => {
    const store = memoryStore({ 'tender:rec': '1' });
    expect(resolveRec('#/?rec=0', '', store)).toBe(false);
    expect(store.dump()).toEqual({});
    expect(resolveRec('#/', '', store)).toBe(false);
  });

  test('storage that throws or is missing never breaks the page', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(resolveRec('#/?rec=1', '', broken)).toBe(true);
    expect(resolveRec('#/', '', broken)).toBe(false);
    expect(resolveRec('#/?rec=1', '', null)).toBe(true);
    expect(resolveRec('#/', '', null)).toBe(false);
  });
});

describe('applyRec', () => {
  test('sets the light theme and the rec flag, and clears them again', () => {
    const root = { dataset: {} as Record<string, string | undefined> } as unknown as HTMLElement;
    applyRec(true, root);
    expect(root.dataset).toMatchObject({ rec: '1', theme: 'light' });
    applyRec(false, root);
    expect(root.dataset.rec).toBeUndefined();
    expect(root.dataset.theme).toBeUndefined();
  });
});
