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
