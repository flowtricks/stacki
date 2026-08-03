// Built-in attribute schemas for plain HTML elements, in the same shape as
// the parser's component prop schemas ({name, type, options, default}).
// HTML elements have no interface Props, so without this their attributes
// would all render as untyped text fields. Defaults mirror the HTML spec so
// an unset attribute shows what the browser will actually do.

const SCHEMAS = {
  button: [
    { name: 'type', type: 'enum', options: ['submit', 'button', 'reset'], default: 'submit' },
    { name: 'disabled', type: 'boolean', default: false },
  ],
  // Astro's slot: unnamed takes the default children, `name` makes it a named
  // slot the caller fills with `slot="…"`.
  slot: [{ name: 'name', type: 'string' }],
  a: [
    { name: 'href', type: 'string' },
    { name: 'target', type: 'enum', options: ['_self', '_blank', '_parent', '_top'], default: '_self' },
    { name: 'rel', type: 'string' },
  ],
  input: [
    {
      name: 'type',
      type: 'enum',
      options: [
        'text', 'email', 'password', 'number', 'search', 'tel', 'url',
        'checkbox', 'radio', 'date', 'time', 'file', 'hidden', 'range', 'color',
      ],
      default: 'text',
    },
    { name: 'name', type: 'string' },
    { name: 'value', type: 'string' },
    { name: 'placeholder', type: 'string' },
    { name: 'required', type: 'boolean', default: false },
    { name: 'disabled', type: 'boolean', default: false },
  ],
  textarea: [
    { name: 'name', type: 'string' },
    { name: 'placeholder', type: 'string' },
    { name: 'rows', type: 'number', default: 2 },
    { name: 'required', type: 'boolean', default: false },
    { name: 'disabled', type: 'boolean', default: false },
  ],
  select: [
    { name: 'name', type: 'string' },
    { name: 'multiple', type: 'boolean', default: false },
    { name: 'required', type: 'boolean', default: false },
    { name: 'disabled', type: 'boolean', default: false },
  ],
  form: [
    { name: 'action', type: 'string' },
    { name: 'method', type: 'enum', options: ['get', 'post', 'dialog'], default: 'get' },
  ],
  img: [
    { name: 'src', type: 'string' },
    { name: 'alt', type: 'string' },
    { name: 'width', type: 'number' },
    { name: 'height', type: 'number' },
    { name: 'loading', type: 'enum', options: ['eager', 'lazy'], default: 'eager' },
    { name: 'decoding', type: 'enum', options: ['auto', 'sync', 'async'], default: 'auto' },
  ],
  iframe: [
    { name: 'src', type: 'string' },
    { name: 'title', type: 'string' },
    { name: 'loading', type: 'enum', options: ['eager', 'lazy'], default: 'eager' },
  ],
  video: [
    { name: 'src', type: 'string' },
    { name: 'controls', type: 'boolean', default: false },
    { name: 'autoplay', type: 'boolean', default: false },
    { name: 'loop', type: 'boolean', default: false },
    { name: 'muted', type: 'boolean', default: false },
    { name: 'playsinline', type: 'boolean', default: false },
    { name: 'preload', type: 'enum', options: ['auto', 'metadata', 'none'], default: 'auto' },
  ],
  audio: [
    { name: 'src', type: 'string' },
    { name: 'controls', type: 'boolean', default: false },
    { name: 'autoplay', type: 'boolean', default: false },
    { name: 'loop', type: 'boolean', default: false },
    { name: 'muted', type: 'boolean', default: false },
  ],
  label: [{ name: 'for', type: 'string' }],
  ol: [
    { name: 'type', type: 'enum', options: ['1', 'a', 'A', 'i', 'I'], default: '1' },
    { name: 'start', type: 'number', default: 1 },
    { name: 'reversed', type: 'boolean', default: false },
  ],
  th: [
    { name: 'scope', type: 'enum', options: ['col', 'row', 'colgroup', 'rowgroup'] },
    { name: 'colspan', type: 'number', default: 1 },
    { name: 'rowspan', type: 'number', default: 1 },
  ],
  td: [
    { name: 'colspan', type: 'number', default: 1 },
    { name: 'rowspan', type: 'number', default: 1 },
  ],
};

// Returns the built-in attribute schema for an HTML tag ([] if unknown).
export function getElementSchema(tag) {
  return SCHEMAS[String(tag).toLowerCase()] || [];
}

