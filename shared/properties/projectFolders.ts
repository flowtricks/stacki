// The project's `.stacki/folders.json`: which folders each panel reads its
// files from. It is a tracked project setting, shared by Desktop and Studio,
// so both editors show the same components, layouts, assets, stylesheets and
// variables.
//
// A missing file, or a missing key in it, means "today's defaults": a project
// that never opens the Folders tab behaves exactly as it always has, and no
// file is written until someone changes a folder. Every scanner asks
// `foldersFor(kind, config)` instead of naming a folder itself, so a folder is
// chosen in exactly one place.
//
// Pages are not configurable: `src/pages` is Astro's routing root, and every
// route, page rename and `.stacki/pages.json` key is relative to it. Content
// collections follow the loaders in the project's content config, which is
// where Astro itself looks; a second setting could only disagree with it.
import { assert } from '../core/assert';
import { err, ok, type Result } from '../core/result';
import { record } from '../core/boundary';

export const PROJECT_FOLDERS_FILE = '.stacki/folders.json';

/** Astro's routing root: fixed, because every route is relative to it. */
export const PAGES_FOLDER = 'src/pages';

export const PROJECT_FOLDER_LIMITS = {
  /** Folders one panel reads. A project keeps each kind of file in a handful. */
  foldersPerKindMax: 16,
  /** Characters in one project-relative folder. */
  pathCharsMax: 200,
  /** Segments in one folder: `src/a/b/c/d/e/f/g` is already deeper than any project keeps a panel's files. */
  pathSegmentsMax: 8,
  /** Characters in one folder name. */
  segmentCharsMax: 64,
  /** Characters in the whole file: sixteen folders for each kind fit many times over. */
  fileCharsMax: 16_384,
  /** Data files the CMS panel lists by choice: far more than a site keeps its settings in. */
  cmsFilesMax: 64,
  /** Content collections the CMS panel leaves out. */
  cmsHiddenCollectionsMax: 256,
  /** Characters in one collection name, as the content config declares it. */
  collectionNameCharsMax: 64,
  /** Sources the data picker leaves out: every data file, export and collection of a large site. */
  cmsPickerExcludedMax: 512,
  /** Characters in one export name a data file declares. */
  exportNameCharsMax: 128,
} as const satisfies Record<string, number>;

/** The panels whose folders are configurable, in the order the Folders tab lists them. */
export const PROJECT_FOLDER_KINDS = ['components', 'layouts', 'assets', 'styles', 'variables'] as const;
export type ProjectFolderKind = (typeof PROJECT_FOLDER_KINDS)[number];

/** What every panel read before folders were configurable. Pinned by test. */
export const DEFAULT_PROJECT_FOLDERS: Readonly<Record<ProjectFolderKind, readonly string[]>> = {
  components: ['src/components'],
  layouts: ['src/layouts'],
  // public/ is served as-is and referenced by URL; src/ is imported by the build.
  assets: ['public', 'src'],
  // The top-level folders the style panel, the selectors panel and the
  // unused-selector check have always read.
  styles: ['src', 'public', 'styles'],
  // The variables panel read the same folders while it shared the `styles` key.
  variables: ['src', 'public', 'styles'],
};

/**
 * The top-level folders each kind may live under. Assets keep their two
 * reference kinds (URL under `public/`, import under `src/`), which the assets
 * panel and its write protections depend on. Components and layouts must be
 * compiled by Astro, so they live under `src/`. Stylesheets keep the three
 * roots the style panel has always read.
 */
export const PROJECT_FOLDER_ROOTS: Readonly<Record<ProjectFolderKind, readonly string[]>> = {
  components: ['src'],
  layouts: ['src'],
  assets: ['public', 'src'],
  styles: ['src', 'public', 'styles'],
  variables: ['src', 'public', 'styles'],
};

export interface ProjectFolders {
  readonly version: 1;
  /** Only the kinds someone changed; a kind that is absent reads its default. */
  readonly folders: ProjectFolderChoices;
  /**
   * What a newer Stacki wrote that this one does not know: top-level keys, and
   * panels inside `folders`. Kept as written and written back, so editing the
   * file here never drops a setting a newer editor relies on. Entries, not an
   * object, so a key such as `__proto__` stays plain data.
   */
  readonly unknownKeys?: ReadonlyArray<readonly [string, unknown]>;
  readonly unknownFolders?: ReadonlyArray<readonly [string, unknown]>;
  /** What the CMS panel lists; absent means what it always listed. */
  readonly cms?: ProjectCmsChoices;
}

