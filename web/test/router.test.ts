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

  it('round-trips the projects route', () => {
    expect(parseRoute('#/projects')).toEqual({ view: 'projects' });
    expect(routeHash({ view: 'projects' })).toBe('#/projects');
  });

  it('round-trips the login route', () => {
    expect(parseRoute('#/login')).toEqual({ view: 'login' });
    expect(routeHash({ view: 'login' })).toBe('#/login');
  });

  it('does not read a near miss as the login page', () => {
    // Same reason as the projects near misses: an unrecognised hash is the list,
    // never a blank screen.
    for (const hash of ['#/log', '#/login/', '#/login?next=/']) {
      expect(parseRoute(hash)).toEqual({ view: 'list' });
    }
  });

  it('does not read a near miss as the projects page', () => {
    // `/projects` is a REST resource, so only the exact hash is a page -- and
    // anything else lands on the list rather than on a blank screen.
    for (const hash of ['#/project', '#/projects/', '#/projects?x=1']) {
      expect(parseRoute(hash)).toEqual({ view: 'list' });
    }
  });
});
