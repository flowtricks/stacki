// Design mode (experimental, removable: docs/design-mode/REMOVE.md): drafts, the frames kept between sessions.
//
// When the mode ends, each frame's changed files and its place on the canvas (its snapshot beside them,
// designSnapshots.ts) are kept in Stacki's own data folder,
// `design-drafts/<project hash>/`, readable by the person only, and come back the next time the mode begins on
// the same project. Never in the project. Secrets are never kept: a frame's change to `.env` or a key file is
// dropped from its draft (the sandbox that held it is deleted with the session).
//
// Each kept file remembers what the project's file was when the draft was made (`baseDigest`); a draft that
// comes back over a project that has changed since is marked stale, so the person knows a frame may hide a
// newer edit.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DESIGN_SESSION_LIMITS,
  defaultFramePlace,
  parseDesignFrameId,
  parseDesignPlace,
  type DesignFrameId,
  type DesignPlace,
} from '../../../shared/ipc/designSession';
import { ensurePrivateDirectory } from './designSandbox';
import { DESIGN_FRAME_LIMITS, type FileChange, type FrameFiles } from './designFrames';

export const DESIGN_DRAFT_LIMITS = {
  /** One project's draft file. */
  draftBytesMax: 96 * 1024 * 1024,
} as const satisfies Record<string, number>;

export interface DraftFrame {
  readonly id: DesignFrameId;
  readonly name: string;
  readonly at: DesignPlace;
  readonly files: FrameFiles;
}

export interface Draft {
  readonly frames: readonly DraftFrame[];
  readonly active: DesignFrameId;
}

const DRAFTS_FOLDER = 'design-drafts';
const DRAFT_FILE = 'draft.json';
const DRAFT_VERSION = 1;

/** A file whose content is a secret: never kept in a draft. */
export function isSecretFile(rel: string): boolean {
  const name = rel.split('/').at(-1) ?? rel;
  if (name.startsWith('.env') || name === '.dev.vars') {
    return true;
  }
  return /\.(pem|key|p12|pfx)$/i.test(name);
}

export function draftFolder(appDataRoot: string, realRoot: string): string {
  const hash = createHash('sha256').update(path.resolve(realRoot)).digest('hex').slice(0, 32);
  return path.join(appDataRoot, DRAFTS_FOLDER, hash);
}

function digestOf(file: string): string {
  return fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'absent';
}

/** Keeps `draft` for the project at `realRoot`; `base` is the project as copied, for each file's digest. */
export function saveDraft(input: { readonly appDataRoot: string; readonly realRoot: string; readonly base: string; readonly draft: Draft }): void {
  const folder = draftFolder(input.appDataRoot, input.realRoot);
  ensurePrivateDirectory(path.dirname(folder));
  ensurePrivateDirectory(folder);
  const frames = input.draft.frames.map((frame) => ({
    id: frame.id,
    name: frame.name,
    at: frame.at,
    files: [...frame.files]
      .filter(([rel]) => !isSecretFile(rel))
      .map(([rel, change]) => ({
        rel,
        kind: change.kind,
        baseDigest: digestOf(path.join(input.base, rel)),
        ...(change.kind === 'write' ? { base64: change.bytes.toString('base64') } : {}),
      })),
  }));
  const text = JSON.stringify({ version: DRAFT_VERSION, realRoot: path.resolve(input.realRoot), active: input.draft.active, frames });
  if (text.length > DESIGN_DRAFT_LIMITS.draftBytesMax) {
    throw new Error('Design draft: larger than a draft holds');
  }
  const temporary = path.join(folder, `${DRAFT_FILE}.tmp`);
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, path.join(folder, DRAFT_FILE));
}

export type DraftRead = { readonly kind: 'none' } | { readonly kind: 'draft'; readonly draft: Draft; readonly stale: boolean };

