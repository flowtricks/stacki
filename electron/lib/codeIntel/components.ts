// The project's components, as suggestions for a tag: any .astro file, any framework or MDX component, and any
// TypeScript or JavaScript component with an export named like its file, wherever it lives. Accepting one writes its
// import, spelled as the file's other imports would be: relative nearby, through a tsconfig alias further off. A file
// already imported is offered under the name it has, and a name already taken gets its folder's.
import ts from 'typescript';
import { CODE_INTEL_LIMITS, type CodeCompletion, type CodeEdit } from '../../../shared/ipc/codeIntel';
import { assert } from '../../../shared/core/assert';
import { fileCache } from './fileCache';
import { frontmatterRange } from './markupContext';
import type { PathAlias } from './pathSuggest';
import { extensionOf, folderOf, nameOf, relativeSpecifier, within } from './paths';
import type { ProjectIndex } from './projectIndex';
import { suggestion } from './suggestion';

const KEPT_EXTENSIONS: ReadonlySet<string> = new Set(['.astro', '.vue', '.svelte', '.mdx']);
const SCRIPT_COMPONENTS: ReadonlySet<string> = new Set(['.tsx', '.jsx']);
const SUGGESTED_MAX = 2_000;
const FRAMEWORKS: Readonly<Record<string, string>> = { '.vue': 'Vue', '.svelte': 'Svelte', '.mdx': 'MDX', '.tsx': 'JSX', '.jsx': 'JSX' };

export interface ImportedName {
  readonly name: string;
  readonly specifier: string;
}

/** What a block of module code already declares: its imports, and every name taken at its top level. */
export interface ModuleNames {
  readonly imports: readonly ImportedName[];
  readonly taken: ReadonlySet<string>;
  /** Where a new import goes, as an offset into the code, after the last one. */
  readonly after: number;
  readonly quote: '"' | "'";
  readonly semicolon: ';' | '';
}

export function moduleNames(code: string): ModuleNames {
  const source = ts.createSourceFile('frontmatter.ts', code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const imports: ImportedName[] = [];
  const taken = new Set<string>();
  let after = 0;
  let quote: '"' | "'" = "'";
  let semicolon: ';' | '' = ';';
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      after = statement.end;
      quote = code.charAt(statement.moduleSpecifier.end - 1) === '"' ? '"' : "'";
      semicolon = code.slice(statement.moduleSpecifier.end, statement.end).includes(';') ? ';' : '';
      const clause = statement.importClause;
      if (clause?.name !== undefined) {
        imports.push({ name: clause.name.text, specifier });
        taken.add(clause.name.text);
      }
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        taken.add(bindings.name.text);
      } else if (bindings !== undefined) {
        for (const element of bindings.elements) {
          taken.add(element.name.text);
          imports.push({ name: element.name.text, specifier });
        }
      }
    } else {
      declaredNames(statement, taken);
    }
  }
  return { imports, taken, after, quote, semicolon };
}

function declaredNames(statement: ts.Statement, taken: Set<string>): void {
  if (ts.isVariableStatement(statement)) {
    const pending: ts.BindingName[] = statement.declarationList.declarations.map((declaration) => declaration.name);
    // A pattern holds finitely many names; each is queued once.
    for (const name of pending) {
      if (ts.isIdentifier(name)) {
        taken.add(name.text);
      } else {
        for (const element of name.elements) {
          if (ts.isBindingElement(element)) {
            pending.push(element.name);
          }
        }
      }
    }
    return;
  }
  const named =
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement);
  if (named && statement.name !== undefined) {
    taken.add(statement.name.text);
  }
}

export interface ComponentFile {
  readonly file: string;
  readonly name: string;
  /** How the file exports it. */
  readonly exported: 'default' | 'named';
}

export interface ComponentCatalogue {
  readonly all: () => readonly ComponentFile[];
}