/**
 * The `cms` key. `files` replaces the panel's automatic data file detection
 * (every data module under src/, with single values only from src/data/ and
 * root consts files) with exactly these project files; absent keeps it.
 * `hiddenCollections` names content collections the panel leaves out; they
 * stay in the content config and everywhere else that reads it.
 */
export interface ProjectCmsChoices {
  readonly files?: readonly string[];
  readonly hiddenCollections?: readonly string[];
  /**
   * What the binding picker leaves out of its project data (Settings → Folders,
   * "Show in data picker"), as written in the file: a data file (`src/consts.ts`),
   * one of its exports (`src/consts.ts#SITE`), or a content collection (`blog`).
   * Absent means the picker shows everything. The CMS panel ignores it.
   */
  readonly pickerExcluded?: readonly string[];
  /** Keys a newer Stacki wrote under `cms`, kept for the next write. */
  readonly unknownKeys?: ReadonlyArray<readonly [string, unknown]>;
}

/** The file types the CMS panel reads data from (cmsHandlers.ts, cms:list). */
export const CMS_FILE_EXTENSION = /\.(cjs|cts|js|jsx|mjs|mts|ts|tsx|json|astro)$/i;
// A collection name as a content config writes it, as an object key.
const COLLECTION_NAME = /^[A-Za-z0-9_$-]+$/;
// An export a data file declares: an identifier, or `default` for a JSON file's data.
const EXPORT_NAME = /^[A-Za-z_$][\w$]*$/;

/**
 * One thing the data picker can leave out. A file and an export are told apart
 * from a collection by the `/` every project path has and no collection name can.
 */
export type PickerExclusion =
  | { readonly kind: 'file'; readonly file: string }
  | { readonly kind: 'export'; readonly file: string; readonly exported: string }
  | { readonly kind: 'collection'; readonly name: string };

export interface ProjectFolderChoices {
  readonly components?: readonly string[];
  readonly layouts?: readonly string[];
  readonly assets?: readonly string[];
  readonly styles?: readonly string[];
  readonly variables?: readonly string[];
}

/** What reading the file found. An invalid file is reported, and every panel keeps its defaults meanwhile. */
export type ProjectFoldersRead =
  { readonly kind: 'absent' } | { readonly kind: 'ready'; readonly config: ProjectFolders } | { readonly kind: 'invalid'; readonly message: string };

export const EMPTY_PROJECT_FOLDERS: ProjectFolders = { version: 1, folders: {} };

// One folder name: letters, digits, `_`, `-`, `.` and spaces, never starting
// with a dot or a space. Narrow on purpose: it excludes drive letters (`C:`),
// backslashes, quotes and every character a glob or a URL would read
// specially, and it is the set Studio's own project paths accept.
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9_. -]*$/;
// Folders that are never a project's own files: installed packages and build output.
const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(['node_modules', 'dist']);

/** The resolver every scanner uses: the configured folders for `kind`, else its defaults. */
export function foldersFor(kind: ProjectFolderKind, config: ProjectFolders | undefined): readonly string[] {
  assert(PROJECT_FOLDER_KINDS.includes(kind), 'foldersFor: kind is a project folder kind');
  const chosen = config?.folders[kind];
  const folders = chosen ?? DEFAULT_PROJECT_FOLDERS[kind];
  assert(folders.length <= PROJECT_FOLDER_LIMITS.foldersPerKindMax, 'foldersFor: the parser bounds folder count');
  return folders;
}

/** Whether `kind` has a choice of its own in the file, even one equal to its defaults. Scanners ask this. */
export function isCustomized(kind: ProjectFolderKind, config: ProjectFolders | undefined): boolean {
  return config?.folders[kind] !== undefined;
}

/**
 * Whether `kind` reads something other than its defaults: what the Folders tab
 * marks as changed. A list written out equal to the defaults (as `variables`
 * is beside chosen `styles`, see withFolders) has nothing to reset.
 */
export function differsFromDefaults(kind: ProjectFolderKind, config: ProjectFolders | undefined): boolean {
  const reads = foldersFor(kind, config);
  const differs = reads.join('\n') !== DEFAULT_PROJECT_FOLDERS[kind].join('\n');
  assert(!differs || isCustomized(kind, config), 'differsFromDefaults: only a choice can differ');
  return differs;
}

/** The configuration a read found, or undefined (defaults) when it found none or an invalid one. */
export function configOf(read: ProjectFoldersRead): ProjectFolders | undefined {
  switch (read.kind) {
    case 'absent':
      return undefined;
    case 'ready':
      return read.config;
    case 'invalid':
      return undefined;
    default: {
      const exhaustive: never = read;
      return exhaustive;
    }
  }
}

