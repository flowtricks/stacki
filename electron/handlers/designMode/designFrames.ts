// Design mode (experimental, removable: docs/design-mode/REMOVE.md): frames, the versions of the site a person
// compares.
//
// A frame is the set of files it changes against `base/` (the project as copied). One frame is shown at a time:
// the live copy holds base plus the active frame's changes, and that is what the window, its panels and the dev server
// work on. Switching frames records what the live copy now differs by (`captureChanges`), then rewrites only the files
// either frame touches (`applyFrame`); the editor and the dev server pick the change up the way they pick up any
// edit made outside the app. Every write here lands in the live copy, inside the sandbox.
import fs from 'node:fs';
import path from 'node:path';
import { isSkippedPath } from './designSandbox';

export const DESIGN_FRAME_LIMITS = {
  /** Files one frame may change; a redesign of a page touches a handful. */
  changedFilesMax: 2_000,
  changedBytesMax: 256 * 1024 * 1024,
  /** Files compared in one capture. */
  comparedFilesMax: 40_000,
  walkDepthMax: 64,
  /** Files read or written at once. */
  filesInFlightMax: 16,
  /** One file's described change, in characters, and how many lines of it are shown. */
  fileChangeCharsMax: 6_000,
  hunkLinesMax: 80,
} as const satisfies Record<string, number>;

export type FileChange = { readonly kind: 'write'; readonly bytes: Buffer } | { readonly kind: 'delete' };
/** Project-relative path, forward slashes, to its change. */
export type FrameFiles = ReadonlyMap<string, FileChange>;

/**
 * What `live` differs from `base` (the project, read only) by. Files untouched since `copiedAtMs` are taken as
 * unchanged without reading them. Asynchronous, a bounded number of files at once, so the main process keeps answering.
 */
export async function captureChanges(base: string, live: string, copiedAtMs: number): Promise<FrameFiles> {
  const changes = new Map<string, FileChange>();
  const liveFiles = await listFiles(live);
  let bytes = 0;
  await inBatches(liveFiles, async (rel) => {
    const change = await compareFile(path.join(base, rel), path.join(live, rel), copiedAtMs);
    if (change === undefined) {
      return;
    }
    changes.set(rel, change);
    bytes += change.kind === 'write' ? change.bytes.length : 0;
  });
  if (changes.size > DESIGN_FRAME_LIMITS.changedFilesMax) {
    throw new Error('Design frame: more files changed than a frame holds');
  }
  if (bytes > DESIGN_FRAME_LIMITS.changedBytesMax) {
    throw new Error('Design frame: the changed files are larger than a frame holds');
  }
  const present = new Set(liveFiles);
  for (const rel of await listFiles(base)) {
    if (!present.has(rel)) {
      changes.set(rel, { kind: 'delete' });
    }
  }
  return new Map([...changes].sort(([left], [right]) => left.localeCompare(right, 'en')));
}

async function compareFile(baseFile: string, liveFile: string, copiedAtMs: number): Promise<FileChange | undefined> {
  const liveStat = await fs.promises.stat(liveFile);
  const baseStat = await statOrMissing(baseFile);
  if (baseStat === undefined) {
    return { kind: 'write', bytes: await fs.promises.readFile(liveFile) };
  }
  if (liveStat.size === baseStat.size && liveStat.mtimeMs <= copiedAtMs) {
    return undefined;
  }
  const liveBytes = await fs.promises.readFile(liveFile);
  if (liveBytes.equals(await fs.promises.readFile(baseFile))) {
    return undefined;
  }
  return { kind: 'write', bytes: liveBytes };
}

async function statOrMissing(file: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.stat(file);
  } catch {
    return undefined;
  }
}

/** Runs `work` on every item, with at most filesInFlightMax at once. */
async function inBatches<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const lanes = Array.from({ length: Math.min(DESIGN_FRAME_LIMITS.filesInFlightMax, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      if (item !== undefined) {
        await work(item);
      }
    }
  });
  await Promise.all(lanes);
}

/** Every file under `root` a frame compares, project-relative with forward slashes. Links are not followed. */
export async function listFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  let level: readonly string[] = [''];
  for (let depth = 0; level.length > 0; depth += 1) {
    if (depth > DESIGN_FRAME_LIMITS.walkDepthMax) {
      throw new Error('Design frame: folders deeper than a frame compares');
    }
    const next: string[] = [];
    await inBatches(level, async (folder) => {
      for (const dirent of await fs.promises.readdir(path.join(root, folder), { withFileTypes: true })) {
        const rel = folder === '' ? dirent.name : `${folder}/${dirent.name}`;
        if (isSkippedPath(rel)) {
          continue;
        }
        if (dirent.isDirectory()) {
          next.push(rel);
        } else if (dirent.isFile()) {
          files.push(rel);
        }
      }
    });
    if (files.length > DESIGN_FRAME_LIMITS.comparedFilesMax) {
      throw new Error('Design frame: more files than a frame compares');
    }
    level = next;
  }
  return files.sort();
}

