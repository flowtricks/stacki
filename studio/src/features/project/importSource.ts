// The source of a module a page imports, for the binding picker to read the
// values it exports (vendor src/editor/importedValues.ts). The import is
// resolved the way the page's own bundle resolves it, through the dev server's
// resolver, so `@/consts.ts` and an extensionless `../data/site` both land on
// the project file. Nothing is run: the text is read and returned. Only a
// script or JSON module under src/ is answered, never a package. The desktop
// app answers the same question over IPC (src:readSymbol).

import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { ViteDevServer } from 'vite';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { IMPORTED_VALUE_LIMITS } from '../../../vendor/stacki/src/editor/importedValues';

const SCRIPT_MODULE = /\.(?:[cm]?[jt]s|json)$/i;

export interface ImportSourceRequest {
  /** The page or component, project-relative, doing the importing. */
  readonly file: string;
  /** The import as the file writes it: `@/consts.ts`. */
  readonly spec: string;
}

export function importSource(server: ViteDevServer, root: string) {
  const source = path.resolve(root, 'src');
  return async (request: ImportSourceRequest): Promise<{ readonly file: string; readonly text: string }> => {
    const importer = path.resolve(root, request.file);
    if (!importer.startsWith(source + path.sep)) {
      throw new Error('Only a file under src/ has imports to read');
    }
    const resolved = await server.pluginContainer.resolveId(request.spec, importer, { ssr: true });
    const id = resolved?.id.split('?')[0];
    if (id === undefined || !path.resolve(id).startsWith(source + path.sep)) {
      throw new Error('Only a project module under src/ is read');
    }
    if (!SCRIPT_MODULE.test(id)) {
      throw new Error('Only a script or JSON module holds values to read');
    }
    const size = (await stat(id)).size;
    if (size > IMPORTED_VALUE_LIMITS.moduleCharsMax) {
      throw new Error('The module is too large to read for values');
    }
    const text = await readFile(id, 'utf8');
    const file = path.relative(root, id).split(path.sep).join('/');
    assert(!file.startsWith('..'), 'importSource: the module is inside the project');
    return { file, text };
  };
}