/** Reads the file's text, as either editor loaded it: undefined when the file does not exist. */
export function readProjectFoldersSource(source: string | undefined): ProjectFoldersRead {
  if (source === undefined) {
    return { kind: 'absent' };
  }
  try {
    if (source.length > PROJECT_FOLDER_LIMITS.fileCharsMax) {
      throw new Error(`Folder settings exceed ${PROJECT_FOLDER_LIMITS.fileCharsMax} characters`);
    }
    const input: unknown = JSON.parse(source);
    return { kind: 'ready', config: parseProjectFolders(input) };
  } catch (error: unknown) {
    return { kind: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }
}

export function parseProjectFolders(input: unknown): ProjectFolders {
  const value = record(input);
  if (value['version'] !== 1) {
    throw new Error('Unsupported folder settings version');
  }
  // A newer Stacki may add keys and panels: this one reads the ones it knows
  // and keeps the rest for the next write (unknownKeys, unknownFolders).
  const unknownKeys = Object.entries(value).filter(([key]) => key !== 'version' && key !== 'folders' && key !== 'cms');
  const cms = value['cms'] === undefined ? undefined : parseCmsChoices(value['cms']);
  const folders = value['folders'] === undefined ? {} : record(value['folders']);
  const choices: Record<string, readonly string[]> = {};
  const unknownFolders: Array<readonly [string, unknown]> = [];
  for (const [key, item] of Object.entries(folders)) {
    const kind = knownFolderKind(key);
    if (kind === undefined) {
      unknownFolders.push([key, item]);
    } else {
      choices[kind] = parseKindFolders(kind, item);
    }
  }
  // Before the variables panel had a key of its own, `styles` chose its folders
  // too: a file from then seeds `variables` from `styles`, so the panel keeps
  // reading what it read, and the next save writes both keys.
  const legacyStyles = choices['styles'];
  if (legacyStyles !== undefined && choices['variables'] === undefined) {
    choices['variables'] = legacyStyles;
  }
  assert(choices['styles'] === undefined || choices['variables'] !== undefined, 'parseProjectFolders: chosen styles always come with variables');
  return {
    version: 1,
    folders: choices,
    ...(unknownKeys.length === 0 ? {} : { unknownKeys }),
    ...(unknownFolders.length === 0 ? {} : { unknownFolders }),
    ...(cms === undefined ? {} : { cms }),
  };
}

function parseCmsChoices(input: unknown): ProjectCmsChoices {
  const value = record(input);
  const unknownKeys = Object.entries(value).filter(([key]) => !CMS_KEYS.has(key));
  const files = value['files'] === undefined ? undefined : parseCmsFiles(value['files']);
  const hidden = value['hiddenCollections'] === undefined ? undefined : parseHiddenCollections(value['hiddenCollections']);
  const excluded = value['pickerExcluded'] === undefined ? undefined : parsePickerExcluded(value['pickerExcluded']);
  return {
    ...(files === undefined ? {} : { files }),
    ...(hidden === undefined ? {} : { hiddenCollections: hidden }),
    ...(excluded === undefined ? {} : { pickerExcluded: excluded }),
    ...(unknownKeys.length === 0 ? {} : { unknownKeys }),
  };
}

// The keys under `cms` this version reads; any other is kept for the next write.
const CMS_KEYS: ReadonlySet<string> = new Set(['files', 'hiddenCollections', 'pickerExcluded']);

function parsePickerExcluded(input: unknown): readonly string[] {
  if (!Array.isArray(input)) {
    throw new Error('Data picker exclusions: expected a list');
  }
  if (input.length > PROJECT_FOLDER_LIMITS.cmsPickerExcludedMax) {
    throw new Error(`Data picker exclusions: exceed ${PROJECT_FOLDER_LIMITS.cmsPickerExcludedMax} entries`);
  }
  const entries = new Set<string>();
  for (const item of input) {
    if (typeof item !== 'string') {
      throw new Error('Data picker exclusions: each is a file, an export or a collection name');
    }
    parsePickerExclusion(item);
    if (entries.has(item)) {
      throw new Error(`Data picker exclusions: ${item} is listed twice`);
    }
    entries.add(item);
  }
  assert(entries.size === input.length, 'parsePickerExcluded: every entry is kept once');
  return [...entries];
}

/** One `pickerExcluded` entry as what it names; throws on text that names nothing the picker lists. */
export function parsePickerExclusion(input: string): PickerExclusion {
  if (!input.includes('/')) {
    if (input.length === 0 || input.length > PROJECT_FOLDER_LIMITS.collectionNameCharsMax || !COLLECTION_NAME.test(input)) {
      throw new Error(`Data picker exclusions: ${input === '' ? 'an empty entry' : input} is not a collection name`);
    }
    return { kind: 'collection', name: input };
  }
  const hash = input.indexOf('#');
  const file = parseProjectFolder(hash === -1 ? input : input.slice(0, hash));
  if (!file.startsWith('src/') || !CMS_FILE_EXTENSION.test(file) || isAstroSource(file)) {
    throw new Error(`Data picker exclusions: ${file} is not a data file under src/`);
  }
  if (hash === -1) {
    return { kind: 'file', file };
  }
  const exported = input.slice(hash + 1);
  if (exported.length > PROJECT_FOLDER_LIMITS.exportNameCharsMax || !EXPORT_NAME.test(exported)) {
    throw new Error(`Data picker exclusions: ${exported === '' ? 'an empty export' : exported} is not an export name`);
  }
  return { kind: 'export', file, exported };
}

/** The text a `pickerExcluded` entry is written as. Inverse of parsePickerExclusion. */
export function pickerExclusionText(exclusion: PickerExclusion): string {
  switch (exclusion.kind) {
    case 'file':
      return exclusion.file;
    case 'export':
      return `${exclusion.file}#${exclusion.exported}`;
    case 'collection':
      return exclusion.name;
    default: {
      const exhaustive: never = exclusion;
      return exhaustive;
    }
  }
}

/**
 * Whether the data picker lists `source`. Everything is listed unless the
 * project left it out; an export is left out with its whole file too.
 */
export function isPickerShown(config: ProjectFolders | undefined, source: PickerExclusion): boolean {
  const excluded = config?.cms?.pickerExcluded;
  if (excluded === undefined) {
    return true;
  }
  assert(excluded.length <= PROJECT_FOLDER_LIMITS.cmsPickerExcludedMax, 'isPickerShown: the parser bounds the exclusions');
  if (excluded.includes(pickerExclusionText(source))) {
    return false;
  }
  if (source.kind === 'export') {
    return !excluded.includes(source.file);
  }
  return true;
}

/** Shows or leaves out one source in the data picker. Leaving out nothing removes the key. */
export function withPickerShown(config: ProjectFolders | undefined, source: PickerExclusion, options: { readonly shown: boolean }): ProjectFolders {
  const text = pickerExclusionText(source);
  assert(pickerExclusionText(parsePickerExclusion(text)) === text, 'withPickerShown: the entry reads back as written');
  const rest = (config?.cms?.pickerExcluded ?? []).filter((other) => other !== text);
  const excluded = options.shown ? rest : [...rest, text];
  if (excluded.length > PROJECT_FOLDER_LIMITS.cmsPickerExcludedMax) {
    throw new Error(`At most ${PROJECT_FOLDER_LIMITS.cmsPickerExcludedMax} sources can be left out of the data picker`);
  }
  const next = withCmsChoices(config, { ...config?.cms, pickerExcluded: excluded });
  // An export stays hidden while its whole file is left out; anything else reads exactly as set.
  if (source.kind === 'export') {
    assert(options.shown || !isPickerShown(next, source), 'withPickerShown: a left-out export is not listed');
  } else {
    assert(isPickerShown(next, source) === options.shown, 'withPickerShown: the source reads as set');
  }
  return next;
}

function parseCmsFiles(input: unknown): readonly string[] {
  if (!Array.isArray(input)) {
    throw new Error('CMS files: expected a list');
  }
  if (input.length > PROJECT_FOLDER_LIMITS.cmsFilesMax) {
    throw new Error(`CMS files: exceed ${PROJECT_FOLDER_LIMITS.cmsFilesMax} files`);
  }
  const files: string[] = [];
  for (const item of input) {
    const file = parseProjectFolder(item);
    const problem = cmsFileProblem(files, file);
    if (problem !== undefined) {
      throw new Error(`CMS files: ${problem}`);
    }
    files.push(file);
  }
  return files;
}

function parseHiddenCollections(input: unknown): readonly string[] {
  if (!Array.isArray(input)) {
    throw new Error('Hidden collections: expected a list');
  }
  if (input.length > PROJECT_FOLDER_LIMITS.cmsHiddenCollectionsMax) {
    throw new Error(`Hidden collections: exceed ${PROJECT_FOLDER_LIMITS.cmsHiddenCollectionsMax} names`);
  }
  const names = new Set<string>();
  for (const item of input) {
    if (typeof item !== 'string' || item.length === 0 || item.length > PROJECT_FOLDER_LIMITS.collectionNameCharsMax || !COLLECTION_NAME.test(item)) {
      throw new Error('Hidden collections: each is a collection name');
    }
    if (names.has(item)) {
      throw new Error(`Hidden collections: ${item} is listed twice`);
    }
    names.add(item);
  }
  return [...names];
}

/** Why `file` cannot join the CMS panel's data files, or undefined when it can. */
export function cmsFileProblem(existing: readonly string[], file: string): string | undefined {
  assert(file.length > 0, 'cmsFileProblem: the file is named');
  if (!file.startsWith('src/')) {
    return `${file} is outside src/, where the CMS panel reads data`;
  }
  if (!CMS_FILE_EXTENSION.test(file) || /\.d\.[cm]?ts$/i.test(file)) {
    return `${file} is not a file the CMS can edit: choose a .ts, .js, .json or .astro file`;
  }
  if (existing.includes(file)) {
    return `${file} is already in the list`;
  }
  if (existing.length >= PROJECT_FOLDER_LIMITS.cmsFilesMax) {
    return `At most ${PROJECT_FOLDER_LIMITS.cmsFilesMax} files`;
  }
  return undefined;
}

/** The data files the CMS panel lists by choice, or undefined for its automatic detection. */
export function cmsFilesFor(config: ProjectFolders | undefined): readonly string[] | undefined {
  return config?.cms?.files;
}

/**
 * Whether a project file is an Astro file. Every `.astro` file (page, layout or
 * component) is a CMS source whenever it is the open file, whatever the data
 * file list says, so it is never listed, added or removed as a data file.
 */
export function isAstroSource(file: string): boolean {
  return /\.astro$/i.test(file);
}

/**
 * The data files the Folders tab lists and edits: the chosen ones, else the
 * detected ones, less `.astro` files. A list saved before this rule may name
 * them; they read as redundant and drop out at the next save.
 */
export function cmsDataFiles(config: ProjectFolders | undefined, detected: readonly string[]): readonly string[] {
  const files = (cmsFilesFor(config) ?? detected).filter((file) => !isAstroSource(file));
  assert(
    files.every((file) => !isAstroSource(file)),
    'cmsDataFiles: no Astro file is a data file',
  );
  return files;
}

/** Whether the CMS panel leaves the content collection `name` out. */
export function isCollectionHidden(config: ProjectFolders | undefined, name: string): boolean {
  return config?.cms?.hiddenCollections?.includes(name) ?? false;
}

/** The configuration with the CMS panel's data files set, or back to automatic detection when `files` is undefined. */
export function withCmsFiles(config: ProjectFolders | undefined, files: readonly string[] | undefined): ProjectFolders {
  const cms = config?.cms;
  const next = withCmsChoices(config, {
    ...(files === undefined ? {} : { files }),
    ...(cms?.hiddenCollections === undefined ? {} : { hiddenCollections: cms.hiddenCollections }),
    ...(cms?.pickerExcluded === undefined ? {} : { pickerExcluded: cms.pickerExcluded }),
  });
  assert(cmsFilesFor(next) === files, 'withCmsFiles: the files are what was set');
  return next;
}

// Every CMS choice at once; an empty list of hidden collections or picker
// exclusions is dropped, and an empty set of choices removes the `cms` key, so
// a project that undoes every change keeps the file shape it had.
function withCmsChoices(config: ProjectFolders | undefined, choices: ProjectCmsChoices): ProjectFolders {
  const base = config ?? EMPTY_PROJECT_FOLDERS;
  const { files, hiddenCollections: hidden, pickerExcluded: excluded } = choices;
  const unknownKeys = base.cms?.unknownKeys;
  const cms: ProjectCmsChoices = {
    ...(files === undefined ? {} : { files }),
    ...(hidden === undefined || hidden.length === 0 ? {} : { hiddenCollections: hidden }),
    ...(excluded === undefined || excluded.length === 0 ? {} : { pickerExcluded: excluded }),
    ...(unknownKeys === undefined ? {} : { unknownKeys }),
  };
  const rest: ProjectFolders = {
    version: 1,
    folders: base.folders,
    ...(base.unknownKeys === undefined ? {} : { unknownKeys: base.unknownKeys }),
    ...(base.unknownFolders === undefined ? {} : { unknownFolders: base.unknownFolders }),
  };
  return Object.keys(cms).length === 0 ? rest : { ...rest, cms };
}

/** Adds a data file to the CMS panel's list, starting from `detected` when the list is still automatic. */
export function addCmsFile(config: ProjectFolders | undefined, input: string, detected: readonly string[]): Result<ProjectFolders, string> {
  let file: string;
  try {
    file = parseProjectFolder(input);
  } catch (error: unknown) {
    return err(error instanceof Error ? error.message : String(error));
  }
  if (isAstroSource(file)) {
    return err(`${file} is an Astro file: the CMS includes the open one automatically`);
  }
  const current = cmsDataFiles(config, detected);
  const problem = cmsFileProblem(current, file);
  if (problem !== undefined) {
    return err(problem);
  }
  return ok(withCmsFiles(config, [...current, file]));
}

/** Removes a data file from the CMS panel's list, starting from `detected` when the list is still automatic. */
export function removeCmsFile(config: ProjectFolders | undefined, file: string, detected: readonly string[]): ProjectFolders {
  const current = cmsDataFiles(config, detected);
  assert(current.includes(file), 'removeCmsFile: the file is in the list');
  return withCmsFiles(
    config,
    current.filter((other) => other !== file),
  );
}

/** The collections the CMS panel lists: the content config's, less the ones the project hides, in their order. */
export function shownCollections<T extends { readonly name: string }>(collections: readonly T[], config: ProjectFolders | undefined): readonly T[] {
  const shown = collections.filter((collection) => !isCollectionHidden(config, collection.name));
  assert(shown.length <= collections.length, 'shownCollections: hiding only removes');
  return shown;
}

/** Shows or hides one content collection in the CMS panel. */
export function withCollectionShown(config: ProjectFolders | undefined, name: string, options: { readonly shown: boolean }): ProjectFolders {
  assert(COLLECTION_NAME.test(name), 'withCollectionShown: a collection name');
  const hidden = (config?.cms?.hiddenCollections ?? []).filter((other) => other !== name);
  return withCmsChoices(config, { ...config?.cms, hiddenCollections: options.shown ? hidden : [...hidden, name] });
}

/** The panel a key names, or undefined for one this version does not know (pages are fixed, see the header). */
export function knownFolderKind(input: string): ProjectFolderKind | undefined {
  return PROJECT_FOLDER_KINDS.find((kind) => kind === input);
}

function parseKindFolders(kind: ProjectFolderKind, input: unknown): readonly string[] {
  if (!Array.isArray(input)) {
    throw new Error(`Folders for ${kind}: expected a list`);
  }
  if (input.length > PROJECT_FOLDER_LIMITS.foldersPerKindMax) {
    throw new Error(`Folders for ${kind}: exceed ${PROJECT_FOLDER_LIMITS.foldersPerKindMax} folders`);
  }
  const folders: string[] = [];
  for (const item of input) {
    const folder = parseProjectFolder(item);
    const problem = folderChoiceProblem(kind, folders, folder);
    if (problem !== undefined) {
      throw new Error(`Folders for ${kind}: ${problem}`);
    }
    folders.push(folder);
  }
  return folders;
}

/** One project-relative folder: `/`-separated, no `.`/`..`, hidden folders, absolute paths or drive letters. */
export function parseProjectFolder(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('A folder is a project-relative path');
  }
  if (input.length === 0) {
    throw new Error('A folder needs a path');
  }
  if (input.length > PROJECT_FOLDER_LIMITS.pathCharsMax) {
    throw new Error(`A folder path exceeds ${PROJECT_FOLDER_LIMITS.pathCharsMax} characters`);
  }
  if (input.startsWith('/')) {
    throw new Error('A folder is relative to the project, not absolute');
  }
  if (input.includes('\\')) {
    throw new Error('A folder path uses / between folders');
  }
  if (/^[A-Za-z]:/.test(input)) {
    throw new Error('A folder is relative to the project, not a drive');
  }
  const segments = input.split('/');
  if (segments.length > PROJECT_FOLDER_LIMITS.pathSegmentsMax) {
    throw new Error(`A folder is at most ${PROJECT_FOLDER_LIMITS.pathSegmentsMax} levels deep`);
  }
  for (const segment of segments) {
    folderSegment(segment);
  }
  return input;
}

