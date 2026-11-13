import type { MouseEvent } from 'react';

/** Scrolls a home-page section into view, smoothly unless the visitor asked for reduced motion. */
export function scrollToSection(id: string): void {
  const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  document.getElementById(id)?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
}

/** A link to a home section (`#/?at=how`) that is already the current hash fires no hashchange, so it would do nothing: scroll by hand. */
export function onSectionLinkClick(e: MouseEvent<HTMLAnchorElement>): void {
  const href = e.currentTarget.getAttribute('href') ?? '';
  const m = /^#\/\?at=([a-z]+)$/.exec(href);
  if (!m || window.location.hash !== href) return;
  e.preventDefault();
  scrollToSection(m[1]!);
}
