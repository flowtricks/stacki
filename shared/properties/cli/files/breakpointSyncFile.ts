// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `.stacki/breakpoint-sync.json`: the places a breakpoint's sync was told to leave alone, or has changed, per breakpoint id.
import { BREAKPOINT_LIMITS } from '../../projectBreakpoints';
import {
  BREAKPOINT_SYNC_FILE as BREAKPOINT_SYNC_PATH,
  SYNC_RECORD_LIMITS,
  parseBreakpointSyncRecord,
  serializeBreakpointSyncRecord,
} from '../../breakpointSyncRecord';
import { arrayOf, field, literal, objectOf, text, type FieldSchema, type FileSchema } from '../stackiSchema';

// A project-relative path with `/` separators that stays inside the project (`isProjectPath`): no leading slash, no
// backslash, no NUL, no empty, `.` or `..` segment.
const PROJECT_PATH = '^(?!/)(?!.*(?:^|/)\\.{0,2}(?:/|$))[^\\\\\\u0000]+$';
const LOCATOR = '^[0-9a-f]{8}:\\d{1,6}$';
const TIMESTAMP = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$';

const place = objectOf({
  file: field(
    text(SYNC_RECORD_LIMITS.fileCharsMax, { charsMin: 1, pattern: PROJECT_PATH }),
    'The project-relative file, with / separators, that holds the bound.',
    { required: true },
  ),
  locator: field(
    text(SYNC_RECORD_LIMITS.locatorCharsMax, { charsMin: 1, pattern: LOCATOR }),
    "The bound's locator, such as 2d535645:0: it survives the number changing and lines moving.",
    { required: true },
  ),
});

const entry = objectOf({
  excluded: field(
    arrayOf(place, SYNC_RECORD_LIMITS.refsMax, { unique: true }),
    'Places the person unchecked: listed unchecked and labelled "Not synced" on every later sync, never changed unless they check them again.',
    {
      commands: ['breakpoints sync'],
    },
  ),
  linked: field(arrayOf(place, SYNC_RECORD_LIMITS.refsMax, { unique: true }), 'Places a sync has changed to follow this breakpoint.', {
    commands: ['breakpoints sync'],
  }),
  appliedAt: field(text(24, { charsMin: 1, pattern: TIMESTAMP }), 'When the last sync was applied: an ISO time ending in Z.', {
    commands: ['breakpoints sync'],
  }),
});

// The file is keyed by breakpoint id, and the registry's top level is a fixed list of keys. The ids the app can give are the
// three built-in ones and `bp-1` upward (`nextBreakpointId` hands out `bp-1` to `bp-<countMax + 1>`), so those are the keys.
const SYNC_IDS: readonly string[] = ['laptop', 'tablet', 'phone', ...Array.from({ length: BREAKPOINT_LIMITS.countMax + 1 }, (_, index) => `bp-${index + 1}`)];

const entryField = (id: string): FieldSchema =>
  field(entry, `What the sync of breakpoint "${id}" remembers; absent means nothing is remembered.`, { commands: ['breakpoints sync', 'breakpoints remove'] });

/** The app's canonical writer on a document: parsed first, so a document the app refuses throws its reason; sorted and deduplicated. */
function serializeSyncDocument(document: Record<string, unknown>): string {
  const parsed = parseBreakpointSyncRecord(document);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return serializeBreakpointSyncRecord(parsed.value);
}

export const BREAKPOINT_SYNC_FILE: FileSchema = {
  id: 'breakpointSync',
  file: BREAKPOINT_SYNC_PATH,
  description:
    "What each breakpoint's sync has been told: bounds in @media queries the person unchecked (excluded) or that were changed (linked). A bound is named by its file and a locator. Written by the app as sorted, deduplicated places.",
  requires: 'settings:breakpoints',
  metadataKind: 'breakpointSync',
  fields: {
    version: field(literal(1), 'The file format version.', { required: true }),
    ...Object.fromEntries(SYNC_IDS.map((id) => [id, entryField(id)])),
  },
  empty: { version: 1 },
  serialize: serializeSyncDocument,
  commands: ['breakpoints sync', 'breakpoints remove'],
  parserSources: ['shared/properties/breakpointSyncRecord.ts'],
};
