import { describe, expect, test } from 'vitest';
import { parseHash, titleFor } from '../router';

describe('parseHash', () => {
  test('sale id param', () => {
    expect(parseHash('#/sale/7')).toMatchObject({ path: '/sale/:id', params: { id: '7' } });
  });

  test('query string on a bid route', () => {
    const r = parseHash('#/bid/1?mode=fund');
    expect(r.path).toBe('/bid/:id');
    expect(r.params).toEqual({ id: '1' });
    expect(r.query.get('mode')).toBe('fund');
  });

  test('static routes, empty hash and trailing slash', () => {
    expect(parseHash('').path).toBe('/');
    expect(parseHash('#').path).toBe('/');
    expect(parseHash('#/').path).toBe('/');
    expect(parseHash('#/try').path).toBe('/try');
    expect(parseHash('#/keys/').path).toBe('/keys');
    expect(parseHash('#/withdraw').path).toBe('/withdraw');
    expect(parseHash('#/trust').path).toBe('/trust');
    expect(parseHash('#/sales').path).toBe('/sales');
  });

  test('home sections are a query, not a route', () => {
    const r = parseHash('#/?at=live');
    expect(r.path).toBe('/');
    expect(r.query.get('at')).toBe('live');
    expect(titleFor(parseHash('#/trust'))).toBe('Who can see your bid · Tender');
  });

  test('unknown routes and wrong arity fall through', () => {
    expect(parseHash('#/nope').path).toBe('*');
    expect(parseHash('#/sale').path).toBe('*');
    expect(parseHash('#/sale/1/extra').path).toBe('*');
    expect(parseHash('#/sale/%E0%A4%A').path).toBe('*'); // malformed percent escape
  });

  test('a second question mark stays inside the query', () => {
    expect(parseHash('#/try?a=1?b=2').query.get('a')).toBe('1?b=2');
  });
});
