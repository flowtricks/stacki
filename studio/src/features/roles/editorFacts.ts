// What the editor content check needs to know about the project, read before it
// runs: which component props are words on the page, and which frontmatter strings
// the page prints. Both are the canvas text editor's own answers (canvasPropSites.ts,
// canvasBoundSites.ts), so a role may type exactly where the canvas lets it type.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import type { ScanComponent } from '../../../vendor/stacki/shared/properties/projectScan';
import { componentReference } from '../../../vendor/stacki/src/app/model/componentReference';
import { propSiteReader, type ComponentSource } from '../../../vendor/stacki/src/app/model/canvasPropSites';
import { resolvePageTexts } from '../../../vendor/stacki/src/app/model/canvasBoundSites';
import { resolveBoundText, type BoundTextEnvironment } from '../../../vendor/stacki/src/editor/boundText';
import { componentSchema } from '../components/componentSchema';
import { resolveImport } from '../source/imports';
import { flatten, parsePage } from '../source/source';
import type { ContentRules, SourceRange, TextPropKind } from './editorContent';

// Studio's files are project-relative; the finder resolves imports against a root, so both are read under this stand-in.
const ROOT = 'studio';
const COMPONENTS_MAX = 200;
const PROPS_BOUND_MAX = 200;

/** Reads a project file's source; undefined when it cannot be read. */
export type SourceReader = (file: string) => Promise<string | undefined>;

interface Catalog {
  readonly components: readonly ScanComponent[];
  readonly sources: ReadonlyMap<string, ComponentSource>;
}

function importsOf(source: string) {
  const parsed = parsePage(source, { locs: true });
  return parsed.editable ? parsed.model : undefined;
}

// The project components the page reaches through imports, the nested ones included.
async function componentCatalog(file: string, source: string, read: SourceReader): Promise<Catalog> {
  const queue: { readonly file: string; readonly source: string }[] = [{ file, source }];
  const seen = new Set<string>([file]);
  const components: ScanComponent[] = [];
  const sources = new Map<string, ComponentSource>();
  for (let index = 0; index < queue.length && index <= COMPONENTS_MAX; index++) {
    const entry = queue[index];
    assert(entry !== undefined, 'A queued component exists');
    for (const declaration of importsOf(entry.source)?.imports ?? []) {
      const target = resolveImport(entry.file, declaration.path);
      if (target === undefined || !target.endsWith('.astro') || seen.has(target) || seen.size > COMPONENTS_MAX) {
        continue;
      }
      seen.add(target);
      const text = await read(target);
      const model = text === undefined ? undefined : importsOf(text);
      if (text === undefined || model === undefined) {
        continue;
      }
      const schema = await componentSchema(target, text, async (candidate) => {
        const found = await read(candidate);
        if (found === undefined) {
          throw Object.assign(new Error('Component declaration not found'), { code: 'ENOENT' });
        }
        return found;
      });
      const path = `${ROOT}/${target}`;
      // The finder reads only each prop's name and its text default.
      const props = schema.map((field) => ({
        name: field.name,
        type: field.type,
        optional: field.optional,
        ...(typeof field.default === 'string' ? { default: field.default } : {}),
      }));
      components.push({ name: declaration.name, path, folder: path.slice(0, path.lastIndexOf('/')), schema: props });
      sources.set(path, { nodes: model.nodes, imports: model.imports, extraFrontmatter: model.extraFrontmatter });
      queue.push({ file: target, source: text });
    }
  }
  return { components, sources };
}

/** Which props of the components `versions` of a page use are words on it, by `tag` and prop. */
export async function componentTextProps(file: string, versions: readonly string[], read: SourceReader): Promise<ContentRules['textProp']> {
  assert(versions.length <= 2, 'A change has two versions');
  const found = new Map<string, TextPropKind>();
  for (const source of versions) {
    const model = importsOf(source);
    if (model === undefined) {
      continue;
    }
    const catalog = await componentCatalog(file, source, read);
    const sites = propSiteReader({
      projectPath: ROOT,
      components: catalog.components,
      relative: (path) => path.slice(ROOT.length + 1),
      read: async (path) => catalog.sources.get(path),
    });
    for (const node of flatten(model.nodes)) {
      if (node.kind !== 'component') {
        continue;
      }
      const component = componentReference({
        name: node.name,
        project: ROOT,
        file: `${ROOT}/${file}`,
        imports: model.imports,
        components: catalog.components,
      });
      if (component === undefined) {
        continue;
      }
      for (const site of await sites(component)) {
        found.set(`${node.name}\n${site.prop}`, site.kind);
      }
    }
  }
  return (component, prop) => found.get(`${component}\n${prop}`);
}

/** The frontmatter strings of `source` that the page prints as words, through its own text or a component's. */
export async function printedLiterals(file: string, source: string, textProp: ContentRules['textProp']): Promise<readonly SourceRange[]> {
  const model = importsOf(source);
  if (model === undefined) {
    return [];
  }
  // Only the page's own file: a text kept in another module is that file's to write, under its own permission.
  const environment: BoundTextEnvironment = { page: { file, text: source }, readModule: async () => undefined };
  const ranges = new Map<number, SourceRange>();
  const keep = (outcome: Awaited<ReturnType<typeof resolveBoundText>>) => {
    if (outcome.ok && (outcome.site.file === '' || outcome.site.file === file)) {
      ranges.set(outcome.site.start, { start: outcome.site.start, end: outcome.site.end });
    }
  };
  for (const text of await resolvePageTexts(environment, model.nodes)) {
    keep(text.outcome);
  }
  let followed = 0;
  for (const node of flatten(model.nodes)) {
    for (const [prop, value] of Object.entries(node.props ?? {})) {
      if (value.type === 'expr' && followed < PROPS_BOUND_MAX && textProp(node.name ?? '', prop) !== undefined) {
        followed += 1;
        keep(await resolveBoundText(environment, value.value.trim()));
      }
    }
  }
  return [...ranges.values()];
}