/** Turns `live` from showing `from` into showing `to`, writing only the files either of them changes. */
export async function applyFrame(input: { readonly base: string; readonly live: string; readonly from: FrameFiles; readonly to: FrameFiles }): Promise<void> {
  const { base, live, from, to } = input;
  const touched = [...new Set([...from.keys(), ...to.keys()])];
  if (touched.length > DESIGN_FRAME_LIMITS.changedFilesMax * 2) {
    throw new Error('Assertion failed: applyFrame: two frames change at most twice a frame’s files');
  }
  await inBatches(touched, async (rel) => {
    const target = path.join(live, rel);
    if (!isInside(live, target)) {
      throw new Error(`Assertion failed: applyFrame: ${rel} is inside the copy`);
    }
    const change = to.get(rel);
    if (change === undefined) {
      await restoreBase(path.join(base, rel), target);
    } else if (change.kind === 'write') {
      await writeIfDifferent(target, change.bytes);
    } else {
      await fs.promises.rm(target, { force: true });
    }
  });
}

async function restoreBase(baseFile: string, target: string): Promise<void> {
  const original = await readOrMissing(baseFile);
  if (original === undefined) {
    await fs.promises.rm(target, { force: true });
  } else {
    await writeIfDifferent(target, original);
  }
}

async function readOrMissing(file: string): Promise<Buffer | undefined> {
  try {
    return await fs.promises.readFile(file);
  } catch {
    return undefined;
  }
}

// An unchanged file is not written, so the editor and the dev server are not told of a change that is none.
async function writeIfDifferent(target: string, bytes: Buffer): Promise<void> {
  const current = await readOrMissing(target);
  if (current !== undefined && current.equals(bytes)) {
    return;
  }
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, bytes);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** One frame's changes as text for the AI: each file, and the lines that differ from the project. */
export function describeChanges(base: string, files: FrameFiles, charsMax: number): string {
  const parts: string[] = [];
  let length = 0;
  for (const [rel, change] of [...files].sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    const part = describeFile(rel, readText(path.join(base, rel)), change.kind === 'write' ? textOf(change.bytes) : undefined);
    if (length + part.length > charsMax) {
      parts.push(`… ${files.size - parts.length} more changed files`); // i18n-ignore: text for the AI, not the interface.
      break;
    }
    parts.push(part);
    length += part.length + 1;
  }
  return parts.join('\n');
}

function readText(file: string): string | undefined {
  return fs.existsSync(file) ? textOf(fs.readFileSync(file)) : undefined;
}

// Binary content (an image swapped in) is named, not shown.
function textOf(bytes: Buffer): string | undefined {
  return bytes.includes(0) ? undefined : bytes.toString('utf8');
}

/** A file's change as one hunk: the lines between the longest common start and end, removed then added. */
export function describeFile(rel: string, before: string | undefined, after: string | undefined): string {
  if (before === undefined && after === undefined) {
    return `${rel}: removed or binary`; // i18n-ignore: text for the AI, not the interface.
  }
  if (before === undefined) {
    return clip(`${rel} (new file)\n${prefixLines(after ?? '', '+')}`); // i18n-ignore: text for the AI.
  }
  if (after === undefined) {
    return `${rel} (removed)`; // i18n-ignore: text for the AI, not the interface.
  }
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) {
    start += 1;
  }
  let end = 0;
  while (end < beforeLines.length - start && end < afterLines.length - start && beforeLines.at(-1 - end) === afterLines.at(-1 - end)) {
    end += 1;
  }
  const removed = beforeLines.slice(start, beforeLines.length - end);
  const added = afterLines.slice(start, afterLines.length - end);
  return clip(`${rel} @@ line ${start + 1}\n${prefixLines(removed.join('\n'), '-')}\n${prefixLines(added.join('\n'), '+')}`);
}

function prefixLines(text: string, mark: '+' | '-'): string {
  const lines = text.length === 0 ? [] : text.split('\n');
  const shown = lines.slice(0, DESIGN_FRAME_LIMITS.hunkLinesMax).map((line) => `${mark} ${line}`);
  if (lines.length > shown.length) {
    shown.push(`${mark} … ${lines.length - shown.length} more lines`); // i18n-ignore: text for the AI.
  }
  return shown.join('\n');
}

function clip(text: string): string {
  return text.length <= DESIGN_FRAME_LIMITS.fileChangeCharsMax ? text : `${text.slice(0, DESIGN_FRAME_LIMITS.fileChangeCharsMax)}…`;
}
