// Builds the Stacki UI kit for apps from the editor's own components, so a
// design change in Stacki reaches apps on the next build (docs/apps.md, "Look and
// feel"). Run by `npm run build` (package.json build:base) before the compiler,
// and by hand with scripts/build/appUiKit.mts; test/renderer/apps/appUiKit.test.js
// fails when the generated module differs from what the editor builds today.
//
// The behaviour is the editor's React components themselves: esbuild compiles
// src/features/apps/uiKit/kitElements.tsx, which wraps Dropdown, Switch,
// SegmentedTabs, SearchField, ResetLabel and Tooltip in custom elements, with
// React, into one script. The look is the CSS those components import, exactly as
// esbuild collects it from the same files the editor loads (the shared sheets in
// src/ui), placed inside one `@scope` rule so it styles the kit's elements and
// popups and nothing else of the app's. Inside the scope the editor's root tokens
// and its body type apply at zero specificity, as they do in the editor, so the
// cascade is the editor's own.
//
// Apps also get the design tokens as public `--stacki-*` variables, injected into
// every page. Each token names where its value lives in the editor: a custom
// property on its root, or one declaration of one rule (TOKEN_SOURCES).
import { build, type Plugin } from 'esbuild';
import path from 'node:path';

/** The files the kit reads besides the bundle, by repository path. */
export const KIT_SOURCE_FILES = {
  editor: 'src/app/styles.css',
  styleTokens: 'src/features/style/tokens.css',
  controls: 'src/ui/controls.css',
  dropdown: 'src/ui/dropdown.css',
  switch: 'src/ui/switch.css',
  kitHost: 'src/features/apps/uiKit/kitHost.css',
} as const;
export type KitSourceName = keyof typeof KIT_SOURCE_FILES;
export type KitSources = { readonly [N in KitSourceName]: string };
/** The compiled components: the script and the CSS its components import. */
export interface KitBundle {
  readonly script: string;
  readonly css: string;
  /** Every source file compiled into the script, by repository-relative path (the graph test pins what may enter). */
  readonly inputs: readonly string[];
}
/** The entry esbuild compiles. */
export const KIT_ENTRY = 'src/features/apps/uiKit/kitElements.tsx';
/**
 * The kit's translator. The editor's `useTranslate` reaches the locale provider and every English catalog; an app's frame has no
 * provider, so the compile below sends that one import to this module, which holds only the `ui` words (test/renderer/apps/appUiKitGraph.test.js).
 */
export const KIT_TRANSLATE = 'src/features/apps/uiKit/kitTranslate.ts';
const TRANSLATE_HOOK_SPECIFIER = /(^|\/)lib\/i18n\/useTranslate$/;
/**
 * Where the kit's CSS applies: inside its elements' mounts and the layer its popups portal to
 * (src/ui/popupLayer.ts). A scoped rule matches inside its root, never the root itself.
 */
export const KIT_SCOPE_ROOTS = ['.stacki-ui'] as const;

/** The kit's themes. The editor draws one, dark; a theme added here needs its own token values. */
export const KIT_THEMES = ['dark'] as const;

type TokenSource =
  | { readonly kind: 'variable'; readonly variable: string }
  | {
      readonly kind: 'rule';
      readonly file: KitSourceName;
      readonly selector: string;
      readonly property: string;
      /** One word of a shorthand (`padding: 6px 8px`, part 1 is `8px`). */
      readonly part?: number;
    };

