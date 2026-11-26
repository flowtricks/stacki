// Code intelligence for the open project: one question about one file's unsaved text, one answer. It reads the
// project's files and never runs them. Everything it keeps is rebuilt from disk, so the process holding it can be
// stopped and started at any time.
import ts from 'typescript';
import {
  CODE_INTEL_LIMITS,
  UNAVAILABLE,
  type CodeCompletion,
  type CodeCompletions,
  type CodeDiagnostic,
  type CodeHover,
  type CodeIntelReply,
  type CodeIntelRequest,
} from '../../../shared/ipc/codeIntel';
import { assert } from '../../../shared/core/assert';
import { componentCatalogue, componentSuggestions, frontmatterImport, mdxImport, moduleNames, type ComponentCatalogue } from './components';
import { fileStamp } from './fileCache';
import { frontmatterRange, isComponentTag, markupContext, type EmbeddedBlock, type MarkupContext } from './markupContext';
import { exportedSpecifier, owningPackage, packageManifest, type PackageManifest } from './packageSpecifier';
import { pathCompletions, servesPaths, type PathPlace } from './pathSuggest';
import { extensionOf, folderOf, joined, slashed, within } from './paths';
import { createProjectIndex, type ProjectIndex, type ProjectIndexOptions, type ProjectWatching } from './projectIndex';
import { blockLanguage, createStyleIndex, fileStyles, STYLESHEET_EXTENSIONS, type StyleIndex } from './styleIndex';
import { markupClassSuggestions, stylesheetCompletions, variableSuggestions, type StyleSources } from './styleSuggest';
import { completions, noCompletions, suggestion } from './suggestion';
import { entryMemory, sameTarget, typeDetail, typeDiagnostics, typeHover, typeSignature, typeSuggestions, type Target } from './typeAnswers';
import { typeConfig, type TypeConfig } from './typeConfig';
import { libraryFiles, type LibraryFiles } from './typeFiles';
import { createTypeProject, type TypeProject } from './typeProject';

const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const DEPENDENCIES_CHECKED_MAX = 30;
/** Files whose tsconfig is remembered. */
const CONFIGS_KEPT_MAX = 50;
/** Folders walked up looking for installed dependencies. */
const ANCESTORS_MAX = 40;
const ASTRO_DIRECTIVES: readonly string[] = [
  'class:list',
  'set:html',
  'set:text',
  'is:inline',
  'is:raw',
  'define:vars',
  'transition:name',
  'transition:animate',
  'transition:persist',
];

export interface CodeIntelService {
  readonly handle: (request: CodeIntelRequest) => CodeIntelReply;
  readonly dispose: () => void;
}

export function createCodeIntelService(options: { readonly libraries?: LibraryFiles; readonly watching?: ProjectWatching } = {}): CodeIntelService {
  const libraries = options.libraries ?? libraryFiles();
  let workspace: Workspace | undefined;
  return {
    handle: (request) => {
      const root = slashed(request.projectPath).replace(/\/+$/, '');
      if (workspace?.root !== root) {
        workspace?.dispose();
        workspace = createWorkspace(root, libraries, options.watching === undefined ? {} : { watching: options.watching });
      }
      return answer(workspace, request);
    },
    dispose: () => {
      workspace?.dispose();
      workspace = undefined;
    },
  };
}

interface Workspace {
  readonly root: string;
  readonly index: ProjectIndex;
  readonly styles: StyleIndex;
  readonly components: ComponentCatalogue;
  readonly memory: ReturnType<typeof entryMemory>;
  readonly libraries: LibraryFiles;
  /** The type checker's project for a file, made on first need. */
  readonly types: (file: string) => TypeProject;
  readonly packageFolder: (file: string) => string;
  /** The tsconfig a file belongs to, read once between changes: finding it among references lists the project. */
  readonly config: (file: string) => TypeConfig;
  readonly astroPackage: (folder: string) => string | undefined;
  /** False when the file's package lists dependencies and none are installed. */
  readonly installed: (file: string) => boolean;
  /** Reads what changed on disk since the last question. */
  readonly refresh: () => void;
  readonly dispose: () => void;
}

