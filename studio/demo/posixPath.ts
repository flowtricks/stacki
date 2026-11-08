// `node:path` for the CSS variable engine in the demo page. The engine runs against an
// in-memory project rooted at `/studio`, so POSIX paths are all it ever sees. Only the
// functions it calls exist here; a call to any other fails the bundle, not the page.
import { assert } from '../vendor/stacki/shared/core/assert';

const SEGMENTS_MAX = 256;

export const sep = '/';

function normalized(segments: readonly string[]): string[] {
  assert(segments.length <= SEGMENTS_MAX, 'A demo path stays under its segment limit');
  const result: string[] = [];
  for (const segment of segments) {
    if (segment === '..') {
      result.pop();
    } else if (segment !== '' && segment !== '.') {
      result.push(segment);
    }
  }
  return result;
}

export function resolve(...parts: readonly string[]): string {
  let start = 0;
  for (let index = parts.length - 1; index >= 0; index--) {
    if (parts[index]?.startsWith('/') === true) {
      start = index;
      break;
    }
  }
  const joined = parts.slice(start).join('/');
  assert(joined.startsWith('/'), 'The engine only resolves against its absolute root');
  return `/${normalized(joined.split('/')).join('/')}`;
}

export function join(...parts: readonly string[]): string {
  const joined = parts.filter((part) => part !== '').join('/');
  const body = normalized(joined.split('/')).join('/');
  return joined.startsWith('/') ? `/${body}` : body || '.';
}

export function relative(from: string, to: string): string {
  const source = normalized(resolve(from).split('/'));
  const target = normalized(resolve(to).split('/'));
  let shared = 0;
  while (shared < source.length && shared < target.length && source[shared] === target[shared]) {
    shared++;
  }
  return [...source.slice(shared).map(() => '..'), ...target.slice(shared)].join('/');
}

export function basename(file: string): string {
  return normalized(file.split('/')).at(-1) ?? '';
}

export default { sep, resolve, join, relative, basename };