/** Every token the kit exports, and where in the editor's CSS its value lives. */
export const TOKEN_SOURCES: ReadonlyArray<{ readonly name: string; readonly source: TokenSource }> = [
  // Fills, darkest to lightest.
  { name: 'bg', source: { kind: 'variable', variable: '--bg' } },
  { name: 'bg-panel', source: { kind: 'variable', variable: '--bg-panel' } },
  { name: 'bg-raised', source: { kind: 'variable', variable: '--bg-panel-2' } },
  { name: 'bg-popover', source: { kind: 'rule', file: 'dropdown', selector: '.dd-popup', property: 'background' } },
  { name: 'bg-input', source: { kind: 'variable', variable: '--bg-input' } },
  { name: 'bg-hover', source: { kind: 'variable', variable: '--bg-hover' } },
  { name: 'bg-active', source: { kind: 'variable', variable: '--bg-active' } },
  // Text, high to low emphasis.
  { name: 'text', source: { kind: 'variable', variable: '--text' } },
  { name: 'text-muted', source: { kind: 'variable', variable: '--text-dim' } },
  { name: 'text-faint', source: { kind: 'variable', variable: '--text-faint' } },
  // The accent and the states.
  { name: 'accent', source: { kind: 'variable', variable: '--accent' } },
  { name: 'accent-hover', source: { kind: 'rule', file: 'controls', selector: 'button.primary:hover:not(:disabled)', property: 'background' } },
  { name: 'accent-soft', source: { kind: 'variable', variable: '--accent-soft' } },
  { name: 'accent-text', source: { kind: 'rule', file: 'controls', selector: 'button.primary', property: 'color' } },
  { name: 'danger', source: { kind: 'variable', variable: '--red' } },
  { name: 'success', source: { kind: 'variable', variable: '--green' } },
  // The editor's warning text (code notes, Git hints).
  { name: 'warning', source: { kind: 'variable', variable: '--amber' } },
  { name: 'selection', source: { kind: 'variable', variable: '--selection' } },
  { name: 'selection-text', source: { kind: 'variable', variable: '--selection-text' } },
  // Lines: the 1px divider between a header and its body, or between sections. Stacki draws no
  // borders on controls; `border` is the same colour under the name CSS authors reach for first.
  { name: 'line', source: { kind: 'variable', variable: '--border' } },
  { name: 'border', source: { kind: 'variable', variable: '--border' } },
  // Radii.
  { name: 'radius', source: { kind: 'variable', variable: '--radius' } },
  { name: 'radius-control', source: { kind: 'rule', file: 'dropdown', selector: '.dd-trigger', property: 'border-radius' } },
  { name: 'radius-option', source: { kind: 'rule', file: 'dropdown', selector: '.dd-option', property: 'border-radius' } },
  { name: 'radius-round', source: { kind: 'rule', file: 'switch', selector: '.ui-switch', property: 'border-radius' } },
  // Spacing, smallest first.
  { name: 'space-1', source: { kind: 'rule', file: 'dropdown', selector: '.dd-popup', property: 'padding' } },
  { name: 'space-2', source: { kind: 'rule', file: 'dropdown', selector: '.dd-trigger', property: 'padding', part: 0 } },
  { name: 'space-3', source: { kind: 'rule', file: 'dropdown', selector: '.dd-trigger', property: 'padding', part: 1 } },
  { name: 'space-4', source: { kind: 'rule', file: 'controls', selector: 'button', property: 'padding', part: 1 } },
  // Type.
  { name: 'font', source: { kind: 'variable', variable: '--font' } },
  { name: 'font-mono', source: { kind: 'variable', variable: '--mono' } },
  { name: 'font-size', source: { kind: 'rule', file: 'editor', selector: 'body', property: 'font-size' } },
  { name: 'font-size-small', source: { kind: 'rule', file: 'dropdown', selector: '.dd-empty', property: 'font-size' } },
  { name: 'font-size-tiny', source: { kind: 'rule', file: 'dropdown', selector: '.dd-group-label', property: 'font-size' } },
  { name: 'font-weight-medium', source: { kind: 'rule', file: 'controls', selector: 'button', property: 'font-weight' } },
  { name: 'font-weight-strong', source: { kind: 'rule', file: 'controls', selector: 'button.primary', property: 'font-weight' } },
  // Sizes, shadows and focus.
  { name: 'row-height', source: { kind: 'rule', file: 'dropdown', selector: '.dd-option', property: 'height' } },
  { name: 'shadow-popover', source: { kind: 'rule', file: 'dropdown', selector: '.dd-popup', property: 'box-shadow' } },
  { name: 'focus-color', source: { kind: 'variable', variable: '--color-border-focus' } },
  { name: 'focus-ring', source: { kind: 'rule', file: 'controls', selector: ':focus-visible:where(:not(input):not(textarea))', property: 'outline' } },
  {
    name: 'focus-ring-offset',
    source: { kind: 'rule', file: 'controls', selector: ':focus-visible:where(:not(input):not(textarea))', property: 'outline-offset' },
  },
];

