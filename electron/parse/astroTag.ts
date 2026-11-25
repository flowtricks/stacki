// One balanced tag reader serves template parsing and conditional scanning so
// operators and braces inside props cannot turn surrounding markup into code.
import { assert } from '../../shared/core/assert';
import { findMatchingBrace } from './astroLexical';

export interface ScannedTag {
  readonly full: string;
  readonly name: string;
  readonly attrs: string;
  readonly selfClose: string;
  readonly end: number;
}

const TAG_NAME = /<([A-Za-z][\w.-]*)/y;

export function scanTag(source: string, start: number): ScannedTag | undefined {
  TAG_NAME.lastIndex = start;
  const match = TAG_NAME.exec(source);
  if (!match) {
    return undefined;
  }
  const name = match[1];
  assert(name !== undefined, 'A matched tag has a name');
  const attrsAt = start + match[0].length;
  if (!/[\s/>]/.test(source.charAt(attrsAt))) {
    return undefined;
  }
  for (let position = attrsAt; position < source.length; position++) {
    const character = source.charAt(position);
    if (character === '>') {
      const selfClose = source.charAt(position - 1) === '/' ? '/' : '';
      assert(position >= attrsAt, 'A tag ends after its name');
      return {
        full: source.slice(start, position + 1),
        name,
        attrs: source.slice(attrsAt, position - selfClose.length),
        selfClose,
        end: position + 1,
      };
    }
    if (character === '<') {
      return undefined; // Comments and child tags cannot occur inside an opening tag.
    }
    if (character === '{') {
      const end = findMatchingBrace(source, position);
      if (end === -1) {
        return undefined;
      }
      position = end;
    } else if (character === '"' || character === "'") {
      const end = source.indexOf(character, position + 1);
      if (end === -1) {
        return undefined;
      }
      position = end;
    }
  }
  return undefined;
}
