// Desktop's side of "Upgrade Studio" in Settings: find the newest published release, note which files the
// project had changed, and replace the Studio folder with the same transactional updater `astro-studio update`
// uses (studioInstall.ts: stage, install, check, build, then swap). The whole previous folder is kept under
// `.stacki/studio/updates`, so a project's own changes never block the upgrade: they are backed up, counted, and
// can be put back with one restore. `npm create stacki@latest` is not that updater: it leaves an installed Studio
// alone, so the box never runs it. The pure rules live in shared/ipc/studioUpgrade.ts; this file reads the disk
// and the release feed.
import { createHash } from 'node:crypto';
import { lstat, open, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import type { StudioRelease } from '../../shared/ipc/studioRelease';
import { retainedPath } from '../../shared/ipc/studioRelease';
import type { StudioInstallUpdate } from '../../shared/ipc/studioProgress';
import {
  STUDIO_GENERATED_ROOTS,
  STUDIO_UPGRADE_LIMITS,
  STUDIO_UPGRADE_MANIFEST,
  decideUpgrade,
  detectChangedFiles,
  parseStudioUpgradeManifest,
  type StudioChangedFiles,
  type StudioRestoreResult,
  type StudioUpgradeCheck,
  type StudioUpgradeManifest,
  type StudioUpgradeNote,
  type StudioUpgradeResult,
} from '../../shared/ipc/studioUpgrade';
import { STUDIO_UPDATES_DIRECTORY } from '../../shared/properties/studioLocal';
import { translateMain } from '../lib/mainLocale';
import { errorMessage } from '../lib/mainHelpers';
import { downloadRelease, latestRelease } from './studioCatalog';
import { installRelease, restoreBackup } from './studioInstall';
import { studioStatus, validateStudio } from './studioSetup';

// One file is never larger than a release file may be (studioRelease.ts allows 2,000,000 characters).
const FILE_BYTES_MAX = 2_000_000;
const MANIFEST_BYTES_MAX = 100_000;

/** The newest published Studio version, or undefined when the feed cannot be reached or has none: offline is quiet, never an error. */
export async function latestStudioVersion(): Promise<string | undefined> {
  try {
    return (await latestRelease())?.version;
  } catch {
    return undefined;
  }
}

/** Line endings are normalised so a checkout that rewrote them (autocrlf) does not look like an edit. */
export function contentDigest(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex');
}

export function releaseDigests(release: StudioRelease): Map<string, string> {
  assert(release.files.length > 0, 'A release always carries files');
  return new Map(release.files.map((file) => [file.path, contentDigest(file.content)]));
}

/**
 * A digest for every file of a Studio folder, skipping what an upgrade never compares (retained and generated
 * top-level folders). The walk is bounded: more files or bytes than a release can hold returns undefined, which the
 * caller reports as "no count" rather than guessing.
 */
export async function installedDigests(directory: string): Promise<Map<string, string> | undefined> {
  const digests = new Map<string, string>();
  const pending: string[] = [''];
  let bytes = 0;
  for (let step = 0; step < STUDIO_UPGRADE_LIMITS.filesScannedMax; step += 1) {
    const relative = pending.pop();
    if (relative === undefined) {
      break;
    }
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const file = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const first = file.split('/')[0] ?? '';
      if (retainedPath(file) || STUDIO_GENERATED_ROOTS.some((root) => root === first)) {
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(file);
      } else if (entry.isSymbolicLink()) {
        // A link is never what a release writes; its target text makes the digest differ from any file's.
        digests.set(file, `link:${await readlink(path.join(directory, file))}`);
      } else {
        const size = (await lstat(path.join(directory, file))).size;
        bytes += size;
        if (size > FILE_BYTES_MAX || bytes > STUDIO_UPGRADE_LIMITS.bytesScannedMax || digests.size >= STUDIO_UPGRADE_LIMITS.filesScannedMax) {
          return undefined;
        }
        digests.set(file, contentDigest(await readText(path.join(directory, file))));
      }
    }
  }
  return pending.length > 0 ? undefined : digests;
}

// `JSON.parse` returns `any`; binding it to `unknown` at once keeps the parser as the only thing that trusts it.
function parseJSONText(content: string): unknown {
  const value: unknown = JSON.parse(content);
  return value;
}

