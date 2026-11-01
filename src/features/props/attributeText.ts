// Attributes as text: an attribute's value decoded for a field and encoded
// back, its display name, a pasted run of name=value pairs, and an object
// literal read into rows and written back (propAttributes.tsx).

import type { Attr } from '../../../shared/page/pageNode';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';

export interface AttributePair {
  readonly name: string;
  readonly value: string;
}
export interface ObjectEntry {
  readonly key: string;
  readonly raw: string;
}

export const decodeAttr = (attribute: Attr | undefined) =>
  attribute === undefined || attribute.type === 'bare' ? '' : attribute.type === 'expr' ? `{${attribute.value}}` : String(attribute.value);

export const attributeDisplayName = (name: string, value: Attr | undefined): string => (value?.type === 'spread' ? `{...${value.value}}` : name);

export const encodeAttr = (text: string): Attr => {
  if (text === '') {
    return { type: 'bare' };
  }
  const match = text.match(/^\{([\s\S]*)\}$/);
  if (match) {
    return { type: 'expr', value: (match[1] ?? '').trim() };
  }
  return { type: 'string', value: text };
};

export const ATTR_PASTE_RE = /([\w@:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\{(?:[^{}]|\{[^{}]*\})*\})|([^\s]+)))?/g;

export function parseAttrPaste(text: string): readonly AttributePair[] {
  if (text.length > LIMITS.attrCharsMax) {
    return [];
  }
  const out: AttributePair[] = [];
  ATTR_PASTE_RE.lastIndex = 0;
  let match;
  while ((match = ATTR_PASTE_RE.exec(text)) !== null) {
    if (!match[0].trim()) {
      continue;
    }
    const value = match[2] ?? match[3] ?? match[4] ?? match[5];
    if (out.length === LIMITS.attrsPerNodeMax) {
      return [];
    }
    out.push({ name: match[1] ?? '', value: value === undefined ? '' : value });
  }
  return out;
}

export function parseObjectLiteral(input: unknown): readonly ObjectEntry[] | undefined {
  const text = String(input ?? '').trim();
  if (text.length > LIMITS.attrCharsMax) {
    return undefined;
  }
  const match = text.match(/^\{([\s\S]*)\}$/);
  if (!match) {
    return text === '' ? [] : undefined;
  }
  const inner = (match[1] ?? '').trim();
  if (!inner) {
    return [];
  }
  if (/[{}]|\.\.\./.test(inner)) {
    return undefined;
  }
  const entries = [];
  const re = new RegExp(
    /\s*(?:"([^"]*)"|'([^']*)'|([\w$@:.-]+))\s*:\s*/.source + /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[^,]+?)\s*(?:,|$)/.source,
    'y',
  );
  let position = 0;
  while (position < inner.length) {
    re.lastIndex = position;
    const em = re.exec(inner);
    if (!em) {
      return undefined;
    }
    if (entries.length === LIMITS.attrsPerNodeMax) {
      return undefined;
    }
    entries.push({ key: em[1] ?? em[2] ?? em[3] ?? '', raw: (em[4] ?? '').trim() });
    position = re.lastIndex;
  }
  return entries;
}

export function serializeObjectLiteral(entries: readonly ObjectEntry[]) {
  assert(entries.length <= LIMITS.attrsPerNodeMax, 'Object attributes: entry limit exceeded');
  const body = entries
    .map((entry) => {
      const key = /^[A-Za-z_$][\w$]*$/.test(entry.key) ? entry.key : JSON.stringify(entry.key);
      return `${key}: ${entry.raw}`;
    })
    .join(', ');
  const text = `{ ${body} }`;
  assert(text.length <= LIMITS.attrCharsMax, 'Object attributes: output limit exceeded');
  return text;
}

export const decodeRaw = (raw: string) => {
  const match = String(raw).match(/^"((?:[^"\\]|\\.)*)"$|^'((?:[^'\\]|\\.)*)'$/);
  if (match) {
    return (match[1] ?? match[2] ?? '').replace(/\\(.)/g, '$1');
  }
  return raw === 'true' ? '' : `{${raw}}`;
};

export const encodeRaw = (text: string) => {
  if (text === '') {
    return 'true';
  }
  const match = text.match(/^\{([\s\S]*)\}$/);
  if (match) {
    return (match[1] ?? '').trim() || 'true';
  }
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};
