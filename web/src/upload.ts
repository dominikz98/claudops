/**
 * Names for the files that arrive without one.
 *
 * A clipboard image is called `image.png` in every browser and on every paste,
 * so two screenshots in a row would be the same upload twice -- the second one
 * overwriting the first in the container. The timestamp is what makes them two
 * files, and it is local time on purpose: it has to line up with what the
 * person pasting sees on their own clock.
 */

/** Subtypes whose obvious extension is not their name. */
const EXTENSIONS: Record<string, string> = {
  jpeg: 'jpg',
  'svg+xml': 'svg',
  plain: 'txt',
  'x-icon': 'ico',
};

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** `image/png` -> `png`. Anything unreadable becomes `bin`: a wrong extension
 *  is worse than none, and Claude reads the file either way. */
export function extensionFor(mimeType: string): string {
  const subtype = mimeType.split('/')[1]?.split(';')[0]?.trim().toLowerCase() ?? '';
  const mapped = EXTENSIONS[subtype] ?? subtype;
  return /^[a-z0-9]{1,8}$/.test(mapped) ? mapped : 'bin';
}

export function pastedFileName(mimeType: string, now: Date = new Date()): string {
  const stamp =
    `${String(now.getFullYear())}${two(now.getMonth() + 1)}${two(now.getDate())}` +
    `-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `pasted-${stamp}.${extensionFor(mimeType)}`;
}
