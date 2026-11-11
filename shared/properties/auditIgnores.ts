// `.stacki/audits.json`: how a project audits itself. It is tracked, so the
// whole team shares one list of ignored findings (each with the reason someone
// gave) and one configuration of the checks: which run and how loud, the
// design-token rules, and the placeholder phrases.
//
//   {
//     "version": 2,
//     "ignored": [{ "id": "img-alt|src/pages/index.astro|0.3|src=\"/a.png\"", "reason": "Decorative hero" }],
//     "checks": { "token-value": { "enabled": false }, "token-color": { "priority": "high" } },
//     "tokens": { "properties": ["border-radius", "gap"], "colors": true, "px": false, "remOutsideVariables": true, "allowed": ["1px", "100%"] },
//     "placeholders": ["lorem ipsum", "button text"]
//   }
//
// One file, not a second `.stacki/lint.json`: ignores and settings are both "how
// this project's audit behaves", are edited from the same panel and Settings tab,
// and one file means one write witnessed against one set of bytes. Version 1
// (ignores only) still reads; it is written back as version 2.
//
// An id is the finding's own (shared/page/auditFindings.ts findingId), so an
// ignore follows the finding while the file holds still and lapses when the
// markup it named moves. The parser is the boundary: a hand-edited file is
// checked in full, bounds included, before the panel reads a single entry.
import { assert } from '../core/assert';
import { toArray, toRecord } from '../core/record';

export const AUDIT_IGNORES_FILE = '.stacki/audits.json';

export const AUDIT_IGNORE_LIMITS = {
  entriesMax: 2_000,
  idCharsMax: 1_024,
  reasonCharsMax: 500,
  checksMax: 100,
  listItemsMax: 200,
  listItemCharsMax: 120,
} as const satisfies Record<string, number>;

export interface AuditIgnore {
  readonly id: string;
  readonly reason: string;
}

export const AUDIT_SETTING_PRIORITIES = ['high', 'medium', 'low'] as const;
export type AuditSettingPriority = (typeof AUDIT_SETTING_PRIORITIES)[number];

/** One check's override: off, or louder or quieter than its default. */
export interface AuditCheckSetting {
  readonly enabled: boolean;
  readonly priority: AuditSettingPriority | undefined;
}

/** The design-token linter's rules. */
export interface AuditTokenSettings {
  /** Properties whose values must come from variables; `padding*` matches every padding longhand. */
  readonly properties: readonly string[];
  /** Raw hex, rgb() and hsl() colours are flagged. */
  readonly colors: boolean;
  /** Any px value outside a variable definition is flagged. */
  readonly px: boolean;
  /** Any rem value outside a variable definition is flagged. */
  readonly remOutsideVariables: boolean;
  /** Raw values that are fine as written, compared lower-cased: `0`, `auto`, `1px`, `100%`. */
  readonly allowed: readonly string[];
}

export interface AuditFile {
  readonly version: 2;
  /** Unique by id, in the order they were added. */
  readonly ignored: readonly AuditIgnore[];
  /** Overrides by check id; a check not named keeps its defaults. */
  readonly checks: Readonly<Record<string, AuditCheckSetting>>;
  readonly tokens: AuditTokenSettings;
  /** Phrases that mark copy as placeholder: one word must be the whole text, several may be part of it. */
  readonly placeholders: readonly string[];
}

/** Kept for callers that only read and write ignores. */
export type AuditIgnores = AuditFile;

export const DEFAULT_TOKEN_SETTINGS: AuditTokenSettings = {
  properties: ['border-radius', 'gap', 'row-gap', 'column-gap', 'font-size', 'line-height', 'letter-spacing', 'padding*', 'margin*', 'width', 'max-width'],
  colors: true,
  px: false,
  remOutsideVariables: false,
  allowed: ['0', 'auto', 'inherit', 'initial', 'unset', 'currentcolor', 'transparent', 'none', 'normal', '100%'],
};

export const DEFAULT_PLACEHOLDERS: readonly string[] = [
  'lorem',
  'lorem ipsum',
  'ipsum dolor',
  'dolor sit amet',
  'button text',
  'heading',
  'subheading',
  'text alongside',
  'your text here',
  'sample text',
  'body text',
  'link text',
  'title goes here',
  'placeholder',
  'example',
  'example text',
  'heading text',
  'paragraph text',
  'add your text',
  'text goes here',
];

export const EMPTY_AUDIT_IGNORES: AuditFile = { version: 2, ignored: [], checks: {}, tokens: DEFAULT_TOKEN_SETTINGS, placeholders: DEFAULT_PLACEHOLDERS };

const TOP_FIELDS = ['version', 'ignored', 'checks', 'tokens', 'placeholders'] as const;
const TOKEN_FIELDS = ['properties', 'colors', 'px', 'remOutsideVariables', 'allowed'] as const;

