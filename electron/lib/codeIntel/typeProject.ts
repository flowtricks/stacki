// One TypeScript project: a tsconfig's options with a language service over them. The checker is the one the app
// ships (never the project's), and it only reads: sources, type declarations and package.json files.
import ts from 'typescript';
import { CODE_INTEL_LIMITS } from '../../../shared/ipc/codeIntel';
import { assert } from '../../../shared/core/assert';
import { astroDocument, type AstroDocument } from './astroDocument';
import { fileCache, fileStamp, readText } from './fileCache';
import { embeddedBlocks, type EmbeddedBlock } from './markupContext';
import { extensionOf, joined, slashed, within } from './paths';
import type { ProjectIndex } from './projectIndex';
import type { TypeConfig } from './typeConfig';
import { FALLBACK_AMBIENT, FALLBACK_AMBIENT_FILE, FOREIGN_COMPONENTS, isStandIn, standInSource, type LibraryFiles } from './typeFiles';
import { isCssModule } from './styleIndex';

const SCRIPT_MARK = '.__stacki-script-';
const SCRIPTS_MAX = 20;
const TYPE_SOURCES: ReadonlySet<string> = new Set(['.ts', '.tsx', '.mts', '.cts']);
const OWN_RESOLVED = /\.(astro|vue|svelte|mdx)$|\.module\.(css|scss|sass|less)$/i;

export interface OpenDocument {
  readonly file: string;
  readonly text: string;
}

/** A `<script>` of the open file, as a file of its own: the same text with everything outside the block blanked. */
export interface ScriptDocument {
  readonly file: string;
  readonly block: EmbeddedBlock;
}

export interface TypeProject {
  readonly config: TypeConfig;
  readonly service: ts.LanguageService;
  /** Puts the editor's unsaved text over the file on disk. */
  readonly open: (document: OpenDocument) => void;
  /** The conversion of an .astro file, from the open text when it is the open one. */
  readonly astro: (file: string) => AstroDocument | undefined;
  readonly scripts: () => readonly ScriptDocument[];
  /** The file a specifier names from `containing`. */
  readonly resolve: (specifier: string, containing: string) => string | undefined;
  readonly dispose: () => void;
}

export interface TypeProjectParts {
  readonly config: TypeConfig;
  readonly index: ProjectIndex;
  readonly libraries: LibraryFiles;
  readonly registry: ts.DocumentRegistry;
  /** The version of a file on disk, kept until the watch says it changed. */
  readonly diskVersion: (file: string) => string;
  /** The folder of the installed `astro` package seen from a folder; undefined when it is not installed. */
  readonly astroPackage: (folder: string) => string | undefined;
  /** The nearest folder above a file with a package.json. */
  readonly packageFolder: (file: string) => string;
}

interface State {
  open: (OpenDocument & { readonly version: number }) | undefined;
  scripts: readonly ScriptDocument[];
  version: number;
  readonly roots: Map<string, readonly string[]>;
}

export function createTypeProject(parts: TypeProjectParts): TypeProject {
  const state: State = { open: undefined, scripts: [], version: 0, roots: new Map() };
  const convert = fileCache({ entriesMax: 200, sizeBytesMax: CODE_INTEL_LIMITS.sourceFileBytesMax }, (file, text) => astroDocument(text, file));
  let openAstro: { readonly version: number; readonly document: AstroDocument } | undefined;
  const astro = (file: string): AstroDocument | undefined => {
    if (state.open?.file === file) {
      if (openAstro?.version !== state.open.version) {
        openAstro = { version: state.open.version, document: astroDocument(state.open.text, file) };
      }
      return openAstro.document;
    }
    return convert(file);
  };
  const virtualText = createVirtualText(parts, state, astro);
  const host = createHost(parts, state, virtualText);
  const service = ts.createLanguageService(host, parts.registry);
  return {
    config: parts.config,
    service,
    open: (document) => {
      if (state.open?.file === document.file && state.open.text === document.text) {
        return;
      }
      state.version += 1;
      state.open = { ...document, version: state.version };
      state.scripts = extensionOf(document.file) === '.astro' ? scriptDocuments(document) : [];
    },
    astro,
    scripts: () => state.scripts,
    resolve: (specifier, containing) => resolveModule(parts, host, specifier, containing)?.resolvedFileName,
    dispose: () => service.dispose(),
  };
}

function scriptDocuments(document: OpenDocument): readonly ScriptDocument[] {
  return embeddedBlocks(document.text)
    .scripts.filter((block) => !isDataScript(block))
    .slice(0, SCRIPTS_MAX)
    .map((block, position) => {
      // An inline script is shipped as written, so it is JavaScript; any other goes through the build as TypeScript.
      const extension = block.attributes.has('is:inline') ? 'js' : 'ts';
      return { file: `${document.file}${SCRIPT_MARK}${position}.${extension}`, block };
    });
}

