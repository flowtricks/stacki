// The boot snapshot: what the last session knew about a project, kept so the next window's first frame already
// shows it. It is a cache of the app's own state, never a copy of the project: the page list and the editor
// layout, not page source, file contents or secrets. Main reads the file before the window exists and hands the
// parsed value to the renderer's first render; the renderer reconciles it with the fresh scan that follows
// (docs/startup.md, docs/contracts.md "Boot snapshot").
//
// Why every field is optional or bounded: the file is read from disk, so it is untrusted like any other
// boundary value. A snapshot that fails to parse is dropped whole and the project opens as it did before
// there was a cache; one bad field never half-applies.
import { assert } from '../core/assert';
import { err, ok, type Result } from '../core/result';
import { parseScanResult, type ScanResult } from './projectScan';

export const BOOT_SNAPSHOT_VERSION = 1;

export const BOOT_LIMITS = {
  /** Projects remembered; the oldest is dropped first. */
  projectsMax: 4,
  /** One project's serialized snapshot. A scan larger than this is left out and the rest kept. */
  snapshotBytesMax: 256 * 1024,
  /** The whole file, which is also what crosses to the renderer in one synchronous message. */
  fileBytesMax: 1024 * 1024,
  pathCharsMax: 4096,
  nameCharsMax: 512,
  labelCharsMax: 64,
} as const;

/** The branch chip's last known state (a read answer, never a placeholder), so the title bar's chip is real in the first frame. */
export type BootBranch =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'default'; readonly name: string }
  | { readonly kind: 'other'; readonly name: string; readonly defaultName: string }
  | { readonly kind: 'detached'; readonly defaultName: string; readonly canSwitch: boolean };

export interface BootSnapshot {
  readonly version: typeof BOOT_SNAPSHOT_VERSION;
  readonly projectPath: string;
  /** The page list, folders, layouts and components, as the last scan settled. */
  readonly scan?: ScanResult;
  /** The page open when the session ended (its scan name). */
  readonly pageName?: string;
  /** The left panel that was open, as its rail id; absent when the panel was closed. */
  readonly leftTab?: string;
  readonly branch?: BootBranch;
}

export interface BootFile {
  readonly version: typeof BOOT_SNAPSHOT_VERSION;
  /** Most recent first. */
  readonly projects: readonly BootSnapshot[];
}

export interface BootError {
  readonly code: 'boot-invalid';
  readonly message: string;
}

const invalid = (message: string): Result<never, BootError> => err({ code: 'boot-invalid', message });

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function boundedText(input: unknown, charsMax: number): string | undefined {
  return typeof input === 'string' && input.length > 0 && input.length <= charsMax ? input : undefined;
}

/** One project's snapshot from unknown. Every shape that is not exactly this contract is an error value. */
export function parseBootSnapshot(input: unknown): Result<BootSnapshot, BootError> {
  if (!isRecord(input)) {
    return invalid('snapshot: expected an object');
  }
  if (input['version'] !== BOOT_SNAPSHOT_VERSION) {
    return invalid('snapshot: unknown version');
  }
  const projectPath = boundedText(input['projectPath'], BOOT_LIMITS.pathCharsMax);
  if (projectPath === undefined) {
    return invalid('snapshot.projectPath: expected a non-empty bounded string');
  }
  const out: { -readonly [Key in keyof BootSnapshot]: BootSnapshot[Key] } = { version: BOOT_SNAPSHOT_VERSION, projectPath };
  if (input['scan'] !== undefined) {
    try {
      out.scan = parseScanResult(input['scan']);
    } catch (error: unknown) {
      return invalid(`snapshot.scan: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const optionalText: ReadonlyArray<readonly ['pageName' | 'leftTab', number]> = [
    ['pageName', BOOT_LIMITS.nameCharsMax],
    ['leftTab', BOOT_LIMITS.labelCharsMax],
  ];
  for (const [key, charsMax] of optionalText) {
    const value = input[key];
    if (value === undefined) {
      continue;
    }
    const text = boundedText(value, charsMax);
    if (text === undefined) {
      return invalid(`snapshot.${key}: expected a non-empty bounded string`);
    }
    out[key] = text;
  }
  if (input['branch'] !== undefined) {
    const branch = parseBootBranch(input['branch']);
    if (branch === undefined) {
      return invalid('snapshot.branch: unknown shape');
    }
    out.branch = branch;
  }
  return ok(out);
}

function parseBootBranch(input: unknown): BootBranch | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const name = boundedText(input['name'], BOOT_LIMITS.nameCharsMax);
  const defaultName = boundedText(input['defaultName'], BOOT_LIMITS.nameCharsMax);
  switch (input['kind']) {
    case 'hidden':
      return { kind: 'hidden' };
    case 'default':
      return name === undefined ? undefined : { kind: 'default', name };
    case 'other':
      return name === undefined || defaultName === undefined ? undefined : { kind: 'other', name, defaultName };
    case 'detached': {
      const canSwitch = input['canSwitch'];
      return defaultName === undefined || typeof canSwitch !== 'boolean' ? undefined : { kind: 'detached', defaultName, canSwitch };
    }
    default:
      return undefined;
  }
}

/** The file's text. The size is checked before parsing so a huge file costs nothing. */
export function parseBootFileText(text: string): Result<BootFile, BootError> {
  if (text.length > BOOT_LIMITS.fileBytesMax) {
    return invalid('boot file: larger than the limit');
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return invalid('boot file: not JSON');
  }
  if (!isRecord(input) || input['version'] !== BOOT_SNAPSHOT_VERSION || !Array.isArray(input['projects'])) {
    return invalid('boot file: expected { version, projects }');
  }
  if (input['projects'].length > BOOT_LIMITS.projectsMax) {
    return invalid('boot file: too many projects');
  }
  const projects: BootSnapshot[] = [];
  for (const entry of input['projects'] as readonly unknown[]) {
    const parsed = parseBootSnapshot(entry);
    if (!parsed.ok) {
      return parsed;
    }
    projects.push(parsed.value);
  }
  return ok({ version: BOOT_SNAPSHOT_VERSION, projects });
}

/** `snapshot` serialized, or without its scan when that alone is over the limit; undefined when even the rest is. */
export function serializeBootSnapshot(snapshot: BootSnapshot): string | undefined {
  const whole = JSON.stringify(snapshot);
  if (whole.length <= BOOT_LIMITS.snapshotBytesMax) {
    return whole;
  }
  const lean = JSON.stringify({ ...snapshot, scan: undefined });
  return lean.length <= BOOT_LIMITS.snapshotBytesMax ? lean : undefined;
}

/** `file` with `snapshot` first and at most `projectsMax` kept: replaces the project's old entry. */
export function withSnapshot(file: BootFile, snapshot: BootSnapshot): BootFile {
  const others = file.projects.filter((entry) => entry.projectPath !== snapshot.projectPath);
  const projects = [snapshot, ...others].slice(0, BOOT_LIMITS.projectsMax);
  assert(projects.length <= BOOT_LIMITS.projectsMax, 'withSnapshot: the file is bounded');
  assert(projects[0]?.projectPath === snapshot.projectPath, 'withSnapshot: the newest project is first');
  return { version: BOOT_SNAPSHOT_VERSION, projects };
}
