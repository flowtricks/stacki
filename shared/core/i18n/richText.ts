// i18n-ignore-file: these are developer diagnostics for a malformed rich message or a call that offers the wrong tags; programmer errors, not interface text.
// Rich messages: a sentence with inline code, a link or emphasis in the middle of it (docs/i18n-playbook.md,
// "Rich text"). The message is one template with two kinds of marks, so a translator can move them
// wherever the language needs them:
//
//   'Saved in {file} for Desktop and Studio.'          {name}   a slot: the renderer supplies a value or an element
//   'Read the <link>guide</link> for details.'          <name>   a tag: the renderer wraps the text between the marks
//
// Nothing here knows about React or the DOM. This file turns a template into a bounded tree of parts and picks
// the right template from the active catalog; `src/lib/i18n/translateRich.tsx` turns the parts into elements, so
// nothing is ever parsed as HTML and `dangerouslySetInnerHTML` has no place in a translated sentence.
import { assert } from '../assert';
import { err, ok, type Result } from '../result';
import { pluralTemplate, type MessageValue, type TranslatorOptions } from './catalog';
import type { Locale } from './locales';

/** Bounds on a rich message (AGENTS.md §10): a template cannot nest or repeat marks without limit. */
export const RICH_LIMITS = {
  /** Tags inside tags: `<link><code>x</code></link>` is two. */
  tagDepthMax: 4,
  /** Tags in one message. */
  tagsMax: 16,
  /** Slots in one message. */
  slotsMax: 16,
} as const satisfies Record<string, number>;

export type RichPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'slot'; readonly name: string }
  | { readonly kind: 'tag'; readonly name: string; readonly children: readonly RichPart[] };

/** What a call site offers a rich message: the slots and tags it can fill, and the plural count if there is one. */
export interface RichRequest {
  readonly count?: number;
  readonly slots: readonly string[];
  readonly tags: readonly string[];
}

export type RichTranslate<K extends string> = (key: K, request: RichRequest) => readonly RichPart[];

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
const TAG_PATTERN = /<(\/?)([a-z][A-Za-z0-9]*)>/y;

interface Frame {
  readonly name: string | undefined;
  readonly children: RichPart[];
}

/**
 * Parses `{slot}` and `<tag>…</tag>` marks. `{{` and `}}` are literal braces, as in a plain message; a `<` that does not
 * open a well-formed `<name>` or `</name>` is ordinary text. A stray `}`, an unclosed `{`, a mismatched or unclosed tag,
 * and any bound exceeded are error values, never a guess.
 */
export function parseRichTemplate(template: string): Result<readonly RichPart[]> {
  assert(typeof template === 'string', 'parseRichTemplate: the template is a string');
  const frames: Frame[] = [{ name: undefined, children: [] }];
  let text = '';
  let index = 0;
  let tagCount = 0;
  let slotCount = 0;
  // One pass, left to right; every branch moves `index` forward, and the template's length is bounded by the caller.
  while (index < template.length) {
    const character = template.charAt(index);
    const next = template.charAt(index + 1);
    const top = frames[frames.length - 1];
    assert(top !== undefined, 'parseRichTemplate: the frame stack is never empty');
    if (character === '{' && next === '{') {
      text += '{';
      index += 2;
    } else if (character === '}' && next === '}') {
      text += '}';
      index += 2;
    } else if (character === '}') {
      return err({ code: 'bad-placeholder', message: `Stray "}" at ${index}` });
    } else if (character === '{') {
      const close = template.indexOf('}', index);
      if (close < 0) {
        return err({ code: 'bad-placeholder', message: `Unclosed "{" at ${index}` });
      }
      const name = template.slice(index + 1, close);
      if (!NAME_PATTERN.test(name)) {
        return err({ code: 'bad-placeholder', message: `Bad slot "{${name}}"` });
      }
      slotCount += 1;
      if (slotCount > RICH_LIMITS.slotsMax) {
        return err({ code: 'too-many-slots', message: 'Message exceeds the slot limit' });
      }
      text = flushText(top, text);
      top.children.push({ kind: 'slot', name });
      index = close + 1;
    } else if (character === '<') {
      TAG_PATTERN.lastIndex = index;
      const match = TAG_PATTERN.exec(template);
      if (match === null) {
        text += character;
        index += 1;
      } else {
        const closing = match[1] === '/';
        const name = match[2];
        assert(name !== undefined, 'parseRichTemplate: the tag pattern captures a name');
        text = flushText(top, text);
        if (closing) {
          if (top.name !== name) {
            return err({ code: 'bad-tag', message: `Closing </${name}> does not match ${top.name === undefined ? 'an open tag' : `<${top.name}>`}` });
          }
          frames.pop();
          const parent = frames[frames.length - 1];
          assert(parent !== undefined, 'parseRichTemplate: a closed tag has a parent');
          parent.children.push({ kind: 'tag', name, children: top.children });
        } else {
          tagCount += 1;
          if (tagCount > RICH_LIMITS.tagsMax) {
            return err({ code: 'too-many-tags', message: 'Message exceeds the tag limit' });
          }
          if (frames.length > RICH_LIMITS.tagDepthMax) {
            return err({ code: 'tags-too-deep', message: 'Message nests tags too deeply' });
          }
          frames.push({ name, children: [] });
        }
        index += match[0].length;
      }
    } else {
      text += character;
      index += 1;
    }
  }
  const root = frames[0];
  assert(root !== undefined, 'parseRichTemplate: the root frame exists');
  if (frames.length > 1) {
    return err({ code: 'bad-tag', message: `Unclosed <${frames[frames.length - 1]?.name ?? '?'}>` });
  }
  flushText(root, text);
  return ok(root.children);
}

