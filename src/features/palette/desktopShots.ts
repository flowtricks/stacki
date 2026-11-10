import { parseComponentShotEntries, parseComponentShotImage } from '../../../shared/properties/componentShots';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { record } from '../../../shared/core/boundary';
import type { ComponentShotSource } from './componentShotSource';

// The desktop app's photographs of components, as the insert palette sees them. Every result is
// parsed here, so the palette never holds anything the main process merely claimed.

/** Undefined where there is no main process to ask. */
export function desktopComponentShots(projectPath: string): ComponentShotSource | undefined {
  if (typeof window === 'undefined' || !('avb' in window) || typeof window.avb.listComponentShots !== 'function') {
    return undefined;
  }
  return {
    list: async () => {
      const payload = parseIpcPayload('componentShots:list', projectPath);
      const result = record(await window.avb.listComponentShots(payload));
      return parseComponentShotEntries(result['shots']);
    },
    read: async (component) => {
      const payload = parseIpcPayload('componentShots:read', { projectPath, component });
      return parseComponentShotImage(await window.avb.readComponentShot(payload));
    },
    onChanged: (listener) => window.avb.onComponentShotsChanged(listener),
  };
}