function createWorkspace(root: string, libraries: LibraryFiles, indexOptions: ProjectIndexOptions): Workspace {
  const index = createProjectIndex(root, indexOptions);
  const registry = ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, root);
  const versions = new Map<string, string>();
  const projects = new Map<string, TypeProject>();
  const astroFolders = new Map<string, string>();
  const configs = new Map<string, { readonly generation: number; readonly config: TypeConfig }>();
  const configFor = (file: string): TypeConfig => {
    const generation = index.generation();
    const kept = configs.get(file);
    if (kept?.generation === generation) {
      return kept.config;
    }
    const config = typeConfig(file, root);
    configs.delete(file);
    configs.set(file, { generation, config });
    const oldest = configs.keys().next();
    if (configs.size > CONFIGS_KEPT_MAX && oldest.done !== true) {
      configs.delete(oldest.value);
    }
    return config;
  };
  const installedFolders = new Set<string>();
  /** Packages last seen without their dependencies, and one of the names they lacked. */
  const awaited = new Map<string, readonly string[]>();
  const reset = (): void => {
    for (const project of projects.values()) {
      project.dispose();
    }
    projects.clear();
    configs.clear();
    versions.clear();
    astroFolders.clear();
    installedFolders.clear();
    awaited.clear();
  };
  const diskVersion = (file: string): string => {
    const kept = versions.get(file);
    if (kept !== undefined) {
      return kept;
    }
    const stamp = fileStamp(libraries.physical(file))?.stamp;
    if (stamp !== undefined) {
      versions.set(file, stamp);
    }
    return stamp ?? 'missing';
  };
  const packageFolder = (file: string): string => {
    let folder = folderOf(file);
    for (let depth = 0; depth < CODE_INTEL_LIMITS.indexDepthMax && within(root, folder); depth++) {
      if (ts.sys.fileExists(`${folder}/package.json`)) {
        return folder;
      }
      folder = folderOf(folder);
    }
    return root;
  };
  // Dependencies may be installed above the opened folder, as in a workspace.
  const installedPackage = (folder: string, name: string): string | undefined => {
    let at = folder;
    for (let depth = 0; depth < ANCESTORS_MAX; depth++) {
      if (ts.sys.fileExists(`${at}/node_modules/${name}/package.json`)) {
        return `${at}/node_modules/${name}`;
      }
      const parent = folderOf(at);
      if (parent === at) {
        break;
      }
      at = parent;
    }
    return undefined;
  };
  const astroPackage = (folder: string): string | undefined => {
    const kept = astroFolders.get(folder);
    if (kept !== undefined) {
      return kept;
    }
    const found = installedPackage(folder, 'astro');
    if (found === undefined) {
      return undefined;
    }
    const real = slashed(ts.sys.realpath?.(found) ?? found);
    astroFolders.set(folder, real);
    return real;
  };
  return {
    root,
    index,
    styles: createStyleIndex(index),
    components: componentCatalogue(index),
    memory: entryMemory(),
    libraries,
    packageFolder,
    config: configFor,
    astroPackage,
    installed: (file) => {
      const folder = packageFolder(file);
      if (installedFolders.has(folder)) {
        return true;
      }
      const names = dependencyNames(folder);
      const found = names.length === 0 || names.slice(0, DEPENDENCIES_CHECKED_MAX).some((name) => installedPackage(folder, name) !== undefined);
      if (found) {
        installedFolders.add(folder);
      } else {
        awaited.set(folder, names.slice(0, DEPENDENCIES_CHECKED_MAX));
      }
      return found;
    },
    types: (file) => {
      const config = configFor(file);
      const key = config.file ?? root;
      let project = projects.get(key);
      if (project === undefined) {
        project = createTypeProject({ config, index, libraries, registry, diskVersion, astroPackage, packageFolder });
      }
      projects.delete(key);
      projects.set(key, project);
      const oldest = projects.entries().next();
      if (projects.size > CODE_INTEL_LIMITS.projectsMax && oldest.done !== true) {
        oldest.value[1].dispose();
        projects.delete(oldest.value[0]);
      }
      return project;
    },
    refresh: () => {
      // Installing dependencies changes nothing the watch reports: what was read without them is read again.
      if ([...awaited].some(([folder, names]) => names.some((name) => installedPackage(folder, name) !== undefined))) {
        reset();
      }
      const changes = index.takeChanges();
      if (changes === 'all') {
        versions.clear();
        return;
      }
      if (changes.some((file) => /\/(tsconfig[\w.-]*\.json|jsconfig\.json|package\.json)$/.test(file))) {
        reset();
        return;
      }
      for (const file of changes) {
        versions.delete(file);
      }
    },
    dispose: () => {
      reset();
      index.dispose();
    },
  };
}