// JSON, import maps and templates in a script tag are not code to check.
function isDataScript(block: EmbeddedBlock): boolean {
  const type = block.attributes.get('type')?.toLowerCase();
  return type !== undefined && type !== '' && !/^(module|text\/javascript|application\/javascript)$/.test(type);
}

function createVirtualText(parts: TypeProjectParts, state: State, astro: (file: string) => AstroDocument | undefined) {
  const standIns = fileCache({ entriesMax: 500, sizeBytesMax: CODE_INTEL_LIMITS.sourceFileBytesMax }, standInSource);
  return (file: string): string | undefined => {
    if (file === FALLBACK_AMBIENT_FILE) {
      return FALLBACK_AMBIENT;
    }
    const script = state.scripts.find((entry) => entry.file === file);
    if (script !== undefined) {
      assert(state.open !== undefined, 'A script document belongs to the open file');
      return scriptText(state.open.text, script);
    }
    const extension = extensionOf(file);
    if (extension === '.astro') {
      return astro(file)?.code;
    }
    if (state.open?.file === file) {
      return isStandIn(file) ? standInSource(file, state.open.text) : state.open.text;
    }
    if (isStandIn(file)) {
      return standIns(file);
    }
    const inLibraries = file.startsWith(`${parts.libraries.folder}/`);
    const limit = inLibraries || file.includes('/node_modules/') ? CODE_INTEL_LIMITS.sourceFileBytesMax * 4 : CODE_INTEL_LIMITS.sourceFileBytesMax;
    return readText(parts.libraries.physical(file), limit);
  };
}

function scriptText(text: string, script: ScriptDocument): string {
  const { from, to } = script.block;
  const blank = (part: string): string => part.replace(/[^\r\n]/g, ' ');
  const body = `${blank(text.slice(0, from))}${text.slice(from, to)}${blank(text.slice(to))}`;
  // A built script is a module of its own; an inline one shares the page's globals.
  return script.file.endsWith('.ts') ? `${body}\nexport {};\n` : body;
}

function createHost(parts: TypeProjectParts, state: State, virtualText: (file: string) => string | undefined): ts.LanguageServiceHost {
  const { config, index, libraries } = parts;
  const versionOf = (file: string): string => {
    if (state.open !== undefined) {
      if (state.open.file === file || state.scripts.some((entry) => entry.file === file)) {
        return `open-${state.open.version}`;
      }
    }
    return file === FALLBACK_AMBIENT_FILE ? '1' : parts.diskVersion(file);
  };
  const exists = (file: string): boolean => {
    if (file === FALLBACK_AMBIENT_FILE || state.open?.file === file || state.scripts.some((entry) => entry.file === file)) {
      return true;
    }
    return ts.sys.fileExists(libraries.physical(file));
  };
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => config.options,
    getProjectVersion: () => `${state.version}:${index.generation()}`,
    getScriptFileNames: () => rootsOf(parts, state),
    getScriptVersion: versionOf,
    getScriptKind: scriptKind,
    getScriptSnapshot: (file) => {
      const text = virtualText(slashed(file));
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => config.folder,
    getDefaultLibFileName: (options) => `${libraries.folder}/${ts.getDefaultLibFileName(options)}`,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    fileExists: exists,
    readFile: (file) => virtualText(slashed(file)),
    readDirectory: (path, extensions, exclude, include, depth) => ts.sys.readDirectory(path, extensions, exclude, include, depth),
    directoryExists: (folder) => ts.sys.directoryExists(folder),
    getDirectories: (folder) => ts.sys.getDirectories(folder),
    ...(ts.sys.realpath === undefined ? {} : { realpath: ts.sys.realpath }),
    resolveModuleNameLiterals: (literals, containing, redirected, options) =>
      literals.map((literal) => ({ resolvedModule: resolveModule(parts, host, literal.text, containing, { redirected, options }) })),
  };
  return host;
}

function scriptKind(file: string): ts.ScriptKind {
  if (isCssModule(file) || FOREIGN_COMPONENTS.has(extensionOf(file))) {
    return ts.ScriptKind.TS;
  }
  switch (extensionOf(file)) {
    case '.astro':
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.json':
      return ts.ScriptKind.JSON;
    default:
      return ts.ScriptKind.TS;
  }
}

