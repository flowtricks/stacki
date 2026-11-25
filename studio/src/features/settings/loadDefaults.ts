import { stat } from 'node:fs/promises';
import { listedPath, scanProject } from '../project/projectServer';
import { defaultAssetUses } from '../../../vendor/stacki/shared/properties/componentDefaultValues';
import { readMetadataSource } from './projectMetadata';
import { parseDefaultsSource, type ComponentDefaults } from '../../../vendor/stacki/shared/properties/componentDefaults';
import { starterDefaults } from '../../../vendor/stacki/shared/properties/componentStarterDefaults';

/** The asset defaults whose file is not in the project. */
async function missingAssetFiles(root: string, config: ComponentDefaults): Promise<readonly string[]> {
  const files = [...new Set(defaultAssetUses(config).map((use) => use.file))];
  const found = await Promise.all(
    files.map((file) =>
      listedPath(root, file)
        .then((absolute) => stat(absolute))
        .then((info) => info.isFile())
        .catch(() => false),
    ),
  );
  return files.filter((_, index) => found[index] !== true);
}

export async function loadInsertionDefaults(root: string) {
  const [project, stored] = await Promise.all([scanProject(root), readMetadataSource(root, 'components')]);
  const catalog = project.components.map((component) => ({
    file: component.file,
    name: component.name,
    props: component.fields.map((field) => field.name),
    slots: component.slots,
    slotText: component.slotText,
    ...(component.setHtml === true ? { setHtml: true } : {}),
    ...(component.htmlProps === undefined ? {} : { htmlProps: component.htmlProps }),
  }));
  if (stored.source === undefined) {
    return { config: starterDefaults(catalog), catalog, imports: project.components };
  }
  const parsed = parseDefaultsSource(stored.source);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return { config: parsed.value, catalog, imports: project.components, missingAssets: await missingAssetFiles(root, parsed.value) };
}
