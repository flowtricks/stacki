// What the editor does when `.stacki/apps/` changes (shared/properties/appFolders.ts):
// the Installed list and the app commands read the apps again at once, and each
// running app whose folder moved acts on what its folder reads as once it settled.
// AppsHost mounts this once, so it works whichever panel is open, in Desktop and
// in Studio.
//
// An AI agent writing an app's folder leaves it briefly broken between files (a
// manifest half written, a file the manifest names not there yet). A running app
// must never close for that, so a running app acts only on a settled folder: the
// notices are waited out for `settleMs`, the folder is read, and a read that a
// newer notice overtook is dropped for the next one. Then each running app:
// - valid: reloads in place, once, on its new files and summary (same window, mode,
//   size and panel; a version bump included);
// - broken: keeps its last good version running and shows the reason in its window
//   (AppWindows.tsx), until the folder reads as valid again;
// - gone (its folder deleted): closes.
import { useEffect } from 'react';
import { assert } from '../../../shared/core/assert';
import type { AppSummary } from '../../../shared/properties/apps';
import type { MessageRef } from '../../../shared/core/i18n/messageReference';
import type { Translator } from '../../../shared/properties/i18n/messageRef';
import { APP_FOLDER_LIMITS, joinBrokenRows, type AppFolderBroken } from '../../../shared/properties/appFolders';
import { listInstalledAppList } from '../../ipc/appsBridge';
import { listBrokenAppFolders, onAppFoldersChanged } from '../../ipc/appFoldersBridge';
import { bumpAppFileRevisions } from './appFileRevisions';
import { bumpAppsRefresh } from './appsRefresh';
import { runningApps, settleRunningApp, stopApp } from './appsRuntime';

export function useAppFolderChanges(projectPath: string): void {
  useEffect(() => {
    const settler = createAppFolderSettler({
      settleMs: APP_FOLDER_LIMITS.settleMs,
      schedule: (delayMs, run) => {
        const timer = setTimeout(run, delayMs);
        return () => clearTimeout(timer);
      },
      running: () => runningApps().map((running) => running.app.manifest.id),
      read: () => readAppFolders(projectPath),
      apply: applySettledAppFolders,
    });
    const stop = onAppFoldersChanged(projectPath, (change) => {
      // The lists follow every notice; only running apps wait for the folder to settle.
      bumpAppsRefresh();
      settler.heard(change.folders);
    });
    return () => {
      settler.close();
      stop();
    };
  }, [projectPath]);
}

/** What `.stacki/apps/` reads as: the apps, and the folders that do not read as one. */
export interface AppFolderReading {
  readonly apps: readonly AppSummary[];
  readonly broken: readonly AppFolderBroken[];
}

/** What a running app whose folder changed does once the folder settled. */
export type SettledAppFolder =
  | { readonly kind: 'valid'; readonly app: AppSummary }
  | { readonly kind: 'broken'; readonly appId: string; readonly message: string; readonly messageRef?: MessageRef | undefined }
  | { readonly kind: 'removed'; readonly appId: string };

export interface AppFolderSettlerDeps {
  readonly settleMs: number;
  /** Runs `run` after `delayMs`; returns the cancel. Tests pass a fake clock. */
  readonly schedule: (delayMs: number, run: () => void) => () => void;
  /** The ids of the apps running now. */
  readonly running: () => readonly string[];
  /** The folder now; undefined when it cannot be read (the next notice reads it again). */
  readonly read: () => Promise<AppFolderReading | undefined>;
  /** Acts on one settled reading: called at most once per settle, never with an empty list. */
  readonly apply: (settled: readonly SettledAppFolder[]) => void;
}

/**
 * The debounce `useAppFolderChanges` runs, apart from React and the host, for tests.
 * `heard` takes each notice's folders; once none came for `settleMs`, the folder is
 * read and the running apps among them are settled together.
 */
