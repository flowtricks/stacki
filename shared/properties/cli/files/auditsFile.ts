// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `.stacki/audits.json`: how the project audits itself: ignored findings and pages, which checks run and how loud, the design-token rules and the placeholder phrases.
import {
  AUDIT_IGNORE_LIMITS,
  AUDIT_SETTING_PRIORITIES,
  DEFAULT_PLACEHOLDERS,
  DEFAULT_TOKEN_SETTINGS,
  parseAuditIgnores,
  serializeAuditIgnores,
} from '../../auditIgnores';
import { CUSTOM_AUDIT_ICONS, CUSTOM_AUDIT_LIMITS, CUSTOM_AUDIT_SEVERITIES } from '../../customAudits';
import { arrayOf, bool, field, literal, mapOf, objectOf, oneOf, text, variantOf, type FieldSchema, type FileSchema } from '../stackiSchema';

// The parser lowercases `allowed` and trims every list item; a registry value is checked as written.
const listItem = text(AUDIT_IGNORE_LIMITS.listItemCharsMax, { charsMin: 1 });

// One custom audit (shared/properties/customAudits.ts): the fields every scope shares, then what each scope's `match` holds.
const pattern = (description: string, options: { readonly required?: boolean } = {}): FieldSchema =>
  field(
    text(CUSTOM_AUDIT_LIMITS.patternCharsMax, { charsMin: 1 }),
    `${description} A regular expression, case-insensitive, checked for safety before it runs.`,
    options,
  );
const customAuditFields = (match: Readonly<Record<string, FieldSchema>>): Readonly<Record<string, FieldSchema>> => ({
  id: field(
    text(CUSTOM_AUDIT_LIMITS.idCharsMax, { charsMin: 1, pattern: '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$' }),
    'Lowercase letters, digits and hyphens; unique in the list. Findings and ignores key on it.',
    { required: true },
  ),
  name: field(text(CUSTOM_AUDIT_LIMITS.nameCharsMax, { charsMin: 1 }), 'The name the Audits panel shows.', {
    required: true,
  }),
  icon: field(oneOf(...CUSTOM_AUDIT_ICONS), 'An icon the Audits panel already draws.', { required: true }),
  category: field(
    text(CUSTOM_AUDIT_LIMITS.categoryCharsMax, { charsMin: 1 }),
    'A built-in category (accessibility, seo, content, tokens, performance) or the name of a category of the project’s own.',
    { required: true },
  ),
  severity: field(oneOf(...CUSTOM_AUDIT_SEVERITIES), 'How loud its findings are.', { default: 'medium' }),
  match: field(objectOf(match), 'What it looks for.', { required: true }),
  exclude: pattern('A match is dropped when its declaration (property: value) or, for a text scope, its line also matches this.'),
  message: field(text(CUSTOM_AUDIT_LIMITS.messageCharsMax, { charsMin: 1 }), 'One line under the name: why it matters or what to use instead.'),
  enabled: field(bool(), 'Whether it runs.', { default: true }),
});
const textMatch = { pattern: pattern('What to find.', { required: true }) };

