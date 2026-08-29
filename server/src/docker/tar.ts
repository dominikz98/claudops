/**
 * The one archive format Docker's `putArchive` takes, written by hand for the
 * one shape claudops needs: a single regular file.
 *
 * A dependency would buy nothing here. `tar-stream` lies under dockerode as a
 * transitive of `tar-fs`, so using it would mean declaring it plus its
 * `@types` package -- for sixty lines that never grow, because nothing in this
 * server ever writes a second entry into one archive.
 *
 * USTAR, as POSIX defines it: one 512-byte header, the content padded to a
 * multiple of 512, and two zero blocks to end the stream.
 */

const BLOCK = 512;

/** Where each field this writes starts, and how wide it is. */
const NAME = { at: 0, width: 100 };
const MODE = { at: 100, width: 8 };
const UID = { at: 108, width: 8 };
const GID = { at: 116, width: 8 };
const SIZE = { at: 124, width: 12 };
const MTIME = { at: 136, width: 12 };
const CHECKSUM = { at: 148, width: 8 };
const TYPEFLAG = { at: 156, width: 1 };
const MAGIC = { at: 257, width: 8 };
const UNAME = { at: 265, width: 32 };
const GNAME = { at: 297, width: 32 };

/** A regular file. The only type this writes. */
const REGULAR_FILE = '0';

/**
 * The container user, not root. `putArchive` creates the file with exactly the
 * ids in the header, and extraction runs as root -- so a header left at 0
 * hands the agent a file it does not own
 * (knowledge/putarchive-writes-the-uid-from-the-tar-header.md).
 */
export const CONTAINER_UID = 1001;
export const CONTAINER_GID = 1001;
export const CONTAINER_USER = 'claude';

export interface TarEntryOptions {
  uid?: number;
  gid?: number;
  /** Permission bits, e.g. 0o644. */
  mode?: number;
  /** Modification time written into the header. Whole seconds -- tar has no
   *  finer resolution. */
  mtime?: Date;
}

/**
 * Numbers are octal in tar, zero-padded and NUL-terminated: an 8-byte field
 * carries seven digits, a 12-byte one eleven.
 */
function writeOctal(header: Uint8Array, field: { at: number; width: number }, value: number): void {
  const digits = value.toString(8).padStart(field.width - 1, '0');
  writeAscii(header, field, `${digits}\0`);
}

function writeAscii(
  header: Uint8Array,
  field: { at: number; width: number },
  value: string,
): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > field.width) {
    throw new RangeError(`'${value}' does not fit into ${String(field.width)} bytes`);
  }
  header.set(bytes, field.at);
}

/**
 * The sum of every header byte, with the checksum field itself read as eight
 * spaces. Written back as six octal digits, a NUL and a space -- the odd
 * ending is what the format prescribes, not a typo.
 */
function sign(header: Uint8Array): void {
  header.fill(0x20, CHECKSUM.at, CHECKSUM.at + CHECKSUM.width);

  let sum = 0;
  for (const byte of header) sum += byte;

  writeAscii(header, CHECKSUM, `${sum.toString(8).padStart(6, '0')}\0 `);
}

/**
 * One file as a complete tar stream, ready to hand to `putArchive`.
 *
 * `name` is the path *inside* the archive and therefore relative to the
 * directory the extraction targets -- a leading slash would make the entry
 * absolute and Docker would refuse it.
 */
export function singleFileArchive(
  name: string,
  content: Uint8Array,
  options: TarEntryOptions = {},
): Uint8Array {
  const {
    uid = CONTAINER_UID,
    gid = CONTAINER_GID,
    mode = 0o644,
    mtime = new Date(),
  } = options;

  const header = new Uint8Array(BLOCK);
  // Throws for a name over 99 bytes rather than silently truncating it: the
  // caller's sanitiser caps the length, and a truncated name would be a file
  // nobody finds again.
  writeAscii(header, { at: NAME.at, width: NAME.width - 1 }, name);
  writeOctal(header, MODE, mode);
  writeOctal(header, UID, uid);
  writeOctal(header, GID, gid);
  writeOctal(header, SIZE, content.length);
  writeOctal(header, MTIME, Math.floor(mtime.getTime() / 1000));
  writeAscii(header, TYPEFLAG, REGULAR_FILE);
  // "ustar\0" plus version "00", which is one field as far as the layout goes.
  writeAscii(header, MAGIC, 'ustar\0' + '00');
  writeAscii(header, UNAME, CONTAINER_USER);
  writeAscii(header, GNAME, CONTAINER_USER);
  sign(header);

  const padded = Math.ceil(content.length / BLOCK) * BLOCK;
  // Two zero blocks are the end-of-archive marker.
  const archive = new Uint8Array(BLOCK + padded + 2 * BLOCK);
  archive.set(header, 0);
  archive.set(content, BLOCK);

  return archive;
}

/* ------------------------------------------------------------------ reading */