function folderSegment(segment: string): void {
  if (segment.length === 0) {
    throw new Error('A folder path has an empty folder name');
  }
  if (segment === '.' || segment === '..') {
    throw new Error('A folder path cannot step out with . or ..');
  }
  if (segment.length > PROJECT_FOLDER_LIMITS.segmentCharsMax) {
    throw new Error(`A folder name exceeds ${PROJECT_FOLDER_LIMITS.segmentCharsMax} characters`);
  }
  if (segment.startsWith('.')) {
    throw new Error('Hidden folders hold tools’ settings, not project files');
  }
  if (!SEGMENT.test(segment)) {
    throw new Error(`Folder name ${segment} uses characters a folder path cannot hold`);
  }
  if (segment.endsWith(' ')) {
    throw new Error('A folder name cannot end with a space');
  }
  if (RESERVED_SEGMENTS.has(segment)) {
    throw new Error(`${segment} holds installed or built files, not the project’s own`);
  }
}

/**
 * Why `folder` cannot join `existing` for `kind`, or undefined when it can.
 * The parser and the Folders tab both ask this, so a choice the tab accepts
 * always reads back from the file.
 */
export function folderChoiceProblem(kind: ProjectFolderKind, existing: readonly string[], folder: string): string | undefined {
  assert(folder.length > 0, 'folderChoiceProblem: the folder is named');
  const roots = PROJECT_FOLDER_ROOTS[kind];
  const top = folder.split('/')[0] ?? '';
  if (!roots.includes(top)) {
    return `${folder} is outside ${roots.map((root) => root + '/').join(' and ')}, where ${kind} must live`;
  }
  if (kind === 'components' || kind === 'layouts') {
    if (isWithin(PAGES_FOLDER, folder)) {
      return `${folder} is inside ${PAGES_FOLDER}, where every file is a page`;
    }
    if (folder === 'src') {
      return `src holds the pages too; choose the folder ${kind} live in`;
    }
  }
  for (const other of existing) {
    if (other === folder) {
      return `${folder} is already in the list`;
    }
    if (isWithin(other, folder)) {
      return `${folder} is already covered by ${other}`;
    }
    if (isWithin(folder, other)) {
      return `${folder} would cover ${other}; remove ${other} first`;
    }
  }
  if (existing.length >= PROJECT_FOLDER_LIMITS.foldersPerKindMax) {
    return `At most ${PROJECT_FOLDER_LIMITS.foldersPerKindMax} folders`;
  }
  return undefined;
}