export function createAppFolderSettler(deps: AppFolderSettlerDeps): { readonly heard: (folders: readonly string[]) => void; readonly close: () => void } {
  assert(deps.settleMs > 0, 'Settling waits a while');
  let pending = new Set<string>();
  let cancel: (() => void) | undefined;
  // Moves with every notice, so a read that a newer notice overtook is known as stale.
  let generation = 0;
  let closed = false;
  const settle = (): void => {
    cancel = undefined;
    const taken = pending;
    pending = new Set();
    if (!deps.running().some((id) => taken.has(id))) {
      return; // No running app's folder moved: the lists already refreshed.
    }
    const started = generation;
    void deps.read().then(
      (reading) => {
        if (closed) {
          return;
        }
        if (generation !== started) {
          // The folder moved again while it was read: the settle already scheduled acts for these too.
          for (const folder of taken) {
            pending.add(folder);
          }
          return;
        }
        if (reading === undefined) {
          return;
        }
        const affected = deps.running().filter((id) => taken.has(id));
        if (affected.length > 0) {
          deps.apply(settledAppFolders(affected, reading));
        }
      },
      () => undefined, // A folder that cannot be read now is read again on the next notice.
    );
  };
  return {
    heard: (folders) => {
      if (closed) {
        return;
      }
      generation += 1;
      for (const folder of folders) {
        pending.add(folder);
      }
      // A folder is named once however often it moves: bounded by the folders a project can hold.
      assert(pending.size <= APP_FOLDER_LIMITS.entriesMax * 2, 'Pending folders are bounded');
      cancel?.();
      cancel = deps.schedule(deps.settleMs, settle);
    },
    close: () => {
      closed = true;
      cancel?.();
      cancel = undefined;
    },
  };
}

/**
 * Each running app whose folder changed, as its settled folder reads: valid with its
 * summary, broken with the reason, or removed when neither lists it (the folder is
 * gone). Pure, for its test.
 */
export function settledAppFolders(affected: readonly string[], reading: AppFolderReading): readonly SettledAppFolder[] {
  const apps = new Map(reading.apps.map((app) => [app.manifest.id, app]));
  const broken = new Map(reading.broken.map((row) => [row.folder, row]));
  const settled = affected.map((appId): SettledAppFolder => {
    const app = apps.get(appId);
    if (app !== undefined) {
      return { kind: 'valid', app };
    }
    const row = broken.get(appId);
    if (row !== undefined) {
      return { kind: 'broken', appId, message: row.message, ...(row.messageRef === undefined ? {} : { messageRef: row.messageRef }) };
    }
    return { kind: 'removed', appId };
  });
  assert(settled.length === affected.length, 'Every affected app settles one way');
  return settled;
}

/** The sentence a broken app's window shows over its last good version. */
export function appFolderErrorNotice(message: string, translate: Translator): string {
  const reason = message.trim().replace(/[.。]+$/, '');
  assert(reason.length > 0, 'A broken folder says why');
  return translate('apps.folder.errorNotice', { reason });
}

// Valid apps take their new summary and reload once together; broken ones keep running and say why; removed ones close.
function applySettledAppFolders(settled: readonly SettledAppFolder[]): void {
  assert(settled.length > 0, 'A settle acts on at least one app');
  const reload: string[] = [];
  for (const folder of settled) {
    switch (folder.kind) {
      case 'valid':
        if (settleRunningApp(folder.app.manifest.id, { kind: 'valid', app: folder.app })) {
          reload.push(folder.app.manifest.id);
        }
        break;
      case 'broken':
        settleRunningApp(folder.appId, { kind: 'broken', message: folder.message, messageRef: folder.messageRef });
        break;
      case 'removed':
        stopApp(folder.appId);
        break;
      default: {
        const exhaustive: never = folder;
        return exhaustive;
      }
    }
  }
  if (reload.length > 0) {
    bumpAppFileRevisions(reload);
  }
}

async function readAppFolders(projectPath: string): Promise<AppFolderReading | undefined> {
  const [apps, broken] = await Promise.all([listInstalledAppList(projectPath), listBrokenAppFolders(projectPath)]);
  // Either list unread, the folder is unknown: closing on it could close an app whose folder is fine.
  if (!apps.ok) {
    return undefined;
  }
  if (!broken.ok) {
    return undefined;
  }
  // An app this editor cannot read is broken here as its folder is: a running copy keeps its last version and says why.
  return { apps: apps.value.apps, broken: joinBrokenRows(broken.value, apps.value.broken) };
}
