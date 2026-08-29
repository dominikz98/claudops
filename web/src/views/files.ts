/**
 * What the instance produced, next to the console that produced it.
 *
 * A tree on the left, one file at a time on the right. Nothing is downloaded
 * to be looked at: a screenshot Claude took and a report it wrote are visible
 * where they were made, without a `git add` and without a `docker cp`.
 *
 * The panel asks for one directory per open rather than a tree at once -- the
 * workspace holds a clone with its `node_modules`, and the server refuses to
 * walk it for the same reason.
 */

import {
  ApiCallError,
  type Api,
  type FileEntry,
  type FileListing,
} from '../api.ts';
import { clear, el } from '../dom.ts';
import { renderMarkdown } from '../markdown.ts';

/** Rendered as Markdown rather than as its own source. */
const MARKDOWN = /\.(?:md|markdown|mdx)$/i;

export interface FilesPanel {
  readonly element: HTMLElement;
  /** Re-reads the directories that are open. What an agent wrote a second ago
   *  is not in a listing that was fetched a minute ago. */
  refresh(): void;
  destroy(): void;
}

function describe(error: unknown): string {
  if (error instanceof ApiCallError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * A path short enough for one line of the preview bar, cut at a separator from
 * the left -- the end of a path is the half worth seeing.
 *
 * In JavaScript rather than in CSS: `text-overflow` cuts the end, and the
 * `direction: rtl` trick that appears to fix that moves the leading slash to
 * the other end of the string. The whole path stays in the title attribute.
 */
export function shortenPath(path: string, maxLength = 48): string {
  if (path.length <= maxLength) return path;

  const segments = path.split('/');
  let kept = segments.pop() ?? path;
  while (segments.length > 0) {
    const next = `${segments[segments.length - 1] ?? ''}/${kept}`;
    if (next.length + 2 > maxLength) break;
    segments.pop();
    kept = next;
  }
  // A single segment longer than the line is cut mid-word; there is nothing
  // else to cut it at.
  return `…/${kept.length > maxLength ? kept.slice(kept.length - maxLength) : kept}`;
}

/** Binary units, like every size the server prints. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;

  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? 'B'}`;
}

export function mountFiles(api: Api, id: string): FilesPanel {
  /** Directories the reader has opened, so a refresh restores the tree rather
   *  than collapsing it back to the root. */
  const open = new Set<string>();
  let selected: string | undefined;
  /** The object URL of the image on screen. Revoked before the next one is
   *  made: a blob URL keeps its bytes alive until it is. */
  let objectUrl: string | undefined;
  let destroyed = false;

  const tree = el('div', { class: 'file-tree', 'data-testid': 'file-tree' });
  const preview = el('div', { class: 'file-preview', 'data-testid': 'file-preview' });
  const title = el('span', { class: 'preview-name', 'data-testid': 'preview-name' });
  const download = el('a', {
    class: 'preview-download',
    hidden: 'hidden',
    'data-testid': 'preview-download',
    download: '',
  }, 'Download');
  const reload = el(
    'button',
    { type: 'button', class: 'secondary', 'data-testid': 'files-refresh' },
    'Refresh',
  );

  const element = el(
    'aside',
    { class: 'files', 'data-testid': 'files-panel' },
    el('div', { class: 'files-bar' }, el('span', { class: 'files-title' }, 'Files'), reload),
    tree,
    el('div', { class: 'preview-bar' }, title, download),
    preview,
  );

  const showObject = (node: Node): void => {
    clear(preview);
    preview.append(node);
  };

  const showMessage = (text: string, state: string): void => {
    showObject(el('p', { class: 'preview-message', 'data-state': state, 'data-testid': 'preview-message' }, text));
  };

  const releaseObjectUrl = (): void => {
    if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    objectUrl = undefined;
  };

  /**
   * One file in the right-hand half.
   *
   * The bytes are fetched once and the server's `content-type` decides what
   * happens to them -- not the extension, which is a guess the server has
   * already made better with the bytes in front of it. The image is shown from
   * the blob that was just fetched rather than from a second request for the
   * same URL.
   */
  const show = async (entry: FileEntry): Promise<void> => {
    selected = entry.path;
    paint();
    title.textContent = shortenPath(entry.path);
    title.setAttribute('title', entry.path);
    download.setAttribute('href', api.fileUrl(id, entry.path, true));
    // Offered only once the file has been read: a download goes through the
    // same endpoint and the same size limit, so a link on a file the preview
    // was refused is a link that cannot work either.
    download.setAttribute('hidden', 'hidden');
    showMessage('loading…', 'busy');

    try {
      const body = await api.readFile(id, entry.path);
      if (destroyed || selected !== entry.path) return;

      download.removeAttribute('hidden');
      releaseObjectUrl();

      if (body.contentType.startsWith('image/')) {
        objectUrl = URL.createObjectURL(body.blob);
        showObject(el('img', { class: 'preview-image', 'data-testid': 'preview-image', src: objectUrl, alt: entry.name }));
        return;
      }

      if (!body.contentType.startsWith('text/')) {
        // Not text and not an image: there is nothing to render, and the
        // download above is the whole answer.
        showMessage(`${formatSize(entry.size)} of ${body.contentType} -- download it to open it`, 'info');
        return;
      }

      const text = await body.blob.text();
      if (destroyed || selected !== entry.path) return;

      if (MARKDOWN.test(entry.name)) {
        const article = el('article', { class: 'preview-markdown', 'data-testid': 'preview-markdown' });
        // The only innerHTML in this UI. What goes in has been escaped
        // character by character first -- see web/src/markdown.ts.
        article.innerHTML = renderMarkdown(text);
        showObject(article);
        return;
      }

      showObject(el('pre', { class: 'preview-text', 'data-testid': 'preview-text' }, text));
    } catch (error) {
      if (!destroyed && selected === entry.path) showMessage(describe(error), 'error');
    }
  };

  /** Listings by directory, so a repaint after an expand does not re-fetch the
   *  directories that were already open. */
  const listings = new Map<string, FileListing>();
  const failures = new Map<string, string>();

  const load = async (path: string | undefined): Promise<void> => {
    const key = path ?? '';
    try {
      const listing = await api.listFiles(id, path);
      if (destroyed) return;
      listings.set(key, listing);
      failures.delete(key);
    } catch (error) {
      if (destroyed) return;
      listings.delete(key);
      failures.set(key, describe(error));
    }
    paint();
  };

  const toggle = (entry: FileEntry): void => {
    if (open.has(entry.path)) {
      open.delete(entry.path);
      paint();
      return;
    }
    open.add(entry.path);
    paint();
    void load(entry.path);
  };

  /**
   * One directory's entries, and under every open one its own list. Depth is an
   * indent rather than a nesting of scroll containers.
   *
   * `path` is the key `load` filed the listing under: the empty string for the
   * root, whose absolute path the server chooses, and the entry's own absolute
   * path for everything below it.
   */
  const renderEntries = (path: string, depth: number): HTMLElement => {
    const list = el('ul', { class: 'tree-list' });
    const listing = listings.get(path);
    const failure = failures.get(path);

    if (failure !== undefined) {
      list.append(el('li', { class: 'tree-message', 'data-state': 'error' }, failure));
      return list;
    }
    if (listing === undefined) {
      list.append(el('li', { class: 'tree-message' }, 'loading…'));
      return list;
    }
    if (listing.entries.length === 0) {
      list.append(el('li', { class: 'tree-message' }, 'empty'));
      return list;
    }

    for (const entry of listing.entries) {
      const expanded = open.has(entry.path);
      const row = el(
        'button',
        {
          type: 'button',
          class: 'tree-entry',
          'data-kind': entry.kind,
          'data-path': entry.path,
          'data-testid': 'file-entry',
          style: `padding-left: ${String(0.4 + depth * 0.8)}rem`,
          ...(entry.path === selected ? { 'data-selected': 'true' } : {}),
          ...(entry.kind === 'other' ? { disabled: 'disabled' } : {}),
        },
        el('span', { class: 'tree-mark' }, entry.kind === 'directory' ? (expanded ? '▾' : '▸') : '·'),
        el('span', { class: 'tree-name' }, entry.name),
        el('span', { class: 'tree-size' }, entry.kind === 'file' ? formatSize(entry.size) : ''),
      );
      row.addEventListener('click', () => {
        if (entry.kind === 'directory') toggle(entry);
        else if (entry.kind === 'file') void show(entry);
      });

      const item = el('li', {}, row);
      if (entry.kind === 'directory' && expanded) item.append(renderEntries(entry.path, depth + 1));
      list.append(item);
    }

    if (listing.truncated) {
      list.append(
        el(
          'li',
          { class: 'tree-message', 'data-state': 'warn' },
          `only the first ${String(listing.entries.length)} entries`,
        ),
      );
    }
    return list;
  };

  function paint(): void {
    if (destroyed) return;
    clear(tree);
    tree.append(renderEntries('', 0));
  }

  /** The root and everything open under it. A file on screen is left alone:
   *  re-reading it is a click on it. */
  const refresh = (): void => {
    void load(undefined);
    for (const path of open) void load(path);
  };

  reload.addEventListener('click', refresh);

  paint();
  void load(undefined);

  return {
    element,
    refresh,
    destroy: () => {
      destroyed = true;
      releaseObjectUrl();
    },
  };
}