function dependencyNames(folder: string): readonly string[] {
  return packageManifest(folder)?.dependencies ?? [];
}

/** One request, resolved against the workspace. */
interface Question {
  readonly workspace: Workspace;
  readonly file: string;
  readonly extension: string;
  readonly text: string;
}

function answer(workspace: Workspace, request: CodeIntelRequest): CodeIntelReply {
  const file = joined(workspace.root, request.path);
  assert(within(workspace.root, file), 'An asked-about file is inside the project');
  workspace.refresh();
  const question: Question = { workspace, file, extension: extensionOf(file), text: request.text };
  const query = request.query;
  switch (query.kind) {
    case 'complete': {
      const found = complete(question, query.position, { explicit: query.explicit });
      return { kind: 'completions', completions: found };
    }
    case 'resolve': {
      const asked = typed(question, query.position);
      const detail = asked === undefined ? undefined : typeDetail(asked.project.service, asked.target, query, workspace.memory);
      return detail === undefined ? UNAVAILABLE : { kind: 'detail', detail };
    }
    case 'hover':
      return { kind: 'hover', hover: hover(question, query.position) };
    case 'signature': {
      const asked = typed(question, query.position);
      return { kind: 'signature', help: asked === undefined ? undefined : typeSignature(asked.project.service, asked.target, query.position) };
    }
    case 'diagnostics':
      return { kind: 'diagnostics', diagnostics: diagnostics(question) };
    default: {
      const exhaustive: never = query;
      return exhaustive;
    }
  }
}

interface Typed {
  readonly project: TypeProject;
  readonly target: Target;
}

function openProject(question: Question): TypeProject {
  const project = question.workspace.types(question.file);
  project.open({ file: question.file, text: question.text });
  return project;
}

/** The file the type checker answers about at `position`: the file, an .astro file's TSX, or one of its scripts. */
function typed(question: Question, position: number): Typed | undefined {
  if (SCRIPT_EXTENSIONS.has(question.extension)) {
    return { project: openProject(question), target: sameTarget(question.file, question.text) };
  }
  if (question.extension !== '.astro') {
    return undefined;
  }
  const context = markupContext(question.text, position);
  if (context.kind === 'style' || context.kind === 'comment') {
    return undefined;
  }
  const project = openProject(question);
  if (context.kind === 'script') {
    const script = project.scripts().find((entry) => entry.block.from === context.from);
    return script === undefined ? undefined : { project, target: sameTarget(script.file, question.text) };
  }
  const target = astroTarget(project, question);
  return target === undefined ? undefined : { project, target };
}

function astroTarget(project: TypeProject, question: Question): Target | undefined {
  const printed = project.astro(question.file);
  if (printed === undefined) {
    return undefined;
  }
  return { file: question.file, text: question.text, toService: printed.toGenerated, toEditor: printed.toOriginal, astro: true };
}

function typeCompletions(question: Question, position: number, how: { readonly attribute: boolean }): CodeCompletions {
  const asked = typed(question, position);
  const found =
    asked === undefined ? undefined : typeSuggestions(asked.project.service, asked.target, { position, attribute: how.attribute }, question.workspace.memory);
  if (found === undefined || found.items.length === 0) {
    return noCompletions(position, { exclusive: false });
  }
  return completions({ from: found.from, to: found.to, typed: found.typed, exclusive: true }, found.items);
}

