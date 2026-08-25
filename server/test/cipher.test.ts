import { describe, expect, it } from 'vitest';
import {
  createCipher,
  parseSecretKey,
  SecretKeyMissingError,
  SecretUndecryptableError,
} from '../src/secrets/cipher.ts';
import { TEST_SECRET_KEY } from './fixtures.ts';

const OTHER_KEY = Buffer.alloc(32, 0x11);
const PAT = 'ghp_averyrealisticlookingtoken';

describe('parseSecretKey', () => {
  it('accepts 32 bytes as base64 and as hex', () => {
    expect(parseSecretKey(TEST_SECRET_KEY.toString('base64'))).toEqual(TEST_SECRET_KEY);
    expect(parseSecretKey(TEST_SECRET_KEY.toString('hex'))).toEqual(TEST_SECRET_KEY);
  });

  it('rejects anything that is not 32 bytes', () => {
    expect(parseSecretKey('')).toBeUndefined();
    expect(parseSecretKey('too-short')).toBeUndefined();
    expect(parseSecretKey(Buffer.alloc(16).toString('base64'))).toBeUndefined();
    expect(parseSecretKey(Buffer.alloc(64).toString('hex'))).toBeUndefined();
  });
});

describe('SecretCipher with a key', () => {
  const cipher = createCipher(TEST_SECRET_KEY);

  it('round-trips a token', () => {
    expect(cipher.open(cipher.seal(PAT))).toBe(PAT);
    expect(cipher.available).toBe(true);
  });

  it('keeps no readable trace of the token', () => {
    const sealed = cipher.seal(PAT);

    expect(sealed).not.toContain(PAT);
    expect(sealed).not.toContain('ghp_');
    expect(sealed.startsWith('v1:')).toBe(true);
  });

  it('produces a different blob every time, so equal tokens are not comparable', () => {
    expect(cipher.seal(PAT)).not.toBe(cipher.seal(PAT));
  });

  it('round-trips multi-byte characters', () => {
    expect(cipher.open(cipher.seal('pässwörd-✓'))).toBe('pässwörd-✓');
  });

  it('refuses a blob sealed with another key', () => {
    const sealed = createCipher(OTHER_KEY).seal(PAT);

    expect(() => cipher.open(sealed)).toThrow(SecretUndecryptableError);
  });

  it('refuses a tampered blob', () => {
    const sealed = cipher.seal(PAT);
    const flipped = `${sealed.slice(0, -2)}${sealed.endsWith('A=') ? 'B=' : 'A='}`;

    expect(() => cipher.open(flipped)).toThrow(SecretUndecryptableError);
  });

  it('refuses anything without the version prefix or too short to hold a tag', () => {
    expect(() => cipher.open('plaintext')).toThrow(SecretUndecryptableError);
    expect(() => cipher.open(`v1:${Buffer.alloc(20).toString('base64')}`)).toThrow(
      SecretUndecryptableError,
    );
  });
});

describe('SecretCipher without a key', () => {
  const cipher = createCipher(undefined);

  it('reports itself unavailable and refuses both directions', () => {
    expect(cipher.available).toBe(false);
    expect(() => cipher.seal(PAT)).toThrow(SecretKeyMissingError);
    expect(() => cipher.open('v1:whatever')).toThrow(SecretKeyMissingError);
  });
});
