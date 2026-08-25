import { describe, expect, it } from 'vitest';
import { parseRoute, routeHash } from '../src/router.ts';

describe('hash routes', () => {
  it('reads a console route', () => {
    expect(parseRoute('#/i/abc123')).toEqual({ view: 'console', id: 'abc123' });
  });

  it('falls back to the list for anything else', () => {
    for (const hash of ['', '#', '#/', '#/nope', '#/i/', 'garbage']) {
      expect(parseRoute(hash)).toEqual({ view: 'list' });
    }
  });

  it('round-trips an id that needs escaping', () => {
    const route = { view: 'console', id: 'a/b c' } as const;

    expect(routeHash(route)).toBe('#/i/a%2Fb%20c');
    expect(parseRoute(routeHash(route))).toEqual(route);
  });

  it('points the list at a hash rather than at the API path', () => {
    expect(routeHash({ view: 'list' })).toBe('#/');
  });
});