/** The kept draft of the project at `realRoot`, checked against `base`, the project as copied now. */
export function readDraft(input: { readonly appDataRoot: string; readonly realRoot: string; readonly base: string }): DraftRead {
  const file = path.join(draftFolder(input.appDataRoot, input.realRoot), DRAFT_FILE);
  if (!fs.existsSync(file)) {
    return { kind: 'none' };
  }
  if (fs.statSync(file).size > DESIGN_DRAFT_LIMITS.draftBytesMax) {
    return { kind: 'none' };
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parseDraft(parsed, input);
  } catch {
    // A draft this version cannot read is set aside rather than trusted: the mode starts fresh.
    return { kind: 'none' };
  }
}

function recordOf(input: unknown, what: string): Readonly<Record<string, unknown>> {
  if (typeof input !== 'object' || !input || Array.isArray(input)) {
    throw new Error(`${what}: expected an object`);
  }
  return Object.fromEntries(Object.entries(input));
}

function stringOf(input: unknown, what: string): string {
  if (typeof input !== 'string') {
    throw new Error(`${what}: expected text`);
  }
  return input;
}

function parseDraft(input: unknown, where: { readonly realRoot: string; readonly base: string }): DraftRead {
  const value = recordOf(input, 'Design draft');
  if (value['version'] !== DRAFT_VERSION) {
    return { kind: 'none' };
  }
  if (stringOf(value['realRoot'], 'Design draft root') !== path.resolve(where.realRoot)) {
    return { kind: 'none' };
  }
  const frames = value['frames'];
  if (!Array.isArray(frames) || frames.length === 0 || frames.length > DESIGN_SESSION_LIMITS.framesMax) {
    throw new Error('Design draft frames: expected one to the most a session holds');
  }
  let stale = false;
  const parsed = frames.map((entry: unknown, index): DraftFrame => {
    const frame = recordOf(entry, 'Design draft frame');
    const files = frame['files'];
    if (!Array.isArray(files) || files.length > DESIGN_FRAME_LIMITS.changedFilesMax) {
      throw new Error('Design draft files: expected a bounded list');
    }
    const changes = new Map<string, FileChange>();
    for (const item of files) {
      const parsedFile = parseDraftFile(item);
      stale = stale || digestOf(path.join(where.base, parsedFile.rel)) !== parsedFile.baseDigest;
      changes.set(parsedFile.rel, parsedFile.change);
    }
    const name = stringOf(frame['name'], 'Design draft frame name').slice(0, DESIGN_SESSION_LIMITS.frameNameCharsMax);
    // A draft kept before frames had places is laid out in a row.
    const at = frame['at'] === undefined ? defaultFramePlace(index) : parseDesignPlace(frame['at']);
    return { id: parseDesignFrameId(frame['id']), name, at, files: changes };
  });
  const active = parseDesignFrameId(value['active']);
  if (!parsed.some((frame) => frame.id === active)) {
    throw new Error('Design draft: the active frame is one of its frames');
  }
  return { kind: 'draft', draft: { frames: parsed, active }, stale };
}

function parseDraftFile(input: unknown): { readonly rel: string; readonly change: FileChange; readonly baseDigest: string } {
  const value = recordOf(input, 'Design draft file');
  const rel = stringOf(value['rel'], 'Design draft file path');
  // A kept path names a file inside the copy: relative, forward slashes, never climbing.
  if (rel.length === 0 || path.isAbsolute(rel) || rel.includes('\\') || rel.split('/').some((part) => part === '..' || part === '')) {
    throw new Error('Design draft file path: expected a path inside the project');
  }
  const baseDigest = stringOf(value['baseDigest'], 'Design draft digest');
  if (value['kind'] === 'delete') {
    return { rel, change: { kind: 'delete' }, baseDigest };
  }
  if (value['kind'] !== 'write') {
    throw new Error('Design draft file: unknown kind');
  }
  return { rel, change: { kind: 'write', bytes: Buffer.from(stringOf(value['base64'], 'Design draft content'), 'base64') }, baseDigest };
}

/** Forgets the project's drafts: Start over. */
export function removeDraft(appDataRoot: string, realRoot: string): void {
  fs.rmSync(draftFolder(appDataRoot, realRoot), { recursive: true, force: true });
}