export function componentCatalogue(index: ProjectIndex): ComponentCatalogue {
  const exports = fileCache({ entriesMax: SUGGESTED_MAX * 2, sizeBytesMax: CODE_INTEL_LIMITS.styleFileBytesMax }, scriptExport);
  let kept: { readonly generation: number; readonly components: readonly ComponentFile[] } | undefined;
  return {
    all: () => {
      const files = index.files().files;
      const generation = index.generation();
      if (kept?.generation !== generation) {
        const components: ComponentFile[] = [];
        for (const file of files) {
          if (components.length >= SUGGESTED_MAX) {
            break;
          }
          const component = componentOf(file, exports);
          if (component !== undefined) {
            components.push(component);
          }
        }
        kept = { generation, components };
      }
      return kept.components;
    },
  };
}

function componentOf(file: string, scriptExports: (file: string) => ScriptExport | undefined): ComponentFile | undefined {
  const extension = extensionOf(file);
  if (!KEPT_EXTENSIONS.has(extension) && !SCRIPT_COMPONENTS.has(extension)) {
    return undefined;
  }
  // A page or a content entry is routed or queried, not placed in another file.
  if (/\/(pages|content)\//.test(file) || /\.(test|spec|stories)\.[jt]sx$/.test(file)) {
    return undefined;
  }
  const name = componentName(file);
  if (name === undefined) {
    return undefined;
  }
  if (KEPT_EXTENSIONS.has(extension)) {
    return { file, name, exported: 'default' };
  }
  const found = scriptExports(file);
  if (found === undefined) {
    return undefined;
  }
  if (found.named.has(name)) {
    return { file, name, exported: 'named' };
  }
  return found.hasDefault ? { file, name, exported: 'default' } : undefined;
}

interface ScriptExport {
  readonly hasDefault: boolean;
  readonly named: ReadonlySet<string>;
}

function scriptExport(_file: string, text: string): ScriptExport {
  const named = new Set<string>();
  for (const match of text.matchAll(/^export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Z]\w*)/gm)) {
    named.add(match[1] ?? '');
  }
  return { hasDefault: /^export\s+default\b|^export\s*\{[^}]*\bas\s+default\b/m.test(text), named };
}

/** The tag a file is usually imported as: its name in PascalCase, or its folder's for an `index` file. */
export function componentName(file: string): string | undefined {
  const base = nameOf(file).slice(0, -extensionOf(file).length);
  const named = base === 'index' ? nameOf(folderOf(file)) : base;
  const pascal = pascalCase(named);
  return /^[A-Z][A-Za-z0-9_]*$/.test(pascal) ? pascal : undefined;
}

