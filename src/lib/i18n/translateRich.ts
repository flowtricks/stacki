// Renders a rich message (shared/core/i18n/richText.ts) as React nodes: `{slot}` marks become the node the call site passed,
// and `<tag>…</tag>` marks wrap the translated text in the element the call site's function returns. Every piece of text
// reaches React as a string child, so a translation can never inject markup (no `dangerouslySetInnerHTML`, no HTML parsing).
import { createElement, Fragment, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import { RICH_LIMITS, type RichPart, type RichTranslate } from '../../../shared/core/i18n/richText';
import type { MessageKey } from '../../../shared/properties/i18n/messages/en/index';

/** What a `<tag>` mark becomes: a function from the already-translated children to an element, e.g. `(text) => <CodeInline>{text}</CodeInline>`. */
export type RichTag = (children: ReactNode) => ReactNode;

/**
 * What a call site passes: a value or element for each `{slot}`, a function for each `<tag>`. A number named `count` also selects the plural
 * form. A mark the message uses that is missing here is a programmer error and asserts; a translation that uses one the call site did not offer
 * falls back to English with a console warning.
 */
export type RichSlots = Readonly<Record<string, ReactNode | RichTag>>;

export type RichTranslator = (key: MessageKey, slots?: RichSlots) => ReactNode;

export function createReactRichTranslator(partsFor: RichTranslate<MessageKey>): RichTranslator {
  return (key, slots = {}) => {
    const names = Object.keys(slots);
    const tags = names.filter((name) => typeof slots[name] === 'function');
    const values = names.filter((name) => typeof slots[name] !== 'function');
    const count = slots['count'];
    const parts = partsFor(key, { slots: values, tags, ...(typeof count === 'number' ? { count } : {}) });
    return renderParts(parts, slots, 0);
  };
}

function renderParts(parts: readonly RichPart[], slots: RichSlots, depth: number): ReactNode {
  assert(depth <= RICH_LIMITS.tagDepthMax, 'translateRich: tags nest no deeper than the parser allows');
  return parts.map((part, index) => {
    switch (part.kind) {
      case 'text':
        return createElement(Fragment, { key: index }, part.text);
      case 'slot': {
        const value = slots[part.name];
        assert(typeof value !== 'function', `translateRich: {${part.name}} is a slot, not a tag`);
        return createElement(Fragment, { key: index }, value);
      }
      case 'tag': {
        const wrap = slots[part.name];
        assert(typeof wrap === 'function', `translateRich: <${part.name}> needs a tag function`);
        return createElement(Fragment, { key: index }, wrap(renderParts(part.children, slots, depth + 1)));
      }
      default: {
        const exhaustive: never = part;
        return exhaustive;
      }
    }
  });
}
