import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/markdown.ts';

describe('renderMarkdown', () => {
  it('renders the shapes a report is made of', () => {
    expect(renderMarkdown('# Run 4\n## Gates')).toBe('<h1>Run 4</h1>\n<h2>Gates</h2>');
    expect(renderMarkdown('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
    expect(renderMarkdown('1. one\n2. two')).toBe('<ul><li>one</li><li>two</li></ul>');
    expect(renderMarkdown('just a line\nand its rest')).toBe('<p>just a line and its rest</p>');
    expect(renderMarkdown('---')).toBe('<hr>');
  });

  it('keeps a fenced block whole, including the characters in it', () => {
    expect(renderMarkdown('```sh\npnpm test\nrm -rf *\n```')).toBe(
      '<pre><code>pnpm test\nrm -rf *</code></pre>',
    );
    // A fence nobody closed still renders as the code it collected.
    expect(renderMarkdown('```\nunfinished')).toBe('<pre><code>unfinished</code></pre>');
  });

  it('renders the inline forms, code before the rest', () => {
    expect(renderMarkdown('a **bold** and an *italic*')).toBe(
      '<p>a <strong>bold</strong> and an <em>italic</em></p>',
    );
    // The asterisks inside a code span stay characters.
    expect(renderMarkdown('`rm -rf *`')).toBe('<p><code>rm -rf *</code></p>');
  });

  it('links, and opens them without handing the opener over', () => {
    expect(renderMarkdown('[the PR](https://github.com/o/r/pull/1)')).toBe(
      '<p><a href="https://github.com/o/r/pull/1" target="_blank" rel="noreferrer noopener">the PR</a></p>',
    );
  });

  describe('the text comes out of a container, so', () => {
    it('escapes markup instead of rendering it', () => {
      // The whole reason this module exists rather than a dependency: what is
      // rendered is whatever the agent wrote, on claudops' own origin.
      const rendered = renderMarkdown('<script>fetch("/instances")</script>');

      expect(rendered).not.toContain('<script>');
      expect(rendered).toContain('&lt;script&gt;');
    });

    it('escapes an image tag hidden in a heading or a list', () => {
      const rendered = renderMarkdown('# <img src=x onerror=alert(1)>\n- <b>bold</b>');

      expect(rendered).not.toContain('<img');
      expect(rendered).not.toContain('<b>');
      expect(rendered).toContain('&lt;img');
    });

    it('refuses a link target that is not a link', () => {
      for (const target of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<x>']) {
        const rendered = renderMarkdown(`[click](${target})`);
        expect(rendered, target).toContain('href="#"');
        expect(rendered.toLowerCase(), target).not.toContain('javascript:');
      }
    });

    it('cannot be made to break out of the href attribute', () => {
      const rendered = renderMarkdown('[x](https://a" onmouseover="alert(1))');

      expect(rendered).not.toContain('onmouseover="');
      expect(rendered).toContain('&quot;');
    });
  });
});