/** Whether project-relative `rel` is `folder` or inside it. */
export function isWithin(folder: string, rel: string): boolean {
  assert(folder.length > 0, 'isWithin: the folder is named');
  assert(!folder.endsWith('/'), 'isWithin: a folder has no trailing slash');
  return rel === folder || rel.startsWith(folder + '/');
}

/** The configured folder `rel` is in, or undefined when it is in none of them. */
export function folderHolding(folders: readonly string[], rel: string): string | undefined {
  assert(folders.length <= PROJECT_FOLDER_LIMITS.foldersPerKindMax, 'folderHolding: the folder list is bounded');
  return folders.find((folder) => isWithin(folder, rel));
}

/** Whether `rel` is a folder above a configured one: shown so the tree can reach it, never written. */
export function isAboveFolder(folders: readonly string[], rel: string): boolean {
  assert(rel.length > 0, 'isAboveFolder: the path is named');
  return folders.some((folder) => folder !== rel && isWithin(rel, folder));
}

/**
 * The Components panel group of a component at project-relative `rel`. With one
 * folder it is the path below that folder, as it always was (`""`, `cards`);
 * with several, the folder's own path below `src/` leads, so two folders'
 * top-level components do not merge into one group (`ui`, `components/cards`).
 */
export function componentGroup(folders: readonly string[], rel: string): string {
  const folder = folderHolding(folders, rel);
  assert(folder !== undefined, 'componentGroup: the component is inside a component folder');
  const directory = rel.slice(0, Math.max(rel.lastIndexOf('/'), 0));
  const below = directory === folder ? '' : directory.slice(folder.length + 1);
  if (folders.length === 1) {
    return below;
  }
  const lead = folder.startsWith('src/') ? folder.slice('src/'.length) : folder;
  return below === '' ? lead : `${lead}/${below}`;
}