export const AUDITS_FILE: FileSchema = {
  id: 'audits',
  file: '.stacki/audits.json',
  description:
    'Audit configuration shared by the team: ignored findings and pages (each with a reason), per-check overrides, the design-token rules and the placeholder phrases.',
  requires: 'panel:audits',
  metadataKind: 'audits',
  fields: {
    version: field(literal(2), 'The file format version. Version 1 (ignores only) still reads and is written back as 2.', { required: true }),
    ignored: field(
      arrayOf(
        objectOf({
          id: field(
            text(AUDIT_IGNORE_LIMITS.idCharsMax, { charsMin: 1 }),
            'The finding id, as the audit reports it: check|file|path|detail. Unique in the list.',
            { required: true },
          ),
          reason: field(text(AUDIT_IGNORE_LIMITS.reasonCharsMax, { charsMin: 1 }), 'Why the finding is ignored; not blank.', { required: true }),
        }),
        AUDIT_IGNORE_LIMITS.entriesMax,
      ),
      'Findings the project silenced, in the order they were added. An entry lapses when the markup it named moves.',
      { required: true },
    ),
    ignoredPages: field(
      arrayOf(
        objectOf({
          file: field(text(AUDIT_IGNORE_LIMITS.idCharsMax, { charsMin: 1 }), 'A project-relative path (no leading slash). Unique in the list.', {
            required: true,
          }),
          reason: field(text(AUDIT_IGNORE_LIMITS.reasonCharsMax, { charsMin: 1 }), 'Why the page is ignored; not blank.', { required: true }),
        }),
        AUDIT_IGNORE_LIMITS.pagesMax,
      ),
      'Pages ignored whole: every finding of every check in the file. Written only when there is one.',
      { default: 'none' },
    ),
    checks: field(
      mapOf(
        objectOf({
          enabled: field(bool(), 'Whether the check runs.', { default: true }),
          priority: field(oneOf(...AUDIT_SETTING_PRIORITIES), 'Louder or quieter than the check default; absent keeps the default.'),
        }),
        AUDIT_IGNORE_LIMITS.checksMax,
        'a check id (lowercase letters, digits and hyphens, up to 40 characters)',
        '^[a-z0-9-]{1,40}$',
      ),
      'Per-check overrides by check id. A check not named keeps its defaults.',
      { default: 'no overrides' },
    ),
    tokens: field(
      objectOf({
        properties: field(
          arrayOf(listItem, AUDIT_IGNORE_LIMITS.listItemsMax),
          'CSS properties whose values must come from variables; a trailing * matches a prefix (padding* covers every padding longhand).',
          {
            default: DEFAULT_TOKEN_SETTINGS.properties.join(', '),
          },
        ),
        colors: field(bool(), 'Flag raw hex, rgb() and hsl() colours.', { default: DEFAULT_TOKEN_SETTINGS.colors }),
        px: field(bool(), 'Flag any px value outside a variable definition.', { default: DEFAULT_TOKEN_SETTINGS.px }),
        remOutsideVariables: field(bool(), 'Flag any rem value outside a variable definition.', { default: DEFAULT_TOKEN_SETTINGS.remOutsideVariables }),
        allowed: field(arrayOf(listItem, AUDIT_IGNORE_LIMITS.listItemsMax), 'Raw values that are fine as written, compared lower-cased: 0, auto, 1px, 100%.', {
          default: DEFAULT_TOKEN_SETTINGS.allowed.join(', '),
        }),
      }),
      'The design-token linter rules. Written only when they differ from the defaults.',
      { default: 'the app defaults' },
    ),
    placeholders: field(
      arrayOf(listItem, AUDIT_IGNORE_LIMITS.listItemsMax),
      'Phrases that mark copy as placeholder: one word must be the whole text, several may be part of it. Written only when they differ from the defaults.',
      { default: DEFAULT_PLACEHOLDERS.join(', ') },
    ),
    customAudits: field(
      arrayOf(
        variantOf('scope', {
          declaration: customAuditFields({
            property: pattern('On the property name, such as ^text-align$.', { required: true }),
            valueMustMatch: pattern('The value must match it, such as var\\(\\s*--swatch-.'),
            valueMustNotMatch: pattern('The value must not match it, such as var\\(.'),
          }),
          css: customAuditFields(textMatch),
          markup: customAuditFields(textMatch),
          rendered: customAuditFields(textMatch),
        }),
        CUSTOM_AUDIT_LIMITS.auditsMax,
      ),
      'The project’s own audits, shown in the Audits panel beside the built-in checks. scope says what each reads: declaration (CSS declarations: property and value rules), css (stylesheet text), markup (.astro templates) or rendered (served HTML). Prefer "stacki audits add|update|remove|test", which check every pattern for safety. Written only when there is one.',
      { default: 'none' },
    ),
  },
  empty: { version: 2, ignored: [] },
  // The app's writer leaves out settings at their defaults and an empty ignoredPages; the CLI writes the same bytes.
  serialize: (document) => serializeAuditIgnores(parseAuditIgnores(document)),
  commands: [],
  parserSources: [
    'shared/properties/auditIgnores.ts',
    'shared/properties/auditIgnoreList.ts',
    'shared/page/auditTokens.ts',
    'shared/properties/customAudits.ts',
  ],
  parserKeyExceptions: {
    page: 'A type lookup (IgnoredGroup["page"]) in the ignore list, not a key read from the file.',
    code: 'A type lookup (CustomAuditProblem["code"]) of a refused pattern, not a key read from the file.',
    rel: 'Wire key of a scanned stylesheet handed to the token linter, not a setting of the file.',
    declarations: 'Wire key of a scanned stylesheet handed to the token linter, not a setting of the file.',
    selector: 'Wire key of a scanned CSS rule handed to the token linter, not a setting of the file.',
    entries: 'Wire key of a scanned CSS rule handed to the token linter, not a setting of the file.',
    kind: 'Wire key of a scanned CSS entry handed to the token linter, not a setting of the file.',
    name: 'Wire key of a scanned CSS variable handed to the token linter, not a setting of the file.',
    value: 'Wire key of a scanned CSS variable handed to the token linter, not a setting of the file.',
  },
};
