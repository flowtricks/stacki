// Starts Node's on-disk compile cache for the main process's own modules (the ~300 files and
// `typescript`, a 9 MB one, that main.ts pulls in before the app is ready). V8 then loads their
// compiled form from disk instead of parsing and compiling them on every launch.
//
// This module must be the first import of main.ts: only modules required after it are cached.
// The cache is keyed by each file's content, so a changed file is compiled afresh and a stale
// entry cannot run. A directory that cannot be written costs nothing: Node reports a status and
// carries on uncached, which is why the result is read and not thrown on.
import * as path from 'path';
import * as nodeModule from 'module';
import { app } from 'electron';

// @types/node 20 does not declare `enableCompileCache` (Node 22.1 added it), so it is looked up by
// name and checked, rather than asserted: a runtime without it simply starts uncached.
const enable: unknown = Reflect.get(nodeModule, 'enableCompileCache');
if (typeof enable === 'function') {
  try {
    Reflect.apply(enable, nodeModule, [path.join(app.getPath('userData'), 'compile-cache')]);
  } catch (error: unknown) {
    console.debug('[startup] the compile cache could not start:', error instanceof Error ? error.message : String(error));
  }
}
