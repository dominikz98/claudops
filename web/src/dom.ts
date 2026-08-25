/** The three lines of DOM plumbing the views would otherwise repeat. Not a
 *  framework: there are two views, and both fit on a screen. */

type Attributes = Record<string, string>;
type Child = Node | string;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

export function clear(node: Element): void {
  node.replaceChildren();
}

/** `<time>` with the exact value in the tooltip -- "3 min" is what you want to
 *  read, the timestamp is what you want when something looks wrong. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m`;
  if (seconds < 86400) return `${String(Math.floor(seconds / 3600))}h`;
  return `${String(Math.floor(seconds / 86400))}d`;
}
