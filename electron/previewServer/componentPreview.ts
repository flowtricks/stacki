// Standalone palette previews need sample inputs for guarded text content.
// Authored defaults run inside the component; preview data never evaluates source expressions.
import { parsePropSchema } from '../parse/astroParser';
import { assert } from '../../shared/core/assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { componentPreviewStylesModule, componentPreviewStyleText } from './componentPreviewStyles';
import { readPropModel } from '../parse/propModel/readPropModel';
import { previewRendersNoContent, previewRendersOnlyName } from '../../shared/properties/previewSnapshot';
import { ATTEMPT_LIMITS, buildPreviewAttempts, previewDependencySources, previewKey, type PreviewAttempt } from './previewAttempts';
import { previewTypePrelude, readPathAliases, type PreludeFiles } from './previewTypePrelude';
import { PAGES_FOLDER, foldersFor, isWithin, type ProjectFolders } from '../../shared/properties/projectFolders';
import {
  componentPreviewContextModule,
  componentPreviewSample,
  readPreviewProjectIndex,
  type PreviewProjectIndex,
  type PreviewSample,
  type PreviewSampleValue,
  type PreviewSlot,
} from './componentPreviewContext';
import {
  componentPreviewRecipe,
  previewModuleSource,
  instanceMarkupNodes,
  instancePreviewRecipe,
  previewDefaultsPath,
  readPreviewDefaults,
  RECIPE_LIMITS,
  type PreviewRecipe,
  type PreviewRecipeNode,
} from './componentPreviewRecipe';

const PREVIEW_LIMITS = {
  nameCharsMax: 200,
  rootsMax: 8,
} as const;

/**
 * What the route puts in the component's slots. `recipe` is the project's insertion recipe
 * (componentPreviewRecipe.ts): the component and everything nested in it, rendered by the recipe
 * node component, and the component files among them, which the route loads before it renders.
 */
export type ComponentPreviewSlot =
  PreviewSlot | { readonly kind: 'recipe'; readonly node: Extract<PreviewRecipeNode, { readonly component: string }>; readonly files: readonly string[] };

export interface ComponentPreviewInputs {
  readonly props: Readonly<Record<string, PreviewSampleValue>>;
  readonly missing: readonly string[];
  readonly slot: ComponentPreviewSlot;
}

/**
 * The props and slot a preview renders the component with. A recipe wins over everything: the
 * preview shows what inserting the component produces. Without one, a real instance's literal
 * props and plain children win over invented ones.
 */
export function componentPreviewInputs(source: unknown, name: unknown, sample?: PreviewSample, recipe?: PreviewRecipe): ComponentPreviewInputs {
  const text = previewString(source, 'Component source');
  const label = previewString(name, 'Component name');
  assert(label.length <= PREVIEW_LIMITS.nameCharsMax, 'Component name: exceeds length limit');
  const schema = parsePropSchema(text);
  const props: Record<string, PreviewSampleValue> = {};
  for (const field of schema) {
    if (field.name === 'preview' && field.type === 'boolean') {
      // The project's design-mode switch ("keep open in design mode"), set over its default: with
      // it, and the `stacki-designer` class the route puts on <html>, a modal, dropdown or tab set
      // shows what it holds instead of waiting to be opened. Only a preview reads it.
      props[field.name] = true;
      continue;
    }
    // Even false, empty, or expression defaults belong to the component author.
    if (field.default !== undefined || field.defaultExpr) {
      continue;
    }
    if (field.type === 'string') {
      if (/^(heading|title|label|text|description|caption|summary|content)$/i.test(field.name)) {
        props[field.name] = label;
      } else if (field.name === 'id') {
        // A modal or a tab set often renders nothing without an id to be opened by; the preview gives it one.
        props[field.name] = 'stacki-preview-' + label.replace(/[^\w-]/g, '-');
      }
    } else if (field.name === 'render' && field.type === 'boolean') {
      props[field.name] = true;
    } else if (field.type === 'enum' && !field.optional) {
      const option = field.options?.[0];
      if (option !== undefined) {
        props[field.name] = option;
      }
    }
  }
  // A real instance shows the component as the site uses it: its literal props win over
  // invented ones, and its plain children replace the name placeholder in the slot.
  // The project's recipe is what an insert produces, so it wins over both.
  Object.assign(props, recipe === undefined ? (sample?.props ?? {}) : recipe.recipe.props);
  // Imported objects and page-scoped values cannot be invented safely. Do not execute
  // a standalone component when its declared required inputs are unavailable.
  const missing = schema
    .filter((field) => !field.optional)
    .filter((field) => field.default === undefined && !field.defaultExpr)
    .filter((field) => !Object.hasOwn(props, field.name))
    .map((field) => field.name);
  assert(missing.length <= schema.length, 'Missing preview inputs belong to the prop schema');
  return { props, missing, slot: recipe === undefined ? (sample?.slot ?? { kind: 'name' }) : recipeSlot(recipe, props) };
}