/**
 * The other direction: what `getArchive` hands back.
 *
 * Docker answers a read of one path with a tar stream, so a file that has to
 * reach the browser has to come out of one. Only the first entry is ever
 * looked at -- claudops asks for a single path, and a directory is refused
 * before the request goes out rather than assembled from its entries here.
 */

/** The second spelling of "regular file". `singleFileArchive` writes `0`, but
 *  a reader meets `\0` too -- older writers use it, and Docker's tar of a file
 *  is not written by this module. */
const TYPEFLAG_ALTERNATIVE_REGULAR = '\0';

/** What one read of an archive produced. A union rather than four throws: the
 *  three refusals are ordinary answers about a path, and their HTTP codes are
 *  the caller's decision, not this module's. */
export type ArchiveRead =
  | { kind: 'file'; name: string; size: number; content: Uint8Array }
  /** The header says the entry is bigger than the caller allows. Decided from
   *  the header, so the body is never read -- which is the whole point of
   *  parsing the stream rather than buffering it. */
  | { kind: 'too-large'; name: string; size: number }
  /** A directory, a symlink, a device: an entry that is not bytes. */
  | { kind: 'other'; name: string; typeflag: string }
  /** The archive held nothing -- two zero blocks and no entry. */
  | { kind: 'empty' };

/** The stream is not a tar. A daemon that answers something else is a bug or a
 *  proxy in the way, not a state a caller can do anything about. */
export class MalformedArchiveError extends Error {
  constructor(detail: string) {
    super(`the archive could not be read: ${detail}`);
    this.name = 'MalformedArchiveError';
  }
}

/** A field as text, up to its first NUL or space. Tar pads with either. */
function readAscii(header: Uint8Array, field: { at: number; width: number }): string {
  const bytes = header.subarray(field.at, field.at + field.width);
  let end = bytes.length;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte === 0 || byte === 0x20) {
      end = index;
      break;
    }
  }
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/**
 * A size field as a number.
 *
 * Octal, except when it is not: tar encodes a size that does not fit into
 * eleven digits in base 256, marked by the high bit of the first byte. Nothing
 * that small a field cannot hold is ever going to pass a size limit, so such an
 * entry is reported as the largest safe integer rather than decoded.
 */
function readSize(header: Uint8Array): number {
  const first = header[SIZE.at] ?? 0;
  if ((first & 0x80) !== 0) return Number.MAX_SAFE_INTEGER;

  const digits = readAscii(header, SIZE);
  const value = Number.parseInt(digits, 8);
  if (!Number.isFinite(value) || value < 0) {
    throw new MalformedArchiveError(`'${digits}' is not a size`);
  }
  return value;
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

/**
 * The first entry of a tar stream, refusing one the header says is over
 * `maxBytes` before its body is read.
 *
 * `source` is consumed only as far as the entry needs. The caller closes it --
 * for an oversized file that is what keeps a gigabyte in the container instead
 * of in the server's heap.
 */
export async function readFirstEntry(
  // Both, because `for await` takes both: the engine hands over a socket, a
  // test hands over the chunks it wants the boundaries to fall on.
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  maxBytes: number,
): Promise<ArchiveRead> {
  const chunks: Uint8Array[] = [];
  let held = 0;
  let header: Uint8Array | undefined;
  let name = '';
  let size = 0;

  const joined = (): Uint8Array => {
    if (chunks.length > 1) {
      const all = new Uint8Array(held);
      let at = 0;
      for (const chunk of chunks) {
        all.set(chunk, at);
        at += chunk.length;
      }
      chunks.length = 0;
      chunks.push(all);
    }
    return chunks[0] ?? new Uint8Array(0);
  };

  for await (const chunk of source) {
    chunks.push(chunk);
    held += chunk.length;

    if (header === undefined) {
      if (held < BLOCK) continue;

      header = joined().subarray(0, BLOCK);
      if (isZeroBlock(header)) return { kind: 'empty' };
      if (readAscii(header, MAGIC) !== 'ustar') {
        throw new MalformedArchiveError('no ustar magic in the first block');
      }

      name = readAscii(header, { at: NAME.at, width: NAME.width });
      const typeflag = readAscii(header, TYPEFLAG);
      if (typeflag !== REGULAR_FILE && typeflag !== TYPEFLAG_ALTERNATIVE_REGULAR) {
        return { kind: 'other', name, typeflag };
      }

      size = readSize(header);
      // Before the body: the caller destroys the stream on this answer, so the
      // rest of an oversized file is never transferred at all.
      if (size > maxBytes) return { kind: 'too-large', name, size };
    }

    if (held >= BLOCK + size) {
      return { kind: 'file', name, size, content: joined().slice(BLOCK, BLOCK + size) };
    }
  }

  if (header === undefined) return { kind: 'empty' };
  throw new MalformedArchiveError(
    `the entry claims ${String(size)} bytes and the stream ended after ${String(held - BLOCK)}`,
  );
}
