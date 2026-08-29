import { describe, expect, it } from 'vitest';
import { formatSize, shortenPath } from '../src/views/files.ts';

describe('shortenPath', () => {
  it('leaves a path that fits alone', () => {
    expect(shortenPath('/workspace/repo/README.md')).toBe('/workspace/repo/README.md');
  });

  it('cuts from the left at a separator, keeping the end', () => {
    const long = '/workspace/repo/packages/server/src/instances/service.test.ts';
    const short = shortenPath(long, 30);

    // The end of a path is the half worth seeing, and the cut is a whole
    // segment rather than a character count.
    expect(short.startsWith('…/')).toBe(true);
    expect(short.length).toBeLessThanOrEqual(32);
    expect(long.endsWith(short.slice(2))).toBe(true);
    expect(short).toContain('service.test.ts');
  });

  it('cuts a single oversized segment where there is no separator', () => {
    const short = shortenPath(`/workspace/${'a'.repeat(80)}.log`, 20);
    expect(short.startsWith('…/')).toBe(true);
    expect(short.length).toBeLessThanOrEqual(22);
  });
});

describe('formatSize', () => {
  it('counts in binary units, like every size the server prints', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(999)).toBe('999 B');
    expect(formatSize(1024)).toBe('1.0 KiB');
    expect(formatSize(3_000_000)).toBe('2.9 MiB');
    expect(formatSize(20 * 1024 * 1024)).toBe('20 MiB');
  });
});
