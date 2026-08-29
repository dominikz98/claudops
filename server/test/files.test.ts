import { describe, expect, it } from 'vitest';
import {
  contentDisposition,
  contentTypeOf,
  looksLikeText,
  MAX_LISTING_ENTRIES,
  parentOf,
  parseListing,
  PathOutsideWorkspaceError,
  resolveWorkspacePath,
  scriptCommand,
  LIST_SCRIPT,
  WORKSPACE_ROOT,
} from '../src/instances/files.ts';

/** One `find -printf '%y\t%s\t%T@\t%f\0'` record. */
function record(kind: string, size: number, epoch: number, name: string): string {
  return `${kind}\t${String(size)}\t${String(epoch)}\t${name}\0`;
}

describe('resolveWorkspacePath', () => {
  it('takes a relative path as relative to the workspace', () => {
    expect(resolveWorkspacePath('repo/README.md')).toBe('/workspace/repo/README.md');
    expect(resolveWorkspacePath('./repo')).toBe('/workspace/repo');
  });

  it('answers the root for nothing at all', () => {
    expect(resolveWorkspacePath(undefined)).toBe(WORKSPACE_ROOT);
    expect(resolveWorkspacePath('')).toBe(WORKSPACE_ROOT);
  });

  it('keeps an absolute path inside the workspace', () => {
    expect(resolveWorkspacePath('/workspace/.claudops/uploads')).toBe(
      '/workspace/.claudops/uploads',
    );
    // Resolved, not refused: what it means is a path in the workspace.
    expect(resolveWorkspacePath('/workspace/repo/../notes.md')).toBe('/workspace/notes.md');
    expect(resolveWorkspacePath('/workspace/')).toBe('/workspace');
  });

  it('refuses a traversal, however it is spelled', () => {
    for (const attempt of [
      '../../etc/passwd',
      '..',
      '../',
      'repo/../../etc/shadow',
      '/etc/passwd',
      '/',
      // The prefix check has to be on the separator: this one starts with
      // '/workspace' and is a different directory.
      '/workspacex/secrets',
      '/workspace/../workspacex',
    ]) {
      expect(() => resolveWorkspacePath(attempt), attempt).toThrow(PathOutsideWorkspaceError);
    }
  });

  it('refuses a NUL, which would end the path in the container', () => {
    expect(() => resolveWorkspacePath('/workspace/ok\0/../../etc/passwd')).toThrow(
      PathOutsideWorkspaceError,
    );
  });
});

describe('parentOf', () => {
  it('stops at the workspace root', () => {
    expect(parentOf('/workspace/repo/src')).toBe('/workspace/repo');
    expect(parentOf('/workspace/repo')).toBe(WORKSPACE_ROOT);
    expect(parentOf(WORKSPACE_ROOT)).toBeNull();
  });
});

describe('scriptCommand', () => {
  it('hands the path over as an argument, never as script text', () => {
    // A directory really can be called this. If it were interpolated into the
    // script, the exec would run it.
    const hostile = '/workspace/"; touch /tmp/pwned; "';
    const command = scriptCommand(LIST_SCRIPT, hostile);

    expect(command[0]).toBe('sh');
    expect(command[1]).toBe('-c');
    expect(command[2]).toBe(LIST_SCRIPT);
    // $0, then $1 and $2.
    expect(command.slice(3)).toEqual(['sh', hostile, WORKSPACE_ROOT]);
    expect(LIST_SCRIPT).not.toContain('pwned');
  });
});