/** The file's value, or a throw naming the first field that is wrong. */
export function parseAuditIgnores(input: unknown): AuditFile {
  const value = toRecord(input);
  if (value === undefined) {
    throw new Error('Audit ignores: expected an object');
  }
  for (const key of Object.keys(value)) {
    if (!TOP_FIELDS.some((field) => field === key)) {
      throw new Error(`Audit ignores: unknown field "${key}"`);
    }
  }
  const version = value['version'];
  if (version !== 1 && version !== 2) {
    throw new Error('Audit ignores: unsupported version');
  }
  if (version === 1 && (value['checks'] !== undefined || value['tokens'] !== undefined || value['placeholders'] !== undefined)) {
    throw new Error('Audit ignores: settings need version 2');
  }
  const list = toArray(value['ignored']);
  if (list === undefined) {
    throw new Error('Audit ignores.ignored: expected an array');
  }
  if (list.length > AUDIT_IGNORE_LIMITS.entriesMax) {
    throw new Error(`Audit ignores.ignored: more than ${AUDIT_IGNORE_LIMITS.entriesMax} entries`);
  }
  const ignored = list.map((entry, index) => parseAuditIgnore(entry, index));
  if (new Set(ignored.map((entry) => entry.id)).size !== ignored.length) {
    throw new Error('Audit ignores.ignored: an id is listed twice');
  }
  assert(ignored.length <= AUDIT_IGNORE_LIMITS.entriesMax, 'parseAuditIgnores: the list is bounded');
  return {
    version: 2,
    ignored,
    checks: value['checks'] === undefined ? {} : parseChecks(value['checks']),
    tokens: value['tokens'] === undefined ? DEFAULT_TOKEN_SETTINGS : parseTokens(value['tokens']),
    placeholders: value['placeholders'] === undefined ? DEFAULT_PLACEHOLDERS : parseList(value['placeholders'], 'Audit settings.placeholders'),
  };
}

