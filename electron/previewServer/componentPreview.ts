// Standalone palette previews need sample inputs for guarded text content.
// Authored defaults run inside the component; preview data never evaluates source expressions.
import { parsePropSchema } from '../parse/astroParser';
import { assert } from '../../shared/core/assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { componentPreviewStylesModule } from './componentPreviewStyles';
import {
  componentPreviewContextModule,
  componentPreviewSample,
  readPreviewProjectIndex,
  type PreviewProjectIndex,
  type PreviewSample,
  type PreviewSampleValue,
  type PreviewSlot,
} from './componentPreviewContext';

const PREVIEW_LIMITS = {
  sourceCharsMax: 10 * 1024 * 1024,
  fieldsMax: 1024,
  nameCharsMax: 200,
  rootsMax: 8,
} as const;

export interface ComponentPreviewInputs {
  readonly props: Readonly<Record<string, PreviewSampleValue>>;
  readonly missing: readonly string[];
  readonly slot: PreviewSlot;
}

export function componentPreviewInputs(source: unknown, name: unknown, sample?: PreviewSample): ComponentPreviewInputs {
  const text = previewText(source, PREVIEW_LIMITS.sourceCharsMax, 'Component source');
  const label = previewText(name, PREVIEW_LIMITS.nameCharsMax, 'Component name');
  const schema = parsePropSchema(text);
  assert(schema.length <= PREVIEW_LIMITS.fieldsMax, 'Preview prop count exceeds limit');
  const props: Record<string, PreviewSampleValue> = {};
  for (const field of schema) {
    // Even false, empty, or expression defaults belong to the component author.
    if (field.default !== undefined || field.defaultExpr) {
      continue;
    }
    if (field.type === 'string') {
      if (/^(heading|title|label|text|description|caption|summary|content)$/i.test(field.name)) {
        props[field.name] = label;
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
  Object.assign(props, sample?.props ?? {});
  // Imported objects and page-scoped values cannot be invented safely. Do not execute
  // a standalone component when its declared required inputs are unavailable.
  const missing = schema
    .filter((field) => !field.optional)
    .filter((field) => field.default === undefined && !field.defaultExpr)
    .filter((field) => !Object.hasOwn(props, field.name))
    .map((field) => field.name);
  assert(missing.length <= schema.length, 'Missing preview inputs belong to the prop schema');
  return { props, missing, slot: sample?.slot ?? { kind: 'name' } };
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
    if (/^\/(src\/(components|layouts)|node_modules)\/.+\.astro$/.test(key)) {
      return paths.find((candidate) => candidate === key);
    }
    return undefined;
  }
  if (/^[A-Za-z][\w-]*$/.test(name)) {
    return paths.find((candidate) => candidate.endsWith('/' + name + '.astro'));
  }
  return undefined;
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
      const relative = roots
        .map((candidate) => path.relative(candidate, file).split(path.sep).join('/'))
        .find((candidate) => /^src\/(components|layouts)\/.+\.astro$/.test(candidate));
      assert(relative !== undefined, 'Preview metadata must belong to a project component or layout');
      const bytes = fs.statSync(file).size;
      assert(bytes <= PREVIEW_LIMITS.sourceCharsMax, 'Component source exceeds size limit');
      const source = fs.readFileSync(file, 'utf8');
      const name = path.basename(file, '.astro');
      const found = componentPreviewSample(projectIndex(), relative);
      if (found !== undefined) {
        // Editing the sampled instance changes what the preview should show.
        addWatchFile(this, path.join(root, found.host));
      }
      return 'export default ' + JSON.stringify(componentPreviewInputs(source, name, found?.sample)) + ';';
    },
  };
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

export function renderComponentPreviewPage(): string {
  return PREVIEW_PAGE.replace('__STACKI_PREVIEW_PATH__', () => componentPreviewPath.toString());
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
const mods = {
  ...import.meta.glob(['/src/components/**/*.astro', '/src/layouts/**/*.astro']), ...packageModules,
};
const canvasId = Astro.url.searchParams.get('defaults') || '';
const canvasKey = '/.stacki/canvas/' + canvasId + '.astro';
// Resolve on demand: a new canvas can be created after this route was compiled.
const DefaultCanvas = /^[a-f0-9-]{36}$/.test(canvasId)
  ? (await import(/* @vite-ignore */ canvasKey)).default : null;
const inputs = { ...import.meta.glob(['/src/components/**/*.astro', '/src/layouts/**/*.astro'], {
  query: '?raw&stacki-preview-props', import: 'default',
}), ...packageInputs };
const selected = componentPreviewPath(
  Object.keys(mods), Astro.url.searchParams.get('p') || '', Astro.url.searchParams.get('c') || '',
);
const name = selected ? selected.split('/').pop().replace(/\\.astro$/, '') : '';
let C = null;
let props = {};
let missing = [];
let slot = { kind: 'name' };
if (selected) {
  ({ props, missing, slot } = await inputs[selected]());
  if (missing.length === 0) {
    C = (await mods[selected]()).default;
  }
}
---
{DefaultCanvas ? <DefaultCanvas /> : <html {...htmlAttributes}>
  <head>
    <meta charset="utf-8" />
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
        function reportStatus(status) {
          if (status === lastStatus) return;
          lastStatus = status;
          window.parent.postMessage({ type: 'avb:component-preview', status: status }, '*');
        }
        function fit() {
          scheduled = false;
          stage.style.transform = 'none';
          unfix();
          var box = bbox(stage);
          if (!box || box.w < 1 || box.h < 1) {
            document.body.classList.add('avb-is-empty');
            stage.style.visibility = 'hidden';
            reportStatus('empty');
            return;
          }
          document.body.classList.remove('avb-is-empty');
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
