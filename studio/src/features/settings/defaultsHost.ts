import { getEditorRole } from '../roles/roleStore';
import {
  parseDefaultsSource,
  type DefaultsSnapshot,
  type DefaultComponent,
} from '../../../vendor/stacki/shared/properties/componentDefaults';
import { starterDefaults } from '../../../vendor/stacki/shared/properties/componentStarterDefaults';
import { loadProject } from '../project/projectClient';
import { readMetadata, writeMetadata } from './metadataClient';
export interface DefaultsHost {
  readonly load: () => Promise<DefaultsSnapshot>;
  readonly save: (snapshot: DefaultsSnapshot) => Promise<DefaultsSnapshot>;
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
    }));
    if (stored.source === undefined) {
      return { catalog, config: starterDefaults(catalog) };
    }
    const parsed = parseDefaultsSource(stored.source);
    if (!parsed.ok) {
      throw new Error(parsed.error.message);
    }
    return { source: stored.source, config: parsed.value, catalog };
  },
  save: async (snapshot: DefaultsSnapshot): Promise<DefaultsSnapshot> => {
    if (getEditorRole() === 'client') {
      throw new Error('Component defaults are only editable in Developer mode.');
    }
    const stored = await writeMetadata('', {
      kind: 'components',
      source: JSON.stringify(snapshot.config, undefined, 2) + '\n',
      ...(snapshot.source === undefined ? {} : { base: snapshot.source }),
    });
    return { ...snapshot, ...stored };
  },
};
