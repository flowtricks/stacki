// Which component renderings a bake asks for: every instance a page can show without
// a loop around it, and every component's insertion recipe, rendered on a page that
// already uses that component so no page gains styles it did not have.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ParserNode } from '../source/source';
import { defaultInstance } from '../source/instanceDefaults';
import { loadInsertionDefaults } from '../settings/loadDefaults';
import { scanProject } from '../project/projectServer';
import { filledSlots } from './componentTemplates';
import { localName, pageInstances, planProbes, probeSpec, PROBE_LIMITS, requiredProps, type ProbePlan, type ProbeSpec, type ScanField } from './bakeProbes';
import { assert } from '../../../vendor/stacki/shared/core/assert';

const RECIPE_NODES_MAX = 64;

/** Recipes no page imports render on pages of their own, one per component, injected
 * into the build and pruned after it, so no real page gains their styles, and one that
 * throws costs only its own page. The plan keys them by their route. */
export const RECIPE_ROUTE = '/__stacki-recipes/';

export interface ComponentProbes {
  readonly plan: ProbePlan;
  /** Each recipe page's route, and its source. */
  readonly recipePages: ReadonlyMap<string, string>;
}

export async function componentProbePlan(root: string): Promise<ComponentProbes> {
  const scan = await scanProject(root);
  const fields = new Map<string, readonly ScanField[]>(scan.components.map((component) => [component.file, component.fields]));
  const pages = new Map<string, string>();
  for (const file of [...scan.pages].sort()) {
    // A template page (`[...slug].astro`) is probed too: once, on the first entry the build
    // renders (planProbes), and its entries share the result (bakeSite.ts).
    if (file.endsWith('.astro')) {
      pages.set(file, await readFile(path.join(root, file), 'utf8'));
    }
  }
  const specs = new Map<string, ProbeSpec[]>();
  for (const [page, source] of pages) {
    const bytes = await readFile(path.join(root, page));
    const stamp = `avb-d:${createHash('sha256').update(bytes).digest('hex')}:${page}`;
    specs.set(page, [...pageInstances(page, source, (file) => fields.get(file), stamp)]);
  }
  const orphans = new Map<string, ProbeSpec[]>();
  for (const spec of await recipeSpecs(root, pages, fields)) {
    const host = [...pages].find(([page, source]) => localName(page, source, spec.file) !== undefined);
    const name = host === undefined ? undefined : localName(host[0], host[1], spec.file);
    if (host !== undefined && name !== undefined) {
      specs.get(host[0])?.push({ ...spec, name });
    } else {
      orphans.set(spec.file, [...(orphans.get(spec.file) ?? []), { ...spec, name: 'StackiProbe' }]);
    }
  }
  const imports = new Map<string, string>();
  for (const [file, list] of orphans) {
    const route = `${RECIPE_ROUTE}${imports.size}`;
    imports.set(route, file);
    specs.set(route, list);
  }
  const plan = planProbes(specs);
  const recipePages = new Map<string, string>();
  for (const [route, file] of imports) {
    const markup = plan.pages.get(route)?.markup;
    if (markup !== undefined) {
      recipePages.set(route, `---\nimport StackiProbe from ${JSON.stringify(path.join(root, file))};\n---\n${markup}`);
    }
  }
  return { plan, recipePages };
}

/** Each component node of every insertion recipe, as Studio's own insertion builds it.
 * The name is a placeholder until a page that imports the component is chosen. */
async function recipeSpecs(root: string, pages: ReadonlyMap<string, string>, fields: ReadonlyMap<string, readonly ScanField[]>): Promise<readonly ProbeSpec[]> {
  const settings = await loadInsertionDefaults(root).catch(() => undefined);
  if (settings === undefined || pages.size === 0) {
    return [];
  }
  const specs: ProbeSpec[] = [];
  for (const component of settings.catalog) {
    let recipe: ParserNode | undefined;
    try {
      recipe = defaultInstance(component.file, settings, (file) => file);
    } catch {
      recipe = undefined; // A recipe Studio itself would refuse inserts nothing.
    }
    const nodes: ParserNode[] = recipe === undefined ? [] : [recipe];
    for (let index = 0; index < nodes.length && index < RECIPE_NODES_MAX; index++) {
      const node = nodes[index];
      assert(node !== undefined, 'The recipe walk reads what it queued');
      const file = node.kind === 'component' ? node.name : undefined;
      const known = file === undefined ? undefined : fields.get(file);
      const slots = filledSlots(node.children ?? []);
      // A recipe that leaves out a prop the component requires renders nothing a page
      // could hold, and a component that reads it throws, taking its host page's probes.
      const complete = known !== undefined && requiredProps(known).every((name) => node.props?.[name] !== undefined);
      if (file !== undefined && known !== undefined && slots !== undefined && complete) {
        specs.push(probeSpec({ file, name: file, node, slots, fields: known, stamp: undefined, instance: undefined }));
      }
      nodes.push(...(node.children ?? []));
    }
  }
  assert(specs.length <= settings.catalog.length * RECIPE_NODES_MAX, 'Recipes stay within their walk limit');
  return specs.slice(0, PROBE_LIMITS.instancesPerPageMax);
}
