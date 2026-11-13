import type { MouseEvent } from 'react';

/** Focus is still where a section link or a fresh load left it: on the page, on `main`, or on a section link. */
function focusIsFree(): boolean {
  const a = document.activeElement as (Element & { tagName?: string; getAttribute?: (n: string) => string | null }) | null;
  if (!a || a === document.body || a.tagName === 'MAIN') return true;
  return a.tagName === 'A' && /^#\/\?at=[a-z]+$/.test(a.getAttribute?.('href') ?? '');
}

/**
 * Scrolls a home-page section into view, smoothly unless the visitor asked for reduced motion, and moves keyboard and
 * screen-reader focus to its heading. A later call (the sales loaded and moved the layout) only scrolls when the visitor
 * has meanwhile moved focus elsewhere.
 */
export function scrollToSection(id: string): void {
  const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const section = document.getElementById(id);
  section?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  const headingId = section?.getAttribute('aria-labelledby');
  const heading = headingId ? document.getElementById(headingId) : null;
  if (!heading || document.activeElement === heading || !focusIsFree()) return;
  heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
}

/** A link to a home section (`#/?at=how`) that is already the current hash fires no hashchange, so it would do nothing: scroll by hand. */
export function onSectionLinkClick(e: MouseEvent<HTMLAnchorElement>): void {
  const href = e.currentTarget.getAttribute('href') ?? '';
  const m = /^#\/\?at=([a-z]+)$/.exec(href);
  if (!m || window.location.hash !== href) return;
  e.preventDefault();
  scrollToSection(m[1]!);
}