function complete(question: Question, position: number, how: { readonly explicit: boolean }): CodeCompletions {
  if (STYLESHEET_EXTENSIONS.has(question.extension)) {
    return styleCompletions(question, position, { from: 0, language: question.extension.slice(1) });
  }
  if (SCRIPT_EXTENSIONS.has(question.extension)) {
    return importCompletions(question, position) ?? scriptCompletions(question, position, how);
  }
  if (question.extension === '.astro' || question.extension === '.mdx' || question.extension === '.html') {
    return markupCompletions(question, position, how);
  }
  return noCompletions(position, { exclusive: false });
}

function scriptCompletions(question: Question, position: number, how: { readonly explicit: boolean }): CodeCompletions {
  const line = lineBefore(question.text, position);
  const inClass = /\bclass(?:Name)?\s*=\s*(?:\{\s*)?["'`]([^"'`]*)$/.exec(line);
  if (inClass !== null && /\.(tsx|jsx)$/.test(question.extension)) {
    return classCompletions(question, position, inClass[1] ?? '');
  }
  // In a .tsx or .jsx tag, an attribute of a component is being named.
  const attributeOf = /\.(tsx|jsx)$/.test(question.extension) ? /<([A-Z][\w.]*)(?:\s+[^<>]*)?\s+[\w-]*$/.exec(line)?.[1] : undefined;
  if (!how.explicit && attributeOf === undefined && !asksAfter(line)) {
    return noCompletions(position, { exclusive: true });
  }
  return typeCompletions(question, position, { attribute: attributeOf !== undefined });
}

/** Whether what was just typed is a place to suggest at, so a space or a new line does not open a list of everything. */
function asksAfter(line: string): boolean {
  return /(?:[\w$]|\.|["'`/<@]|=\{)$/.test(line) || /[(,{]\s?["']$/.test(line);
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'])([^"'\n]*)$/;

// Inside an import's quotes: the type checker knows packages and TypeScript files, the index everything else.
function importCompletions(question: Question, position: number): CodeCompletions | undefined {
  const match = SPECIFIER.exec(lineBefore(question.text, position));
  if (match === null) {
    return undefined;
  }
  const written = match[2] ?? '';
  const paths = pathCompletions(question.workspace.index, pathPlace(question), { typed: written, position, use: 'import' });
  const checked = question.extension === '.mdx' ? undefined : typeCompletions(question, position, { attribute: false });
  if (paths === undefined) {
    return checked ?? noCompletions(position, { exclusive: true });
  }
  const names = new Set(paths.items.map((item) => item.label.replace(/\/$/, '')));
  const more = checked !== undefined && checked.from === paths.from ? checked.items.filter((item) => !names.has(item.label)) : [];
  return { ...paths, exclusive: true, items: [...paths.items, ...more].slice(0, CODE_INTEL_LIMITS.completionsMax) };
}

function lineBefore(text: string, position: number): string {
  return text.slice(text.lastIndexOf('\n', position - 1) + 1, position);
}

function pathPlace(question: Question): PathPlace {
  const packageFolder = question.workspace.packageFolder(question.file);
  return {
    file: question.file,
    packageFolder,
    aliases: question.workspace.config(question.file).aliases,
    dependencies: dependencyNames(packageFolder),
  };
}

function styleSources(question: Question): StyleSources {
  return {
    root: question.workspace.root,
    current: fileStyles(question.file, question.text),
    others: question.workspace.styles.all().filter((styles) => styles.file !== question.file),
  };
}

function styleCompletions(question: Question, position: number, sheet: { readonly from: number; readonly language: string }): CodeCompletions {
  const before = question.text.slice(sheet.from, position);
  const line = lineBefore(question.text, position);
  const url = /(?:url\(\s*["']?|@(?:import|use|forward|reference)\s+(?:url\(\s*)?["'])([^"')\s]*)$/.exec(line);
  if (url !== null) {
    const written = url[1] ?? '';
    return (
      pathCompletions(question.workspace.index, pathPlace(question), { typed: written, position, use: 'style-url' }) ??
      noCompletions(position, { exclusive: false })
    );
  }
  return stylesheetCompletions(styleSources(question), { before, position, language: sheet.language }) ?? noCompletions(position, { exclusive: false });
}

function classCompletions(question: Question, position: number, value: string): CodeCompletions {
  const word = /[^\s]*$/.exec(value)?.[0] ?? '';
  const written = new Set(value.slice(0, value.length - word.length).split(/\s+/));
  const items = markupClassSuggestions(styleSources(question)).filter((item) => !written.has(item.label));
  return completions({ from: position - word.length, to: position, typed: word, exclusive: false }, items);
}

function markupCompletions(question: Question, position: number, how: { readonly explicit: boolean }): CodeCompletions {
  const none = noCompletions(position, { exclusive: false });
  if (question.extension === '.mdx') {
    const imports = importCompletions(question, position);
    if (imports !== undefined) {
      return imports;
    }
  }
  const context = markupContext(question.text, position);
  const checked = question.extension === '.astro';
  switch (context.kind) {
    case 'frontmatter':
    case 'expression':
      if (!checked) {
        return none;
      }
      return importCompletions(question, position) ?? scriptCompletions(question, position, how);
    case 'script':
      if (!checked) {
        return none;
      }
      return importCompletions(question, position) ?? scriptCompletions(question, position, how);
    case 'style':
      return styleCompletions(question, position, { from: context.from, language: blockLanguage(context) });
    case 'tag-name':
      return context.closing || question.extension === '.html' ? none : tagCompletions(question, position, context.from);
    case 'attribute-name':
      return attributeCompletions(question, position, context);
    case 'attribute-value':
      return valueCompletions(question, position, context);
    case 'text':
    case 'comment':
      return none;
    default: {
      const exhaustive: never = context;
      return exhaustive;
    }
  }
}

function tagCompletions(question: Question, position: number, from: number): CodeCompletions {
  const written = question.text.slice(from, position);
  if (written.includes('.')) {
    return question.extension === '.astro' ? typeCompletions(question, position, { attribute: false }) : noCompletions(position, { exclusive: false });
  }
  const { workspace, file } = question;
  const mdx = question.extension === '.mdx';
  const resolver = mdx ? undefined : openProject(question);
  const config = workspace.config(file);
  const fence = frontmatterRange(question.text);
  const code = mdx ? (question.text.match(/^import\s[^\n]*$/gm) ?? []).join('\n') : fence === undefined ? '' : question.text.slice(fence.from, fence.to);
  const items = componentSuggestions(
    workspace.components.all(),
    {
      file,
      root: workspace.root,
      packageFolder: workspace.packageFolder(file),
      aliases: config.aliases,
      resolve: (specifier) => (resolver ?? workspace.types(file)).resolve(specifier, file),
      packaged: workspacePackages(workspace, file),
    },
    {
      names: moduleNames(code),
      addImport: (statement) => (mdx ? mdxImport(question.text, statement) : frontmatterImport(question.text, statement)),
    },
  );
  return completions({ from, to: position, typed: written, exclusive: false }, items);
}

// The other packages of a workspace this file's package depends on, and how each of their components is named.
function workspacePackages(workspace: Workspace, file: string): (component: string) => string | undefined {
  const dependencies = new Set(dependencyNames(workspace.packageFolder(file)));
  const manifests = new Map<string, PackageManifest | undefined>();
  return (component) => {
    const folder = owningPackage(component, workspace.root, (candidate) => ts.sys.fileExists(`${candidate}/package.json`));
    if (folder === undefined) {
      return undefined;
    }
    if (!manifests.has(folder)) {
      manifests.set(folder, packageManifest(folder));
    }
    const owner = manifests.get(folder);
    return owner?.name !== undefined && dependencies.has(owner.name) ? exportedSpecifier(owner, folder, component) : undefined;
  };
}

function attributeCompletions(question: Question, position: number, context: Extract<MarkupContext, { kind: 'attribute-name' }>): CodeCompletions {
  if (question.extension === '.astro' && isComponentTag(context.tag)) {
    return typeCompletions(question, position, { attribute: true });
  }
  if (question.extension !== '.astro') {
    return noCompletions(position, { exclusive: false });
  }
  const word = question.text.slice(context.from, position);
  const items: CodeCompletion[] = ASTRO_DIRECTIVES.filter((name) => !context.written.includes(name)).map((name) => suggestion(name, 'property'));
  return word === '' ? noCompletions(position, { exclusive: false }) : completions({ from: context.from, to: position, typed: word, exclusive: false }, items);
}

function valueCompletions(question: Question, position: number, context: Extract<MarkupContext, { kind: 'attribute-value' }>): CodeCompletions {
  const value = question.text.slice(context.from, position);
  const attribute = context.attribute.toLowerCase();
  if (attribute === 'class' || attribute === 'classname') {
    return classCompletions(question, position, value);
  }
  if (attribute === 'style') {
    return styleCompletions(question, position, { from: context.from, language: 'css' });
  }
  const component = question.extension === '.astro' && isComponentTag(context.tag);
  if (component) {
    const types = typeCompletions(question, position, { attribute: false });
    if (types.items.length > 0) {
      return types;
    }
  }
  if (servesPaths(attribute)) {
    const paths = pathCompletions(question.workspace.index, pathPlace(question), { typed: value, position, use: 'served' });
    if (paths !== undefined) {
      return paths;
    }
  }
  return noCompletions(position, { exclusive: component });
}

function hover(question: Question, position: number): CodeHover | undefined {
  const style = styleHover(question, position);
  if (style !== undefined) {
    return style;
  }
  const asked = typed(question, position);
  return asked === undefined ? undefined : typeHover(asked.project.service, asked.target, position);
}

// A custom property says its value and where it is declared.
function styleHover(question: Question, position: number): CodeHover | undefined {
  const start = question.text.slice(Math.max(0, position - 200), position).search(/--[\w\u0080-￿-]*$/);
  const from = start === -1 ? position : Math.max(0, position - 200) + start;
  const name = /^--[\w\u0080-￿-]+/.exec(question.text.slice(from, from + 200))?.[0];
  if (name === undefined || position > from + name.length || !/var\(\s*$/.test(question.text.slice(Math.max(0, from - 20), from))) {
    return undefined;
  }
  const found = variableSuggestions(styleSources(question)).find((item) => item.label === name);
  return found === undefined ? undefined : { from, to: from + name.length, signature: found.signature, documentation: undefined };
}

function diagnostics(question: Question): readonly CodeDiagnostic[] {
  const script = SCRIPT_EXTENSIONS.has(question.extension);
  if (!script && question.extension !== '.astro') {
    return [];
  }
  const project = openProject(question);
  const installed = question.workspace.installed(question.file);
  if (script) {
    return typeDiagnostics(project.service, sameTarget(question.file, question.text), { syntaxOnly: !installed });
  }
  const printed = project.astro(question.file);
  const target = astroTarget(project, question);
  if (printed === undefined || target === undefined) {
    return [];
  }
  const syntaxOnly = !installed || question.workspace.astroPackage(question.workspace.packageFolder(question.file)) === undefined;
  const found: CodeDiagnostic[] = printed.problems.map((problem) => ({ ...problem, severity: 'error' }));
  found.push(...typeDiagnostics(project.service, target, { syntaxOnly }));
  for (const entry of project.scripts()) {
    found.push(...typeDiagnostics(project.service, sameTarget(entry.file, question.text), { syntaxOnly: syntaxOnly || isInline(entry.block) }));
  }
  found.sort((left, right) => left.from - right.from);
  return found.slice(0, CODE_INTEL_LIMITS.diagnosticsMax);
}

function isInline(block: EmbeddedBlock): boolean {
  return block.attributes.has('is:inline');
}
