// The component editing settings of the open project (.stacki/components.json: lineBreaks, richText), read once and
// again after every metadata write the app makes and every project scan, so a switch turned in the defaults editor
// reaches the canvas and the Properties panel at once. A file that cannot be read leaves every setting off: today's
// editing, never a wrong one.
import { useEffect, useMemo, useState } from 'react';
import { onMetadataWrite, readMetadata } from '../../ipc/projectMetadataBridge';
import { effectiveEditing, parseDefaultsSource, type ComponentDefaults, type EditingSettings } from '../../../shared/properties/componentDefaults';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import { assert } from '../../../shared/core/assert';

export type ComponentEditingLookup = (componentPath: string | undefined) => EditingSettings;

export function useComponentEditing(projectPath: string | undefined, components: readonly ScanComponent[]): ComponentEditingLookup {
  const [config, setConfig] = useState<ComponentDefaults>();
  useEffect(() => {
    if (projectPath === undefined || projectPath === '') {
      setConfig(undefined);
      return;
    }
    let live = true;
    const read = () =>
      void readMetadata(projectPath, 'components')
        .then((stored) => {
          const parsed = stored.source === undefined ? undefined : parseDefaultsSource(stored.source);
          if (live) {
            setConfig(parsed?.ok === true ? parsed.value : undefined);
          }
        })
        .catch((error: unknown) => console.warn('Could not read component editing settings:', error));
    read();
    const stop = onMetadataWrite(read);
    return () => {
      live = false;
      stop();
    };
  }, [projectPath, components]);
  return useMemo(() => editingLookup(projectPath, components, config), [projectPath, components, config]);
}

/** The settings that apply to the component at an absolute path, as the panel and the canvas catalog read them. */
export function editingLookup(
  projectPath: string | undefined,
  components: readonly ScanComponent[],
  config: ComponentDefaults | undefined,
): ComponentEditingLookup {
  const root = (projectPath ?? '').replaceAll('\\', '/').replace(/\/$/, '') + '/';
  return (componentPath) => {
    if (config === undefined || componentPath === undefined) {
      return {};
    }
    const normalized = componentPath.replaceAll('\\', '/');
    const component = components.find((entry) => entry.path.replaceAll('\\', '/') === normalized);
    if (component === undefined || !normalized.startsWith(root)) {
      return {};
    }
    const file = normalized.slice(root.length);
    assert(!file.startsWith('/'), 'A component file is project relative');
    return effectiveEditing(config, {
      file,
      name: component.name,
      props: [],
      slots: component.slots ?? [],
      slotText: component.slotText ?? false,
      setHtml: component.setHtml === true,
    });
  };
}
