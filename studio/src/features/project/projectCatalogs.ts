import { readWorkspaceId } from './projectIdentity';
import path from 'node:path';
import { ComponentAnalysis } from './componentAnalysis';
import type { ViteDevServer } from 'vite';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { CoalescedRead } from '../../shared/coalescedRead';
import { assetCatalog } from '../assets/assetCatalog';
import { scanProject } from './projectServer';
import { valueSampler } from './valueSampler';

export function projectCatalogs(server: ViteDevServer, root: string) {
  const analysis = new ComponentAnalysis();
  const project = catalogRead('project-scan', () => scanProject(root, analysis));
  const assets = catalogRead('asset-scan', () => assetCatalog(root));
  const invalidate = () => {
    project.invalidate();
    assets.invalidate();
  };
  const changed = (_event: string, file: string) => {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (/^(src|public|\.stacki)(\/|$)/.test(relative)) {
      invalidate();
    }
  };
  server.watcher.on('all', changed);
  server.httpServer?.once('close', () => server.watcher.off('all', changed));
  return {
    // What a page's calls to its imports return, for the binding picker.
    values: valueSampler(server, root),
    project: async () => {
      const cached = await project.read();
      return { ...cached, value: { ...cached.value, workspaceId: await readWorkspaceId(root) } };
    },
    assets: assets.read,
    invalidate,
  };
}

function catalogRead<T>(name: string, read: () => Promise<T>) {
  let sequence = 0;
  return new CoalescedRead(async () => {
    assert(sequence < Number.MAX_SAFE_INTEGER, 'Catalog scan identifiers remain safe integers');
    const identifier = ++sequence;
    const started = performance.now();
    const value = await read();
    const duration = performance.now() - started;
    assert(duration >= 0, 'Catalog duration uses one monotonic server clock');
    // Server-Timing reports server work separately from browser elapsed time.
    // Shared identifiers also let tests detect duplicate scans across editors.
    return { value, timing: `${name};dur=${duration.toFixed(1)};desc="${identifier}"` };
  });
}
