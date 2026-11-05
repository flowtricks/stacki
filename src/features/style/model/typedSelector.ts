// A name typed into the Style panel's selector box without a dot is a class.
//
// People name classes far more often than they style a bare tag, and builders
// they come from (Webflow among them) take a typed `hero_wrap` as the class
// `hero_wrap`. Read literally as CSS, `hero_wrap` is a tag selector for an
// element nobody has, so the chip showed with no styles, nothing went on the
// element, and the Settings class box never saw it. So a leading name is read
// as a class unless it is a tag: one of the standard HTML or SVG element names,
// or the selected element's own tag (which covers custom elements such as
// `my-card`, whose names are otherwise indistinguishable from hyphenated
// classes). A typed `.x`, `#x`, `[x]` or `:x` is already explicit and kept.
//
// Only the start of the text is looked at: `hero_wrap:hover` and
// `hero_wrap.is-dark` become `.hero_wrap:hover` and `.hero_wrap.is-dark`,
// while `section .title` keeps its tag.

import { assert } from '../../../../shared/core/assert';
import { HTML_TAGS } from '../../../editor/elementSchemas';

// Element names HTML_TAGS leaves out (it lists what can be inserted in a
// page body), which a stylesheet still targets by name.
const OTHER_TAGS = [
  'body',
  'circle',
  'defs',
  'ellipse',
  'g',
  'head',
  'html',
  'line',
  'math',
  'path',
  'polygon',
  'polyline',
  'rect',
  'slot',
  'svg',
  'symbol',
  'text',
  'tspan',
  'use',
] as const;

const TAG_NAMES: ReadonlySet<string> = new Set([...HTML_TAGS, ...OTHER_TAGS]);

// A CSS identifier at the start, then the end or the start of the next simple
// selector or combinator.
const LEADING_NAME = /^(-?[A-Za-z_][A-Za-z0-9_-]*)(?=$|[.:#[\s>+~])/;

/** `text` as the selector it means: a leading name that is not a tag gets its class dot. */
export function typedSelectorText(text: string, elementTag: string | undefined): string {
  const trimmed = text.trim();
  const name = LEADING_NAME.exec(trimmed)?.[1];
  if (name === undefined) {
    return trimmed;
  }
  const lower = name.toLowerCase();
  if (TAG_NAMES.has(lower)) {
    return trimmed;
  }
  if (elementTag !== undefined && elementTag.toLowerCase() === lower) {
    return trimmed;
  }
  const selector = `.${trimmed}`;
  assert(selector.startsWith(`.${name}`), 'typedSelectorText: the class is the name that was typed');
  return selector;
}
