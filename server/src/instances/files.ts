/**
 * Reading what an instance produced: which paths may be asked for, how a
 * directory listing is obtained and parsed, and what content type a file's
 * bytes may be served as.
 *
 * Everything here is about a path the browser sent, so everything here starts
 * from the assumption that it is hostile. Two independent barriers stand
 * between a query string and a file:
 *
 * 1. `resolveWorkspacePath` normalises the path here, in the server, and
 *    refuses anything that is not under the workspace. `..` is gone by then --
 *    it is resolved, not searched for.
 * 2. The shell scripts below resolve the path again *inside* the container with
 *    `realpath` and refuse it a second time if what it points at has left the
 *    workspace. That is the barrier the first one cannot be: a symlink is a
 *    fact about the container's filesystem, not about the string.
 */

import { posix } from 'node:path';

/**
 * What may be browsed. The clone lives at `<root>/<repo>` and the uploads of
 * #15 next to it, so this is "everything the instance has", and deliberately
 * not the container's filesystem.
 *
 * Mirrors WORKSPACE_DIR in docker/base/entrypoint.sh. An image that moves it
 * would have to move this too, which is why the container re-checks rather
 * than trusting the number: the two cannot silently disagree in the unsafe
 * direction.
 */
export const WORKSPACE_ROOT = '/workspace';

/**
 * How many entries one listing carries. A `node_modules` has tens of
 * thousands, and a panel that has to paint them all is no more useful than one
 * that says there are more -- while the exec that produced them would be
 * megabytes of output for a single click.
 */
export const MAX_LISTING_ENTRIES = 500;

/** What one entry of a directory is. */
export type EntryKind = 'file' | 'directory' | 'other';

export interface DirectoryEntry {
  name: string;
  /** The absolute path in the container -- what the next request asks for, so
   *  the browser never has to join paths itself. */
  path: string;
  kind: EntryKind;
  /** Bytes for a file; for a directory this is the size of the directory entry
   *  itself and says nothing about what is in it. */
  size: number;
  modifiedAt: string;
}

export interface DirectoryListing {
  path: string;
  /** `null` at the workspace root, which is where "up" stops. */
  parent: string | null;
  entries: DirectoryEntry[];
  /** The directory holds more than `MAX_LISTING_ENTRIES`; what came back is
   *  the first of them. */
  truncated: boolean;
}

/** One file read out of a container, on its way to the browser. */
export interface FileContent {
  path: string;
  name: string;
  size: number;
  content: Uint8Array;
  /** What the response says it is -- see `contentTypeOf`. */
  contentType: string;
  /** Whether a browser may render it in place. `false` is served as an
   *  attachment, whatever the caller asked for. */
  inline: boolean;
}

export class PathOutsideWorkspaceError extends Error {
  constructor(readonly requested: string) {
    super(`'${requested}' is outside ${WORKSPACE_ROOT}`);
    this.name = 'PathOutsideWorkspaceError';
  }
}

export class PathNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`'${path}' does not exist in the instance`);
    this.name = 'PathNotFoundError';
  }
}

/** The path is there and is not what the endpoint can answer with: a directory
 *  asked for its content, a file asked for its listing, a symlink either way. */
export class WrongPathKindError extends Error {
  constructor(
    readonly path: string,
    readonly wanted: 'file' | 'directory',
  ) {
    super(
      wanted === 'file'
        ? `'${path}' is not a regular file`
        : `'${path}' is not a directory`,
    );
    this.name = 'WrongPathKindError';
  }
}

/**
 * The path a request may actually be answered for, or a refusal.
 *
 * `posix.resolve` does the work: it joins a relative path onto the workspace,
 * leaves an absolute one where it is, and collapses every `.` and `..` in
 * both. What is left is compared against the root as a prefix -- with the
 * separator, because `/workspacex` starts with `/workspace` and is not in it.
 */
export function resolveWorkspacePath(raw: string | undefined): string {
  const requested = raw ?? '';
  // A NUL ends a path in every syscall, so a name carrying one would reach the
  // container as a different path than the one that was checked here.
  if (requested.includes('\0')) throw new PathOutsideWorkspaceError(requested);
  if (requested === '') return WORKSPACE_ROOT;

  const resolved = posix.resolve(WORKSPACE_ROOT, requested);
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(`${WORKSPACE_ROOT}/`)) {
    throw new PathOutsideWorkspaceError(requested);
  }
  return resolved;
}

/** Where "up" leads from a directory, and `null` once that is out of the
 *  workspace. */
export function parentOf(path: string): string | null {
  if (path === WORKSPACE_ROOT) return null;
  const parent = posix.dirname(path);
  return parent === path ? null : parent;
}

/**
 * What the scripts below report through their exit code. stdout carries the
 * answer and nothing else, so a refusal never has to be told apart from a
 * filename by parsing text.
 */
export const PATH_MISSING = 3;
export const PATH_WRONG_KIND = 4;
/** `realpath` left the workspace: a symlink pointing out of it. */
export const PATH_ESCAPED = 6;

/**
 * Lists one directory, one level deep.
 *
 * The path is `$1` and the workspace root `$2` -- arguments of the script, not
 * text pasted into it. A directory really can be called `"; rm -rf /; "`, and
 * the check in `resolveWorkspacePath` is about where a path points, not about
 * what it would do to a shell.
 *
 * `-maxdepth 1` because a tree is walked by clicking, not by one recursive
 * exec: the workspace holds a clone with its `node_modules` and its `.git`.
 * `%y` reports the entry's own type, so a symlink stays a symlink rather than
 * quietly becoming what it points at.
 */
