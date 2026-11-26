// Which tsconfig a file belongs to and what it says. TypeScript's own parser reads it, `extends` and `paths` included,
// as data: nothing in a config is run, and a tsconfig's `plugins` are never loaded (the language service has no plugin
// host). A project with no config, or one whose `extends` is not installed, gets defaults that suit an Astro site.
import ts from 'typescript';
import type { PathAlias } from './pathSuggest';
import { folderOf, joined, within } from './paths';

/** Referenced projects looked into for the one that holds a file. */
const REFERENCES_MAX = 16;
const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json'] as const;

/** The nearest config above `file`, not above the project's root. */
export function nearestConfig(file: string, root: string): string | undefined {
  let folder = folderOf(file);
  while (within(root, folder)) {
    for (const name of CONFIG_NAMES) {
      const candidate = `${folder}/${name}`;
      if (ts.sys.fileExists(candidate)) {
        return candidate;
      }
    }
    const parent = folderOf(folder);
    if (parent === folder) {
      break;
    }
    folder = parent;
  }
  return undefined;
}

export interface TypeConfig {
  /** The config file the options came from; undefined for the defaults. */
  readonly file: string | undefined;
  /** The folder relative settings and automatic `@types` start from. */
  readonly folder: string;
  readonly options: ts.CompilerOptions;
  readonly aliases: readonly PathAlias[];
}

const EXTRA_EXTENSIONS: readonly ts.FileExtensionInfo[] = [{ extension: 'astro', isMixedContent: true, scriptKind: ts.ScriptKind.Deferred }];

/** The config for `file`: the nearest one, or the project it references that holds the file. */
export function typeConfig(file: string, root: string): TypeConfig {
  const nearest = nearestConfig(file, root);
  if (nearest === undefined) {
    return finished(undefined, root, {});
  }
  const parsed = parseConfig(nearest, 'options');
  const references = parsed?.projectReferences ?? [];
  if (parsed !== undefined && references.length > 0 && !holdsFile(nearest, file)) {
    const referenced = references.slice(0, REFERENCES_MAX).map((reference) => ts.resolveProjectReferencePath(reference));
    const holder = referenced.find((candidate) => holdsFile(candidate, file)) ?? referenced.find((candidate) => within(folderOf(joined(candidate)), file));
    const inner = holder === undefined ? undefined : parseConfig(holder, 'options');
    if (holder !== undefined && inner !== undefined) {
      return finished(joined(holder), folderOf(joined(holder)), inner.options);
    }
  }
  return finished(nearest, folderOf(nearest), parsed?.options ?? {});
}

function holdsFile(config: string, file: string): boolean {
  const parsed = parseConfig(config, 'files');
  return parsed?.fileNames.some((name) => joined(name) === file) === true;
}

function parseConfig(config: string, want: 'options' | 'files'): ts.ParsedCommandLine | undefined {
  const read = ts.readConfigFile(config, (name) => ts.sys.readFile(name));
  if (read.config === undefined) {
    return undefined;
  }
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: (name) => ts.sys.fileExists(name),
    readFile: (name) => ts.sys.readFile(name),
    // Listing every file is only needed to ask which referenced project holds one.
    readDirectory: want === 'files' ? ts.sys.readDirectory : () => [],
  };
  return ts.parseJsonConfigFileContent(read.config, host, folderOf(joined(config)), undefined, config, undefined, EXTRA_EXTENSIONS);
}

const DEFAULTS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  esModuleInterop: true,
  resolveJsonModule: true,
  jsx: ts.JsxEmit.Preserve,
  allowImportingTsExtensions: true,
};

function finished(file: string | undefined, folder: string, written: ts.CompilerOptions): TypeConfig {
  const options: ts.CompilerOptions = {
    ...DEFAULTS,
    ...written,
    // What analysis needs whatever the project says: nothing is written to disk, JavaScript imports are typed, other
    // files' own mistakes are not worked through, and `.astro` files may be sources.
    noEmit: true,
    allowJs: true,
    skipLibCheck: true,
    allowNonTsExtensions: true,
    incremental: false,
    composite: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
  };
  delete options.outDir;
  delete options.rootDir;
  delete options.tsBuildInfoFile;
  delete options.outFile;
  if (options.moduleResolution === ts.ModuleResolutionKind.Classic) {
    options.moduleResolution = ts.ModuleResolutionKind.Bundler;
  }
  return { file, folder, options, aliases: aliasesOf(options, folder) };
}

function aliasesOf(options: ts.CompilerOptions, folder: string): readonly PathAlias[] {
  const base = options.baseUrl ?? (typeof options['pathsBasePath'] === 'string' ? options['pathsBasePath'] : folder);
  return Object.entries(options.paths ?? {}).flatMap(([pattern, targets]) => {
    const target = targets[0];
    const star = pattern.indexOf('*');
    if (target === undefined || star !== pattern.length - 1 || !target.includes('*')) {
      return [];
    }
    const [head = '', suffix = ''] = target.split('*');
    if (head !== '' && !head.endsWith('/') && head !== '.') {
      return [];
    }
    return [{ prefix: pattern.slice(0, star), folder: joined(base, head === '' ? '.' : head), suffix }];
  });
}
