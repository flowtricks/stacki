// The build-time half of a baked site: the same source markers the dev preview
// makes, applied to a production `astro build`. Nothing here runs in `astro dev`:
// `apply: 'build'` keeps it out of the dev server, and only `bakeSite` installs it.
import path from 'node:path';
import type { AstroIntegration } from 'astro';
import type { Plugin } from 'vite';
import { markSourceFile } from '../../../vendor/stacki/electron/previewServer/previewMarkers';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { BAKE_RUNTIME_DIRECTORY, sectionFences } from './bakeProtocol';
import { entryPropsMarkup, TemplateOutputs, type TemplateOutput } from './bakeTemplates';
import { sampleEntryProps } from '../pages/entryPropsSample';

export interface BakeIntegrationOptions {
  readonly root: string;
  /** The URL prefix the baked site is served under, with a trailing slash. */
  readonly base: string;
  /** Component probes to render at the end of a page, by project-relative file. */
  readonly probes?: (file: string) => string | undefined;
  /** Pages of probes for recipes no page imports, added to this build alone. */
  readonly recipes?: readonly { readonly pattern: string; readonly entrypoint: string }[];
  /** Told each template page's built documents once the build is done (bakeTemplates.ts). */
  readonly templates?: (outputs: readonly TemplateOutput[]) => void;
}

const STYLE_QUERY = /^(.*\.astro)\?astro&type=style&index=(\d+)&lang\.css$/;

export function bakeIntegration(options: BakeIntegrationOptions): AstroIntegration {
  assert(options.base.endsWith('/'), 'The bake base ends with a slash');
  assert(path.isAbsolute(options.root), 'The bake root is absolute');
  const templates = new TemplateOutputs(options.root);
  return {
    name: 'stacki-bake',
    hooks: {
      'astro:routes:resolved': ({ routes }) => {
        templates.resolved(routes);
      },
      'astro:build:done': ({ dir, assets }) => {
        options.templates?.(templates.done(dir, assets));
      },
      'astro:config:setup': ({ updateConfig, injectRoute }) => {
        updateConfig({ vite: { plugins: [bakeMarkers(options), bakeStyleSections(options)] } });
        for (const recipe of options.recipes ?? []) {
          injectRoute({ pattern: recipe.pattern, entrypoint: recipe.entrypoint, prerender: true });
        }
      },
    },
  };
}

/** The section a Vite module id belongs to, or undefined when it is not authored CSS. */
export function styleSectionId(id: string, root: string): string | undefined {
  const astro = STYLE_QUERY.exec(id);
  if (astro !== null) {
    const file = projectFile(astro[1] ?? '', root);
    return file === undefined ? undefined : `${file}#${astro[2] ?? '0'}`;
  }
  if (id.includes('?') || !id.endsWith('.css')) {
    return undefined;
  }
  return projectFile(id, root);
}

function projectFile(id: string, root: string): string | undefined {
  const relative = path.relative(root, id).split(path.sep).join('/');
  return relative.startsWith('src/') ? relative : undefined;
}

function bakeMarkers(options: BakeIntegrationOptions): Plugin {
  const runtime = `${options.base}${BAKE_RUNTIME_DIRECTORY}`;
  return {
    name: 'stacki-bake-markers',
    apply: 'build',
    enforce: 'pre',
    load(id: string) {
      if (id.includes('?')) {
        return undefined;
      }
      const marked = markSourceFile(id, [options.root]);
      if (marked === undefined) {
        return undefined;
      }
      if (!marked.page) {
        return marked.code;
      }
      // Probes render after everything the page renders, and the bake cuts them out
      // again (bakeProbes.ts), so the page itself is what it would be without them.
      const file = path.relative(options.root, id).split(path.sep).join('/');
      // A template page's entries also render their props, for the binding picker (bakeTemplates.ts).
      const probes = (options.probes?.(file) ?? '') + (file.includes('[') ? entryPropsMarkup(sampleEntryProps) : '');
      // The same two scripts the dev plugin adds, from the baked runtime folder.
      return `${marked.code}${probes}\n<script is:inline type="module" src="${runtime}/morph.js"></script>\n<script is:inline type="module" async src="${runtime}/preview.js"></script>`;
    },
  };
}

// Each authored stylesheet is fenced so the finished CSS can be cut back into one
// replaceable section per source. Bundling otherwise erases where a `<style>`
// block ends, and a static page could never swap just that block.
function bakeStyleSections(options: BakeIntegrationOptions): Plugin {
  return {
    name: 'stacki-bake-style-sections',
    apply: 'build',
    // Normal order on purpose: after `vite:css` has inlined `@import`, and before
    // `vite:css-post` wraps the text in a module.
    transform(code: string, id: string) {
      const section = styleSectionId(id, options.root);
      if (section === undefined) {
        return undefined;
      }
      const { start, end } = sectionFences(section);
      return { code: `${start}\n${code}\n${end}\n`, map: null };
    },
  };
}
