// Standalone palette previews need sample inputs for guarded text content.
// Authored defaults run inside the component; preview data never evaluates source expressions.
import { parsePropSchema } from '../parse/astroParser';
import { assert } from '../../shared/core/assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { componentPreviewStylesModule } from './componentPreviewStyles';
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
  instanceMarkupNodes,
  instancePreviewRecipe,
  previewDefaultsPath,
  readPreviewDefaults,
  RECIPE_LIMITS,
  type PreviewRecipe,
  type PreviewRecipeNode,
} from './componentPreviewRecipe';

const PREVIEW_LIMITS = {
  sourceCharsMax: 10 * 1024 * 1024,
  fieldsMax: 1024,
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
  const text = previewText(source, PREVIEW_LIMITS.sourceCharsMax, 'Component source');
  const label = previewText(name, PREVIEW_LIMITS.nameCharsMax, 'Component name');
  const schema = parsePropSchema(text);
  assert(schema.length <= PREVIEW_LIMITS.fieldsMax, 'Preview prop count exceeds limit');
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
 * left at scale 1 and cut off at the bottom, so the host can scale the whole frame instead.
 */
export type ComponentPreviewLayout = 'popup' | 'page';

export function componentPreviewLayout(requested: unknown): ComponentPreviewLayout {
  // Emitted into the Astro page like componentPreviewPath: self-contained, no outside names.
  // Anything but the exact word keeps the popup layout the route always had.
  return requested === 'page' ? 'page' : 'popup';
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
        return packagePreviewModule(packages(root));
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
      const bytes = fs.statSync(file).size;
      assert(bytes <= PREVIEW_LIMITS.sourceCharsMax, 'Component source exceeds size limit');
      const source = fs.readFileSync(file, 'utf8');
      const name = path.basename(file, '.astro');
      // Saving a recipe changes what the preview should show, even before the file exists.
      addWatchFile(this, previewDefaultsPath(root));
      const config = readPreviewDefaults(root);
      const recipe = config === undefined ? undefined : componentPreviewRecipe(root, relative, config);
      if (recipe !== undefined) {
        // The owner is this module's own file; the components it nests are watched here.
        for (const file of recipe.files.filter((candidate) => candidate !== relative)) {
          addWatchFile(this, path.join(root, file));
        }
        return 'export default ' + JSON.stringify(componentPreviewInputs(source, name, undefined, recipe)) + ';';
      }
      const found = componentPreviewSample(projectIndex(), relative);
      if (found !== undefined) {
        // Editing the sampled instance changes what the preview should show.
        addWatchFile(this, path.join(root, found.host));
        // Children with components or named slots render through the recipe node component, as the page has them.
        const instance = instanceRecipe(projectIndex(), relative, found.host, found.sample);
        if (instance !== undefined) {
          return 'export default ' + JSON.stringify(componentPreviewInputs(source, name, undefined, instance)) + ';';
        }
      }
      return 'export default ' + JSON.stringify(componentPreviewInputs(source, name, found?.sample)) + ';';
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
    .replace('__STACKI_PREVIEW_RECIPE__', PREVIEW_RECIPE_FILE)
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

function packagePreviewModule(sources: readonly PackagePreviewSource[]): string {
  assert(sources.length <= 10000, 'Package previews are bounded');
  const entries = sources.map(({ file, importPath, source }) => {
    const inputs = componentPreviewInputs(source, path.basename(file, '.astro'));
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

function previewText(input: unknown, maximum: number, label: string): string {
  assert(typeof input === 'string', label + ': expected string');
  assert(input.length <= maximum, label + ': exceeds length limit');
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
import RecipeNode from './__STACKI_PREVIEW_RECIPE__';
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
let props = {};
let missing = [];
let slot = { kind: 'name' };
// The components a recipe nests inside this one, loaded before rendering: the node component renders synchronously.
const recipeModules = {};
if (selected) {
  ({ props, missing, slot } = await inputs[selected]());
  if (missing.length === 0) {
    C = (await mods[selected]()).default;
    if (slot.kind === 'recipe') {
      for (const file of slot.files.slice(0, 256)) {
        // The owner is already loaded as C; the components it nests load here.
        const load = '/' + file === selected ? null : mods['/' + file];
        if ('/' + file === selected) recipeModules[file] = C;
        else if (load) recipeModules[file] = (await load()).default;
      }
    }
  }
}
---
{DefaultCanvas ? <DefaultCanvas /> : <html {...htmlAttributes} class={[htmlAttributes.class, 'stacki-designer'].filter(Boolean).join(' ')}>
  <head>
    <meta charset="utf-8" />
    <meta name="avb-layout" content={layout} />
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
    <div id="avb-stage">{C ? (slot.kind === 'html' ? <C {...props}><Fragment set:html={slot.html} /></C>
      : slot.kind === 'recipe' ? <RecipeNode node={slot.node} modules={recipeModules} />
      : slot.kind === 'none' ? <C {...props} /> : <C {...props}>{name}</C>) : null}</div>
    <div id="avb-empty">{missing.length > 0
      ? 'Preview needs data for: ' + missing.join(', ') + '. Open an instance on a page.'
      : 'Nothing to preview — this component needs props or slot content.'}</div>
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
          var page = !!layoutMeta && layoutMeta.getAttribute('content') === 'page';
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
            reportStatus('empty', note && note.textContent ? note.textContent.trim() : 'The component rendered nothing.');
            return;
          }
          document.body.classList.remove('avb-is-empty');
          if (page) {
            // The page layout: top left, unscaled, cut off at the bottom.
            stage.style.visibility = 'visible';
            reportStatus('ready');
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
