import { useEffect, useState } from 'react';

export type RoutePattern = '/' | '/sale/:id' | '/bid/:id' | '/try' | '/keys' | '/withdraw';

export interface Route {
  /** Matched pattern, or `*` when nothing matches. */
  path: RoutePattern | '*';
  params: Record<string, string>;
  query: URLSearchParams;
}

const PATTERNS: RoutePattern[] = ['/', '/sale/:id', '/bid/:id', '/try', '/keys', '/withdraw'];

/** `#/sale/7?x=1` → `{path: '/sale/:id', params: {id: '7'}, query: x=1}`. Pure, so it can be tested without a DOM. */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const q = raw.indexOf('?');
  const pathPart = q === -1 ? raw : raw.slice(0, q);
  const queryPart = q === -1 ? '' : raw.slice(q + 1);
  const query = new URLSearchParams(queryPart);
  const segs = pathPart.split('/').filter((s) => s !== '');
  for (const pattern of PATTERNS) {
    const pSegs = pattern.split('/').filter((s) => s !== '');
    if (pSegs.length !== segs.length) continue;
    const params: Record<string, string> = {};
    const ok = pSegs.every((ps, i) => {
      const seg = segs[i]!;
      if (ps.startsWith(':')) {
        try {
          params[ps.slice(1)] = decodeURIComponent(seg);
        } catch {
          return false;
        }
        return true;
      }
      return ps === seg;
    });
    if (ok) return { path: pattern, params, query };
  }
  return { path: '*', params: {}, query };
}

export function useHashRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return parseHash(hash);
}
