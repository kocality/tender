import { afterEach, describe, expect, test, vi } from 'vitest';
import { onSectionLinkClick, scrollToSection } from '../lib/sections';

// A home section link (`#/?at=how`) moves keyboard and screen-reader focus to the section heading, not only the scroll
// position, so the next Tab and the reader both continue from there.

interface FakeEl {
  id: string;
  tagName: string;
  tabIndex: number;
  attrs: Record<string, string>;
  scrolled: number;
  focusedWith: unknown[];
  heading?: FakeEl;
  getAttribute(n: string): string | null;
  setAttribute(n: string, v: string): void;
  scrollIntoView(): void;
  focus(o?: unknown): void;
  querySelector(sel: string): FakeEl | null;
}
const el = (id: string, tagName: string, attrs: Record<string, string> = {}): FakeEl => ({
  id,
  tagName,
  tabIndex: -1,
  attrs,
  scrolled: 0,
  focusedWith: [],
  getAttribute(n) {
    return this.attrs[n] ?? null;
  },
  setAttribute(n, v) {
    this.attrs[n] = v;
  },
  scrollIntoView() {
    this.scrolled++;
  },
  focus(o) {
    this.focusedWith.push(o);
    doc.activeElement = this;
  },
  querySelector() {
    return this.heading ?? null;
  },
});

let doc: { activeElement: unknown; body: unknown; getElementById: (id: string) => FakeEl | null };
let section: FakeEl;
let heading: FakeEl;
const link = el('', 'A', { href: '#/?at=how' });

function setup(active: 'body' | 'link' | 'other') {
  heading = el('how-title', 'H2');
  section = el('how', 'SECTION', { 'aria-labelledby': 'how-title' });
  section.heading = heading;
  const body = { tagName: 'BODY' };
  const other = { tagName: 'INPUT', matches: () => false };
  const byId: Record<string, FakeEl> = { how: section, 'how-title': heading };
  doc = { activeElement: active === 'body' ? body : active === 'link' ? link : other, body, getElementById: (id) => byId[id] ?? null };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { matchMedia: () => ({ matches: true }), location: { hash: '#/?at=how' } });
}
afterEach(() => vi.unstubAllGlobals());

describe('section links move focus to the section heading', () => {
  test('after a section link, the heading gets focus (without a second scroll) and becomes focusable by script only', () => {
    setup('link');
    scrollToSection('how');
    expect(section.scrolled).toBe(1);
    expect(doc.activeElement).toBe(heading);
    expect(heading.focusedWith).toEqual([{ preventScroll: true }]);
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });

  test('a deep link on first load (focus still on the page) lands on the heading too', () => {
    setup('body');
    scrollToSection('how');
    expect(doc.activeElement).toBe(heading);
  });

  test('a later re-scroll (the sales loaded) never takes focus from a control the visitor moved to', () => {
    setup('other');
    scrollToSection('how');
    expect(section.scrolled).toBe(1);
    expect(heading.focusedWith).toEqual([]);
  });

  test('clicking the link of the section already in the address scrolls and focuses by hand', () => {
    setup('link');
    let prevented = false;
    onSectionLinkClick({ currentTarget: link, preventDefault: () => void (prevented = true) } as never);
    expect(prevented).toBe(true);
    expect(doc.activeElement).toBe(heading);
  });
});
