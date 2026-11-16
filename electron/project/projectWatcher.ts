import { createAstroFileMonitor } from './astroFileMonitor';
import fs from 'fs';
import path from 'path';
import { PROJECT_FOLDERS_FILE } from '../../shared/properties/projectFolders';
import { watchAppFolders } from './appsWatcher';
import { pagesDirectoryOf } from '../lib/astroConfig';
import { errorCode } from './projectWalk';

interface WatchProjectDeps {
  readonly projectPath: string;
  readonly send: (channel: string, payload: unknown) => void;
  readonly isSelfWrite: (absolutePath: string) => boolean;
  /** An outside change to a source file: the document actors' hint (plan §7). */
  readonly noteExternalChange: (absolutePath: string) => void;
  readonly notePageMayHaveChanged: (changed: boolean) => void;
  readonly scheduleThumb: (projectPath: string, delayMs: number) => void;
  readonly mediaPattern: RegExp;
  readonly watch?: typeof fs.watch;
}

// Both directory watchers and every queued notification belong to one open
// project. Closing it cancels the whole group before another project can hear
// an event or a timer left over from the old one.
function watchProject({
  projectPath,
  send,
  isSelfWrite,
  noteExternalChange,
  notePageMayHaveChanged,
  scheduleThumb,
  mediaPattern,
  watch = fs.watch,
}: WatchProjectDeps): WatchedProject {
  const watchers: fs.FSWatcher[] = [];
  const degraded: UnwatchedFolder[] = [];
  // A folder that cannot be watched (missing, unreadable, or past the system's watcher limit) is
  // reported, not fatal: the project opens and only live reflection of outside edits is lost there.
  const watchFolder = (directory: string, options: fs.WatchOptions, listener: fs.WatchListener<string | Buffer>): fs.FSWatcher | undefined => {
    const armed = armWatcher(watch, directory, options, listener, (code) => degraded.push({ directory, code }));
    if (armed !== undefined) {
      watchers.push(armed);
    }
    return armed;
  };
  const notifier = createNotifier(send);
  const astroFiles = createAstroFileMonitor(projectPath, (astroChanges) => send('fs:changed', { files: [], astroChanges }));
  let appFolders: { readonly close: () => void } | undefined;
  const close = (): void => {
    notifier.close();
    astroFiles.close();
    appFolders?.close();
    for (const watcher of watchers) {
      watcher.close();
    }
  };

  try {
    // The folder Astro reads (`srcDir`), `src` unless astro.config says otherwise.
    const sourceDirectory = path.dirname(pagesDirectoryOf(projectPath));
    watchFolder(sourceDirectory, { recursive: true }, (event, filename) => {
      if (notifier.isClosed()) {
        return;
      }
      if (event === 'rename' || !filename || /\.astro$/i.test(filename.toString())) {
        astroFiles.request();
      }
      if (!filename) {
        // macOS can coalesce a directory change without naming the file.
        // Refresh every source-backed panel rather than losing the edit.
        notePageMayHaveChanged(true);
        notifier.debounce('fs:changed', 150);
        notifier.debounce('css:changed');
        notifier.debounce('cms:changed');
        notifier.debounce('assets:changed');
        return;
      }
      const name = filename.toString();
      const changed = path.join(sourceDirectory, name);
      // Comparing self writes can read the file. Do it once per event, before
      // routing it to the panels interested in that kind of file.
      if (isSelfWrite(changed)) {
        // A save of the open page can change its `<style>` variables, and
        // nothing else tells the Variables panel.
        if (/\.astro$/i.test(name)) {
          notifier.debounce('css:changed');
        }
        return;
      }
      noteExternalChange(changed);
      notePageMayHaveChanged(true);
      const channel = sourceChangeChannel(name, mediaPattern, event);
      if (channel === 'fs:changed') {
        notifier.addFile(changed);
        scheduleThumb(projectPath, 60000);
        notifier.debounce(channel, 150);
        // `<style>` blocks declare variables, so a page is a stylesheet too.
        if (/\.astro$/i.test(name)) {
          notifier.debounce('css:changed');
        }
      } else if (channel !== undefined) {
        notifier.debounce(channel);
      }
    });

    watchPublicFiles({ projectPath, isSelfWrite, watchFolder }, notifier);
    watchFolderSettings({ projectPath, watchFolder }, notifier);
    // `.stacki/apps/`: the Installed list follows the folder (appsWatcher.ts).
    appFolders = watchAppFolders({ projectPath, send, watch });
  } catch (error: unknown) {
    close();
    throw error;
  }
  // Catch files created while the operating system is still arming its watcher.
  astroFiles.request();
  return { close, degraded };
}

/** A folder whose changes are not being followed, and the system error code that said why. */
export interface UnwatchedFolder {
  readonly directory: string;
  readonly code: string;
}

