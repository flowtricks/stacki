// The Files panel's IPC (docs/contracts.md, "Files panel"): every channel names the project it acts on, and only the
// project the app has open is accepted. The work is in explorerOps.ts; this module resolves the project, routes the
// replies, announces saved text the way the project watcher announces an outside edit, and keeps the window from
// closing over unsaved editor text.
import * as path from 'node:path';
import { ok } from '../../shared/core/result';
import { explorerRoot, lexicalPath, resolveForRead } from '../project/explorerPaths';
import {
  createEntry,
  findEntries,
  importEntries,
  listFolder,
  readExplorerFile,
  renameEntry,
  transferEntries,
  trashEntries,
  writeExplorerFile,
} from '../project/explorerOps';
import { createExplorerWatch } from '../project/explorerWatch';
import { relinkMovedDefaultAssets } from '../project/componentDefaultRelink';
import type { MainHost } from './mainHost';

export interface FileExplorerOptions {
  /** Closes the window, or quits when a quit was what asked; called once the renderer settled its unsaved text. */
  readonly closeAfterSettle: () => void;
  /** The person chose to stay: a quit that asked is over. */
  readonly keepOpen: () => void;
}

/** What main.ts asks before the window closes or the app quits. */
export interface FileExplorerGuard {
  /** True when the close must wait: the renderer is asked to settle its unsaved text and calls back. */
  readonly holdClose: () => boolean;
  readonly stopWatching: () => void;
}

export function registerFileExplorerHandlers(
  host: Pick<MainHost, 'ipcMain' | 'openProject' | 'send' | 'shell'>,
  options: FileExplorerOptions,
): FileExplorerGuard {
  const { ipcMain, openProject, send, shell } = host;
  const disk = { trash: (absolute: string) => shell.trashItem(absolute) };
  const watch = createExplorerWatch((directories) => send('files:changed', { directories }));
  // Whether the editor holds text not yet on disk, as the renderer last said; a close asks first only then.
  let unsaved = false;
  let asking = false;

  ipcMain.handle('files:list', (_event, { projectPath, path: folder }) => {
    const root = explorerRoot(projectPath, openProject());
    return root.ok ? listFolder(root.value, folder) : root;
  });
  ipcMain.handle('files:read', (_event, { projectPath, path: file }) => {
    const root = explorerRoot(projectPath, openProject());
    return root.ok ? readExplorerFile(root.value, file) : root;
  });
  ipcMain.handle('files:write', (_event, { projectPath, path: file, text, byteOrderMark, base }) => {
    const root = explorerRoot(projectPath, openProject());
    if (!root.ok) {
      return root;
    }
    const written = writeExplorerFile(root.value, { file, text, byteOrderMark, base });
    if (!written.ok) {
      return written;
    }
    announceSaved(send, written.value.real);
    return ok({ checksum: written.value.checksum });
  });
  ipcMain.handle('files:create', (_event, { projectPath, parent, name, kind }) => {
    const root = explorerRoot(projectPath, openProject());
    return root.ok ? createEntry(root.value, parent, name, kind) : root;
  });
  ipcMain.handle('files:rename', (_event, { projectPath, path: source, name }) => {
    const root = explorerRoot(projectPath, openProject());
    if (!root.ok) {
      return root;
    }
    const renamed = renameEntry(root.value, source, name);
    if (renamed.ok) {
      // Component defaults that import the file follow it.
      relinkMovedDefaultAssets(root.value.lexical, [{ from: source, to: renamed.value.path }]);
    }
    return renamed;
  });
  ipcMain.handle('files:transfer', async (_event, { projectPath, paths, target, mode, collision }) => {
    const root = explorerRoot(projectPath, openProject());
    if (!root.ok) {
      return root;
    }
    const transferred = await transferEntries(root.value, { sources: paths, target, mode, collision }, disk);
    if (transferred.ok && mode === 'move') {
      relinkMovedDefaultAssets(root.value.lexical, transferred.value.placed);
    }
    return transferred;
  });
  ipcMain.handle('files:trash', async (_event, { projectPath, paths }) => {
    const root = explorerRoot(projectPath, openProject());
    return root.ok ? trashEntries(root.value, paths, disk) : root;
  });
  ipcMain.handle('files:import', async (_event, { projectPath, sources, target, collision }) => {
    const root = explorerRoot(projectPath, openProject());
    return root.ok ? importEntries(root.value, { sources, target, collision }, disk) : root;
  });
  ipcMain.handle('files:reveal', (_event, { projectPath, path: entry }) => {
    const root = explorerRoot(projectPath, openProject());
    if (!root.ok) {
      return root;
    }
    const resolved = resolveForRead(root.value, entry);
    if (!resolved.ok) {
      return resolved;
    }
    shell.showItemInFolder(entry === '' ? root.value.lexical : lexicalPath(root.value, entry));
    return ok({ shown: true as const });
  });
  ipcMain.handle('files:find', (_event, { projectPath, query }) => {
    const root = explorerRoot(projectPath, openProject());
    return root.ok ? findEntries(root.value, query) : root;
  });
  ipcMain.handle('files:watch', (_event, { projectPath, directories }) => {
    const root = explorerRoot(projectPath, openProject());
    if (!root.ok) {
      watch.close();
      return { watching: 0 };
    }
    return { watching: watch.follow(root.value, directories) };
  });
  ipcMain.handle('files:guardClose', (_event, { unsaved: next }) => {
    unsaved = next;
    return { ok: true as const };
  });
  ipcMain.handle('files:allowClose', (_event, { proceed }) => {
    asking = false;
    if (proceed) {
      unsaved = false;
      options.closeAfterSettle();
    } else {
      options.keepOpen();
    }
    return { ok: true as const };
  });

  return {
    holdClose: () => {
      if (!unsaved) {
        return false;
      }
      if (!asking) {
        asking = true;
        send('files:closeRequested', {});
      }
      return true;
    },
    stopWatching: () => watch.close(),
  };
}

// A save from the panel is, to the canvas and the other panels, an outside edit: the project watcher drops the app's
// own writes, so the same channels it would send are sent here, and the open page, the scan, the style and CMS panels
// refresh as they would for an editor's save.
function announceSaved(send: MainHost['send'], real: string): void {
  const name = path.basename(real).toLowerCase();
  if (/\.(astro|md|mdx|html)$/.test(name)) {
    send('fs:changed', { files: [real] });
  }
  if (/\.css$/.test(name) || /\.astro$/.test(name)) {
    send('css:changed', {});
  }
  if (/\.(json|ya?ml|md|mdx)$/.test(name)) {
    send('cms:changed', {});
  }
}
