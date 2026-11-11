// A file's frontmatter as the CMS fields above the editor (one field per key). The block
// edits the YAML text itself, a line at a time, so every byte it does not change
// stays as written: comments, quoting, key order and line endings. Frontmatter
// that is not a flat list of `key: value` lines (nested maps, lists, block
// scalars) is shown as its YAML, edited as text.
import { assert } from '../../../shared/core/assert';
import { INSTRUCTION_LIMITS, splitFrontmatter, yamlScalar } from '../../../shared/properties/instructions';

/** How a value is edited: the CMS field its YAML reads as. Quoted text is always a string. */
export type FrontmatterFieldKind = 'string' | 'number' | 'boolean' | 'date';

export interface FrontmatterField {
  readonly key: string;
  readonly kind: FrontmatterFieldKind;
  /** The value as a person reads it: quotes taken off. */
  readonly value: string;
  /** The line it is on, counted inside the YAML (0 is the line after the opening fence). */
  readonly line: number;
}

export type FrontmatterView =
  { readonly kind: 'none' } | { readonly kind: 'fields'; readonly fields: readonly FrontmatterField[] } | { readonly kind: 'text'; readonly yaml: string };

/** Fields shown in the block at most; past it the YAML is shown as text. */
const FIELDS_MAX = 40;
const FIELD = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*?))?[ \t]*$/;

export function frontmatterView(source: string): FrontmatterView {
  const split = splitFrontmatter(source);
  if (split.raw === '') {
    return { kind: 'none' };
  }
  const lines = splitYamlLines(split.yaml);
  const fields: FrontmatterField[] = [];
  for (const [at, line] of lines.entries()) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }
    // `.` stops at a `\r`, so a Windows line is matched without it.
    const match = FIELD.exec(line.replace(/\r$/, ''));
    const raw = match?.[2] ?? '';
    if (match === null || raw === '' || /^[|>&*!{[]/.test(raw) || raw.includes(' #') || fields.length >= FIELDS_MAX) {
      return { kind: 'text', yaml: split.yaml };
    }
    const value = unquoted(raw);
    if (value === undefined) {
      return { kind: 'text', yaml: split.yaml };
    }
    fields.push({ key: match[1] ?? '', kind: kindOf(raw.replace(/\r$/, '')), value, line: at });
  }
  return fields.length === 0 ? { kind: 'text', yaml: split.yaml } : { kind: 'fields', fields };
}

const DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

// What a plain (unquoted) YAML value reads as; a quoted one is text, whatever it spells.
function kindOf(raw: string): FrontmatterFieldKind {
  if (raw.startsWith('"') || raw.startsWith("'")) {
    return 'string';
  }
  if (raw === 'true' || raw === 'false') {
    return 'boolean';
  }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) {
    return 'number';
  }
  return DATE.test(raw) ? 'date' : 'string';
}

/**
 * The file with one field's value replaced; every other byte, its quoting style included where it still fits, kept.
 * A switch or number is written as YAML reads it back (`true`, `42`); a date stays plain; text is quoted only when it must be.
 */
export function withFieldValue(source: string, field: Pick<FrontmatterField, 'key' | 'line'>, next: { readonly value: string | number | boolean }): string {
  const { value } = next;
  const split = splitFrontmatter(source);
  assert(split.raw !== '', 'A field edit is on a file with frontmatter');
  const oneLine = typeof value === 'string' ? value.replace(/\s*\n\s*/g, ' ') : String(value);
  const lines = splitYamlLines(split.yaml);
  const line = lines[field.line];
  assert(line !== undefined, 'The edited field is a line of the frontmatter');
  const match = FIELD.exec(line.replace(/\r$/, ''));
  assert(match !== null, 'The edited line is a field');
  assert(match[1] === field.key, 'The edited line is the field named');
  const previous = match[2] ?? '';
  const written =
    typeof value !== 'string' || (DATE.test(oneLine) && !/^["']/.test(previous))
      ? oneLine
      : previous.startsWith("'") && !oneLine.includes("'")
        ? `'${oneLine}'`
        : previous.startsWith('"')
          ? JSON.stringify(oneLine)
          : yamlScalar(oneLine);
  const carriage = line.endsWith('\r') ? '\r' : '';
  const replaced = [...lines.slice(0, field.line), `${field.key}: ${written}${carriage}`, ...lines.slice(field.line + 1)].join('\n');
  const opening = split.raw.slice(0, split.raw.length - split.yaml.length - closingLength(split.raw, split.yaml));
  const closing = split.raw.slice(opening.length + split.yaml.length);
  const result = opening + replaced + closing + split.body;
  assert(result.length <= INSTRUCTION_LIMITS.fileBytesMax + INSTRUCTION_LIMITS.frontmatterCharsMax, 'A field edit stays bounded');
  return result;
}

/** The file with its whole YAML replaced: the text view of the block. */
export function withFrontmatterYaml(source: string, yaml: string): string {
  const split = splitFrontmatter(source);
  assert(split.raw !== '', 'A YAML edit is on a file with frontmatter');
  const opening = split.raw.slice(0, split.raw.length - split.yaml.length - closingLength(split.raw, split.yaml));
  const closing = split.raw.slice(opening.length + split.yaml.length);
  return opening + yaml + closing + split.body;
}

// The YAML sits between the opening fence line and the closing one: find where it ends inside `raw`.
function closingLength(raw: string, yaml: string): number {
  const open = /^---[ \t]*\r?\n/.exec(raw);
  assert(open !== null, 'Frontmatter opens on a fence');
  const length = raw.length - open[0].length - yaml.length;
  assert(length > 0, 'Frontmatter closes on a fence');
  return length;
}

function splitYamlLines(yaml: string): readonly string[] {
  return yaml.split('\n');
}

// A plain, single- or double-quoted scalar as text; undefined for one the block should not guess at.
function unquoted(raw: string): string | undefined {
  const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("'")) {
    return value.length >= 2 && value.endsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : undefined;
  }
  return value;
}