function pascalCase(value: string): string {
  return value
    .split(/[^A-Za-z0-9_]+/)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** How `from` would import `target`: relative when it is beside or below, else the shortest alias that reaches it. */
export function importSpecifier(from: string, target: string, aliases: readonly PathAlias[]): string {
  const relative = withoutImplied(relativeSpecifier(folderOf(from), target));
  if (!relative.startsWith('../')) {
    return relative;
  }
  const aliased = aliases
    .filter((alias) => within(alias.folder, target) && target.endsWith(alias.suffix))
    .map((alias) => withoutImplied(`${alias.prefix}${target.slice(alias.folder.length + 1, target.length - alias.suffix.length)}`));
  const shortest = aliased.sort((left, right) => left.length - right.length)[0];
  return shortest ?? relative;
}

// A script is imported without its extension, and a folder's index by the folder.
function withoutImplied(specifier: string): string {
  return specifier.replace(/\.(tsx|jsx|ts|js)$/, '').replace(/(?<=[^./])\/index$/, '');
}

export interface ComponentContext {
  readonly file: string;
  readonly packageFolder: string;
  readonly aliases: readonly PathAlias[];
  readonly root: string;
  readonly resolve: (specifier: string) => string | undefined;
  /** How this package names a component of another package it depends on. */
  readonly packaged: (component: string) => string | undefined;
}

/** The edit that writes `statement` into the file's frontmatter, making the frontmatter when there is none. */
export function frontmatterImport(text: string, statement: (names: ModuleNames) => string): CodeEdit {
  const fence = frontmatterRange(text);
  if (fence === undefined) {
    const names = moduleNames('');
    return { from: 0, to: 0, insert: `---\n${statement(names)}\n---\n\n` };
  }
  const names = moduleNames(text.slice(fence.from, fence.to));
  return importAt(fence.from, names, statement(names));
}

/** The same for MDX, whose imports are lines of the document itself, after any frontmatter. */
export function mdxImport(text: string, statement: (names: ModuleNames) => string): CodeEdit {
  const fence = frontmatterRange(text);
  const start = fence?.end ?? 0;
  const block = /^(?:\s*\n)*(?:import\s[^\n]*\n)+/.exec(text.slice(start))?.[0];
  if (block === undefined) {
    const names = moduleNames('');
    return { from: start, to: start, insert: `${start === 0 ? '' : '\n'}${statement(names)}\n\n` };
  }
  const names = moduleNames(block);
  return importAt(start, names, statement(names));
}

function importAt(base: number, names: ModuleNames, statement: string): CodeEdit {
  return names.after === 0
    ? { from: base, to: base, insert: `${statement}\n` }
    : { from: base + names.after, to: base + names.after, insert: `\n${statement}` };
}

export function componentSuggestions(
  catalogue: readonly ComponentFile[],
  context: ComponentContext,
  document: { readonly names: ModuleNames; readonly addImport: (statement: (names: ModuleNames) => string) => CodeEdit },
): readonly CodeCompletion[] {
  const found: CodeCompletion[] = [];
  const imported = new Map<string, string>();
  for (const entry of document.names.imports) {
    const target = context.resolve(entry.specifier);
    if (target !== undefined && !imported.has(target)) {
      imported.set(target, entry.name);
    }
  }
  // What is imported is offered whatever it is, under the name the file gave it.
  for (const entry of document.names.imports) {
    if (/^[A-Z]/.test(entry.name)) {
      found.push(suggestion(entry.name, 'component', { detail: entry.specifier, boost: 5 }));
    }
  }
  const taken = new Set(document.names.taken);
  for (const component of catalogue) {
    if (component.file === context.file || imported.has(component.file)) {
      continue;
    }
    const here = within(context.packageFolder, component.file);
    // Another package of a workspace is reached only where an alias says how.
    const written = importSpecifier(context.file, component.file, context.aliases);
    const specifier = !here && written.startsWith('.') ? context.packaged(component.file) : written;
    if (specifier === undefined) {
      continue;
    }
    const name = freeName(component, taken);
    const edit = document.addImport((names) => {
      const clause = component.exported === 'default' ? name : name === component.name ? `{ ${name} }` : `{ ${component.name} as ${name} }`;
      return `import ${clause} from ${names.quote}${specifier}${names.quote}${names.semicolon}`;
    });
    const framework = FRAMEWORKS[extensionOf(component.file)];
    const shown = relativeSpecifier(context.root, component.file).replace(/^\.\//, '');
    found.push(
      suggestion(name, 'component', {
        detail: framework === undefined ? shown : `${shown}  ·  ${framework}`,
        boost: here ? 2 : 1,
        edits: [edit],
      }),
    );
  }
  return found;
}

function freeName(component: ComponentFile, taken: ReadonlySet<string>): string {
  if (!taken.has(component.name)) {
    return component.name;
  }
  const folder = pascalCase(nameOf(folderOf(component.file)));
  const qualified = `${folder}${component.name}`;
  if (/^[A-Z]/.test(qualified) && !taken.has(qualified)) {
    return qualified;
  }
  let number = 2;
  while (taken.has(`${component.name}${number}`)) {
    assert(number <= taken.size + 2, 'A free name is found within the names taken');
    number++;
  }
  return `${component.name}${number}`;
}