describe('parseListing', () => {
  const output =
    record('d', 4096, 1_756_000_000, 'src') +
    record('f', 12, 1_756_000_060, 'notes.md') +
    record('l', 7, 0, 'link') +
    record('d', 4096, 0, '.git') +
    record('f', 2048, 0, 'Screenshot.png');

  const listing = parseListing(output, '/workspace/repo');

  it('reports the directory it was asked about, and where up leads', () => {
    expect(listing.path).toBe('/workspace/repo');
    expect(listing.parent).toBe('/workspace');
    expect(listing.truncated).toBe(false);
  });

  it('puts directories first and then sorts by name, case aside', () => {
    // Only directories are lifted out; a symlink sorts among the files, the
    // way `ls` shows it.
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      '.git',
      'src',
      'link',
      'notes.md',
      'Screenshot.png',
    ]);
  });

  it('joins every entry onto the directory, so the browser never has to', () => {
    expect(listing.entries.find((entry) => entry.name === 'notes.md')).toMatchObject({
      path: '/workspace/repo/notes.md',
      kind: 'file',
      size: 12,
      modifiedAt: new Date(1_756_000_060_000).toISOString(),
    });
  });

  it('reports a symlink as neither a file nor a directory', () => {
    // `other` is what keeps it out of both halves of the panel: what it points
    // at is decided in the container, not here.
    expect(listing.entries.find((entry) => entry.name === 'link')?.kind).toBe('other');
  });

  it('survives a tab and a newline in a name', () => {
    // The name is everything after the third tab, and NUL is the one byte a
    // filename cannot hold -- which is why it is the separator.
    const awkward = parseListing(record('f', 1, 0, 'two\tparts\nand a line'), '/workspace');
    expect(awkward.entries).toHaveLength(1);
    expect(awkward.entries[0]?.name).toBe('two\tparts\nand a line');
  });

  it('cuts the listing at the limit and says so', () => {
    const many = Array.from({ length: MAX_LISTING_ENTRIES + 1 }, (_value, index) =>
      record('f', 0, 0, `file-${String(index).padStart(4, '0')}`),
    ).join('');

    const big = parseListing(many, '/workspace');
    expect(big.entries).toHaveLength(MAX_LISTING_ENTRIES);
    expect(big.truncated).toBe(true);
  });

  it('is empty for an empty directory rather than one blank entry', () => {
    expect(parseListing('', '/workspace').entries).toEqual([]);
  });
});

describe('looksLikeText', () => {
  it('takes valid UTF-8 without a NUL', () => {
    expect(looksLikeText(new TextEncoder().encode('# Bericht über den Lauf'))).toBe(true);
    expect(looksLikeText(new Uint8Array(0))).toBe(true);
  });

  it('refuses a PNG and anything else that is not UTF-8', () => {
    expect(looksLikeText(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      false,
    );
    expect(looksLikeText(Uint8Array.from([0xc3, 0x28]))).toBe(false);
    expect(looksLikeText(Uint8Array.from([0x41, 0x00, 0x42]))).toBe(false);
  });
});

describe('contentTypeOf', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
  const text = new TextEncoder().encode('hello');

  it('serves a known image type inline', () => {
    expect(contentTypeOf('shot.png', png)).toEqual({ contentType: 'image/png', inline: true });
    expect(contentTypeOf('SHOT.JPEG', png).contentType).toBe('image/jpeg');
  });

  it('serves everything readable as plain text, whatever it is called', () => {
    for (const name of ['notes.md', 'main.ts', 'report.html', 'no-extension']) {
      expect(contentTypeOf(name, text), name).toEqual({
        contentType: 'text/plain; charset=utf-8',
        inline: true,
      });
    }
  });

  it('never answers text/html or image/svg+xml', () => {
    // Both would execute on claudops' own origin, with the operator's session
    // cookie -- and both are things an agent writes all the time.
    expect(contentTypeOf('page.html', text).contentType).not.toContain('html');
    expect(contentTypeOf('diagram.svg', text).contentType).not.toContain('svg');
  });

  it('makes anything unreadable a download', () => {
    expect(contentTypeOf('heap.bin', png)).toEqual({
      contentType: 'application/octet-stream',
      inline: false,
    });
  });
});

describe('contentDisposition', () => {
  it('carries the name twice, so a non-ASCII one survives', () => {
    expect(contentDisposition('Übersicht.md', false)).toBe(
      `inline; filename="_bersicht.md"; filename*=UTF-8''${encodeURIComponent('Übersicht.md')}`,
    );
  });

  it('cannot be ended early by a quote in the name', () => {
    const header = contentDisposition('a"; x=y.txt', true);
    expect(header.startsWith('attachment; filename="a_; x=y.txt"')).toBe(true);
  });
});
