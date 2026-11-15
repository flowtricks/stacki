// Taking a class or an attribute off an element from the Style panel's selector
// field: a chip selected, then Delete.
//
// A class is removed wherever the element's tag writes it literally: a word of
// `class="…"`, and any literal the `class:list={…}` or `class={…}` expression
// gives (classExpressionRemoval.ts reads the shapes and says what removal means
// for each). A chip stands for the selector applying to the element, so every
// literal occurrence goes, in `class` and `class:list` alike, in one edit and so
// one undo step.
//
// What is left is a value the page computes — `class={className}`, a
// `...rest.class` spread, a `getClasses()` call — which may produce the class
// but can't be rewritten without changing what else it gives. Those are refused
// with the exact piece of code and where it is written, so the person can go
// there ('Show in code') rather than meet a dead end. Nothing is written then.

import type { Attr } from '../../shared/page/pageNode';
import { assert } from '../../shared/core/assert';
import { ENGLISH_TRANSLATE } from '../../shared/properties/i18n/englishTranslator';
import type { Translator } from '../../shared/properties/i18n/messageRef';
import {
  removeClassFromExpression,
  type ClassExpressionContext,
  type ClassExpressionRemoval,
  type ClassExpressionSnippet,
} from '../../shared/engine/classExpressionRemoval';
import { namesIn } from './classAttr';

type ElementProps = Readonly<Record<string, Attr>>;

/** Where the code a refusal is about is written: an attribute's expression, and a piece of it. */
export interface RemovalCodeSite {
  /** The attribute whose `{…}` holds the code: `class:list` or `class`. */
  readonly attribute: string;
  /** Offsets into that attribute's expression, as the page model holds it. */
  readonly snippet: ClassExpressionSnippet;
}

/** The props to write (undefined value: drop the attribute), or why not and where to look. */
export type PropRemoval =
  | { readonly tag: 'edit'; readonly patch: Readonly<Record<string, Attr | undefined>> }
  | { readonly tag: 'refused'; readonly reason: string; readonly site: RemovalCodeSite | undefined };

// Attributes that are not a single removable thing: `class` holds the classes
// (removed one at a time above) and `style` holds declarations.
const ATTRIBUTES_NOT_REMOVABLE: ReadonlySet<string> = new Set(['class', 'class:list', 'style']);

// The code a message quotes is cut here, so a long list never fills the toast.
export const REMOVAL_SNIPPET_CHARS_MAX = 48;

/** Removes every literal `name` from `class` and `class:list`; refuses the computed shapes, saying where they are. */
export function classRemoval(props: ElementProps | undefined, name: string, translate: Translator = ENGLISH_TRANSLATE): PropRemoval {
  assert(name.length > 0, 'classRemoval: a class name is given');
  assert(!/\s/.test(name), 'classRemoval: one class, no whitespace');
  const outcomes = [classAttributeRemoval(props?.['class'], name), listAttributeRemoval(props?.['class:list'], name)];
  // An expression Stacki can't read may hold the class too: removing only the other
  // occurrence would leave the chip in place and look like it did nothing.
  const unreadable = outcomes.find((outcome) => outcome.tag === 'unreadable');
  if (unreadable !== undefined && unreadable.tag === 'unreadable') {
    const code = unreadable.code;
    return refused(translate('editor.selectorRemoval.unreadable', { name, code: quoted(code) }), {
      attribute: unreadable.attribute,
      snippet: { code, from: 0, to: code.length },
    });
  }
  const patch: Record<string, Attr | undefined> = {};
  for (const outcome of outcomes) {
    if (outcome.tag === 'edited') {
      patch[outcome.attribute] = outcome.value;
    }
  }
  if (Object.keys(patch).length > 0) {
    assert(
      Object.keys(patch).every((key) => key === 'class' || key === 'class:list'),
      'classRemoval: only class attributes are written',
    );
    return { tag: 'edit', patch };
  }
  const computed = outcomes.find((outcome) => outcome.tag === 'computed');
  if (computed !== undefined && computed.tag === 'computed') {
    return refused(translate('editor.selectorRemoval.computed', { name, code: quoted(computed.snippet.code), attribute: computed.attribute }), {
      attribute: computed.attribute,
      snippet: computed.snippet,
    });
  }
  return refused(notWritten(name, props, translate), undefined);
}