export interface KitToken {
  readonly name: string;
  /** The value with every variable resolved, as `stacki.ui.theme()` answers it. */
  readonly value: string;
}

export interface BuiltKit {
  readonly tokens: readonly KitToken[];
  /** `:root { --stacki-…: … }`, injected into every app document. */
  readonly tokensCSS: string;
  /** The components' CSS, scoped to the kit, served at `__stacki/ui.css`. */
  readonly componentsCSS: string;
  /** The components, served at `__stacki/ui.js`. */
  readonly script: string;
}

// Bounds: the editor's stylesheet is about 10,000 lines; a block deeper than an
// @media inside an @supports is not something these sheets hold.
const CSS_CHARS_MAX = 2_000_000;
const BLOCK_DEPTH_MAX = 3;
const VARIABLE_CHAIN_MAX = 8;
// The compiled kit is React and six components; past this something unintended came in.
const SCRIPT_CHARS_MAX = 600_000;

/** Compiles the kit's entry with esbuild, as the editor's own build compiles the components. */
export async function bundleAppUiKit(repositoryRoot: string): Promise<KitBundle> {
  // Twice: the script minified, as an app downloads it; the CSS as the editor's files spell it,
  // so a reader (and the parity test) can find each rule as it is in its sheet.
  const kitTranslator: Plugin = {
    name: 'kit-translator',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: TRANSLATE_HOOK_SPECIFIER }, () => ({ path: path.join(repositoryRoot, KIT_TRANSLATE) }));
    },
  };
  const compile = async ({ minify }: { readonly minify: boolean }) =>
    await build({
      entryPoints: [path.join(repositoryRoot, KIT_ENTRY)],
      absWorkingDir: repositoryRoot,
      bundle: true,
      write: false,
      outdir: 'kit',
      format: 'iife',
      target: 'es2020',
      platform: 'browser',
      jsx: 'automatic',
      minify,
      legalComments: 'none',
      charset: 'utf8',
      define: { 'process.env.NODE_ENV': '"production"' },
      loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl' },
      logLevel: 'silent',
      plugins: [kitTranslator],
      metafile: true,
    });
  const scriptBuild = await compile({ minify: true });
  const script = scriptBuild.outputFiles.find((file) => file.path.endsWith('.js'));
  const css = (await compile({ minify: false })).outputFiles.find((file) => file.path.endsWith('.css'));
  invariant(script !== undefined, 'The kit compiles to a script');
  invariant(css !== undefined, "The kit collects its components' CSS");
  invariant(script.text.length <= SCRIPT_CHARS_MAX, `The kit script stays under ${SCRIPT_CHARS_MAX} characters`);
  const inputs = Object.keys(scriptBuild.metafile.inputs).map((input) => input.replaceAll('\\', '/'));
  invariant(inputs.length > 0, 'The kit script has inputs');
  return { script: script.text, css: css.text, inputs };
}

/** Builds the kit from the editor's files and the compiled bundle, or throws naming what is missing. */
export function buildAppUiKit(sources: KitSources, bundle: KitBundle): BuiltKit {
  for (const [name, text] of Object.entries(sources)) {
    invariant(text.length > 0, `${name} is empty`);
    invariant(text.length <= CSS_CHARS_MAX, `${name} exceeds ${CSS_CHARS_MAX} characters`);
  }
  invariant(bundle.css.length > 0, 'The kit has CSS');
  const variables = new Map([...rootVariables(sources.styleTokens), ...rootVariables(sources.editor)]);
  const tokens = TOKEN_SOURCES.map(({ name, source }) => ({ name, value: resolveVariables(tokenValue(sources, variables, source), variables) }));
  invariant(new Set(tokens.map((token) => token.name)).size === tokens.length, 'Every token name is unique');
  const componentsCSS = [
    scopedSheet(sources, bundle.css),
    stripComments(sources.kitHost)
      .replace(/\n{2,}/g, '\n')
      .trim(),
  ].join('\n');
  return { tokens, tokensCSS: tokenSheet(tokens), componentsCSS, script: bundle.script };
}

