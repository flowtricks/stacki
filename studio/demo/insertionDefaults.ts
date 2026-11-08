// What a new component instance holds when it is inserted, read the way the server
// reads it (src/features/settings/loadDefaults.ts), from the bake's scan and the
// project's `.stacki/components.json` as the room holds it now. The bake rendered each
// recipe from the same reading, so an insertion lands on a template it already has.
import { parseDefaultsSource, type DefaultComponent } from '../vendor/stacki/shared/properties/componentDefaults';
import { starterDefaults } from '../vendor/stacki/shared/properties/componentStarterDefaults';
import { METADATA_FILES } from '../vendor/stacki/shared/properties/projectMetadata';
import type { InsertionDefaults } from '../src/features/source/instanceDefaults';
import type { BakeSnapshot } from '../src/features/bake/bakeSnapshot';

const COMPONENTS_MAX = 2_000;
const NAMES_MAX = 200;

function strings(input: unknown): readonly string[] {
  return Array.isArray(input) ? input.slice(0, NAMES_MAX).filter((item): item is string => typeof item === 'string') : [];
}

/** The scan's components as the recipe resolver lists them. Malformed entries are
 * skipped: an entry missing from the catalog only inserts as a bare tag. */
export function defaultCatalog(project: BakeSnapshot['project']): readonly DefaultComponent[] {
  const components = project['components'];
  if (!Array.isArray(components)) {
    return [];
  }
  const catalog: DefaultComponent[] = [];
  for (const input of components.slice(0, COMPONENTS_MAX)) {
    if (typeof input === 'object' && input !== null && 'file' in input && 'name' in input && typeof input.file === 'string' && typeof input.name === 'string') {
      const fields = 'fields' in input && Array.isArray(input.fields) ? input.fields : [];
      const props = fields.flatMap((field: unknown) =>
        typeof field === 'object' && field !== null && 'name' in field && typeof field.name === 'string' ? [field.name] : [],
      );
      const importPath = 'importPath' in input && typeof input.importPath === 'string' ? input.importPath : undefined;
      catalog.push({
        file: input.file,
        name: input.name,
        props,
        slots: 'slots' in input ? strings(input.slots) : [],
        slotText: 'slotText' in input && input.slotText === true,
        ...(importPath === undefined ? {} : { importPath }),
      });
    }
  }
  return catalog;
}

/** The insertion settings for the current `.stacki/components.json`, or the starter
 * recipes when there is none, exactly as the server falls back. A file that does not
 * parse throws, as the server's insertion does. */
export function insertionDefaults(project: BakeSnapshot['project'], read: (file: string) => string | undefined): InsertionDefaults {
  const catalog = defaultCatalog(project);
  const imports = catalog.map((component) =>
    component.importPath === undefined ? { file: component.file } : { file: component.file, importPath: component.importPath },
  );
  const source = read(METADATA_FILES.components);
  if (source === undefined) {
    return { config: starterDefaults(catalog), catalog, imports };
  }
  const parsed = parseDefaultsSource(source);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return { config: parsed.value, catalog, imports };
}
