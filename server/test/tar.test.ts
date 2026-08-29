import { describe, expect, it } from 'vitest';
import {
  CONTAINER_GID,
  CONTAINER_UID,
  MalformedArchiveError,
  readFirstEntry,
  singleFileArchive,
} from '../src/docker/tar.ts';

const BLOCK = 512;
const MTIME = new Date('2026-08-25T08:00:00.000Z');

/** One header field as text, up to its terminating NUL. */
function field(archive: Uint8Array, at: number, width: number): string {
  const bytes = archive.slice(at, at + width);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.slice(0, end));
}

/** The checksum a reader computes: every header byte, with the checksum field
 *  itself counted as eight spaces. */
function checksumOf(archive: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (archive[index] ?? 0);
  }
  return sum;
}

describe('singleFileArchive', () => {
  const content = new TextEncoder().encode('hello');
  const archive = singleFileArchive('note.txt', content, { mtime: MTIME });

  it('is a header, the padded content and the end-of-archive marker', () => {
    // 512 header + 512 for five bytes of content + two zero blocks.
    expect(archive).toHaveLength(BLOCK * 4);
    expect(new TextDecoder().decode(archive.slice(BLOCK, BLOCK + content.length))).toBe('hello');
    // The padding after the content, and the marker, are zero.
    expect(archive.slice(BLOCK + content.length).every((byte) => byte === 0)).toBe(true);
  });

  it('names the entry relative to the directory it is extracted into', () => {
    expect(field(archive, 0, 100)).toBe('note.txt');
    // A leading slash would make the entry absolute and Docker would refuse it.
    expect(field(archive, 0, 100).startsWith('/')).toBe(false);
  });

  it('writes the numbers as NUL-terminated octal', () => {
    expect(field(archive, 100, 8)).toBe('0000644');
    expect(field(archive, 124, 12)).toBe('00000000005');
    expect(field(archive, 136, 12)).toBe(Math.floor(MTIME.getTime() / 1000).toString(8).padStart(11, '0'));
    // A regular file, not a directory or a link.
    expect(field(archive, 156, 1)).toBe('0');
    expect(field(archive, 257, 8)).toBe('ustar');
  });

  it('gives the file to the container user, not to root', () => {
    // Extraction runs as root and takes the ids from the header, so a 0 here is
    // a file the agent does not own
    // (knowledge/putarchive-writes-the-uid-from-the-tar-header.md).
    expect(field(archive, 108, 8)).toBe(CONTAINER_UID.toString(8).padStart(7, '0'));
    expect(field(archive, 116, 8)).toBe(CONTAINER_GID.toString(8).padStart(7, '0'));
    expect(field(archive, 265, 32)).toBe('claude');
    expect(field(archive, 297, 32)).toBe('claude');
  });

  it('signs the header the way a reader verifies it', () => {
    expect(Number.parseInt(field(archive, 148, 8).trim(), 8)).toBe(checksumOf(archive));
  });

  it('pads a content length that is already a multiple of the block size', () => {
    const exact = singleFileArchive('big.bin', new Uint8Array(BLOCK), { mtime: MTIME });
    // No third block of padding: 512 bytes fill one block exactly.
    expect(exact).toHaveLength(BLOCK * 4);
  });

  it('handles an empty file', () => {
    const empty = singleFileArchive('empty.txt', new Uint8Array(0), { mtime: MTIME });
    expect(empty).toHaveLength(BLOCK * 3);
    expect(field(empty, 124, 12)).toBe('00000000000');
  });

  it('refuses a name that does not fit the header rather than truncating it', () => {
    expect(() => singleFileArchive('x'.repeat(100), new Uint8Array(0))).toThrow(RangeError);
  });
});

/** The archive as a stream, in pieces -- what a socket hands over, and what
 *  the reader has to survive: a header split across two chunks is the normal
 *  case, not the odd one. */
function* inChunks(archive: Uint8Array, size: number): Generator<Uint8Array> {
  for (let at = 0; at < archive.length; at += size) {
    yield archive.slice(at, at + size);
  }
}

/** A tar entry of a type this module never writes -- typeflag `5` is a
 *  directory, which is what `getArchive` of a folder starts with. */
function directoryArchive(name: string): Uint8Array {
  const archive = singleFileArchive(name, new Uint8Array(0));
  archive[156] = '5'.charCodeAt(0);
  return archive;
}

describe('readFirstEntry', () => {
  const content = new TextEncoder().encode('# Report\n\nAll green.\n');
  const archive = singleFileArchive('report.md', content);

  it('reads the entry back out of what singleFileArchive wrote', async () => {
    const entry = await readFirstEntry(inChunks(archive, archive.length), 1024);

    expect(entry).toEqual({
      kind: 'file',
      name: 'report.md',
      size: content.length,
      content,
    });
  });

  it('does not care where the chunk boundaries fall', async () => {
    // 100 bytes puts a boundary inside the header, inside the content and
    // inside the padding -- all three at once.
    for (const size of [1, 7, 100, 512, 513]) {
      const entry = await readFirstEntry(inChunks(archive, size), 1024);
      expect(entry.kind, `chunks of ${String(size)}`).toBe('file');
      expect(entry.kind === 'file' && entry.content).toEqual(content);
    }
  });

  it('refuses an oversized entry from its header, before its body', async () => {
    const big = singleFileArchive('heap.bin', new Uint8Array(4096));
    let delivered = 0;

    const counted = function* (): Generator<Uint8Array> {
      for (const chunk of inChunks(big, 512)) {
        delivered += chunk.length;
        yield chunk;
      }
    };

    expect(await readFirstEntry(counted(), 1024)).toEqual({
      kind: 'too-large',
      name: 'heap.bin',
      size: 4096,
    });
    // The header and nothing else: this is what keeps a heap dump out of the
    // server's memory.
    expect(delivered).toBe(512);
  });

  it('says a directory is not a file rather than reading it', async () => {
    expect(await readFirstEntry(inChunks(directoryArchive('src'), 512), 1024)).toEqual({
      kind: 'other',
      name: 'src',
      typeflag: '5',
    });
  });

  it('reports an archive that holds nothing', async () => {
    expect(await readFirstEntry(inChunks(new Uint8Array(1024), 512), 1024)).toEqual({
      kind: 'empty',
    });
    expect(await readFirstEntry(inChunks(new Uint8Array(0), 512), 1024)).toEqual({ kind: 'empty' });
  });

  it('refuses a stream that is not a tar, and one that ends mid-entry', async () => {
    const notTar = new Uint8Array(512).fill(0x41);
    await expect(readFirstEntry(inChunks(notTar, 512), 1024)).rejects.toThrow(
      MalformedArchiveError,
    );

    // The header promises more content than the stream carries.
    const truncated = archive.slice(0, 512 + 4);
    await expect(readFirstEntry(inChunks(truncated, 512), 1024)).rejects.toThrow(
      MalformedArchiveError,
    );
  });

  it('takes an entry of exactly the limit', async () => {
    const exact = singleFileArchive('edge.txt', new Uint8Array(1024).fill(0x61));
    expect((await readFirstEntry(inChunks(exact, 512), 1024)).kind).toBe('file');
  });
});
