import { getStudioRole } from '../roles/roleStore';
import { can } from '../../../vendor/stacki/shared/properties/projectRoles';
import {
  parseDefaultsSource,
  type ComponentDefaults,
  type DefaultsSnapshot,
  type DefaultComponent,
} from '../../../vendor/stacki/shared/properties/componentDefaults';
import { defaultAssetUses } from '../../../vendor/stacki/shared/properties/componentDefaultValues';
import { starterDefaults } from '../../../vendor/stacki/shared/properties/componentStarterDefaults';
import { loadProject } from '../project/projectClient';
import { readMetadata, writeMetadata } from './metadataClient';
export interface DefaultsHost {
  readonly load: () => Promise<DefaultsSnapshot>;
  readonly save: (snapshot: DefaultsSnapshot) => Promise<DefaultsSnapshot>;
}

// The project scan lists these kinds of file under names Studio can open; one it would list and does not is gone.
function missingAssets(config: ComponentDefaults, assets: readonly string[]): readonly string[] {
  const present = new Set(assets);
  const listed = (file: string) => /\.(svg|png|jpe?g|gif|webp|avif|mp4)$/i.test(file) && /^src\/[\w./ \[\]-]+$/.test(file);
  return [...new Set(defaultAssetUses(config).map((use) => use.file))].filter((file) => listed(file) && !present.has(file));
}

export const studioDefaultsHost = {
  load: async (): Promise<DefaultsSnapshot> => {
    const [project, stored] = await Promise.all([loadProject(), readMetadata('', 'components')]);
    const catalog: readonly DefaultComponent[] = project.components.map((component) => ({
      file: component.file,
      ...(component.importPath === undefined ? {} : { importPath: component.importPath }),
      name: component.name,
      props: component.fields.map((field) => field.name),
      slots: component.slots,
      slotText: component.slotText ?? false,
      ...(component.setHtml === true ? { setHtml: true } : {}),
      ...(component.htmlProps === undefined ? {} : { htmlProps: component.htmlProps }),
    }));
    if (stored.source === undefined) {
      return { catalog, config: starterDefaults(catalog) };
    }
    const parsed = parseDefaultsSource(stored.source);
    if (!parsed.ok) {
      throw new Error(parsed.error.message);
    }
    return { source: stored.source, config: parsed.value, catalog, missingAssets: missingAssets(parsed.value, project.assets) };
  },
  save: async (snapshot: DefaultsSnapshot): Promise<DefaultsSnapshot> => {
    if (!can(getStudioRole(), 'component:edit')) {
      throw new Error('Component defaults are only editable by a role that can edit components.');
    }
    const stored = await writeMetadata('', {
      kind: 'components',
      source: JSON.stringify(snapshot.config, undefined, 2) + '\n',
      ...(snapshot.source === undefined ? {} : { base: snapshot.source }),
    });
    return { ...snapshot, ...stored };
  },
};