// Standard body-level HTML tags for the element tag-switcher autocomplete
// (document/metadata tags like html, head, meta, and script/style are
// intentionally left out).
export const HTML_TAGS = [
  'a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'bdi', 'bdo',
  'blockquote', 'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col',
  'colgroup', 'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog',
  'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup',
  'hr', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li',
  'main', 'mark', 'menu', 'meter', 'nav', 'noscript', 'object', 'ol',
  'optgroup', 'option', 'output', 'p', 'picture', 'pre', 'progress', 'q',
  'ruby', 's', 'samp', 'section', 'select', 'small', 'source', 'span',
  'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'template',
  'textarea', 'tfoot', 'th', 'thead', 'time', 'tr', 'track', 'u', 'ul',
  'var', 'video', 'wbr',
];

// Elements that can never hold children (so never any text content).
export const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Inline (phrasing) tags — the only element content a heading, paragraph, or
// other text-level container may hold.
export const PHRASING_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'button', 'cite', 'code', 'data',
  'datalist', 'del', 'dfn', 'em', 'i', 'img', 'input', 'ins', 'kbd', 'label',
  'mark', 'meter', 'output', 'picture', 'progress', 'q', 'ruby', 's', 'samp',
  'select', 'small', 'span', 'strong', 'sub', 'sup', 'svg', 'textarea', 'time',
  // Astro's <slot />: whatever the caller passes lands here, so it's allowed
  // wherever text is — `<h1><slot /></h1>` is the standard layout heading.
  'slot',
  'u', 'var', 'wbr',
]);

// Containers whose content model is phrasing-only: dropping a <div> or a
// second <p> inside one produces markup the browser silently reparents.
const TEXT_ONLY_PARENTS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'strong', 'em', 'b', 'i',
  'u', 's', 'small', 'code', 'kbd', 'samp', 'sub', 'sup', 'mark', 'abbr',
  'cite', 'q', 'dfn', 'label', 'legend', 'summary', 'dt', 'figcaption',
  'caption', 'option', 'textarea', 'title',
]);

// Parents that accept only a fixed set of children.
const ONLY_CHILDREN = {
  ul: ['li', 'script', 'template'],
  ol: ['li', 'script', 'template'],
  menu: ['li', 'script', 'template'],
  dl: ['dt', 'dd', 'div', 'script', 'template'],
  table: ['caption', 'colgroup', 'thead', 'tbody', 'tfoot', 'tr', 'script', 'template'],
  thead: ['tr', 'script', 'template'],
  tbody: ['tr', 'script', 'template'],
  tfoot: ['tr', 'script', 'template'],
  tr: ['td', 'th', 'script', 'template'],
  colgroup: ['col', 'template'],
  select: ['option', 'optgroup', 'hr', 'script', 'template'],
  optgroup: ['option', 'script', 'template'],
  picture: ['source', 'img'],
  video: ['source', 'track'],
  audio: ['source', 'track'],
  figure: null, // flow content — no restriction beyond the defaults
};

// Whether `childTag` is valid markup directly inside `parentTag`. Unknown or
// custom tags are permitted: better to allow than to block a valid page.
export function canContainTag(parentTag, childTag) {
  const parent = String(parentTag || '').toLowerCase();
  const child = String(childTag || '').toLowerCase();
  if (!parent || !child) return true;
  if (VOID_TAGS.has(parent)) return false;

  const only = ONLY_CHILDREN[parent];
  if (Array.isArray(only)) return only.includes(child);

  if (TEXT_ONLY_PARENTS.has(parent)) return PHRASING_TAGS.has(child);
  // An <a> may wrap flow content, but never another link or button.
  if (parent === 'a') return child !== 'a' && child !== 'button';
  if (parent === 'button') return PHRASING_TAGS.has(child) && child !== 'button' && child !== 'a';
  // <li>, <div>, <section>, … take flow content; only list/table parts are
  // out of place without their proper parent.
  return !['li', 'dt', 'dd', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'option', 'optgroup'].includes(
    child
  );
}

// Attributes that stay valid on any element when its tag changes.
export const GLOBAL_ATTRS = new Set([
  'class', 'id', 'style', 'slot', 'title', 'role', 'tabindex', 'hidden',
  'dir', 'lang', 'draggable', 'is', 'part', 'autofocus', 'inert',
]);