/** The generated module's text (shared/properties/generated/appUiKitBundle.ts). */
export function appUiKitModule(kit: BuiltKit): string {
  invariant(kit.tokens.length > 0, 'The kit has tokens');
  invariant(kit.componentsCSS.length > 0, 'The kit has components');
  const names = kit.tokens.map((token) => token.name);
  const values = Object.fromEntries(kit.tokens.map((token) => [token.name, token.value]));
  return [
    "// Generated by scripts/build/appUiKit.mts from the editor's components and CSS. Do not edit:",
    '// `npm run build` writes it again, or run `node scripts/build/appUiKit.mts`.',
    `export const APP_UI_TOKEN_NAMES = ${JSON.stringify(names)} as const;`,
    'export type AppUiTokenName = (typeof APP_UI_TOKEN_NAMES)[number];',
    `export const APP_UI_THEMES = ${JSON.stringify(KIT_THEMES)} as const;`,
    'export type AppUiTheme = (typeof APP_UI_THEMES)[number];',
    `export const APP_UI_TOKEN_VALUES: { readonly [T in AppUiTheme]: { readonly [N in AppUiTokenName]: string } } = { dark: ${JSON.stringify(values)} };`,
    `export const APP_UI_TOKENS_CSS: string = ${JSON.stringify(kit.tokensCSS)};`,
    `export const APP_UI_COMPONENTS_CSS: string = ${JSON.stringify(kit.componentsCSS)};`,
    `export const APP_UI_SCRIPT: string = ${JSON.stringify(kit.script)};`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Reading the editor's CSS
// ---------------------------------------------------------------------------

interface CssBlock {
  readonly prelude: string;
  readonly body: string;
}

function stripComments(css: string): string {
  // An `@import` statement has no block; the sheets it names are read on their own.
  return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import[^;]*;/g, '');
}

/** The top-level blocks of a sheet, comments removed: `prelude { body }`. */
function parseBlocks(css: string): readonly CssBlock[] {
  const text = stripComments(css);
  const blocks: CssBlock[] = [];
  let start = 0;
  let depth = 0;
  let bodyStart = -1;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '{') {
      if (depth === 0) {
        bodyStart = index + 1;
      }
      depth += 1;
      invariant(depth <= BLOCK_DEPTH_MAX, 'CSS blocks nest at most three deep');
    } else if (character === '}') {
      depth -= 1;
      invariant(depth >= 0, 'CSS braces balance');
      if (depth === 0) {
        blocks.push({ prelude: text.slice(start, bodyStart - 1).trim(), body: text.slice(bodyStart, index) });
        start = index + 1;
      }
    }
  }
  invariant(depth === 0, 'CSS braces close');
  invariant(text.slice(start).trim() === '', 'Nothing trails the last CSS block');
  return blocks;
}

/** A block's declarations, in order: `property: value`. */
function declarations(body: string): ReadonlyArray<{ readonly property: string; readonly value: string }> {
  const found: Array<{ readonly property: string; readonly value: string }> = [];
  for (const part of splitOutside(body, ';')) {
    const colon = part.indexOf(':');
    if (part.trim() === '') {
      continue;
    }
    invariant(colon > 0, `A declaration has a property: ${part.trim()}`);
    found.push({
      property: part.slice(0, colon).trim(),
      value: part
        .slice(colon + 1)
        .trim()
        .replace(/\s+/g, ' '),
    });
  }
  return found;
}