/** The configuration with `kind` set to `folders`, or reset to its defaults when `folders` is undefined. */
export function withFolders(config: ProjectFolders | undefined, kind: ProjectFolderKind, folders: readonly string[] | undefined): ProjectFolders {
  const base = config ?? EMPTY_PROJECT_FOLDERS;
  const choices: Record<string, readonly string[]> = {};
  for (const other of PROJECT_FOLDER_KINDS) {
    const chosen = other === kind ? folders : base.folders[other];
    if (chosen !== undefined) {
      choices[other] = chosen;
    }
  }
  // Without a `variables` key, chosen `styles` choose the variables folders too
  // (parseProjectFolders reads files from before the split so). Beside chosen
  // styles, variables are therefore always written out, at their defaults when
  // they have no choice of their own, so the file reads back as set.
  if (choices['styles'] !== undefined && choices['variables'] === undefined) {
    choices['variables'] = DEFAULT_PROJECT_FOLDERS.variables;
  }
  const next: ProjectFolders = {
    version: 1,
    folders: choices,
    ...(base.unknownKeys === undefined ? {} : { unknownKeys: base.unknownKeys }),
    ...(base.unknownFolders === undefined ? {} : { unknownFolders: base.unknownFolders }),
    ...(base.cms === undefined ? {} : { cms: base.cms }),
  };
  assert(foldersFor(kind, next).join('\n') === (folders ?? DEFAULT_PROJECT_FOLDERS[kind]).join('\n'), 'withFolders: the kind reads what was set');
  assert(next.folders.styles === undefined || next.folders.variables !== undefined, 'withFolders: chosen styles always come with variables');
  return next;
}

