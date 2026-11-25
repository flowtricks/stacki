// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `.stacki/folders.json`: which folders each panel reads its files from, and what the CMS panel and the data picker list.
import {
  DEFAULT_PROJECT_FOLDERS,
  PROJECT_FOLDER_KINDS,
  PROJECT_FOLDER_LIMITS,
  PROJECT_FOLDER_ROOTS,
  parseProjectFolders,
  serializeProjectFolders,
  type ProjectFolderKind,
} from '../../projectFolders';
import { arrayOf, field, literal, objectOf, text, type FieldSchema, type FileSchema } from '../stackiSchema';

// One folder name as the app accepts it (`SEGMENT`): letters, digits, `_`, `-`, `.` and spaces, never starting with a dot or a space,
// never ending in a space, at most segmentCharsMax characters. `node_modules` and `dist` are refused by the parser, not the pattern.
const SEGMENT = `[A-Za-z0-9_-][A-Za-z0-9_. -]{0,${PROJECT_FOLDER_LIMITS.segmentCharsMax - 1}}(?<! )`;
const SEGMENT_DEPTH_MAX = PROJECT_FOLDER_LIMITS.pathSegmentsMax - 1;

/** A folder under one of the kind's top-level roots. Components and layouts must sit below `src`, never be `src` itself. */
function folderPattern(kind: ProjectFolderKind): string {
  const roots = PROJECT_FOLDER_ROOTS[kind].join('|');
  const belowMin = kind === 'components' || kind === 'layouts' ? 1 : 0;
  return `^(?:${roots})(?:/${SEGMENT}){${belowMin},${SEGMENT_DEPTH_MAX}}$`;
}

const kindField = (kind: ProjectFolderKind, what: string): FieldSchema =>
  field(
    arrayOf(text(PROJECT_FOLDER_LIMITS.pathCharsMax, { charsMin: 1, pattern: folderPattern(kind) }), PROJECT_FOLDER_LIMITS.foldersPerKindMax, { unique: true }),
    `${what} Top-level folder: ${PROJECT_FOLDER_ROOTS[kind].join(', ')}; no folder inside or around another listed one. Absent reads ${DEFAULT_PROJECT_FOLDERS[kind].join(', ')}.`,
    { commands: ['folders add', 'folders remove', 'folders reset'] },
  );

const COLLECTION_NAME = '^[A-Za-z0-9_$-]+$';
// A data file under src/ with an editable extension (`CMS_FILE_EXTENSION`), optionally followed by `#` and an export name.
const DATA_FILE = `src(?:/${SEGMENT}){1,${SEGMENT_DEPTH_MAX}}\\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx|json|astro)`;
const EXPORT_NAME = '[A-Za-z_$][\\w$]*';

/** The app's canonical writer on a document: parsed first, so a document the app refuses throws its reason; kinds come back in tab order. */
function serializeFoldersDocument(document: Record<string, unknown>): string {
  return serializeProjectFolders(parseProjectFolders(document));
}

export const FOLDERS_FILE: FileSchema = {
  id: 'folders',
  file: '.stacki/folders.json',
  description:
    'Which folders the Components, Layouts, Assets, Styles and Variables panels read from, and which data files, collections and sources the CMS panel and the data picker list. A missing file or key means the defaults. Pages are fixed at src/pages.',
  requires: 'settings:folders',
  metadataKind: 'folders',
  fields: {
    version: field(literal(1), 'The file format version.', { required: true }),
    folders: field(
      objectOf(
        Object.fromEntries(
          PROJECT_FOLDER_KINDS.map((kind): [string, FieldSchema] => [
            kind,
            kindField(
              kind,
              kind === 'styles'
                ? 'Folders the Styles and Selectors panels read; choosing them also writes variables (a file without a variables key reads variables from styles).'
                : `Folders the ${kind} panel reads.`,
            ),
          ]),
        ),
      ),
      'The folders each panel reads, only for the panels someone changed.',
      { commands: ['folders add', 'folders remove', 'folders reset'] },
    ),
    cms: field(
      objectOf({
        files: field(
          arrayOf(text(PROJECT_FOLDER_LIMITS.pathCharsMax, { charsMin: 1, pattern: `^${DATA_FILE}$` }), PROJECT_FOLDER_LIMITS.cmsFilesMax, { unique: true }),
          'The data files the CMS panel lists, replacing its automatic detection. Files under src/ with a script, JSON or Astro extension; Astro files are always sources and drop out at the next save. Absent keeps automatic detection.',
        ),
        hiddenCollections: field(
          arrayOf(
            text(PROJECT_FOLDER_LIMITS.collectionNameCharsMax, { charsMin: 1, pattern: COLLECTION_NAME }),
            PROJECT_FOLDER_LIMITS.cmsHiddenCollectionsMax,
            { unique: true },
          ),
          'Content collections the CMS panel leaves out; they stay in the content config. Absent hides none.',
        ),
        pickerExcluded: field(
          arrayOf(
            text(PROJECT_FOLDER_LIMITS.pathCharsMax + 1 + PROJECT_FOLDER_LIMITS.exportNameCharsMax, {
              charsMin: 1,
              pattern: `^(?:${COLLECTION_NAME.slice(1, -1)}|${DATA_FILE}(?:#${EXPORT_NAME})?)$`,
            }),
            PROJECT_FOLDER_LIMITS.cmsPickerExcludedMax,
            { unique: true },
          ),
          'Sources the data picker leaves out: a data file (src/consts.ts), one of its exports (src/consts.ts#SITE) or a content collection (blog). Absent shows everything; the CMS panel ignores it.',
        ),
      }),
      'What the CMS panel and the data picker list; absent means what they always listed.',
    ),
  },
  empty: { version: 1, folders: {} },
  serialize: serializeFoldersDocument,
  commands: ['folders add', 'folders remove', 'folders reset'],
  parserSources: ['shared/properties/projectFolders.ts'],
  parserKeyExceptions: {
    src: "A folder root in the default and allowed-root tables (components: ['src']), not a key of the file.",
  },
};
