import { assert } from '../../shared/core/assert';
import { BOUNDARY_LIMITS } from '../../shared/core/boundary';
import { safeHTMLLink } from '../../shared/page/richPaste';

export { safeHTMLLink };

const TAGS = new Set(
  (
    'p div br strong b em i u s strike a h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code span ' +
    'sub sup hr small mark kbd table thead tbody tfoot tr th td caption figure figcaption img'
  ).split(' '),
);
const ATTRIBUTES = new Set('class title alt width height colspan rowspan scope'.split(' '));
// Attributes that only describe their own element, which exported rich text
// carries (Webflow writes `<ul start="">`): kept as they are, not a reason to lock the field.
const ELEMENT_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  ol: new Set(['start', 'reversed', 'type']),
  ul: new Set(['start', 'type']),
  li: new Set(['value']),
  a: new Set(['target', 'rel']),
};

export function containsHTML(value: string): boolean {
  assert(value.length <= BOUNDARY_LIMITS.textLengthMax, 'HTML field: text limit exceeded');
  return /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*|\s*\/?)>/i.test(value);
}

// Video, for rich text a component's slot holds (HtmlField's `media`): its own attributes only, its address a project
// path or a web address, as an image's is. Off for every other HTML field, which keeps the list it always had.
const MEDIA_TAGS = new Set(['video', 'source']);
const MEDIA_ATTRIBUTES = new Set(['controls', 'autoplay', 'muted', 'loop', 'playsinline', 'poster', 'preload', 'type']);

export interface EditableOptions {
  readonly media?: boolean;
}

export interface EditableHTML {
  readonly html: string;
  readonly restricted: boolean;
}

// Parse in an inert template, then allow only document content into the editor.
// Opening a field never writes this projection back: original HTML stays intact.
export function editableHTML(value: string, document: Document, options: EditableOptions = {}): EditableHTML {
  assert(value.length <= BOUNDARY_LIMITS.textLengthMax, 'HTML field: text limit exceeded');
  const template = document.createElement('template');
  template.innerHTML = value;
  const elements = template.content.querySelectorAll('*');
  assert(elements.length <= BOUNDARY_LIMITS.itemsMax, 'HTML field: element limit exceeded');
  let restricted = false;
  for (const element of elements) {
    const media = options.media === true && MEDIA_TAGS.has(element.localName);
    if (!TAGS.has(element.localName) && !media) {
      element.remove();
      restricted = true;
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      if (!editableAttribute(element.localName, attribute) && !(media && mediaAttribute(attribute))) {
        element.removeAttribute(attribute.name);
        restricted = true;
      }
    }
  }
  return { html: template.innerHTML, restricted };
}

function mediaAttribute(attribute: Attr): boolean {
  if (MEDIA_ATTRIBUTES.has(attribute.name)) {
    return true;
  }
  return attribute.name === 'src' && /^(?:https?:\/\/|\/|\.\.?\/)/i.test(attribute.value);
}

function editableAttribute(tag: string, attribute: Attr): boolean {
  if (ATTRIBUTES.has(attribute.name)) {
    return true;
  }
  if (ELEMENT_ATTRIBUTES[tag]?.has(attribute.name) === true) {
    return true;
  }
  if (tag === 'a' && attribute.name === 'href') {
    return safeHTMLLink(attribute.value);
  }
  if (tag === 'img' && attribute.name === 'src') {
    return /^(?:https?:\/\/|\/|\.\.?\/)/i.test(attribute.value);
  }
  return false;
}
