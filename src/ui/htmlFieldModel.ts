import { assert } from '../../shared/core/assert';
import { BOUNDARY_LIMITS } from '../../shared/core/boundary';

const TAGS = new Set(
  (
    'p div br strong b em i u s strike a h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code span ' +
    'sub sup hr small mark table thead tbody tfoot tr th td caption figure figcaption img'
  ).split(' '),
);
const ATTRIBUTES = new Set('class title alt width height colspan rowspan scope'.split(' '));

export function containsHTML(value: string): boolean {
  assert(value.length <= BOUNDARY_LIMITS.textLengthMax, 'HTML field: text limit exceeded');
  return /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*|\s*\/?)>/i.test(value);
}

export function safeHTMLLink(value: string): boolean {
  const text = value.trim();
  if (/[\u0000-\u0020\u007f]/.test(text)) {
    return false;
  }
  return /^(?:https?:\/\/|mailto:|tel:|#|\/|\.\.?\/)/i.test(text);
}

export interface EditableHTML {
  readonly html: string;
  readonly restricted: boolean;
}

// Parse in an inert template, then allow only document content into the editor.
// Opening a field never writes this projection back: original HTML stays intact.
export function editableHTML(value: string, document: Document): EditableHTML {
  assert(value.length <= BOUNDARY_LIMITS.textLengthMax, 'HTML field: text limit exceeded');
  const template = document.createElement('template');
  template.innerHTML = value;
  const elements = template.content.querySelectorAll('*');
  assert(elements.length <= BOUNDARY_LIMITS.itemsMax, 'HTML field: element limit exceeded');
  let restricted = false;
  for (const element of elements) {
    if (!TAGS.has(element.localName)) {
      element.remove();
      restricted = true;
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      if (!editableAttribute(element.localName, attribute)) {
        element.removeAttribute(attribute.name);
        restricted = true;
      }
    }
  }
  return { html: template.innerHTML, restricted };
}

function editableAttribute(tag: string, attribute: Attr): boolean {
  if (ATTRIBUTES.has(attribute.name)) {
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
