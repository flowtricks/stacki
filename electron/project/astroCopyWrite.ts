// Making the Astro copy on disk: the boundary checks on where it goes, then the plan (astroCopyPlan.ts)
// written into a temporary sibling folder and renamed into place in one step.
//
// Why a temporary sibling: a copy that fails halfway (a full disk, a file that vanished) must leave
// nothing behind that looks like a project. The sibling sits in the same folder as the target, so the
// final rename never crosses a volume and is atomic. The original is only ever read.
//
// What this run created is the only thing it removes: the temporary folder, made by `mkdtemp` (so it
// cannot have existed before) and checked by name before removal. The target is asserted missing at
// the boundary and again just before the rename.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { astroCopyNameProblem, type AstroCopyFailure, type AstroCopyRequest, type AstroCopyTargetProblem } from '../../shared/ipc/astroCopy';
import { ASTRO_COPY_FILE_LIMITS, planAstroCopy, type AstroCopyPlan, type PlanEntry } from './astroCopyPlan';
import { htmlToAstro } from './htmlToAstro';
import { listSiteFiles } from './plainSiteScan';
import { MAIN_LIMITS } from '../lib/mainLimits';

/** The prefix of the temporary sibling folder, so cleanup can check it removes only its own. */
export const ASTRO_COPY_TEMPORARY_PREFIX = '.stacki-astro-copy-';

export interface AstroCopyMade {
  readonly projectPath: string;
  readonly plan: AstroCopyPlan;
}

type OnLog = (text: string) => void;

/** Whether `request` may make a copy: the name, the location and the target. Reads the disk; writes nothing. */
export function checkAstroCopyTarget(request: AstroCopyRequest): Result<{ readonly targetPath: string }, AstroCopyTargetProblem> {
  assertNormalized(request.sourcePath);
  assertNormalized(request.parentPath);
  const nameProblem = astroCopyNameProblem(request.name);
  if (nameProblem !== undefined) {
    return err(nameProblem);
  }
  let parent: fs.Stats;
  try {
    parent = fs.statSync(request.parentPath);
  } catch {
    return err('location-missing');
  }
  if (!parent.isDirectory()) {
    return err('location-missing');
  }
  try {
    fs.accessSync(request.parentPath, fs.constants.W_OK);
  } catch {
    return err('location-unwritable');
  }
  const targetPath = path.join(request.parentPath, request.name);
  assert(path.dirname(targetPath) === request.parentPath, 'checkAstroCopyTarget: the name is one folder');
  if (isInside(realOrSelf(request.sourcePath), realOrSelf(request.parentPath))) {
    return err('inside-original');
  }
  if (exists(targetPath)) {
    return err('target-exists');
  }
  return ok({ targetPath });
}

/** Copies the plain website at `request.sourcePath` as a new Astro project. The original is only read. */
export async function createAstroCopy(request: AstroCopyRequest, onLog: OnLog): Promise<Result<AstroCopyMade, AstroCopyFailure>> {
  const checked = checkAstroCopyTarget(request);
  if (!checked.ok) {
    return err({ code: checked.error });
  }
  const listing = listSiteFiles(request.sourcePath, {
    depthMax: MAIN_LIMITS.directoryDepthMax,
    entriesMax: ASTRO_COPY_FILE_LIMITS.entriesMax,
    purpose: 'copy',
  });
  const planned = planAstroCopy(listing, request.name);
  if (!planned.ok) {
    return planned;
  }
  const plan = planned.value;
  onLog(`> copying ${path.basename(request.sourcePath)} as an Astro project (${plan.pageCount} pages, ${plan.assetCount} files)\n`);
  const temporary = fs.mkdtempSync(path.join(request.parentPath, ASTRO_COPY_TEMPORARY_PREFIX));
  try {
    await writePlan(temporary, plan.entries);
    // The boundary check ran before the copy, which may have taken minutes; check again right before the rename.
    if (exists(checked.value.targetPath)) {
      removeTemporary(request.parentPath, temporary);
      return err({ code: 'target-exists' });
    }
    fs.renameSync(temporary, checked.value.targetPath);
  } catch (error: unknown) {
    removeTemporary(request.parentPath, temporary);
    return err({ code: 'copy-failed', detail: error instanceof Error ? error.message : String(error) });
  }
  assert(!exists(temporary), 'createAstroCopy: the temporary folder became the project');
  assert(exists(path.join(checked.value.targetPath, 'package.json')), 'createAstroCopy: the project has its manifest');
  onLog(`> made ${checked.value.targetPath}\n`);
  return ok({ projectPath: checked.value.targetPath, plan });
}

// Every entry of the plan under `root`. Folders are made as needed; files are created, never overwritten.
async function writePlan(root: string, entries: readonly PlanEntry[]): Promise<void> {
  assert(fs.readdirSync(root).length === 0, 'writePlan: an empty folder of its own');
  const made = new Set<string>();
  for (const entry of entries) {
    const target = path.join(root, ...entry.target.split('/'));
    assert(isInside(root, target), 'writePlan: every file lands inside the copy');
    const folder = path.dirname(target);
    if (!made.has(folder)) {
      await fs.promises.mkdir(folder, { recursive: true });
      made.add(folder);
    }
    switch (entry.kind) {
      case 'generated':
        await fs.promises.writeFile(target, entry.text, { encoding: 'utf8', flag: 'wx' });
        break;
      case 'page': {
        const source = await readPage(entry.source.absolute);
        await fs.promises.writeFile(target, htmlToAstro(source).text, { encoding: 'utf8', flag: 'wx' });
        await fs.promises.chmod(target, entry.source.mode);
        break;
      }
      case 'asset':
        await fs.promises.copyFile(entry.source.absolute, target, fs.constants.COPYFILE_EXCL);
        await fs.promises.chmod(target, entry.source.mode);
        break;
      default: {
        const exhaustive: never = entry;
        throw new Error(`writePlan: unknown entry ${String(exhaustive)}`);
      }
    }
  }
}

// A page's text, bounded before and after the read: a file may grow between the listing and now.
async function readPage(file: string): Promise<string> {
  const bytes = await fs.promises.readFile(file);
  if (bytes.length > ASTRO_COPY_FILE_LIMITS.pageBytesMax) {
    throw new Error(`${path.basename(file)} grew past ${ASTRO_COPY_FILE_LIMITS.pageBytesMax} bytes while it was copied`);
  }
  return bytes.toString('utf8');
}

// Removes the temporary folder this run made, and nothing else.
function removeTemporary(parentPath: string, temporary: string): void {
  assert(path.dirname(temporary) === parentPath, 'removeTemporary: a sibling of the target');
  assert(path.basename(temporary).startsWith(ASTRO_COPY_TEMPORARY_PREFIX), 'removeTemporary: only the folder this run made');
  fs.rmSync(temporary, { recursive: true, force: true });
}

function assertNormalized(directory: string): void {
  assert(path.isAbsolute(directory), 'astroCopy: an absolute path');
  assert(path.resolve(directory) === directory, 'astroCopy: a normalized path');
}

function exists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function realOrSelf(directory: string): string {
  try {
    return fs.realpathSync(directory);
  } catch {
    return directory;
  }
}

/** Whether `file` is `folder` itself or inside it. */
function isInside(folder: string, file: string): boolean {
  const relative = path.relative(folder, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