async function readText(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/** The files the project changed, or undefined when the folder could not be compared (offline, never published, too large). */
async function changedFiles(directory: string, installedVersion: string): Promise<StudioChangedFiles | undefined> {
  try {
    const installed = await installedDigests(directory);
    if (installed === undefined) {
      return undefined;
    }
    return detectChangedFiles({ pristine: releaseDigests(await downloadRelease(installedVersion)), installed });
  } catch {
    return undefined;
  }
}

function updatesDirectory(project: string): string {
  return path.join(project, STUDIO_UPDATES_DIRECTORY);
}

/** The last upgrade's record, only while its backup folder is still there. Anything unreadable is "no record", never an error. */
async function readManifest(project: string): Promise<StudioUpgradeManifest | undefined> {
  try {
    const file = path.join(updatesDirectory(project), STUDIO_UPGRADE_MANIFEST);
    if ((await lstat(file)).size > MANIFEST_BYTES_MAX) {
      return undefined;
    }
    const manifest = parseStudioUpgradeManifest(parseJSONText(await readText(file)));
    const backup = await lstat(path.join(updatesDirectory(project), manifest.backup));
    return backup.isDirectory() && !backup.isSymbolicLink() ? manifest : undefined;
  } catch {
    return undefined;
  }
}

/** What the Studio box should offer, from the feed and the last upgrade's record. Never throws: a failure is `unavailable`. */
export async function checkStudioUpgrade(project: string, desktopVersion: string): Promise<StudioUpgradeCheck> {
  try {
    const status = await studioStatus(project, desktopVersion);
    if (status.kind !== 'installed') {
      return { kind: 'unavailable' };
    }
    const manifest = await readManifest(project);
    // A record of an upgrade to some other version (someone upgraded by hand since) says nothing about this Studio.
    const previous = manifest?.note.to === status.version ? manifest.note : undefined;
    return decideUpgrade({ installed: status.version, latest: await latestStudioVersion(), previous });
  } catch {
    return { kind: 'unavailable' };
  }
}

/**
 * Replaces the project's Studio with the latest release. The check is made again here: a renderer that asks is never
 * trusted to know the folder is still behind. The previous folder is kept whole; the record of what changed goes next to it.
 */
export async function upgradeStudio(project: string, desktopVersion: string, onProgress: (update: StudioInstallUpdate) => void): Promise<StudioUpgradeResult> {
  try {
    onProgress({ kind: 'stage', stage: 'release' });
    const check = await checkStudioUpgrade(project, desktopVersion);
    if (check.kind !== 'ready') {
      return { kind: 'error', message: translateMain('error.studio.upgradeNotReady') };
    }
    const directory = path.join(project, 'studio');
    const changed = await changedFiles(directory, check.installed);
    const release = await downloadRelease(check.latest).catch(() => {
      throw new Error(translateMain('error.studio.downloadFailed', { version: check.latest }));
    });
    onProgress({ kind: 'stage', stage: 'files' });
    const installed = await installRelease(directory, release, async (staged, projectRoot) => {
      await validateStudio(staged, projectRoot, onProgress);
      onProgress({ kind: 'stage', stage: 'activate' });
    });
    onProgress({ kind: 'stage', stage: 'complete' });
    const note: StudioUpgradeNote = { from: check.installed, to: release.version, changed };
    await recordUpgrade(project, installed.backup, note);
    return { kind: 'upgraded', version: release.version, note };
  } catch (error: unknown) {
    return { kind: 'error', message: errorMessage(error) };
  }
}

// The upgrade has already happened, so a record that cannot be written only costs the restore button.
async function recordUpgrade(project: string, backup: string | undefined, note: StudioUpgradeNote): Promise<void> {
  if (backup === undefined) {
    return;
  }
  try {
    const manifest: StudioUpgradeManifest = { format: 1, backup: path.basename(backup), note };
    await writeFile(path.join(updatesDirectory(project), STUDIO_UPGRADE_MANIFEST), JSON.stringify(manifest, undefined, 2));
  } catch {
    // Left unrecorded on purpose, see above.
  }
}

/** Puts the folder backed up by the last upgrade back, keeping settings and state. */
export async function restoreStudio(project: string, desktopVersion: string): Promise<StudioRestoreResult> {
  try {
    const status = await studioStatus(project, desktopVersion);
    const manifest = await readManifest(project);
    if (status.kind !== 'installed' || manifest === undefined || manifest.note.to !== status.version) {
      return { kind: 'error', message: translateMain('error.studio.restoreNotReady') };
    }
    await restoreBackup(path.join(project, 'studio'), manifest.backup);
    await rm(path.join(updatesDirectory(project), STUDIO_UPGRADE_MANIFEST), { force: true });
    return { kind: 'restored', version: manifest.note.from };
  } catch (error: unknown) {
    return { kind: 'error', message: errorMessage(error) };
  }
}
