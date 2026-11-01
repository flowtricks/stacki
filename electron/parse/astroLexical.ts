// JavaScript regions in Astro attributes need balanced scanning: object depth,
// nested template interpolations and regex contents cannot define tag boundaries.
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';

export function findMatchingBrace(code: string, start: number): number {
  return findMatchingDelimiter(code, start, '{', '}');
}

export function findMatchingParen(code: string, start: number): number {
  return findMatchingDelimiter(code, start, '(', ')');
}

export function skipStringOrComment(code: string, start: number): number {
  return skipLiteral(code, start, 0);
}

function findMatchingDelimiter(code: string, start: number, open: string, close: string, nesting = 0): number {
  if (nesting > LIMITS.treeDepthMax) {
    return -1;
  }
  assert(code.charAt(start) === open, 'Delimiter scanning starts at its opening token');
  let depth = 0;
  for (let position = start; position < code.length; position++) {
    const skipped = skipLiteral(code, position, nesting);
    if (skipped !== position) {
      position = skipped - 1;
      continue;
    }
    const character = code.charAt(position);
    if (character === open) {
      depth++;
    } else if (character === close) {
      depth--;
      if (depth === 0) {
        assert(position > start, 'A matching delimiter follows its opener');
        return position;
      }
    }
  }
  return -1;
}

function skipLiteral(code: string, start: number, nesting: number): number {
  const character = code.charAt(start);
  if (character === '`') {
    return skipTemplate(code, start, nesting);
  }
  if (character === '"' || character === "'") {
    // JSX prose can contain apostrophes; only a closed JavaScript string counts.
    return skipQuoted(code, start, character);
  }
  if (character !== '/') {
    return start;
  }
  if (code.charAt(start + 1) === '/') {
    if (code.charAt(start - 1) === ':') {
      return start; // A literal URL in JSX text is not a line comment.
    }
    const end = code.indexOf('\n', start + 2);
    return end === -1 ? code.length : end;
  }
  if (code.charAt(start + 1) === '*') {
    const end = code.indexOf('*/', start + 2);
    return end === -1 ? code.length : end + 2;
  }
  return regexCanStart(code, start) ? skipRegex(code, start) : start;
}

function skipQuoted(code: string, start: number, quote: string): number {
  for (let position = start + 1; position < code.length; position++) {
    const character = code.charAt(position);
    if (character === '\\') {
      position++;
    } else if (character === quote) {
      return position + 1;
    } else if (character === '\n' || character === '\r') {
      return start;
    }
  }
  return start;
}

function skipTemplate(code: string, start: number, nesting: number): number {
  if (nesting >= LIMITS.treeDepthMax) {
    return code.length;
  }
  for (let position = start + 1; position < code.length; position++) {
    const character = code.charAt(position);
    if (character === '\\') {
      position++;
    } else if (character === '`') {
      return position + 1;
    } else if (character === '$' && code.charAt(position + 1) === '{') {
      const end = findMatchingDelimiter(code, position + 1, '{', '}', nesting + 1);
      if (end === -1) {
        return code.length;
      }
      position = end;
    }
  }
  return code.length;
}

function regexCanStart(code: string, start: number): boolean {
  let position = start - 1;
  while (position >= 0 && /\s/.test(code.charAt(position))) {
    position--;
  }
  if (position < 0) {
    return true;
  }
  if ('([{=:,;!?&|'.includes(code.charAt(position))) {
    return true;
  }
  const end = position + 1;
  while (position >= 0 && /[\w$]/.test(code.charAt(position))) {
    position--;
  }
  return /^(return|throw|case|typeof|void|delete|yield|await)$/.test(code.slice(position + 1, end));
}

function skipRegex(code: string, start: number): number {
  let characterClass = false;
  for (let position = start + 1; position < code.length; position++) {
    const character = code.charAt(position);
    if (character === '\\') {
      position++;
    } else if (character === '\n' || character === '\r') {
      return start;
    } else if (character === '[') {
      characterClass = true;
    } else if (character === ']') {
      characterClass = false;
    } else if (character === '/' && !characterClass) {
      return position + 1;
    }
  }
  return start;
}