function recipeSlot(recipe: PreviewRecipe, props: Readonly<Record<string, PreviewSampleValue>>): ComponentPreviewSlot {
  const content = recipe.recipe.content;
  switch (content.kind) {
    case 'empty':
      return { kind: 'none' };
    case 'text':
      return { kind: 'html', html: escapeHTML(content.text) };
    case 'children':
      // The owner renders with every prop the preview settled on, the recipe's among them.
      return { kind: 'recipe', node: { ...recipe.node, props }, files: recipe.files };
    default: {
      const exhaustive: never = content;
      return exhaustive;
    }
  }
}

function escapeHTML(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function componentPreviewPath(paths: readonly string[], requestedPath: unknown, requestedName: unknown): string | undefined {
  // This pure function is also emitted into the Astro page. Keep its bounds and
  // checks self-contained so edge adapters need neither Node nor CommonJS.
  if (paths.length > 50000) {
    throw new Error('Preview file count exceeds limit');
  }
  if (typeof requestedPath !== 'string' || typeof requestedName !== 'string') {
    throw new Error('Component path and name: expected string');
  }
  if (requestedPath.length > 4096 || requestedName.length > 200) {
    throw new Error('Component path or name: exceeds length limit');
  }
  const selected = requestedPath;
  const name = requestedName;
  if (selected) {
    const key = '/' + selected.replace(/^\/+/, '');
    // Only a file the route's own globs loaded can match: those name the configured
    // component and layout folders (.stacki/folders.json), so src/ is the outer bound.
    if (/^\/(src|node_modules)\/.+\.astro$/.test(key)) {
      return paths.find((candidate) => candidate === key);
    }
    return undefined;
  }
  if (/^[A-Za-z][\w-]*$/.test(name)) {
    return paths.find((candidate) => candidate.endsWith('/' + name + '.astro'));
  }
  return undefined;
}

/**
 * How the route lays the component out. `popup` fits a fixed 1200 px stage into the hover card,
 * centred and scaled to its height. `page` gives the stage the width of the frame, anchored top
 * left at scale 1 and cut off at the bottom, so the host can scale the whole frame instead. `snapshot` lays
 * the stage out as `popup` does but never scales it, and hands the host the rendered markup to keep.
 */
export type ComponentPreviewLayout = 'popup' | 'page' | 'snapshot';

export function componentPreviewLayout(requested: unknown): ComponentPreviewLayout {
  // Emitted into the Astro page like componentPreviewPath: self-contained, no outside names.
  // Anything but the exact word keeps the popup layout the route always had.
  return requested === 'page' ? 'page' : requested === 'snapshot' ? 'snapshot' : 'popup';
}

export function componentPreviewPlugin(projectDirectories: readonly string[], packages: (root: string) => readonly PackagePreviewSource[] = () => []) {
  assert(projectDirectories.length > 0, 'Preview plugin requires a project root');
  assert(projectDirectories.length <= PREVIEW_LIMITS.rootsMax, 'Preview root count exceeds limit');
  const roots = projectDirectories.map((directory) => path.resolve(directory));
  const root = roots[0];
  assert(root !== undefined, 'Preview plugin requires a project root');
  // Rendering the route loads every component's preview inputs once. They share one read
  // of the project, which any .astro change discards.
  let index: PreviewProjectIndex | undefined;
  const projectIndex = (): PreviewProjectIndex => {
    index ??= readPreviewProjectIndex(root);
    return index;
  };
  // What the key of every snapshot depends on besides the component: the project's styles and page context.
  // Read once, and again after any style or component file changes.
  let stylesText: string | undefined;
  const projectStyles = (): string => {
    stylesText ??= componentPreviewStyleText(root) + '\n' + componentPreviewContextModule(root, projectIndex()).code;
    return stylesText;
  };
  const files: PreludeFiles = { read: readTextFile };
  let aliases: ReturnType<typeof readPathAliases> | undefined;
  let aliasesRead = false;
  const pathAliases = () => {
    if (!aliasesRead) {
      aliases = readPathAliases(root, files);
      aliasesRead = true;
    }
    return aliases;
  };
  return {
    name: 'avb-component-preview',
    enforce: 'pre' as const,
    resolveId(id: string): string | undefined {
      return PREVIEW_VIRTUAL_MODULES.includes(id) ? '\0' + id : undefined;
    },
    watchChange(id: string): void {
      if (id.endsWith('.astro')) {
        index = undefined;
      }
      if (/\.(astro|css|scss)$/.test(id)) {
        stylesText = undefined;
      }
      if (id.endsWith('tsconfig.json')) {
        aliasesRead = false;
      }
    },
    load(this: unknown, id: string): string | undefined {
      if (id === '\0virtual:stacki-component-preview-context') {
        const context = componentPreviewContextModule(root, projectIndex());
        for (const file of context.watchFiles) {
          addWatchFile(this, file);
        }
        return context.code;
      }
      if (id === '\0virtual:stacki-package-components') {
        const root = roots[0];
        assert(root !== undefined, 'Package preview requires a project root');
        return packagePreviewModule(packages(root), root);
      }
      if (id === '\0virtual:stacki-component-preview-styles') {
        const root = roots[0];
        assert(root !== undefined, 'Preview styles require a project root');
        return componentPreviewStylesModule(root);
      }
      const separator = id.indexOf('?');
      if (separator < 0) {
        return undefined;
      }
      const query = new URLSearchParams(id.slice(separator + 1));
      if (!query.has('raw') || !query.has('stacki-preview-props')) {
        return undefined;
      }
      const file = path.resolve(id.slice(0, separator));
      // Only the route's globs ask for these, and they name the configured component and
      // layout folders (renderComponentPreviewPage), all under src/ and never in its pages.
      const relative = roots
        .map((candidate) => path.relative(candidate, file).split(path.sep).join('/'))
        .find((candidate) => /^src\/.+\.astro$/.test(candidate) && !isWithin(PAGES_FOLDER, candidate));
      assert(relative !== undefined, 'Preview metadata must belong to a project component or layout');
      const source = fs.readFileSync(file, 'utf8');
      const name = path.basename(file, '.astro');
      // Saving a recipe changes what the preview should show, even before the file exists.
      addWatchFile(this, previewDefaultsPath(root));
      const config = readPreviewDefaults(root);
      const recipe = config === undefined ? undefined : componentPreviewRecipe(root, relative, config);
      let authored: ComponentPreviewInputs | undefined;
      if (recipe !== undefined) {
        // The owner is this module's own file; the components it nests are watched here.
        for (const file of recipe.files.filter((candidate) => candidate !== relative)) {
          addWatchFile(this, path.join(root, file));
        }
        authored = componentPreviewInputs(source, name, undefined, recipe);
      } else {
        const found = componentPreviewSample(projectIndex(), relative);
        if (found !== undefined) {
          // Editing the sampled instance changes what the preview should show.
          addWatchFile(this, path.join(root, found.host));
          // Children with components or named slots render through the recipe node component, as the page has them.
          const instance = instanceRecipe(projectIndex(), relative, found.host, found.sample);
          authored = componentPreviewInputs(source, name, instance === undefined ? found.sample : undefined, instance);
        }
      }
      return previewModuleSource(previewModuleData(root, file, relative, source, name, authored, projectStyles(), pathAliases(), files), recipe?.code);
    },
  };
}

function instanceRecipe(index: PreviewProjectIndex, relative: string, host: string, sample: PreviewSample): PreviewRecipe | undefined {
  if (sample.markup === undefined) {
    return undefined;
  }
  const file = [...index.pages, ...index.others].find((candidate) => candidate.relative === host);
  assert(file !== undefined, 'Preview instance: the sampled host is in the index');
  const children = instanceMarkupNodes(sample.markup, file.imports);
  return children === undefined ? undefined : instancePreviewRecipe(relative, sample.props, children);
}

function readTextFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Everything the route needs to draw one component: its attempts in order, and the key of the result. */
export interface ComponentPreviewModule {
  readonly key: string;
  readonly attempts: readonly PreviewAttempt<ComponentPreviewSlot>[];
  /** Why there is nothing to draw, when there are no attempts. */
  readonly missing: readonly string[];
}

export function previewModuleData(
  root: string,
  file: string,
  relative: string,
  source: string,
  name: string,
  authored: ComponentPreviewInputs | undefined,
  styles: string,
  aliases: ReturnType<typeof readPathAliases>,
  files: PreludeFiles,
): ComponentPreviewModule {
  assert(path.isAbsolute(file), 'A preview module is built for an absolute file');
  const prelude = previewTypePrelude(file, source, aliases, files);
  const model = readPropModel(source, prelude);
  const base = componentPreviewInputs(source, name);
  const attempts = buildPreviewAttempts<ComponentPreviewSlot>({
    source,
    name,
    model,
    authored: authored === undefined ? undefined : { props: authored.props, slot: authored.slot, complete: authored.missing.length === 0 },
    baseProps: base.props,
  });
  const dependencies = previewDependencySources(file, source, aliases, files);
  const key = previewKey({ source, dependencies, styles, attempts });
  assert(attempts.length > 0, 'A preview module has an attempt: ' + relative + ' under ' + root);
  return { key, attempts, missing: [] };
}

const PREVIEW_VIRTUAL_MODULES: readonly string[] = [
  'virtual:stacki-component-preview-context',
  'virtual:stacki-component-preview-styles',
  'virtual:stacki-package-components',
];

/**
 * Registers a file whose edits must reload a virtual module. Vite passes its plugin
 * context as `this`; tests call `load` on the plugin object, which has no watcher.
 */
function addWatchFile(context: unknown, file: string): void {
  assert(path.isAbsolute(file), 'Watched preview files are absolute');
  if (typeof context !== 'object' || context === null || !('addWatchFile' in context)) {
    return;
  }
  const watch = context.addWatchFile;
  assert(typeof watch === 'function', 'A plugin context addWatchFile is a function');
  Reflect.apply(watch, context, [file]);
}

/** The recipe node component, written beside the route's page: the page imports it by this name. */
export const PREVIEW_RECIPE_FILE = 'stacki-preview-recipe.astro';

/** The guard and attempt components, written beside the route's page: the page imports the attempt by this name. */
export const PREVIEW_ATTEMPT_FILE = 'stacki-preview-attempt.astro';
export const PREVIEW_GUARD_FILE = 'stacki-preview-guard.astro';

/** Every generated file the route imports from beside its page, by file name. */
export function previewSupportFiles(): Readonly<Record<string, string>> {
  return {
    [PREVIEW_RECIPE_FILE]: renderComponentPreviewRecipe(),
    [PREVIEW_ATTEMPT_FILE]: renderComponentPreviewAttempt(),
    [PREVIEW_GUARD_FILE]: renderComponentPreviewGuard(),
  };
}

export function renderComponentPreviewGuard(): string {
  return PREVIEW_GUARD.replace('__STACKI_ONLY_NAME__', () => previewRendersOnlyName.toString() + '\n' + previewRendersNoContent.toString());
}

export function renderComponentPreviewAttempt(): string {
  // One slot position per possible named slot; Astro needs each one written out in the template.
  const positions = Array.from(
    { length: ATTEMPT_LIMITS.namedSlotsMax },
    (_, index) => `<Fragment slot={namedName(${index})} set:html={namedHtml(${index})} />`,
  );
  return PREVIEW_ATTEMPT.replace('__STACKI_PREVIEW_RECIPE__', PREVIEW_RECIPE_FILE)
    .replace('__STACKI_PREVIEW_GUARD__', PREVIEW_GUARD_FILE)
    .replace('__STACKI_NAMED_POSITIONS__', () => positions.join('\n      '));
}

export function renderComponentPreviewRecipe(): string {
  // One slot position per possible group; Astro needs each one written out in the template.
  const positions = Array.from(
    { length: RECIPE_LIMITS.slotsMax },
    (_, index) => `<Fragment slot={slotName(${index})}>{slotNodes(${index}).map((child) => <Astro.self node={child} modules={modules} />)}</Fragment>`,
  );
  return PREVIEW_RECIPE_NODE.replace('__STACKI_SLOT_POSITIONS__', () => positions.join('\n      '));
}

/**
 * The preview route's page. Its globs name the project's component and layout folders
 * (`.stacki/folders.json`, read when the dev server starts), so a configured folder
 * previews like `src/components` does. Without a configuration the page is what it always was.
 */
export function renderComponentPreviewPage(config?: ProjectFolders): string {
  // previewFolders asserts each folder is a plain path, so it sits inside single quotes as it is.
  const globs = previewFolders(config).map((folder) => `'/${folder}/**/*.astro'`);
  // An empty glob list would be a Vite error; a pattern no file matches previews nothing instead.
  const list = '[' + (globs.length === 0 ? ["'/src/__stacki_no_components__/*.astro'"] : globs).join(', ') + ']';
  return PREVIEW_PAGE.replace('__STACKI_PREVIEW_PATH__', () => componentPreviewPath.toString() + '\n' + componentPreviewLayout.toString())
    .replace('__STACKI_PREVIEW_ATTEMPT__', PREVIEW_ATTEMPT_FILE)
    .replaceAll('__STACKI_PREVIEW_GLOBS__', () => list);
}

/** The folders the preview route loads components from: the component folders, then the layout ones. */
function previewFolders(config: ProjectFolders | undefined): readonly string[] {
  const folders = [...foldersFor('components', config), ...foldersFor('layouts', config)];
  // The parser restricts these to src/; each becomes a glob literal in generated code.
  for (const folder of folders) {
    assert(/^src\/[A-Za-z0-9_. /-]+$/.test(folder), 'previewFolders: a component folder is a plain path under src/');
  }
  return folders;
}

interface PackagePreviewSource {
  readonly file: string;
  readonly importPath: string;
  readonly source: string;
}

function packagePreviewModule(sources: readonly PackagePreviewSource[], root: string): string {
  assert(sources.length <= 10000, 'Package previews are bounded');
  const files: PreludeFiles = { read: readTextFile };
  const entries = sources.map(({ file, importPath, source }) => {
    const inputs = previewModuleData(root, path.resolve(root, file), file, source, path.basename(file, '.astro'), undefined, '', undefined, files);
    return { key: JSON.stringify('/' + file), specifier: JSON.stringify(importPath), inputs };
  });
  return (
    'export const packageModules = {' +
    entries.map((entry) => `${entry.key}: () => import(${entry.specifier})`).join(',') +
    '};\n' +
    'export const packageInputs = {' +
    entries.map((entry) => `${entry.key}: async () => (${JSON.stringify(entry.inputs)})`).join(',') +
    '};'
  );
}

// A source is any length: a component's size is the component's own business.
function previewString(input: unknown, label: string): string {
  assert(typeof input === 'string', label + ': expected string');
  return input;
}

const PREVIEW_PAGE = `---
// Generated by Stacki (dev preview only) — do not edit.
// Styles and the default slot retain the project's appearance. Site-wide inline
// styles sit at the start of the body, after the project's stylesheets, where the
// pages' own global components put them. The stage uses
// desktop layout dimensions before fitting its rendered bounds into the card.
// On-demand so Astro.url keeps its query string (prerendered pages get
// their searchParams stripped, even in dev).
export const prerender = false;
__STACKI_PREVIEW_PATH__
import 'virtual:stacki-component-preview-styles';
import { contextStyles, htmlAttributes, bodyAttributes } from 'virtual:stacki-component-preview-context';
import { packageModules, packageInputs } from 'virtual:stacki-package-components';
import Attempt from './__STACKI_PREVIEW_ATTEMPT__';
const mods = {
  ...import.meta.glob(__STACKI_PREVIEW_GLOBS__), ...packageModules,
};
const canvasId = Astro.url.searchParams.get('defaults') || '';
const canvasKey = '/.stacki/canvas/' + canvasId + '.astro';
// Resolve on demand: a new canvas can be created after this route was compiled.
const DefaultCanvas = /^[a-f0-9-]{36}$/.test(canvasId)
  ? (await import(/* @vite-ignore */ canvasKey)).default : null;
const inputs = { ...import.meta.glob(__STACKI_PREVIEW_GLOBS__, {
  query: '?raw&stacki-preview-props', import: 'default',
}), ...packageInputs };
const selected = componentPreviewPath(
  Object.keys(mods), Astro.url.searchParams.get('p') || '', Astro.url.searchParams.get('c') || '',
);
const layout = componentPreviewLayout(Astro.url.searchParams.get('layout'));
const name = selected ? selected.split('/').pop().replace(/\\.astro$/, '') : '';
let C = null;
let attempts = [];
let missing = [];
let key = '';
// The components a recipe nests inside an attempt, loaded before rendering: the node component renders synchronously.
const recipeModules = {};
// A snapshot request that names the key the host already holds gets a page that only confirms it, without
// rendering the component or loading its styles' worth of markup.
const known = Astro.url.searchParams.get('known') || '';
let unchanged = false;
if (selected) {
  ({ attempts, missing, key } = await inputs[selected]());
  // "Try with sample data": skip the project's own instance and draw from the component's types.
  if (Astro.url.searchParams.get('attempts') === 'sample') {
    const sampled = attempts.filter((attempt) => attempt.label !== 'authored');
    if (sampled.length > 0) attempts = sampled;
  }
  unchanged = layout === 'snapshot' && known !== '' && known === key;
  if (attempts.length > 0 && !unchanged) {
    C = (await mods[selected]()).default;
    for (const attempt of attempts) {
      if (attempt.slot.kind !== 'recipe') continue;
      for (const file of attempt.slot.files.slice(0, 256)) {
        // The owner is already loaded as C; the components it nests load here.
        const load = '/' + file === selected ? null : mods['/' + file];
        if ('/' + file === selected) recipeModules[file] = C;
        else if (load && !recipeModules[file]) recipeModules[file] = (await load()).default;
      }
    }
  }
}
---
{DefaultCanvas ? <DefaultCanvas /> : <html {...htmlAttributes} class={[htmlAttributes.class, 'stacki-designer'].filter(Boolean).join(' ')}>
  <head>
    <meta charset="utf-8" />
    <meta name="avb-layout" content={layout} />
    <meta name="avb-key" content={key} />
    <meta name="avb-unchanged" content={unchanged ? '1' : ''} />
    <style>
      /* Keep authored backgrounds paired with the project's text colors. */
      html, body { margin: 0; height: 100%; overflow: hidden; }
      #avb-stage {
        position: absolute;
        top: 0;
        left: 0;
        width: 1200px;
        transform-origin: 0 0;
        visibility: hidden;
      }
      #avb-empty {
        position: absolute;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 16px;
        text-align: center;
        font: 12px/1.5 -apple-system, system-ui, sans-serif;
        color: #8a8a8a;
      }
      body.avb-is-empty #avb-empty { display: flex; }
    </style>
  </head>
  <body {...bodyAttributes}>
    {contextStyles.map((css) => <style is:inline set:html={css}></style>)}
    <div id="avb-stage">{C ? <Attempt component={C} attempts={attempts} index={0} name={name} modules={recipeModules} /> : null}</div>
    <div id="avb-empty">{missing.length > 0
      ? 'Preview needs data for: ' + missing.join(', ') + '. Open an instance on a page.'
      : 'The component rendered nothing.'}</div>
    <script is:inline>
      (function () {
        var stage = document.getElementById('avb-stage');
        var PAD = 12;
        // Fixed/sticky descendants are out of flow: untransformed they anchor
        // to the iframe viewport (so they measure small), then re-anchor to
        // the transformed stage and spill past the card. Pin them into flow
        // with an inline style, which outranks any stylesheet rule.
        function unfix() {
          var all = stage.querySelectorAll('*');
          for (var i = -1; i < all.length; i++) {
            var el = i < 0 ? stage.firstElementChild : all[i];
            if (!el) continue;
            var p = getComputedStyle(el).position;
            if (p === 'fixed' || p === 'sticky') el.style.position = 'relative';
          }
        }
        function bbox(el) {
          var l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
          for (var i = 0; i < el.children.length; i++) {
            var q = el.children[i].getBoundingClientRect();
            if (!q.width && !q.height) continue;
            l = Math.min(l, q.left); t = Math.min(t, q.top);
            r = Math.max(r, q.right); b = Math.max(b, q.bottom);
          }
          return isFinite(l) ? { l: l, t: t, w: r - l, h: b - t } : null;
        }
        var scheduled = false;
        var lastStatus = '';
        var lastBox = null;
        var captures = 0;
        var captureTimer = 0;
        var capturedBox = null;
        // CSS the stage can use: every rule whose selector matches something on the page, with the dynamic
        // pseudo-classes and pseudo-elements stripped before matching so :hover and ::before rules stay.
        var DYNAMIC = /::?(?:hover|focus-visible|focus-within|focus|active|visited|target|link|any-link|before|after|first-line|first-letter|placeholder|selection|marker|backdrop|file-selector-button|-[a-z-]+)(?:\\([^)]*\\))?/g;
        function selectorUsed(text) {
          var parts = text.split(',');
          for (var i = 0; i < parts.length; i++) {
            var q = parts[i].replace(DYNAMIC, '').trim();
            if (q === '' || /[>+~]$/.test(q)) q += '*';
            try {
              if (document.querySelector(q)) return true;
            } catch (e) {
              return true;
            }
          }
          return false;
        }
        function walkRules(rules, depth, budget, keyframes) {
          var out = '';
          for (var i = 0; i < rules.length && budget.left > 0; i++) {
            var r = rules[i];
            budget.left--;
            if (r.type === 1) {
              if (selectorUsed(r.selectorText)) out += r.cssText + '\\n';
            } else if (r.type === 7) {
              keyframes.push({ name: r.name, text: r.cssText });
            } else if (r.cssRules && depth < 8) {
              var inner = walkRules(r.cssRules, depth + 1, budget, keyframes);
              if (inner) out += r.cssText.slice(0, r.cssText.indexOf('{')) + '{' + inner + '}\\n';
            } else {
              out += r.cssText + '\\n';
            }
          }
          return out;
        }
        function usedCSS() {
          var css = '';
          var links = '';
          var keyframes = [];
          var budget = { left: 60000 };
          for (var i = 0; i < document.styleSheets.length; i++) {
            var sheet = document.styleSheets[i];
            var rules = null;
            try { rules = sheet.cssRules; } catch (e) { rules = null; }
            if (rules) css += walkRules(rules, 0, budget, keyframes);
            else if (sheet.href) links += '<link rel="stylesheet" href="' + sheet.href.replace(/"/g, '&quot;') + '">';
          }
          for (var k = 0; k < keyframes.length; k++) {
            if (css.indexOf(keyframes[k].name) >= 0) css += keyframes[k].text + '\\n';
          }
          return { css: css, links: links };
        }
        function attrText(el) {
          var text = '';
          for (var i = 0; i < el.attributes.length; i++) {
            var a = el.attributes[i];
            if (/^on/i.test(a.name)) continue;
            text += ' ' + a.name + '="' + a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"';
          }
          return text;
        }
        // The stage as a standalone document with no script: what the host shows in a tile without the dev
        // server. The origin is a token the host replaces, since the dev server's port changes between runs.
        function capture() {
          captureTimer = 0;
          var box = lastBox;
          if (!box || captures >= 3) return;
          captures++;
          capturedBox = box;
          var clone = stage.cloneNode(true);
          var drop = clone.querySelectorAll('script,noscript,iframe,link');
          for (var i = 0; i < drop.length; i++) drop[i].remove();
          var all = clone.querySelectorAll('*');
          for (var j = 0; j < all.length; j++) {
            var el = all[j];
            for (var n = el.attributes.length - 1; n >= 0; n--) {
              if (/^on/i.test(el.attributes[n].name)) el.removeAttribute(el.attributes[n].name);
            }
            if (el.hasAttribute('loading')) el.removeAttribute('loading');
          }
          var used = usedCSS();
          var keyMeta = document.querySelector('meta[name="avb-key"]');
          var marker = document.getElementById('avb-attempt');
          var origin = location.origin;
          var doc = '<!doctype html><html' + attrText(document.documentElement) + '><head><meta charset="utf-8"><base href="' + origin + '/">' + used.links +
            '<style>' + used.css.replace(/<\\/style/gi, '<\\\\/style') + '</style><style>html,body{margin:0!important;height:auto!important;overflow:hidden!important;background:transparent!important}</style></head><body' +
            attrText(document.body) + '><div id="avb-stage" style="position:absolute;visibility:visible;width:1200px;left:0;top:0">' +
            clone.innerHTML + '</div></body></html>';
          doc = doc.split(origin).join('__AVB_ORIGIN__');
          window.parent.postMessage({
            type: 'avb:component-preview-snapshot',
            key: keyMeta ? keyMeta.getAttribute('content') : '',
            html: doc,
            box: { left: box.l, top: box.t, width: Math.ceil(box.w), height: Math.ceil(box.h) },
            attempt: marker ? marker.getAttribute('data-label') : 'authored'
          }, '*');
        }
        // Wait for the page to settle (load, fonts, a steady box), then capture; again if it changes later, three times at most.
        function scheduleCapture() {
          if (captures >= 3) return;
          if (document.readyState !== 'complete') return;
          if (capturedBox && Math.abs(capturedBox.w - lastBox.w) < 2 && Math.abs(capturedBox.h - lastBox.h) < 2) return;
          if (captureTimer) clearTimeout(captureTimer);
          captureTimer = setTimeout(capture, 150);
        }
        function reportStatus(status, reason) {
          if (status === lastStatus) return;
          lastStatus = status;
          var message = { type: 'avb:component-preview', status: status };
          if (reason) message.reason = reason;
          window.parent.postMessage(message, '*');
        }
        // A preview shows what a component holds: a closed <dialog> or <details> would measure as
        // nothing, so the stage opens them (non-modally: the frame is a picture, not a page to trap).
        function reveal() {
          var closed = stage.querySelectorAll('dialog:not([open]), details:not([open])');
          for (var i = 0; i < closed.length && i < 256; i++) closed[i].setAttribute('open', '');
        }
        function fit() {
          scheduled = false;
          var layoutMeta = document.querySelector('meta[name="avb-layout"]');
          var mode = layoutMeta ? layoutMeta.getAttribute('content') : '';
          var page = mode === 'page';
          var snap = mode === 'snapshot';
          // Measure at the width it will be shown at: the frame's in the page layout, else the CSS 1200 px.
          stage.style.width = page ? window.innerWidth + 'px' : '';
          stage.style.transform = 'none';
          reveal();
          unfix();
          var box = bbox(stage);
          if (!box || box.w < 1 || box.h < 1) {
            document.body.classList.add('avb-is-empty');
            stage.style.visibility = 'hidden';
            var note = document.getElementById('avb-empty');
            var failure = document.getElementById('avb-error');
            // A throw says what threw; the rest say why nothing showed.
            reportStatus('empty', failure ? failure.getAttribute('data-message') : note && note.textContent ? note.textContent.trim() : 'The component rendered nothing.');
            return;
          }
          document.body.classList.remove('avb-is-empty');
          if (page) {
            // The page layout: top left, unscaled, cut off at the bottom.
            stage.style.visibility = 'visible';
            reportStatus('ready');
            return;
          }
          if (snap) {
            // Unscaled at the stage's own width: the host fits the snapshot to its tile.
            stage.style.visibility = 'visible';
            reportStatus('ready');
            lastBox = box;
            scheduleCapture();
            return;
          }
          var aw = window.innerWidth - PAD * 2;
          var ah = window.innerHeight - PAD * 2;
          var s = Math.min(1, aw / box.w, ah / box.h);
          var tx = PAD + (aw - box.w * s) / 2 - box.l * s;
          var ty = PAD + (ah - box.h * s) / 2 - box.t * s;
          stage.style.transform =
            'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
          stage.style.visibility = 'visible';
          reportStatus('ready');
        }
        function refit() {
          if (scheduled) return;
          scheduled = true;
          requestAnimationFrame(fit);
        }
        var unchangedMeta = document.querySelector('meta[name="avb-unchanged"]');
        if (unchangedMeta && unchangedMeta.getAttribute('content') === '1') {
          var heldKey = document.querySelector('meta[name="avb-key"]');
          window.parent.postMessage({ type: 'avb:component-preview-unchanged', key: heldKey ? heldKey.getAttribute('content') : '' }, '*');
          return;
        }
        fit();
        // The page is a live picture: the pointer reaches it, so :hover, hover-driven scripts and
        // focus-visible styles answer as on the real page, but it never acts. Presses, clicks, drags,
        // context menus and submits stop here, before the component's own handlers, so a link or a
        // form cannot navigate and nothing inside takes focus. The host learns of the pointer coming
        // in and of a click, and treats them as its own (the insert palette's card highlights and inserts).
        function gesture(name) {
          window.parent.postMessage({ type: 'avb:component-preview-gesture', gesture: name }, '*');
        }
        var inside = false;
        function arrive() {
          if (inside) return;
          inside = true;
          gesture('pointer');
        }
        window.addEventListener('mouseover', arrive, true);
        window.addEventListener('mousemove', arrive, true);
        document.addEventListener('mouseout', function (event) {
          if (!event.relatedTarget) inside = false;
        }, true);
        function refuse(event) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'auxclick', 'dblclick', 'contextmenu', 'dragstart', 'submit', 'touchstart'].forEach(function (name) {
          window.addEventListener(name, refuse, { capture: true, passive: false });
        });
        window.addEventListener('click', function (event) {
          refuse(event);
          if (event.button === 0) gesture('click');
        }, true);
        // In dev, Vite injects component CSS asynchronously and images decode
        // later — both change the layout after the first fit, which would
        // leave the stage unscaled and spilling past the card. Re-fit on any
        // size change, on late <style>/<link> injection, and on media load.
        window.addEventListener('load', refit);
        window.addEventListener('resize', refit);
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit);
        if (window.ResizeObserver) {
          var ro = new ResizeObserver(refit);
          ro.observe(stage);
          for (var i = 0; i < stage.children.length; i++) ro.observe(stage.children[i]);
        }
        new MutationObserver(refit).observe(document.head, { childList: true, subtree: true });
        new MutationObserver(refit).observe(stage, { childList: true, subtree: true });
        document.addEventListener('load', refit, true); // images/iframes
        [60, 200, 600, 1200].forEach(function (ms) { setTimeout(refit, ms); });
      })();
    </script>
  </body>
</html>}
`;

// One node of a component's insertion recipe, rendered as the insert would write it: a literal is
// text, an element is that tag, a component is the project's own (loaded by the page into
// `modules`). Nested nodes render through `Astro.self`; the recipe resolver bounds the depth, and
// a child of a component goes to the slot its `slot` prop names.
const PREVIEW_RECIPE_NODE = `---
// Generated by Stacki (dev preview only) — do not edit.
const { node, modules } = Astro.props;
const { slot: _slot, ...props } = node && node.props ? node.props : {};
const content = node && node.content ? node.content : { kind: 'empty' };
const groups = content.kind === 'children' ? content.children : [];
const children = groups;
// A component's children come grouped by slot; an unused position gets a name no component declares.
const slotName = (index) => (groups[index] ? groups[index].name : 'stacki-unused-' + index);
const slotNodes = (index) => (groups[index] ? groups[index].children : []);
const Component = node && typeof node.component === 'string' ? modules[node.component] : undefined;
const Tag = node && typeof node.element === 'string' ? node.element : undefined;
---
{node && typeof node.literal === 'string' ? node.literal
  : Component ? (content.kind === 'text' ? <Component {...props}>{content.text}</Component>
    : content.kind === 'children' ? <Component {...props}>
      __STACKI_SLOT_POSITIONS__
    </Component>
    : <Component {...props} />)
  : Tag ? (content.kind === 'text' ? <Tag {...props}>{content.text}</Tag>
    : content.kind === 'children' ? <Tag {...props}>{children.map((child) => <Astro.self node={child} modules={modules} />)}</Tag>
    : <Tag {...props} />)
  : null}
`;

// Renders its default slot inside a try, so a component that throws is a reason and not a blank page. When the
// attempt fails (it threw, or drew nothing but the component's own name) and a later attempt exists, that one
// is drawn instead (the `fallback` slot, rendered only here); the last attempt is kept whatever it drew.
const PREVIEW_GUARD = `---
// Generated by Stacki (dev preview only) — do not edit.
__STACKI_ONLY_NAME__
const { name, label, last } = Astro.props;
let html = '';
let failure = '';
try {
  html = await Astro.slots.render('default');
  if (!last && previewRendersOnlyName(html, name)) failure = 'It drew only its own name.';
  else if (!last && previewRendersNoContent(html)) failure = 'It drew nothing.';
} catch (error) {
  failure = 'Threw: ' + String(error && error.message ? error.message : error).slice(0, 300);
}
const useFallback = failure !== '' && !last;
const fallbackHtml = useFallback ? await Astro.slots.render('fallback') : '';
---
{useFallback ? <Fragment set:html={fallbackHtml} /> : <Fragment set:html={html} />}
{failure !== '' && last ? <div id="avb-error" hidden data-message={failure}></div> : null}
{failure === '' ? <div id="avb-attempt" hidden data-label={label}></div> : null}
`;

// One attempt: the component with one set of props and slot content, inside a guard whose fallback is the next attempt.
const PREVIEW_ATTEMPT = `---
// Generated by Stacki (dev preview only) — do not edit.
import Guard from './__STACKI_PREVIEW_GUARD__';
import RecipeNode from './__STACKI_PREVIEW_RECIPE__';
const { component: C, attempts, index, name, modules } = Astro.props;
const attempt = attempts[index];
const next = index + 1 < attempts.length;
const slot = attempt.slot;
const named = slot.kind === 'sample' ? slot.named : [];
const namedName = (position) => (named[position] ? named[position].name : 'stacki-unused-' + position);
const namedHtml = (position) => (named[position] ? named[position].html : '');
---
<Guard name={name} label={attempt.label} last={!next}>
  {slot.kind === 'recipe' ? <RecipeNode node={slot.node} modules={modules} />
    : slot.kind === 'html' ? <C {...attempt.props}><Fragment set:html={slot.html} /></C>
    : slot.kind === 'sample' ? <C {...attempt.props}><Fragment set:html={slot.html} />
      __STACKI_NAMED_POSITIONS__
    </C>
    : slot.kind === 'none' ? <C {...attempt.props} />
    : <C {...attempt.props}>{name}</C>}
  <Fragment slot="fallback">{next ? <Astro.self component={C} attempts={attempts} index={index + 1} name={name} modules={modules} /> : null}</Fragment>
</Guard>
`;