/** Removes a literal attribute (`data-state="open"`, `hidden`); refuses a bound one. */
export function attributeRemoval(props: ElementProps | undefined, name: string, translate: Translator = ENGLISH_TRANSLATE): PropRemoval {
  assert(name.length > 0, 'attributeRemoval: an attribute name is given');
  if (ATTRIBUTES_NOT_REMOVABLE.has(name)) {
    return refused(translate('editor.selectorRemoval.notOneThing', { name }), undefined);
  }
  const prop = props?.[name];
  if (prop === undefined) {
    return refused(notWritten(name, props, translate), undefined);
  }
  switch (prop.type) {
    case 'string':
    case 'bare':
      return { tag: 'edit', patch: { [name]: undefined } };
    case 'expr':
      return refused(translate('editor.selectorRemoval.bound', { name, code: `{${prop.value}}` }), {
        attribute: name,
        snippet: { code: prop.value, from: 0, to: prop.value.length },
      });
    case 'spread':
      return refused(notWritten(name, props, translate), undefined);
    default: {
      const exhaustive: never = prop;
      return exhaustive;
    }
  }
}

/** `code` cut to what a message can show, with an ellipsis where it was cut. */
export function quoted(code: string): string {
  const flat = code.replace(/\s+/g, ' ').trim();
  if (flat.length <= REMOVAL_SNIPPET_CHARS_MAX) {
    return flat;
  }
  return `${flat.slice(0, REMOVAL_SNIPPET_CHARS_MAX - 1)}…`;
}

// What one class attribute does about the class: nothing to do, an edit, computed
// code that may hold it, or code that can't be read.
type AttributeOutcome =
  | { readonly tag: 'absent' }
  | { readonly tag: 'edited'; readonly attribute: string; readonly value: Attr | undefined }
  | { readonly tag: 'computed'; readonly attribute: string; readonly snippet: ClassExpressionSnippet }
  | { readonly tag: 'unreadable'; readonly attribute: string; readonly code: string };

function classAttributeRemoval(prop: Attr | undefined, name: string): AttributeOutcome {
  if (prop === undefined) {
    return { tag: 'absent' };
  }
  switch (prop.type) {
    case 'string':
      return wordRemoval('class', prop.value, name);
    case 'expr':
      return expressionOutcome('class', prop.value, removeClassFromExpression(prop.value, name, 'string'));
    case 'bare':
    case 'spread':
      return { tag: 'absent' };
    default: {
      const exhaustive: never = prop;
      return exhaustive;
    }
  }
}

function listAttributeRemoval(prop: Attr | undefined, name: string): AttributeOutcome {
  if (prop === undefined) {
    return { tag: 'absent' };
  }
  switch (prop.type) {
    case 'string':
      // `class:list="a b"` is unusual but legal: a list of one string.
      return wordRemoval('class:list', prop.value, name);
    case 'expr': {
      const context: ClassExpressionContext = 'list';
      return expressionOutcome('class:list', prop.value, removeClassFromExpression(prop.value, name, context));
    }
    case 'bare':
    case 'spread':
      return { tag: 'absent' };
    default: {
      const exhaustive: never = prop;
      return exhaustive;
    }
  }
}

function wordRemoval(attribute: string, value: string, name: string): AttributeOutcome {
  const words = namesIn({ type: 'string', value });
  if (!words.includes(name)) {
    return { tag: 'absent' };
  }
  const remaining = words.filter((word) => word !== name);
  assert(remaining.length < words.length, 'wordRemoval: the class was taken out');
  return { tag: 'edited', attribute, value: remaining.length === 0 ? undefined : { type: 'string', value: remaining.join(' ') } };
}

function expressionOutcome(attribute: string, code: string, removal: ClassExpressionRemoval): AttributeOutcome {
  switch (removal.tag) {
    case 'edited':
      return { tag: 'edited', attribute, value: removal.code === undefined ? undefined : { type: 'expr', value: removal.code } };
    case 'absent':
      return { tag: 'absent' };
    case 'computed': {
      const snippet = removal.snippets[0];
      assert(snippet !== undefined, 'expressionOutcome: computed code names where it is');
      return { tag: 'computed', attribute, snippet };
    }
    case 'unreadable':
      return { tag: 'unreadable', attribute, code };
    default: {
      const exhaustive: never = removal;
      return exhaustive;
    }
  }
}

function refused(reason: string, site: RemovalCodeSite | undefined): PropRemoval {
  assert(reason.length > 0, 'refused: a refusal says why');
  return { tag: 'refused', reason, site };
}

// Not on this element's tag as written: it reaches the element some other way.
function notWritten(name: string, props: ElementProps | undefined, translate: Translator): string {
  const spread = Object.values(props ?? {}).some((prop) => prop.type === 'spread');
  return spread ? translate('editor.selectorRemoval.notWrittenSpread', { name }) : translate('editor.selectorRemoval.notWritten', { name });
}