/** Adds a folder to what `kind` reads now (its defaults when unchanged), or says why it cannot. */
export function addFolder(config: ProjectFolders | undefined, kind: ProjectFolderKind, input: string): Result<ProjectFolders, string> {
  let folder: string;
  try {
    folder = parseProjectFolder(input);
  } catch (error: unknown) {
    return err(error instanceof Error ? error.message : String(error));
  }
  const current = foldersFor(kind, config);
  const problem = folderChoiceProblem(kind, current, folder);
  if (problem !== undefined) {
    return err(problem);
  }
  const next = withFolders(config, kind, [...current, folder]);
  assert(foldersFor(kind, next).includes(folder), 'addFolder: the folder was added');
  return ok(next);
}

/** Removes a folder from what `kind` reads now; removing the last one leaves the panel reading none. */
export function removeFolder(config: ProjectFolders | undefined, kind: ProjectFolderKind, folder: string): ProjectFolders {
  const current = foldersFor(kind, config);
  assert(current.includes(folder), 'removeFolder: the folder is in the list');
  const next = withFolders(
    config,
    kind,
    current.filter((other) => other !== folder),
  );
  assert(!foldersFor(kind, next).includes(folder), 'removeFolder: the folder was removed');
  return next;
}

/** The configuration as JSON text, kinds in tab order so a diff reviews easily. */
export function serializeProjectFolders(config: ProjectFolders): string {
  const folders: Record<string, readonly string[]> = {};
  for (const kind of PROJECT_FOLDER_KINDS) {
    const chosen = config.folders[kind];
    if (chosen !== undefined) {
      folders[kind] = chosen;
    }
  }
  // Unknown panels and keys follow the known ones, as a newer Stacki wrote them.
  const shape = {
    version: 1,
    ...Object.fromEntries(config.unknownKeys ?? []),
    folders: { ...folders, ...Object.fromEntries((config.unknownFolders ?? []).filter(([key]) => knownFolderKind(key) === undefined)) },
    ...(config.cms === undefined ? {} : { cms: cmsShape(config.cms) }),
  };
  const source = JSON.stringify(shape, undefined, 2) + '\n';
  // Pair assertion: what is written must read back as the same choices.
  const reread = readProjectFoldersSource(source);
  assert(reread.kind === 'ready', 'serializeProjectFolders: the text parses');
  for (const kind of PROJECT_FOLDER_KINDS) {
    assert(reread.config.folders[kind]?.join('\n') === config.folders[kind]?.join('\n'), 'serializeProjectFolders: every kind round-trips');
  }
  assert((reread.config.unknownFolders?.length ?? 0) === (config.unknownFolders?.length ?? 0), 'serializeProjectFolders: unknown panels round-trip');
  assert(reread.config.cms?.files?.join('\n') === config.cms?.files?.join('\n'), 'serializeProjectFolders: CMS files round-trip');
  assert(reread.config.cms?.pickerExcluded?.join('\n') === config.cms?.pickerExcluded?.join('\n'), 'serializeProjectFolders: picker exclusions round-trip');
  return source;
}

function cmsShape(cms: ProjectCmsChoices) {
  return {
    ...(cms.files === undefined ? {} : { files: cms.files }),
    ...(cms.hiddenCollections === undefined ? {} : { hiddenCollections: cms.hiddenCollections }),
    ...(cms.pickerExcluded === undefined ? {} : { pickerExcluded: cms.pickerExcluded }),
    ...Object.fromEntries(cms.unknownKeys ?? []),
  };
}
