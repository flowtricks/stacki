import { parseDefaultsSource, type ComponentDefaults, type DefaultComponent, type DefaultsSnapshot } from '../../../shared/properties/componentDefaults';
import { defaultAssetUses } from '../../../shared/properties/componentDefaultValues';
import { resolveAssetImport } from '../../ipc/assetBridge';
import { starterDefaults } from '../../../shared/properties/componentStarterDefaults';
import { scanProject } from '../../ipc/bridge';
import { readMetadata, writeMetadata } from '../../ipc/projectMetadataBridge';

export interface DefaultsHost {
  readonly load: () => Promise<DefaultsSnapshot>;
  readonly save: (snapshot: DefaultsSnapshot) => Promise<DefaultsSnapshot>;
}

export function desktopDefaultsHost(projectPath: string): DefaultsHost {
  return {
    load: async () => {
      const [project, stored] = await Promise.all([scanProject(projectPath), readMetadata(projectPath, 'components')]);
      const catalog: readonly DefaultComponent[] = [...project.components, ...project.layouts].map((component) => ({
        file: relativeComponentPath(projectPath, component.path),
        ...(component.origin?.kind === 'package' ? { importPath: component.origin.importPath } : {}),
        name: component.name,
        props: (component.schema ?? []).map((field) => field.name),
        slots: component.slots ?? [],
        slotText: component.slotText ?? false,
        ...(component.setHtml === true ? { setHtml: true } : {}),
        ...(component.htmlProps === undefined ? {} : { htmlProps: component.htmlProps }),
      }));
      const snapshot = defaultsSnapshot(stored.source, catalog);
      return { ...snapshot, missingAssets: await missingAssetFiles(projectPath, snapshot.config) };
    },
    save: async (snapshot) => {
      const result = await writeMetadata(projectPath, {
        kind: 'components',
        source: JSON.stringify(snapshot.config, undefined, 2) + '\n',
        ...(snapshot.source === undefined ? {} : { base: snapshot.source }),
      });
      return defaultsSnapshot(result.source, snapshot.catalog);
    },
  };
}

/** The asset defaults of `config` whose file is not in the project (deleted, or moved by hand). */
export async function missingAssetFiles(projectPath: string, config: ComponentDefaults): Promise<readonly string[]> {
  const files = [...new Set(defaultAssetUses(config).map((use) => use.file))];
  const found = await Promise.all(files.map((file) => assetFileExists(projectPath, file)));
  return files.filter((_, index) => found[index] !== true);
}

/** A project file's import from the root resolves only while the file is there. */
export async function assetFileExists(projectPath: string, file: string): Promise<boolean> {
  return (await resolveAssetImport(projectPath, `${projectPath}/${file}`, `/${file}`)).ok;
}

export function defaultsSnapshot(source: string | undefined, catalog: readonly DefaultComponent[]): DefaultsSnapshot {
  if (source === undefined) {
    return { catalog, config: starterDefaults(catalog) };
  }
  const parsed = parseDefaultsSource(source);
  if (!parsed.ok) {
    throw new Error(`.stacki/components.json: ${parsed.error.message}`);
  }
  return { catalog, config: parsed.value, source };
}

export function relativeComponentPath(projectPath: string, file: string): string {
  const root = projectPath.replaceAll('\\', '/').replace(/\/$/, '') + '/';
  const normalized = file.replaceAll('\\', '/');
  if (!normalized.startsWith(root)) {
    throw new Error('Component is outside this project');
  }
  return normalized.slice(root.length);
}
