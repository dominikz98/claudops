import { describe, expect, it } from 'vitest';
import { extensionFor, pastedFileName } from '../src/upload.ts';

describe('extensionFor', () => {
  it('takes the subtype, with the two spellings nobody wants', () => {
    expect(extensionFor('image/png')).toBe('png');
    expect(extensionFor('image/jpeg')).toBe('jpg');
    expect(extensionFor('image/svg+xml')).toBe('svg');
    expect(extensionFor('text/plain;charset=utf-8')).toBe('txt');
  });

  it('falls back rather than inventing an extension', () => {
    expect(extensionFor('application/vnd.oasis.opendocument.text')).toBe('bin');
    expect(extensionFor('')).toBe('bin');
  });
});

describe('pastedFileName', () => {
  const at = new Date(2026, 7, 25, 9, 5, 3);

  it('stamps the name so a second paste is a second file', () => {
    expect(pastedFileName('image/png', at)).toBe('pasted-20260825-090503.png');
    expect(pastedFileName('image/png', new Date(2026, 7, 25, 9, 5, 4))).toBe(
      'pasted-20260825-090504.png',
    );
  });

  it('survives the sanitising the server does to it', () => {
    // Only [A-Za-z0-9._-] gets through server-side, and no leading dot.
    expect(pastedFileName('image/png', at)).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });
});