export const LIST_SCRIPT = `set -eu
if [ ! -e "$1" ]; then exit ${String(PATH_MISSING)}; fi
real=$(realpath -- "$1")
case "$real" in
  "$2"|"$2"/*) ;;
  *) exit ${String(PATH_ESCAPED)} ;;
esac
if [ ! -d "$real" ]; then exit ${String(PATH_WRONG_KIND)}; fi
find "$real" -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\0' 2>/dev/null |
  head -z -n ${String(MAX_LISTING_ENTRIES + 1)}`;

/**
 * Says whether a path can be read, and how big it is. The read itself is
 * `getArchive` -- an exec cannot carry bytes, its output is decoded as UTF-8
 * and a PNG does not survive that.
 *
 * The last component must not be a symlink: `getArchive` would hand back the
 * link rather than its target, and following it here would mean resolving a
 * path the archive then resolves again.
 */
export const STAT_SCRIPT = `set -eu
if [ ! -e "$1" ]; then exit ${String(PATH_MISSING)}; fi
real=$(realpath -- "$1")
case "$real" in
  "$2"|"$2"/*) ;;
  *) exit ${String(PATH_ESCAPED)} ;;
esac
if [ -L "$1" ]; then exit ${String(PATH_WRONG_KIND)}; fi
if [ ! -f "$1" ]; then exit ${String(PATH_WRONG_KIND)}; fi
stat -c '%s' -- "$1"`;

/** The argv that runs one of the scripts above. `sh` as `$0` so a shell error
 *  is prefixed with something readable rather than with the script itself. */
export function scriptCommand(script: string, path: string): string[] {
  return ['sh', '-c', script, 'sh', path, WORKSPACE_ROOT];
}

const KINDS: Record<string, EntryKind> = { f: 'file', d: 'directory' };

/**
 * One `find -printf` record: type, size, mtime and the name, tab-separated and
 * NUL-terminated.
 *
 * The name is everything after the third tab rather than the fourth field: a
 * file may be called `a\tb`, and splitting on every tab would lose half of it.
 * The NUL between records is what makes a newline in a name harmless -- the
 * one byte a filename cannot contain is the one that separates them.
 */
function parseEntry(record: string, directory: string): DirectoryEntry | undefined {
  const fields: string[] = [];
  let rest = record;
  for (let index = 0; index < 3; index += 1) {
    const at = rest.indexOf('\t');
    if (at === -1) return undefined;
    fields.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  if (rest === '') return undefined;

  const seconds = Number.parseFloat(fields[2] ?? '');
  return {
    name: rest,
    path: posix.join(directory, rest),
    kind: KINDS[fields[0] ?? ''] ?? 'other',
    size: Number.parseInt(fields[1] ?? '', 10) || 0,
    modifiedAt: new Date(
      Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
    ).toISOString(),
  };
}

/** Directories first, then by name -- the order a file tree is read in.
 *  `localeCompare` rather than `<`, so `Readme` and `readme` sort together. */
function byKindThenName(left: DirectoryEntry, right: DirectoryEntry): number {
  if (left.kind !== right.kind) {
    if (left.kind === 'directory') return -1;
    if (right.kind === 'directory') return 1;
  }
  return left.name.localeCompare(right.name, 'en');
}

export function parseListing(output: string, directory: string): DirectoryListing {
  const entries = output
    .split('\0')
    .filter((record) => record !== '')
    .map((record) => parseEntry(record, directory))
    .filter((entry): entry is DirectoryEntry => entry !== undefined)
    .sort(byKindThenName);

  return {
    path: directory,
    parent: parentOf(directory),
    // The script asks for one more than the limit, so "there are more" is
    // known rather than guessed from a full page.
    truncated: entries.length > MAX_LISTING_ENTRIES,
    entries: entries.slice(0, MAX_LISTING_ENTRIES),
  };
}

/**
 * Image types a browser may render in place.
 *
 * SVG is deliberately not here. It is a document, not a picture: it carries
 * script, and this content is served from claudops' own origin -- an agent
 * that wrote one could read the session cookie with it. An SVG is text, so it
 * arrives as `text/plain` below and is still readable, just not executed.
 */
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

/** Nothing about a name says whether the bytes are text, so the bytes decide:
 *  valid UTF-8 without a NUL is text, anything else is a download. */
export function looksLikeText(content: Uint8Array): boolean {
  if (content.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content);
    return true;
  } catch {
    return false;
  }
}

/**
 * What the content response says it is.
 *
 * Only two types are ever served inline, and neither can execute: an image
 * from the list above, and `text/plain`. Markdown reaches the browser as text
 * and is rendered there; `text/html` is never sent, because a page an agent
 * wrote would otherwise run on claudops' origin with the operator's session.
 */
export function contentTypeOf(
  name: string,
  content: Uint8Array,
): { contentType: string; inline: boolean } {
  const extension = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
  const image = IMAGE_TYPES[extension];
  if (image !== undefined) return { contentType: image, inline: true };

  return looksLikeText(content)
    ? { contentType: 'text/plain; charset=utf-8', inline: true }
    : { contentType: 'application/octet-stream', inline: false };
}

/**
 * `Content-Disposition` for one file.
 *
 * Two spellings of the name: a plain `filename` for a name that survives a
 * quoted ASCII string, and RFC 5987's `filename*` for everything else. A quote
 * or a backslash in the plain one would end the header field early, so those
 * are what the fallback drops.
 */
export function contentDisposition(name: string, attachment: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name);
  return `${attachment ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
