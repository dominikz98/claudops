import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * The secrets claudops has to keep rather than pass through: a project's PAT and
 * the environment variables its instances are given.
 *
 * Instances get their tokens handed straight into the container environment and
 * nothing keeps them (knowledge/auth-token-handling.md). A project is a template
 * that outlives every instance made from it, so what it hands them has to
 * survive a restart -- and it does so encrypted, which is what keeps the
 * database file itself free of readable secrets even when it ends up in a backup
 * or on a laptop.
 */

/** AES-256-GCM: 32-byte key, 12-byte nonce, 16-byte tag. */
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Version prefix, so a future format change is recognisable instead of
 *  arriving as a decryption failure. */
const SEALED_PREFIX = 'v1:';

/**
 * What a sealed blob is for. Bound into the tag, so a value sealed for one
 * purpose does not open as another: a project variable moved into the
 * `git_token` column would fail to authenticate rather than quietly become the
 * PAT every instance clones with.
 *
 * The names are part of the stored format -- `project.git_token` is what every
 * PAT sealed before this existed was bound to, so it stays exactly that string.
 */
export type SecretScope = 'project.git_token' | 'project.env';

const DEFAULT_SCOPE: SecretScope = 'project.git_token';

function aadFor(scope: SecretScope): Buffer {
  return Buffer.from(`claudops.${scope}`);
}

export class SecretKeyMissingError extends Error {
  constructor() {
    super(
      'no CLAUDOPS_SECRET_KEY is configured -- a project PAT or variable cannot be stored without one',
    );
    this.name = 'SecretKeyMissingError';
  }
}

export class SecretUndecryptableError extends Error {
  constructor(cause?: unknown) {
    super('a stored secret does not decrypt with the current CLAUDOPS_SECRET_KEY');
    this.name = 'SecretUndecryptableError';
    if (cause !== undefined) this.cause = cause;
  }
}

export interface SecretCipher {
  /** Whether a key is configured. A caller that has no secret in hand at all
   *  never needs to ask. */
  readonly available: boolean;
  /** Encrypts for the database. Throws SecretKeyMissingError without a key. */
  seal(plain: string, scope?: SecretScope): string;
  /** The inverse, and it has to be given the same scope. Throws
   *  SecretKeyMissingError without a key and SecretUndecryptableError for
   *  anything that does not authenticate -- a wrong scope among it. */
  open(sealed: string, scope?: SecretScope): string;
}

/**
 * Accepts base64 or hex, because both are what a human pastes from
 * `openssl rand` or from `randomBytes().toString(...)`. `undefined` means the
 * value is not a 32-byte key in either encoding -- the caller turns that into
 * its own configuration error.
 */
export function parseSecretKey(raw: string): Buffer | undefined {
  const hex = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : undefined;
  const key = hex ?? Buffer.from(raw, 'base64');
  return key.length === KEY_BYTES ? key : undefined;
}

/** Handed `undefined`, every operation fails with SecretKeyMissingError. That
 *  is deliberate: a server without a key still runs, it just cannot hold a
 *  PAT, and saying so is better than storing one in the clear. */
export function createCipher(key: Buffer | undefined): SecretCipher {
  if (key === undefined) {
    return {
      available: false,
      seal(): never {
        throw new SecretKeyMissingError();
      },
      open(): never {
        throw new SecretKeyMissingError();
      },
    };
  }

  return {
    available: true,

    seal(plain: string, scope: SecretScope = DEFAULT_SCOPE): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aadFor(scope));
      const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return SEALED_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    },

    open(sealed: string, scope: SecretScope = DEFAULT_SCOPE): string {
      if (!sealed.startsWith(SEALED_PREFIX)) throw new SecretUndecryptableError();

      const blob = Buffer.from(sealed.slice(SEALED_PREFIX.length), 'base64');
      // `<`, not `<=`: a nonce and a tag with nothing after them is what an
      // empty value seals to, and an empty project variable is a legitimate
      // thing to store. Anything shorter cannot be a blob of ours at all;
      // anything this length that was not sealed here fails the tag below.
      if (blob.length < IV_BYTES + TAG_BYTES) throw new SecretUndecryptableError();

      try {
        const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, IV_BYTES));
        decipher.setAAD(aadFor(scope));
        decipher.setAuthTag(blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        return (
          decipher.update(blob.subarray(IV_BYTES + TAG_BYTES), undefined, 'utf8') +
          decipher.final('utf8')
        );
      } catch (error) {
        // A wrong key, a truncated blob and a tampered one are all the same
        // answer to the caller: this secret is not usable any more.
        throw new SecretUndecryptableError(error);
      }
    },
  };
}