function resolveModule(
  parts: TypeProjectParts,
  host: ts.LanguageServiceHost,
  specifier: string,
  containing: string,
  more: { readonly redirected?: ts.ResolvedProjectReference | undefined; readonly options?: ts.CompilerOptions } = {},
): ts.ResolvedModuleFull | undefined {
  const options = more.options ?? parts.config.options;
  const moduleHost: ts.ModuleResolutionHost = {
    fileExists: (file) => host.fileExists(file),
    readFile: (file) => ts.sys.readFile(file),
    directoryExists: (folder) => ts.sys.directoryExists(folder),
    ...(ts.sys.realpath === undefined ? {} : { realpath: ts.sys.realpath }),
  };
  const bare = specifier.replace(/\?.*$/, '');
  if (OWN_RESOLVED.test(bare)) {
    // TypeScript looks for `Card.astro.d.ts` beside the name; answering for that file resolves relative names,
    // aliases, `baseUrl` and package exports the way it resolves any other import.
    const probe: ts.ModuleResolutionHost = {
      ...moduleHost,
      fileExists: (file) => file.endsWith('.d.ts') && OWN_RESOLVED.test(file.slice(0, -5)) && ts.sys.fileExists(file.slice(0, -5)),
    };
    const found = ts.resolveModuleName(bare, containing, options, probe, undefined, more.redirected).resolvedModule;
    if (found !== undefined && found.resolvedFileName.endsWith('.d.ts')) {
      const resolved = found.resolvedFileName.slice(0, -5);
      return {
        resolvedFileName: resolved,
        extension: extensionOf(resolved) === '.astro' ? ts.Extension.Tsx : ts.Extension.Ts,
        isExternalLibraryImport: found.isExternalLibraryImport ?? false,
      };
    }
  }
  return ts.resolveModuleName(specifier, containing, options, moduleHost, undefined, more.redirected).resolvedModule;
}

// The open file, the declarations that give Astro files their globals, and the project's own TypeScript, so that what
// it exports can be suggested before it is imported. Everything else is read when something imports it.
function rootsOf(parts: TypeProjectParts, state: State): string[] {
  const open = state.open?.file;
  const key = `${parts.index.generation()}:${open ?? ''}:${state.scripts.map((entry) => entry.file).join(',')}`;
  let files = state.roots.get(key);
  if (files === undefined) {
    files = collectRoots(parts, state);
    state.roots.clear();
    state.roots.set(key, files);
  }
  return [...files];
}

function collectRoots(parts: TypeProjectParts, state: State): readonly string[] {
  const { config, index } = parts;
  const roots = new Set<string>();
  const packageFolder = state.open === undefined ? config.folder : parts.packageFolder(state.open.file);
  const astro = state.open === undefined ? undefined : parts.astroPackage(packageFolder);
  // First, because the first declaration of a name is the one that counts: what Astro generated for this project
  // must be met before the placeholders Astro ships for a project that has generated nothing.
  const generated = astro === undefined ? [] : generatedTypes(packageFolder, config.folder);
  for (const file of generated) {
    roots.add(file);
  }
  const files = index.files().files.filter((file) => within(config.folder, file));
  const declarations = files.filter((file) => file.endsWith('.d.ts'));
  const sources = files.filter((file) => TYPE_SOURCES.has(extensionOf(file)) && !file.endsWith('.d.ts'));
  for (const file of declarations.slice(0, CODE_INTEL_LIMITS.rootFilesMax)) {
    roots.add(file);
  }
  if (sources.length <= CODE_INTEL_LIMITS.rootFilesMax) {
    for (const file of sources) {
      roots.add(file);
    }
  }
  if (state.open !== undefined) {
    for (const file of astroDeclarations(astro, generated)) {
      roots.add(file);
    }
    if (astro === undefined && extensionOf(state.open.file) === '.astro') {
      roots.add(FALLBACK_AMBIENT_FILE);
    }
    roots.add(state.open.file);
    for (const script of state.scripts) {
      roots.add(script.file);
    }
  }
  return [...roots];
}

// The types Astro generated for this project (content collections, environment variables), which stand in `.astro/`
// once a dev server or `astro sync` has run.
function generatedTypes(packageFolder: string, configFolder: string): readonly string[] {
  return [...new Set([packageFolder, configFolder])].map((folder) => `${folder}/.astro/types.d.ts`).filter((file) => fileStamp(file) !== undefined);
}

// What Astro's own language tools add: its globals and element types, and without generated types, its client's.
function astroDeclarations(astro: string | undefined, generated: readonly string[]): readonly string[] {
  if (astro === undefined) {
    return [];
  }
  const own = [`${astro}/env.d.ts`, `${astro}/astro-jsx.d.ts`, ...(generated.length === 0 ? [`${astro}/client.d.ts`] : [])];
  return own.filter((file) => fileStamp(file) !== undefined).map((file) => joined(file));
}
