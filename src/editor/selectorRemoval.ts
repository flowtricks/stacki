// Taking a class or an attribute off an element from the Style panel's selector
// field: a chip selected, then Delete.
//
// Only a name written literally on this element is removed. Anything else is a
// value the page computes — `class={className}`, a `class:list` entry, a spread,
// a bound attribute — and deleting the expression that produces it would take
// more than the one name with it (or nothing at all, when a component prop feeds
// it). Those are refused with a reason the person can act on, and nothing is
// written.

import type { Attr } from '../../shared/page/pageNode';
import { assert } from '../../shared/core/assert';
import { ENGLISH_TRANSLATE } from '../../shared/properties/i18n/englishTranslator';
import type { Translator } from '../../shared/properties/i18n/messageRef';
import { namesIn } from './classAttr';

type ElementProps = Readonly<Record<string, Attr>>;

/** The prop to write (undefined value: drop the attribute), or why not. */
export type PropRemoval =
  { readonly tag: 'edit'; readonly key: string; readonly value: Attr | undefined } | { readonly tag: 'refused'; readonly reason: string };

// Attributes that are not a single removable thing: `class` holds the classes
// (removed one at a time above) and `style` holds declarations.
const ATTRIBUTES_NOT_REMOVABLE: ReadonlySet<string> = new Set(['class', 'class:list', 'style']);

/** Removes `name` from a literal `class="…"`; refuses every computed shape. */
export function classRemoval(props: ElementProps | undefined, name: string, translate: Translator = ENGLISH_TRANSLATE): PropRemoval {
  assert(name.length > 0, 'classRemoval: a class name is given');
  assert(!/\s/.test(name), 'classRemoval: one class, no whitespace');
  if (namesIn(props?.['class:list']).includes(name)) {
    return refused(translate('editor.selectorRemoval.insideClassList', { name }));
  }
  const prop = props?.['class'];
  if (prop === undefined) {
    return refused(notWritten(name, props, translate));
  }
  if (prop.type === 'string') {
    const words = namesIn(prop);
    if (!words.includes(name)) {
      return refused(notWritten(name, props, translate));
    }
    const remaining = words.filter((word) => word !== name);
    assert(remaining.length < words.length, 'classRemoval: the class was taken out');
    return remaining.length === 0 ? edit('class', undefined) : edit('class', { type: 'string', value: remaining.join(' ') });
  }
  if (prop.type === 'expr') {
    return refused(translate('editor.selectorRemoval.classExpression', { name, code: `class={${prop.value}}` }));
  }
  return refused(notWritten(name, props, translate));
}

/** Removes a literal attribute (`data-state="open"`, `hidden`); refuses a bound one. */
export function attributeRemoval(props: ElementProps | undefined, name: string, translate: Translator = ENGLISH_TRANSLATE): PropRemoval {
  assert(name.length > 0, 'attributeRemoval: an attribute name is given');
  if (ATTRIBUTES_NOT_REMOVABLE.has(name)) {
    return refused(translate('editor.selectorRemoval.notOneThing', { name }));
  }
  const prop = props?.[name];
  if (prop === undefined) {
    return refused(notWritten(name, props, translate));
  }
  switch (prop.type) {
    case 'string':
    case 'bare':
      return edit(name, undefined);
    case 'expr':
      return refused(translate('editor.selectorRemoval.bound', { name, code: `{${prop.value}}` }));
    case 'spread':
      return refused(notWritten(name, props, translate));
    default: {
      const exhaustive: never = prop;
      return exhaustive;
    }
  }
}

function edit(key: string, value: Attr | undefined): PropRemoval {
  return { tag: 'edit', key, value };
}

function refused(reason: string): PropRemoval {
  assert(reason.length > 0, 'refused: a refusal says why');
  return { tag: 'refused', reason };
}

// Not on this element's tag as written: it reaches the element some other way.
function notWritten(name: string, props: ElementProps | undefined, translate: Translator): string {
  const spread = Object.values(props ?? {}).some((prop) => prop.type === 'spread');
  return spread ? translate('editor.selectorRemoval.notWrittenSpread', { name }) : translate('editor.selectorRemoval.notWritten', { name });
}
