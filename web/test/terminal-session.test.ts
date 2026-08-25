import { describe, expect, it } from 'vitest';
import { closeMessage, terminalUrl } from '../src/terminal/session.ts';
import { relativeTime } from '../src/dom.ts';

describe('terminal URL', () => {
  it('carries the geometry so the first redraw is already the right size', () => {
    expect(
      terminalUrl('abc123', { cols: 120, rows: 40 }, { protocol: 'http:', host: 'nuc:8080' }),
    ).toBe('ws://nuc:8080/instances/abc123/terminal?cols=120&rows=40');
  });

  it('follows the page onto TLS', () => {
    expect(
      terminalUrl('abc123', { cols: 80, rows: 24 }, { protocol: 'https:', host: 'nuc' }),
    ).toBe('wss://nuc/instances/abc123/terminal?cols=80&rows=24');
  });

  it('escapes the id', () => {
    expect(terminalUrl('a/b', { cols: 1, rows: 1 }, { protocol: 'http:', host: 'h' })).toContain(
      '/instances/a%2Fb/terminal',
    );
  });
});

describe('close messages', () => {
  it('names every code the bridge can send', () => {
    expect(closeMessage(1000)).toContain('session ended');
    expect(closeMessage(4404)).toBe('no such instance');
    expect(closeMessage(4409)).toContain('no running container');
    expect(closeMessage(4500)).toContain('failed to attach');
    expect(closeMessage(4503)).toContain('Docker daemon');
    expect(closeMessage(1006)).toBe('connection lost');
  });

  it('falls back to the reason, then to the code', () => {
    expect(closeMessage(4999, 'something else')).toBe('something else');
    expect(closeMessage(4999)).toBe('connection closed with code 4999');
  });
});

describe('relative time', () => {
  const now = new Date('2026-08-25T12:00:00.000Z');

  it('counts up through the units', () => {
    expect(relativeTime('2026-08-25T11:59:30.000Z', now)).toBe('30s');
    expect(relativeTime('2026-08-25T11:45:00.000Z', now)).toBe('15m');
    expect(relativeTime('2026-08-25T09:00:00.000Z', now)).toBe('3h');
    expect(relativeTime('2026-08-23T12:00:00.000Z', now)).toBe('2d');
  });

  it('never shows a negative age for a clock that runs ahead', () => {
    expect(relativeTime('2026-08-25T12:00:05.000Z', now)).toBe('0s');
  });
});
