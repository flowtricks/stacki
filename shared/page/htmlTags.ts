// HTML void elements cannot acquire children, even when written with Astro's /> syntax.
export const HTML_VOID_TAGS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

// Inline (phrasing) tags — the only element content a heading, paragraph, or
// other text-level container may hold.
export const HTML_PHRASING_TAGS: ReadonlySet<string> = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'br',
  'button',
  'cite',
  'code',
  'data',
  'datalist',
  'del',
  'dfn',
  'em',
  'i',
  'img',
  'input',
  'ins',
  'kbd',
  'label',
  'mark',
  'meter',
  'output',
  'picture',
  'progress',
  'q',
  'ruby',
  's',
  'samp',
  'select',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'svg',
  'textarea',
  'time',
  // Astro's <slot />: whatever the caller passes lands here, so it's allowed
  // wherever text is — `<h1><slot /></h1>` is the standard layout heading.
  'slot',
  'u',
  'var',
  'wbr',
]);

// Containers whose content model is phrasing-only: dropping a <div> or a
// second <p> inside one produces markup the browser silently reparents.
export const HTML_TEXT_ONLY_PARENTS: ReadonlySet<string> = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'span',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'small',
  'code',
  'kbd',
  'samp',
  'sub',
  'sup',
  'mark',
  'abbr',
  'cite',
  'q',
  'dfn',
  'label',
  'legend',
  'summary',
  'dt',
  'figcaption',
  'caption',
  'option',
  'textarea',
  'title',
]);

// Replaced elements a page lays out inline, as it does phrasing content, though
// they are no element a text parent is offered: a line break beside one shows.
export const HTML_INLINE_REPLACED_TAGS: ReadonlySet<string> = new Set(['audio', 'canvas', 'embed', 'iframe', 'map', 'object', 'video']);

// Elements whose whitespace is content. `<pre>` and `<textarea>` keep it; `<script>`
// and `<style>` are not markup at all. `<code>` collapses it by default, but it is
// the tag a stylesheet gives `white-space: pre`, and Stacki cannot see that rule.
export const HTML_WHITESPACE_TAGS: ReadonlySet<string> = new Set(['code', 'pre', 'script', 'style', 'textarea']);
