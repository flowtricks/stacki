// The component editing settings of the open project (.stacki/components.json: lineBreaks, richText), read once and
// again after every metadata write the app makes and every project scan, so a switch turned in the defaults editor
// reaches the canvas and the Properties panel at once. A file that cannot be read leaves every setting off: today's
// editing, never a wrong one.
import { useEffect, useRef, useState } from 'react';
import { onMetadataWrite, readMetadata } from '../../ipc/projectMetadataBridge';
import {
  effectiveEditing,
  parseDefaultsSource,
  type ComponentDefaults,
  type EditingField,
  type EditingSettings,
} from '../../../shared/properties/componentDefaults';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import { assert } from '../../../shared/core/assert';

/** The settings of one field (a prop, or `slot:<name>`) of the component at an absolute path. */
export type ComponentEditingLookup = (componentPath: string | undefined, field: EditingField) => EditingSettings;

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
  // A rescan hands over a new list of the same components, and the canvas restarts its text catalog (closing an editor
  // being typed in) whenever this lookup changes: it changes only when what it answers changes.
  const key = JSON.stringify([
    projectPath,
    config,
    components.map((entry) => [entry.path, entry.file, entry.slots, entry.slotText, entry.setHtml, entry.htmlProps]),
  ]);
  const kept = useRef<{ readonly key: string; readonly lookup: ComponentEditingLookup }>();
  if (kept.current?.key !== key) {
    kept.current = { key, lookup: editingLookup(projectPath, components, config) };
  }
  return kept.current.lookup;
}

/** The settings that apply to the component at an absolute path, as the panel and the canvas catalog read them. */
export function editingLookup(
  projectPath: string | undefined,
  components: readonly ScanComponent[],
  config: ComponentDefaults | undefined,
): ComponentEditingLookup {
  const root = (projectPath ?? '').replaceAll('\\', '/').replace(/\/$/, '') + '/';
  return (componentPath, field) => {
    if (config === undefined || componentPath === undefined) {
      return {};
    }
    const normalized = componentPath.replaceAll('\\', '/');
    const component = components.find((entry) => entry.path.replaceAll('\\', '/') === normalized);
    // The scan's own project-relative name first: a project under a symbolic link (macOS /var is /private/var) scans
    // to paths that do not start with the folder the project was opened as.
    const file = component?.file ?? (normalized.startsWith(root) ? normalized.slice(root.length) : undefined);
    if (component === undefined || file === undefined) {
      return {};
    }
    assert(!file.startsWith('/'), 'A component file is project relative');
    return effectiveEditing(
      config,
      {
        file,
        name: component.name,
        props: [],
        slots: component.slots ?? [],
        slotText: component.slotText ?? false,
        setHtml: component.setHtml === true,
        ...(component.htmlProps === undefined ? {} : { htmlProps: component.htmlProps }),
      },
      field,
    );
  };
}
