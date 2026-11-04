// Which attribute names an HTML tag takes, for the advisory note under an
// attribute's Name field. A static table rather than a read of Astro's type
// declarations: the editor never parses `.d.ts` files at run time, and the
// HTML attribute set changes slowly. The note is advice and never blocks a
// save, because custom elements and frameworks use attributes no table lists;
// Stacki has never refused an attribute name, and still does not.
//
// Always valid on any tag: the global attributes, `data-*`, `aria-*`, `on*`
// event handlers and `role`. A tag the table does not know (a custom element)
// takes any name. Reserved names are the ones Astro gives a meaning of its own
// (directives) and the component's declared props, which an instance's
// attribute would collide with.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';

const GLOBAL = [
  'accesskey',
  'autocapitalize',
  'autofocus',
  'class',
  'contenteditable',
  'dir',
  'draggable',
  'enterkeyhint',
  'hidden',
  'id',
  'inert',
  'inputmode',
  'is',
  'itemid',
  'itemprop',
  'itemref',
  'itemscope',
  'itemtype',
  'lang',
  'nonce',
  'part',
  'popover',
  'slot',
  'spellcheck',
  'style',
  'tabindex',
  'title',
  'translate',
  'role',
] as const;

const FORM_CONTROL = ['disabled', 'form', 'name'] as const;

// Each tag's own attributes, beyond the global ones. Bounded by being written out.
const TAG_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ['download', 'href', 'hreflang', 'ping', 'referrerpolicy', 'rel', 'target', 'type'],
  area: ['alt', 'coords', 'download', 'href', 'ping', 'referrerpolicy', 'rel', 'shape', 'target'],
  audio: ['autoplay', 'controls', 'crossorigin', 'loop', 'muted', 'preload', 'src'],
  blockquote: ['cite'],
  button: [...FORM_CONTROL, 'formaction', 'formenctype', 'formmethod', 'formnovalidate', 'formtarget', 'popovertarget', 'popovertargetaction', 'type', 'value'],
  canvas: ['height', 'width'],
  col: ['span'],
  colgroup: ['span'],
  data: ['value'],
  del: ['cite', 'datetime'],
  details: ['name', 'open'],
  dialog: ['open'],
  embed: ['height', 'src', 'type', 'width'],
  fieldset: FORM_CONTROL,
  form: ['accept-charset', 'action', 'autocomplete', 'enctype', 'method', 'name', 'novalidate', 'rel', 'target'],
  iframe: ['allow', 'allowfullscreen', 'height', 'loading', 'name', 'referrerpolicy', 'sandbox', 'src', 'srcdoc', 'width'],
  img: ['alt', 'crossorigin', 'decoding', 'fetchpriority', 'height', 'ismap', 'loading', 'referrerpolicy', 'sizes', 'src', 'srcset', 'usemap', 'width'],
  input: [
    ...FORM_CONTROL,
    'accept',
    'alt',
    'autocomplete',
    'checked',
    'dirname',
    'formaction',
    'formenctype',
    'formmethod',
    'formnovalidate',
    'formtarget',
    'height',
    'list',
    'max',
    'maxlength',
    'min',
    'minlength',
    'multiple',
    'pattern',
    'placeholder',
    'popovertarget',
    'popovertargetaction',
    'readonly',
    'required',
    'size',
    'src',
    'step',
    'type',
    'value',
    'width',
  ],
  ins: ['cite', 'datetime'],
  label: ['for'],
  li: ['value'],
  link: ['as', 'crossorigin', 'fetchpriority', 'href', 'hreflang', 'integrity', 'media', 'referrerpolicy', 'rel', 'sizes', 'type'],
  map: ['name'],
  meta: ['charset', 'content', 'http-equiv', 'media', 'name'],
  meter: ['high', 'low', 'max', 'min', 'optimum', 'value'],
  object: ['data', 'form', 'height', 'name', 'type', 'width'],
  ol: ['reversed', 'start', 'type'],
  optgroup: ['disabled', 'label'],
  option: ['disabled', 'label', 'selected', 'value'],
  output: ['for', 'form', 'name'],
  progress: ['max', 'value'],
  q: ['cite'],
  script: ['async', 'crossorigin', 'defer', 'fetchpriority', 'integrity', 'nomodule', 'referrerpolicy', 'src', 'type'],
  select: [...FORM_CONTROL, 'autocomplete', 'multiple', 'required', 'size'],
  slot: ['name'],
  source: ['height', 'media', 'sizes', 'src', 'srcset', 'type', 'width'],
  style: ['media'],
  td: ['colspan', 'headers', 'rowspan'],
  template: ['shadowrootmode'],
  textarea: [...FORM_CONTROL, 'autocomplete', 'cols', 'dirname', 'maxlength', 'minlength', 'placeholder', 'readonly', 'required', 'rows', 'wrap'],
  th: ['abbr', 'colspan', 'headers', 'rowspan', 'scope'],
  time: ['datetime'],
  track: ['default', 'kind', 'label', 'src', 'srclang'],
  video: ['autoplay', 'controls', 'crossorigin', 'height', 'loop', 'muted', 'playsinline', 'poster', 'preload', 'src', 'width'],
};

// Plain containers whose attributes are the global ones alone.
const GLOBAL_ONLY = new Set([
  'abbr',
  'address',
  'article',
  'aside',
  'b',
  'bdi',
  'bdo',
  'body',
  'br',
  'caption',
  'cite',
  'code',
  'dd',
  'dfn',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hgroup',
  'hr',
  'html',
  'i',
  'kbd',
  'legend',
  'main',
  'mark',
  'menu',
  'nav',
  'noscript',
  'p',
  'picture',
  'pre',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'search',
  'section',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'tfoot',
  'thead',
  'title',
  'tr',
  'u',
  'ul',
  'var',
  'wbr',
]);

// Names Astro reads itself: an instance attribute by one of these is a directive, not an attribute.
const RESERVED = /^(class:list|set:html|set:text|slot|define:vars)$|^(is|client|server|transition):/;

const GLOBAL_SET: ReadonlySet<string> = new Set(GLOBAL);

/** Whether `tag` takes an attribute called `name`: always for a tag the table does not know. */
export function attributeValidOn(name: string, tag: string): boolean {
  const lower = name.toLowerCase();
  assert(lower.length <= LIMITS.attrCharsMax, 'attributeValidOn: attribute name is bounded');
  if (GLOBAL_SET.has(lower) || /^(data|aria)-[\w.:-]+$/.test(lower) || /^on[a-z]+$/.test(lower)) {
    return true;
  }
  const own = TAG_ATTRIBUTES[tag];
  if (own !== undefined) {
    return own.includes(lower);
  }
  return !GLOBAL_ONLY.has(tag);
}

/**
 * The advisory note under an attribute's Name field, or undefined when the
 * name is fine. `reserved` is the component's declared props, for an
 * instance's attribute list; without a tag (an instance) only reserved names
 * are noted.
 */
export function attributeNameNote(name: string, tag: string | undefined, reserved: readonly string[]): string | undefined {
  const clean = name.trim();
  if (clean === '') {
    return undefined;
  }
  assert(reserved.length <= LIMITS.propSchemaFieldsMax, 'attributeNameNote: reserved names are bounded');
  if (RESERVED.test(clean) || reserved.includes(clean)) {
    return 'This is a reserved name.';
  }
  if (tag === undefined || clean.startsWith('{')) {
    return undefined;
  }
  return attributeValidOn(clean, tag) ? undefined : `${clean} isn’t an attribute of <${tag}>.`;
}