function flushText(frame: Frame, text: string): string {
  if (text.length > 0) {
    frame.children.push({ kind: 'text', text });
  }
  return '';
}

/** The slot and tag names a parsed message uses, each once, sorted: what a translation must also use, and nothing else. */
export function richNamesOf(parts: readonly RichPart[]): { readonly slots: readonly string[]; readonly tags: readonly string[] } {
  const slots = new Set<string>();
  const tags = new Set<string>();
  const pending: RichPart[] = [...parts];
  // Bounded by the parser: at most slotsMax + tagsMax + the text parts between them.
  let steps = 0;
  while (pending.length > 0 && steps < 4_096) {
    steps += 1;
    const part = pending.pop();
    assert(part !== undefined, 'richNamesOf: pending is not empty');
    if (part.kind === 'slot') {
      slots.add(part.name);
    } else if (part.kind === 'tag') {
      tags.add(part.name);
      pending.push(...part.children);
    }
  }
  return { slots: [...slots].sort(), tags: [...tags].sort() };
}

/** The slot and tag names of a template, or why it is malformed. The parity test compares these across languages. */
export function richNamesOfTemplate(template: string): Result<{ readonly slots: readonly string[]; readonly tags: readonly string[] }> {
  const parsed = parseRichTemplate(template);
  return parsed.ok ? ok(richNamesOf(parsed.value)) : parsed;
}

/**
 * A `translateRich` core for one language. Like `createTranslator`, a missing or unusable translation (a mark the call site did
 * not offer, a malformed template) reports an issue and falls back to English, so the interface shows a sentence, never a key.
 * English itself must fit the call site: a mismatch there is a programmer error and asserts.
 */
export function createRichTranslator<K extends string>(options: TranslatorOptions<K>): RichTranslate<K> {
  assert(Object.keys(options.fallback).length > 0, 'createRichTranslator: the English catalog is not empty');
  return (key, request) => {
    const english = options.fallback[key];
    assert(english !== undefined, `translateRich: "${key}" is not an English message`);
    const params = request.count === undefined ? {} : { count: request.count };
    const translated = Object.hasOwn(options.catalog, key) ? options.catalog[key] : undefined;
    if (translated !== undefined && options.locale !== 'en') {
      const parts = richPartsFor(options.locale, translated, params, request);
      if (parts.ok) {
        return parts.value;
      }
      options.onIssue({ kind: 'bad-message', locale: options.locale, key, reason: parts.error.message });
    } else if (options.locale !== 'en') {
      options.onIssue({ kind: 'missing-key', locale: options.locale, key });
    }
    const fallbackParts = richPartsFor('en', english, params, request);
    assert(fallbackParts.ok, `translateRich: English "${key}" fits the slots and tags the call site passed`);
    return fallbackParts.value;
  };
}

function richPartsFor(locale: Locale, value: MessageValue, params: { readonly count?: number }, request: RichRequest): Result<readonly RichPart[]> {
  const template = pluralTemplate(locale, value, params);
  if (!template.ok) {
    return template;
  }
  const parsed = parseRichTemplate(template.value);
  if (!parsed.ok) {
    return parsed;
  }
  const names = richNamesOf(parsed.value);
  for (const slot of names.slots) {
    if (!request.slots.includes(slot)) {
      return err({ code: 'unknown-slot', message: `The call site offers no slot {${slot}}` });
    }
  }
  for (const tag of names.tags) {
    if (!request.tags.includes(tag)) {
      return err({ code: 'unknown-tag', message: `The call site offers no tag <${tag}>` });
    }
  }
  return ok(parsed.value);
}