function parseAuditIgnore(input: unknown, index: number): AuditIgnore {
  assert(Number.isSafeInteger(index), 'parseAuditIgnore: an index is an integer');
  const where = `Audit ignores.ignored[${index}]`;
  const value = toRecord(input);
  if (value === undefined) {
    throw new Error(`${where}: expected an object`);
  }
  for (const key of Object.keys(value)) {
    if (key !== 'id' && key !== 'reason') {
      throw new Error(`${where}: unknown field "${key}"`);
    }
  }
  const id = value['id'];
  const reason = value['reason'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${where}.id: expected a non-empty string`);
  }
  if (id.length > AUDIT_IGNORE_LIMITS.idCharsMax) {
    throw new Error(`${where}.id: longer than ${AUDIT_IGNORE_LIMITS.idCharsMax} characters`);
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error(`${where}.reason: expected a non-empty string`);
  }
  if (reason.length > AUDIT_IGNORE_LIMITS.reasonCharsMax) {
    throw new Error(`${where}.reason: longer than ${AUDIT_IGNORE_LIMITS.reasonCharsMax} characters`);
  }
  return { id, reason };
}

function parseChecks(input: unknown): Readonly<Record<string, AuditCheckSetting>> {
  const value = toRecord(input);
  if (value === undefined) {
    throw new Error('Audit settings.checks: expected an object');
  }
  const entries = Object.entries(value);
  if (entries.length > AUDIT_IGNORE_LIMITS.checksMax) {
    throw new Error(`Audit settings.checks: more than ${AUDIT_IGNORE_LIMITS.checksMax} checks`);
  }
  const checks: Record<string, AuditCheckSetting> = {};
  for (const [id, raw] of entries) {
    const where = `Audit settings.checks.${id}`;
    if (!/^[a-z0-9-]{1,40}$/.test(id)) {
      throw new Error(`${where}: not a check id`);
    }
    const setting = toRecord(raw);
    if (setting === undefined) {
      throw new Error(`${where}: expected an object`);
    }
    for (const key of Object.keys(setting)) {
      if (key !== 'enabled' && key !== 'priority') {
        throw new Error(`${where}: unknown field "${key}"`);
      }
    }
    const enabled = setting['enabled'] ?? true;
    if (typeof enabled !== 'boolean') {
      throw new Error(`${where}.enabled: expected a boolean`);
    }
    const priority = setting['priority'];
    const known = AUDIT_SETTING_PRIORITIES.find((candidate) => candidate === priority);
    if (priority !== undefined && known === undefined) {
      throw new Error(`${where}.priority: expected high, medium or low`);
    }
    checks[id] = { enabled, priority: known };
  }
  return checks;
}

function parseTokens(input: unknown): AuditTokenSettings {
  const value = toRecord(input);
  if (value === undefined) {
    throw new Error('Audit settings.tokens: expected an object');
  }
  for (const key of Object.keys(value)) {
    if (!TOKEN_FIELDS.some((field) => field === key)) {
      throw new Error(`Audit settings.tokens: unknown field "${key}"`);
    }
  }
  const flag = (key: 'colors' | 'px' | 'remOutsideVariables'): boolean => {
    const raw = value[key] ?? DEFAULT_TOKEN_SETTINGS[key];
    if (typeof raw !== 'boolean') {
      throw new Error(`Audit settings.tokens.${key}: expected a boolean`);
    }
    return raw;
  };
  return {
    properties: value['properties'] === undefined ? DEFAULT_TOKEN_SETTINGS.properties : parseList(value['properties'], 'Audit settings.tokens.properties'),
    colors: flag('colors'),
    px: flag('px'),
    remOutsideVariables: flag('remOutsideVariables'),
    allowed:
      value['allowed'] === undefined
        ? DEFAULT_TOKEN_SETTINGS.allowed
        : parseList(value['allowed'], 'Audit settings.tokens.allowed').map((item) => item.toLowerCase()),
  };
}

function parseList(input: unknown, where: string): readonly string[] {
  const list = toArray(input);
  if (list === undefined) {
    throw new Error(`${where}: expected an array`);
  }
  if (list.length > AUDIT_IGNORE_LIMITS.listItemsMax) {
    throw new Error(`${where}: more than ${AUDIT_IGNORE_LIMITS.listItemsMax} items`);
  }
  return list.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`${where}[${index}]: expected a non-empty string`);
    }
    if (item.length > AUDIT_IGNORE_LIMITS.listItemCharsMax) {
      throw new Error(`${where}[${index}]: longer than ${AUDIT_IGNORE_LIMITS.listItemCharsMax} characters`);
    }
    return item.trim();
  });
}

/** The file's text, or the defaults when there is none. A malformed file throws: it is never silently replaced. */
export function parseAuditIgnoresSource(source: string | undefined): AuditFile {
  if (source === undefined) {
    return EMPTY_AUDIT_IGNORES;
  }
  const input: unknown = JSON.parse(source);
  return parseAuditIgnores(input);
}

/** The file's text: two-space JSON with a trailing newline. Settings at their defaults are left out, so the file says only what the project chose. */
export function serializeAuditIgnores(value: AuditFile): string {
  assert(value.ignored.length <= AUDIT_IGNORE_LIMITS.entriesMax, 'serializeAuditIgnores: the list is bounded');
  const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
  const body = {
    version: 2,
    ignored: value.ignored.map((entry) => ({ id: entry.id, reason: entry.reason })),
    ...(Object.keys(value.checks).length === 0 ? {} : { checks: serializedChecks(value.checks) }),
    ...(same(value.tokens, DEFAULT_TOKEN_SETTINGS) ? {} : { tokens: value.tokens }),
    ...(same(value.placeholders, DEFAULT_PLACEHOLDERS) ? {} : { placeholders: value.placeholders }),
  };
  const text = `${JSON.stringify(body, undefined, 2)}\n`;
  assert(parseAuditIgnoresSource(text).ignored.length === value.ignored.length, 'serializeAuditIgnores: what is written reads back');
  return text;
}

function serializedChecks(checks: Readonly<Record<string, AuditCheckSetting>>): Record<string, { enabled?: boolean; priority?: AuditSettingPriority }> {
  const out: Record<string, { enabled?: boolean; priority?: AuditSettingPriority }> = {};
  for (const [id, setting] of Object.entries(checks)) {
    out[id] = { ...(setting.enabled ? {} : { enabled: false }), ...(setting.priority === undefined ? {} : { priority: setting.priority }) };
  }
  return out;
}

/** The file with `entry` added, or its reason replaced when the id is already there. */
export function withIgnore(value: AuditFile, entry: AuditIgnore): AuditFile {
  assert(entry.id.length > 0, 'withIgnore: an entry has an id');
  assert(entry.reason.trim().length > 0, 'withIgnore: an entry has a reason');
  const kept = value.ignored.filter((existing) => existing.id !== entry.id);
  if (kept.length >= AUDIT_IGNORE_LIMITS.entriesMax) {
    throw new Error(`At most ${AUDIT_IGNORE_LIMITS.entriesMax} findings can be ignored`);
  }
  return { ...value, ignored: [...kept, { id: entry.id, reason: entry.reason.trim().slice(0, AUDIT_IGNORE_LIMITS.reasonCharsMax) }] };
}

/** The file without the entry for `id`. */
export function withoutIgnore(value: AuditFile, id: string): AuditFile {
  const ignored = value.ignored.filter((entry) => entry.id !== id);
  assert(ignored.length >= value.ignored.length - 1, 'withoutIgnore: removes at most one entry');
  return { ...value, ignored };
}

/** The file with one check's setting replaced. */
export function withCheckSetting(value: AuditFile, id: string, setting: AuditCheckSetting): AuditFile {
  assert(/^[a-z0-9-]{1,40}$/.test(id), 'withCheckSetting: a check id');
  const checks = { ...value.checks };
  if (setting.enabled && setting.priority === undefined) {
    delete checks[id]; // Back to its defaults: nothing to write.
  } else {
    checks[id] = setting;
  }
  assert(Object.keys(checks).length <= AUDIT_IGNORE_LIMITS.checksMax, 'withCheckSetting: bounded');
  return { ...value, checks };
}

/** Whether `property` is one the token rules cover: an exact name, or a `prefix*` pattern. */
export function tokenProperty(settings: Pick<AuditTokenSettings, 'properties'>, property: string): boolean {
  const name = property.toLowerCase();
  return settings.properties.some((pattern) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern.toLowerCase()));
}
