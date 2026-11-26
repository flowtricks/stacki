// The files the type checker reads that are not TypeScript on disk, and where its own libraries are.
//
// An `.astro` file is read as the TSX the compiler prints for it, and its `<script>` blocks as files of their own. A
// `.vue`, `.svelte` or `.mdx` component is typed as a component that takes any props, since reading theirs would take
// those frameworks' compilers, which would mean running the project's code. A CSS module is typed with its class names.
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { isCssModule } from './styleIndex';
import { dialectFor, styleSymbols } from './styleSyntax';
import { extensionOf, slashed } from './paths';

export const FOREIGN_COMPONENTS: ReadonlySet<string> = new Set(['.vue', '.svelte', '.mdx']);

const MODULE_CLASSES_MAX = 2_000;

/** What a `.vue`, `.svelte`, `.mdx` or CSS module reads as. */
export function standInSource(file: string, text: string): string {
  if (isCssModule(file)) {
    const symbols = styleSymbols(text, dialectFor(extensionOf(file).slice(1), { global: false }));
    const names = [...new Set(symbols.classes.map((entry) => entry.name))].slice(0, MODULE_CLASSES_MAX);
    const members = names.map((name) => `  readonly ${JSON.stringify(name)}: string;\n`).join('');
    return `declare const classes: {\n${members}  readonly [name: string]: string;\n};\nexport default classes;\n`;
  }
  const component = 'declare const Component: (props: Record<string, any>) => any;\nexport default Component;\n';
  if (extensionOf(file) !== '.mdx') {
    return component;
  }
  return `${component}export declare const Content: typeof Component;\nexport declare const frontmatter: Record<string, any>;\n`;
}

export function isStandIn(file: string): boolean {
  return FOREIGN_COMPONENTS.has(extensionOf(file)) || isCssModule(file);
}

export const FALLBACK_AMBIENT_FILE = '/__stacki__/astro-fallback.d.ts';

/** What an `.astro` file may name when Astro is not installed, so reading the file does not trip over its globals. */
export const FALLBACK_AMBIENT = [
  'declare const Astro: any;',
  'declare const Fragment: any;',
  'declare namespace JSX {',
  '  interface IntrinsicElements { [name: string]: any }',
  '}',
  '',
].join('\n');

export interface LibraryFiles {
  readonly folder: string;
  /** Where a library file's bytes are: itself, or the copy the packaged app carries. */
  readonly physical: (file: string) => string;
}

/**
 * TypeScript's own `lib.*.d.ts`. The installed package has them beside it; the packaged app does not (the packager
 * leaves every `.d.ts` out), so the build keeps a copy with another ending (scripts/build/stageRuntime.ts).
 */
export function libraryFiles(shipped: string = path.resolve(__dirname, '../../typescript-lib')): LibraryFiles {
  const installed = slashed(path.dirname(ts.getDefaultLibFilePath({})));
  if (fs.existsSync(`${installed}/lib.es5.d.ts`)) {
    return { folder: installed, physical: (file) => file };
  }
  return shippedLibraryFiles(shipped);
}

export function shippedLibraryFiles(shipped: string): LibraryFiles {
  const folder = slashed(shipped);
  return { folder, physical: (file) => (file.startsWith(`${folder}/`) ? `${file}.txt` : file) };
}
