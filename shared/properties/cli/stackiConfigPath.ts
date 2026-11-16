// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// The path a `stacki config` command names inside a `.stacki` file: `columns.kind`, `entries[3]`, `components["Card.astro"].tag`.
//
// Why not JSON Pointer: agents and people type these on a command line, and a key such as `src/Card.astro` or `a.b`
// must be writable without escaping rules; a bracketed, quoted key is unambiguous and reads like the JSON it names.
import { err, ok, type Result } from '../../core/result';

export const CONFIG_PATH_LIMITS = {
  /** Steps in one path. Settings files nest a handful of levels. */
  segmentsMax: 16,
  /** Characters in one key. */
  segmentCharsMax: 512,
  /** Characters in a whole path text. */
  pathCharsMax: 4096,
} as const satisfies Record<string, number>;

export type PathSegment = string | number;

const PLAIN_KEY = /^[A-Za-z0-9_$:*@-]+$/u;

/** A path text read into segments: names for keys, numbers for list positions. */
export function parseConfigPath(source: string): Result<readonly PathSegment[]> {
  if (source.length > CONFIG_PATH_LIMITS.pathCharsMax) {
    return failure(`The path is longer than ${CONFIG_PATH_LIMITS.pathCharsMax} characters.`);
  }
  const segments: PathSegment[] = [];
  let position = 0;
  for (let step = 0; step <= CONFIG_PATH_LIMITS.pathCharsMax && position < source.length; step += 1) {
    if (segments.length >= CONFIG_PATH_LIMITS.segmentsMax) {
      return failure(`The path has more than ${CONFIG_PATH_LIMITS.segmentsMax} steps.`);
    }
    const character = source.charAt(position);
    const read = character === '[' ? readBracket(source, position) : readName(source, position, segments.length === 0 ? 'first' : 'later');
    if (!read.ok) {
      return read;
    }
    segments.push(read.value.segment);
    position = read.value.next;
  }
  return ok(segments);
}

/** The path as text, the inverse of `parseConfigPath`. */
export function formatConfigPath(segments: readonly PathSegment[]): string {
  let text = '';
  for (const [index, segment] of segments.entries()) {
    if (typeof segment === 'number') {
      text += `[${segment}]`;
    } else if (PLAIN_KEY.test(segment) && !/^\d+$/u.test(segment)) {
      text += index === 0 ? segment : `.${segment}`;
    } else {
      text += `[${JSON.stringify(segment)}]`;
    }
  }
  return text;
}

interface Read {
  readonly segment: PathSegment;
  readonly next: number;
}

function readName(source: string, start: number, place: 'first' | 'later'): Result<Read> {
  let position = start;
  if (place === 'later') {
    if (source.charAt(position) !== '.') {
      return failure(`Expected "." or "[" at position ${position} of "${source}".`);
    }
    position += 1;
  }
  let end = position;
  for (let step = 0; step <= CONFIG_PATH_LIMITS.pathCharsMax && end < source.length; step += 1) {
    const character = source.charAt(end);
    if (character === '.' || character === '[') {
      break;
    }
    end += 1;
  }
  const name = source.slice(position, end);
  if (name.length === 0 || name.length > CONFIG_PATH_LIMITS.segmentCharsMax || !PLAIN_KEY.test(name)) {
    return failure(`"${name}" is not a plain key at position ${position}; write odd keys as ["key"].`);
  }
  return ok({ segment: name, next: end });
}

function readBracket(source: string, start: number): Result<Read> {
  const quote = source.charAt(start + 1);
  if (quote === '"') {
    return readQuoted(source, start);
  }
  const close = source.indexOf(']', start);
  const inner = close < 0 ? '' : source.slice(start + 1, close);
  if (!/^\d{1,9}$/u.test(inner)) {
    return failure(`Expected a list position or a quoted key in brackets at position ${start} of "${source}".`);
  }
  return ok({ segment: Number(inner), next: close + 1 });
}

function readQuoted(source: string, start: number): Result<Read> {
  // The quoted key is a JSON string, so every escape a JSON string has works here too.
  let end = start + 2;
  for (let step = 0; step <= CONFIG_PATH_LIMITS.pathCharsMax && end < source.length; step += 1) {
    const character = source.charAt(end);
    if (character === '\\') {
      end += 2;
    } else if (character === '"') {
      break;
    } else {
      end += 1;
    }
  }
  if (source.charAt(end) !== '"' || source.charAt(end + 1) !== ']') {
    return failure(`The quoted key at position ${start} of "${source}" is not closed with "] .`);
  }
  let key: unknown;
  try {
    key = JSON.parse(source.slice(start + 1, end + 1));
  } catch {
    return failure(`The quoted key at position ${start} of "${source}" is not valid JSON text.`);
  }
  if (typeof key !== 'string' || key.length === 0 || key.length > CONFIG_PATH_LIMITS.segmentCharsMax) {
    return failure(`The quoted key at position ${start} must be 1 to ${CONFIG_PATH_LIMITS.segmentCharsMax} characters.`);
  }
  return ok({ segment: key, next: end + 2 });
}

function failure(message: string): Result<never> {
  return err({ code: 'bad-path', message });
}
