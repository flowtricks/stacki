// Every class and variable the project's styles declare: stylesheets, the `<style>` blocks of .astro, .vue and .svelte
// files, and the stylesheets those import from outside the project (a workspace's or a package's tokens). What a name's
// scope means is kept with it: a scoped name styles only its own component, a CSS module's classes are reached through
// its import, and everything else is global.
import { CODE_INTEL_LIMITS } from '../../../shared/ipc/codeIntel';
import { fileCache, fileStamp } from './fileCache';
import { embeddedBlocks, type EmbeddedBlock } from './markupContext';
import { extensionOf, folderOf, joined, within } from './paths';
import type { ProjectIndex } from './projectIndex';
import { dialectFor, markupClassNames, styleSymbols, type StyleClass, type StyleSymbols, type StyleVariable } from './styleSyntax';

export const STYLESHEET_EXTENSIONS: ReadonlySet<string> = new Set(['.css', '.scss', '.sass', '.less', '.pcss', '.postcss']);
const STYLED_COMPONENTS: ReadonlySet<string> = new Set(['.astro', '.vue', '.svelte']);
const MARKUP_FILES: ReadonlySet<string> = new Set(['.astro', '.vue', '.svelte', '.jsx', '.tsx', '.html', '.mdx']);

export interface FileStyles {
  readonly file: string;
  readonly symbols: StyleSymbols;
  /** A `*.module.css`: its classes are not names markup can write. */
  readonly module: boolean;
  /** Names a `define:vars` makes into custom properties. */
  readonly definedVariables: readonly StyleVariable[];
  /** Class names the file's own markup writes. */
  readonly markupClasses: readonly { readonly name: string; readonly offset: number }[];
}

export function isStylesheet(file: string): boolean {
  return STYLESHEET_EXTENSIONS.has(extensionOf(file));
}

export function isCssModule(file: string): boolean {
  return /\.module\.(css|scss|sass|less)$/i.test(file);
}

/** The styles of one file's text. */
export function fileStyles(file: string, text: string): FileStyles {
  const extension = extensionOf(file);
  const module = isCssModule(file);
  if (STYLESHEET_EXTENSIONS.has(extension)) {
    const symbols = styleSymbols(text, dialectFor(extension.slice(1), { global: !module }));
    return { file, symbols, module, definedVariables: [], markupClasses: [] };
  }
  const markupClasses = MARKUP_FILES.has(extension) ? markupClassNames(text) : [];
  if (!STYLED_COMPONENTS.has(extension)) {
    return { file, symbols: emptySymbols(), module: false, definedVariables: [], markupClasses };
  }
  const blocks = embeddedBlocks(text).styles;
  const parts = blocks.map((block) => blockSymbols(extension, text, block));
  return {
    file,
    module: false,
    markupClasses,
    definedVariables: blocks.flatMap(definedVariables),
    symbols: {
      variables: parts.flatMap((part) => part.variables),
      preprocessorVariables: parts.flatMap((part) => part.preprocessorVariables),
      classes: parts.flatMap((part) => part.classes),
      imports: parts.flatMap((part) => part.imports),
    },
  };
}

export function blockLanguage(block: EmbeddedBlock): string {
  const language = (block.attributes.get('lang') ?? 'css').toLowerCase();
  return ['scss', 'sass', 'less'].includes(language) ? language : 'css';
}

/** Whether a component's style block is global: Astro and Svelte scope unless told not to, Vue the other way round. */
export function blockIsGlobal(extension: string, block: EmbeddedBlock): boolean {
  if (extension === '.vue') {
    return !block.attributes.has('scoped') && !block.attributes.has('module');
  }
  return block.attributes.has('is:global') || block.attributes.has('global') || block.attributes.has('is:inline');
}

function blockSymbols(extension: string, text: string, block: EmbeddedBlock): StyleSymbols {
  const dialect = dialectFor(blockLanguage(block), { global: blockIsGlobal(extension, block) });
  return styleSymbols(text.slice(block.from, block.to), dialect, block.from);
}

