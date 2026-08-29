/**
 * Enough Markdown for what an agent writes: a report, a plan, a README.
 *
 * Written here rather than pulled in. `marked` and its neighbours are a
 * hundred kilobytes and a supply-chain dependency for a panel that renders
 * headings, lists, code and links -- and the interesting half of the problem
 * is not the parsing.
 *
 * The interesting half is that this text comes out of a container. It is
 * whatever Claude wrote, or whatever a repository somebody cloned contains, so
 * it is not to be trusted with the operator's session. Two rules make that
 * safe, and both are structural rather than a list of things to strip:
 *
 * 1. Every character is HTML-escaped *first*. What is parsed afterwards is
 *    escaped text, so no `<script>` in the source can become an element -- it
 *    is already `&lt;script&gt;` by the time any rule looks at it.
 * 2. The only markup this produces is what the rules below write themselves.
 *    Raw HTML in the Markdown stays visible text, which is a deliberate
 *    difference from a full renderer: this is a preview, not a publisher.
 *
 * The one place text reaches an attribute is a link's `href`, which is why
 * `safeHref` exists.
 */

/** Escaped before anything else looks at the text -- see rule 1 above. */
function escape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * A link target, or `#` for one that is not a link.
 *
 * An allowlist rather than a `javascript:` blocklist: `java\tscript:` and a
 * dozen other spellings survive a blocklist, and nothing an instance produces
 * needs a scheme outside these three.
 */
function safeHref(target: string): string {
  const trimmed = target.trim();
  return /^(https?:\/\/|mailto:|#|\/|\.{0,2}\/)/i.test(trimmed) ? trimmed : '#';
}

/** `**bold**`, `*italic*`, `` `code` `` and `[text](url)`, in that order --
 *  code first, so the characters inside a span stay characters. */
function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(
      /\[([^\]]*)\]\(([^)\s]*)\)/g,
      (_match, label: string, target: string) =>
        // The label is already escaped; the target goes through the allowlist
        // and is escaped again for the attribute it lands in.
        `<a href="${escape(safeHref(target))}" target="_blank" rel="noreferrer noopener">${label}</a>`,
    );
}

/** How deep a heading may go. `######` is a heading, `#######` is a paragraph
 *  that starts with hashes. */
const MAX_HEADING = 6;

/**
 * One Markdown document as HTML.
 *
 * Line-based: a fenced block swallows lines until its closing fence, a list
 * collects consecutive items, and everything else is a paragraph. Nested lists
 * and tables are deliberately not here -- they render as their own text, which
 * is worse than a real renderer and better than a dependency.
 */
export function renderMarkdown(source: string): string {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const out: string[] = [];

  let list: string[] = [];
  let paragraph: string[] = [];
  let fence: string[] | undefined;

  const closeList = (): void => {
    if (list.length === 0) return;
    out.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`);
    list = [];
  };
  const closeParagraph = (): void => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeBlocks = (): void => {
    closeList();
    closeParagraph();
  };

  for (const raw of lines) {
    const line = escape(raw);

    if (fence !== undefined) {
      if (/^\s*```/.test(line)) {
        out.push(`<pre><code>${fence.join('\n')}</code></pre>`);
        fence = undefined;
      } else {
        fence.push(line);
      }
      continue;
    }

    if (/^\s*```/.test(line)) {
      closeBlocks();
      fence = [];
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      closeBlocks();
      const level = Math.min(heading[1]?.length ?? 1, MAX_HEADING);
      out.push(`<h${String(level)}>${inline(heading[2] ?? '')}</h${String(level)}>`);
      continue;
    }

    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
      closeParagraph();
      list.push(line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, ''));
      continue;
    }

    // `---` under nothing is a rule; under a paragraph it is a setext heading
    // nobody writes any more, so it stays a rule.
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeBlocks();
      out.push('<hr>');
      continue;
    }

    if (line.trim() === '') {
      closeBlocks();
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }

  // A document that ends inside a fence still has to render: what was
  // collected is code, the missing fence is the author's problem.
  if (fence !== undefined) out.push(`<pre><code>${fence.join('\n')}</code></pre>`);
  closeBlocks();

  return out.join('\n');
}
