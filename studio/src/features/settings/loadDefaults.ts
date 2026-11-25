import { scanProject } from '../project/projectServer';
import { readMetadataSource } from './projectMetadata';
import { parseDefaultsSource } from '../../../vendor/stacki/shared/properties/componentDefaults';
import { starterDefaults } from '../../../vendor/stacki/shared/properties/componentStarterDefaults';

export async function loadInsertionDefaults(root: string) {
  const [project, stored] = await Promise.all([scanProject(root), readMetadataSource(root, 'components')]);
  const catalog = project.components.map((component) => ({
    file: component.file,
    name: component.name,
    props: component.fields.map((field) => field.name),
    slots: component.slots,
    slotText: component.slotText,
  }));
  if (stored.source === undefined) {
    return { config: starterDefaults(catalog), catalog, imports: project.components };
  }
  const parsed = parseDefaultsSource(stored.source);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return { config: parsed.value, catalog, imports: project.components };
}