function definedVariables(block: EmbeddedBlock): readonly StyleVariable[] {
  const value = block.attributes.get('define:vars');
  if (value === undefined) {
    return [];
  }
  const inside = value.replace(/^\{\s*\{?/, '').replace(/\}+$/, '');
  return inside
    .split(',')
    .map((entry) => /^\s*(?:["']([\w-]+)["']|([A-Za-z_$][\w$-]*))\s*(?::\s*([\s\S]*))?$/.exec(entry))
    .flatMap((match) => {
      const name = match?.[1] ?? match?.[2];
      return name === undefined
        ? []
        : [{ name: `--${name}`, value: (match?.[3] ?? name).trim().slice(0, 100), offset: block.from, selector: 'define:vars', global: false }];
    });
}

function emptySymbols(): StyleSymbols {
  return { variables: [], preprocessorVariables: [], classes: [], imports: [] };
}

export interface StyleIndex {
  /** Every indexed file's styles, within the bounds. */
  readonly all: () => readonly FileStyles[];
}

export function createStyleIndex(index: ProjectIndex): StyleIndex {
  const read = fileCache({ entriesMax: CODE_INTEL_LIMITS.styleFilesMax * 2, sizeBytesMax: CODE_INTEL_LIMITS.styleFileBytesMax }, fileStyles);
  let kept: { readonly generation: number; readonly styles: readonly FileStyles[] } | undefined;
  return {
    all: () => {
      const files = index.files().files;
      const generation = index.generation();
      if (kept?.generation !== generation) {
        kept = { generation, styles: collect(index.root, files, read) };
      }
      return kept.styles;
    },
  };
}

function collect(root: string, files: readonly string[], read: (file: string) => FileStyles | undefined): readonly FileStyles[] {
  const found: FileStyles[] = [];
  let bytes = 0;
  const outside = new Set<string>();
  // Stylesheets first: when a bound is reached, they are what names mostly come from.
  const ordered = [...files.filter(isStylesheet), ...files.filter((file) => MARKUP_FILES.has(extensionOf(file)))];
  const add = (file: string): void => {
    const stamp = fileStamp(file);
    if (stamp === undefined || found.length >= CODE_INTEL_LIMITS.styleFilesMax || bytes + stamp.sizeBytes > CODE_INTEL_LIMITS.styleBytesMax) {
      return;
    }
    const styles = read(file);
    if (styles === undefined) {
      return;
    }
    bytes += stamp.sizeBytes;
    found.push(styles);
    for (const imported of styles.symbols.imports) {
      const target = resolveStyleImport(folderOf(file), imported.specifier);
      if (target !== undefined && (!within(root, target) || target.includes('/node_modules/')) && outside.size < CODE_INTEL_LIMITS.styleImportsMax) {
        outside.add(target);
      }
    }
  };
  for (const file of ordered) {
    add(file);
  }
  // A followed stylesheet may import another; the set's bound ends the walk.
  for (const file of outside) {
    add(file);
  }
  return found;
}

/** The stylesheet an `@import` names: beside the file, or in a package found by walking up. */
export function resolveStyleImport(folder: string, specifier: string): string | undefined {
  if (/^(https?:|data:|\/\/|sass:)/.test(specifier) || specifier === '') {
    return undefined;
  }
  const bases: string[] = [];
  const bare = specifier.replace(/^~/, '').replace(/^pkg:/, '');
  if (specifier.startsWith('.') || /\.(css|scss|sass|less)$/.test(specifier)) {
    bases.push(joined(folder, bare));
  }
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    let at = folder;
    for (let depth = 0; depth < CODE_INTEL_LIMITS.indexDepthMax; depth++) {
      bases.push(`${at}/node_modules/${bare}`);
      const parent = folderOf(at);
      if (parent === at) {
        break;
      }
      at = parent;
    }
  }
  for (const base of bases) {
    for (const candidate of [base, `${base}.scss`, `${base}.css`, `${base}.less`, partial(base)]) {
      if (isStylesheet(candidate) && fileStamp(candidate) !== undefined) {
        return candidate;
      }
    }
  }
  return undefined;
}

function partial(base: string): string {
  const slash = base.lastIndexOf('/');
  return `${base.slice(0, slash + 1)}_${base.slice(slash + 1)}.scss`;
}

export type { StyleClass, StyleVariable };