/** Splits on `separator` outside parentheses and quotes. */
function splitOutside(text: string, separator: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== '') {
      if (character === quote) {
        quote = '';
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
    } else if (character === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** The custom properties a sheet's first `:root` block declares. */
function rootVariables(css: string): ReadonlyMap<string, string> {
  const root = parseBlocks(css).find((block) => block.prelude === ':root');
  invariant(root !== undefined, 'The sheet has a :root block');
  const variables = new Map<string, string>();
  for (const { property, value } of declarations(root.body)) {
    if (property.startsWith('--')) {
      variables.set(property, value);
    }
  }
  return variables;
}

function tokenValue(sources: KitSources, variables: ReadonlyMap<string, string>, source: TokenSource): string {
  if (source.kind === 'variable') {
    const value = variables.get(source.variable);
    invariant(value !== undefined, `The editor declares ${source.variable}`);
    return value;
  }
  const rule = parseBlocks(sources[source.file]).find((block) => normalizeSelector(block.prelude) === normalizeSelector(source.selector));
  invariant(rule !== undefined, `${KIT_SOURCE_FILES[source.file]} has the rule ${source.selector}`);
  const declaration = declarations(rule.body).find((candidate) => candidate.property === source.property);
  invariant(declaration !== undefined, `${source.selector} sets ${source.property}`);
  if (source.part === undefined) {
    return declaration.value;
  }
  const word = declaration.value.split(' ')[source.part];
  invariant(word !== undefined, `${source.selector} ${source.property} has part ${source.part}`);
  return word;
}

function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, ' ').trim();
}

/** Replaces each `var(--x)` with the editor's value for it, following chains a few steps. */
function resolveVariables(value: string, variables: ReadonlyMap<string, string>): string {
  let resolved = value;
  for (let step = 0; step < VARIABLE_CHAIN_MAX; step += 1) {
    if (!resolved.includes('var(')) {
      return resolved;
    }
    resolved = resolved.replace(/var\((--[\w-]+)(?:,[^()]*(?:\([^()]*\))?[^()]*)?\)/g, (_whole, name: string) => {
      const found = variables.get(name);
      invariant(found !== undefined, `The editor declares ${name}`);
      return found;
    });
  }
  invariant(!resolved.includes('var('), `${value} resolves within ${VARIABLE_CHAIN_MAX} steps`);
  return resolved;
}

// ---------------------------------------------------------------------------
// Writing the kit's sheets
// ---------------------------------------------------------------------------

/**
 * The tokens on the document root at zero specificity (`:where`), so an app's
 * own `:root { --stacki-accent: … }` wins wherever the host puts this sheet.
 */
function tokenSheet(tokens: readonly KitToken[]): string {
  const [theme] = KIT_THEMES;
  const lines = tokens.map((token) => `  --stacki-${token.name}: ${token.value};`);
  invariant(lines.length === TOKEN_SOURCES.length, 'Every token is written');
  return [`:where(:root),\n:where(:root[data-theme='${theme}']) {`, ...lines, '}'].join('\n');
}

/**
 * The components' CSS inside `@scope`, after what the editor's document gives
 * every control: its root tokens, its body type and its box reset, each read from
 * the editor's stylesheet and applied at zero specificity, as they are there.
 */
function scopedSheet(sources: KitSources, css: string): string {
  const editor = parseBlocks(sources.editor);
  const rule = (selector: string): ReadonlyArray<{ readonly property: string; readonly value: string }> => {
    const found = editor.find((block) => normalizeSelector(block.prelude) === selector);
    invariant(found !== undefined, `styles.css has the rule ${selector}`);
    return declarations(found.body);
  };
  const variables = [...rootVariables(sources.editor)].map(([name, value]) => `    ${name}: ${value};`);
  const bodyType = rule('body').filter((declaration) => ['font-family', 'color', 'font-size', '-webkit-font-smoothing'].includes(declaration.property));
  invariant(bodyType.length === 4, 'The editor body sets its type and colour');
  const reset = rule('*').map(({ property, value }) => `    ${property}: ${value};`);
  invariant(reset.length > 0, 'The editor resets every box');
  const indented = css
    .trim()
    .split('\n')
    .map((line) => (line === '' ? line : `  ${line}`))
    .join('\n');
  return [
    `@scope (${KIT_SCOPE_ROOTS.join(', ')}) {`,
    '  :where(:scope) {',
    ...variables,
    ...bodyType.map(({ property, value }) => `    ${property}: ${value};`),
    '  }',
    '  :where(:scope, :scope *) {',
    ...reset,
    '  }',
    indented,
    '}',
  ].join('\n');
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`App UI kit: ${message}`);
  }
}