export interface WatchedProject {
  readonly close: () => void;
  readonly degraded: readonly UnwatchedFolder[];
}

// Starts one watcher. Creation can throw (ENOENT, EACCES, ENOSPC, EMFILE) and a running watcher
// emits `error` when its folder is removed or the system runs out of handles; an unhandled
// `error` event is an uncaught exception in the main process, so both end in `onFailure`.
function armWatcher(
  watch: typeof fs.watch,
  directory: string,
  options: fs.WatchOptions,
  listener: fs.WatchListener<string | Buffer>,
  onFailure: (code: string) => void,
): fs.FSWatcher | undefined {
  try {
    const watcher = watch(directory, options, listener);
    watcher.on('error', (error: unknown) => {
      onFailure(errorCode(error));
      watcher.close();
    });
    return watcher;
  } catch (error: unknown) {
    onFailure(errorCode(error));
    return undefined;
  }
}

type ChangeChannel = 'cms:changed' | 'assets:changed' | 'css:changed' | 'fs:changed';

// The panel a changed file under src/ concerns, or undefined when none does.
function sourceChangeChannel(name: string, mediaPattern: RegExp, event: string): ChangeChannel | undefined {
  if (/\.json$/i.test(name)) {
    return 'cms:changed';
  }
  if (mediaPattern.test(name)) {
    return 'assets:changed';
  }
  if (/\.css$/i.test(name)) {
    return 'css:changed';
  }
  if (/\.(astro|md|mdx|html)$/i.test(name)) {
    return 'fs:changed';
  }
  // Directory creation/removal has no extension but still changes the Pages tree.
  return event === 'rename' ? 'fs:changed' : undefined;
}

interface Notifier {
  readonly debounce: (channel: ChangeChannel, delayMs?: number) => void;
  readonly addFile: (file: string) => void;
  readonly isClosed: () => boolean;
  readonly close: () => void;
}

// One timer per channel, so a burst of events sends each channel once. The
// changed page files ride along with `fs:changed` and are cleared as it goes.
function createNotifier(send: WatchProjectDeps['send']): Notifier {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const files = new Set<string>();
  let closed = false;
  const debounce = (channel: ChangeChannel, delayMs = 200): void => {
    clearTimeout(timers.get(channel));
    timers.set(
      channel,
      setTimeout(() => {
        timers.delete(channel);
        if (closed) {
          return;
        }
        const payload = channel === 'fs:changed' ? { files: [...files] } : {};
        if (channel === 'fs:changed') {
          files.clear();
        }
        send(channel, payload);
      }, delayMs),
    );
  };
  const close = (): void => {
    closed = true;
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    files.clear();
  };
  return { debounce, addFile: (file) => files.add(file), isClosed: () => closed, close };
}

export { watchProject };

type FolderWatcher = (directory: string, options: fs.WatchOptions, listener: fs.WatchListener<string | Buffer>) => fs.FSWatcher | undefined;

function watchPublicFiles(
  { projectPath, isSelfWrite, watchFolder }: Pick<WatchProjectDeps, 'projectPath' | 'isSelfWrite'> & { readonly watchFolder: FolderWatcher },
  notifier: Notifier,
): void {
  const publicDirectory = path.join(projectPath, 'public');
  if (!fs.existsSync(publicDirectory)) {
    return;
  }
  watchFolder(publicDirectory, { recursive: true }, (_event, filename) => {
    if (notifier.isClosed() || (filename && String(filename).startsWith('.'))) {
      return;
    }
    if (filename && isSelfWrite(path.join(publicDirectory, filename.toString()))) {
      return;
    }
    notifier.debounce('assets:changed');
  });
}

// `.stacki/folders.json` decides which folders the components, layouts, assets
// and style panels read, so any change to it, an outside edit or Git checkout
// included, refreshes all of them. Self writes are not skipped: the Folders tab
// saving is exactly the change the panels must show. A project without `.stacki`
// yet is watched from its first save, which announces itself
// (projectMetadataHandlers.ts) and the next watch:start arms this.
function watchFolderSettings(
  { projectPath, watchFolder }: Pick<WatchProjectDeps, 'projectPath'> & { readonly watchFolder: FolderWatcher },
  notifier: Notifier,
): void {
  const directory = path.join(projectPath, '.stacki');
  if (!fs.existsSync(directory)) {
    return;
  }
  const name = path.basename(PROJECT_FOLDERS_FILE);
  watchFolder(directory, { recursive: false }, (_event, filename) => {
    if (notifier.isClosed()) {
      return;
    }
    if (filename && String(filename) !== name) {
      return;
    }
    notifier.debounce('fs:changed', 150);
    notifier.debounce('assets:changed');
    notifier.debounce('css:changed');
  });
}
