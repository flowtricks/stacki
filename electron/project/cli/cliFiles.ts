// Reading and writing `.stacki` files for the CLI through the app's own write path.
//
// Why through the app's path: metadata files go through `writeProjectMetadata` (electron/project/projectMetadata.ts), the same function Desktop's
// IPC handler calls: it refuses symlinks, validates with the app's parser, and writes through the document actor, which takes the per-file lock
// the running app also takes, witnesses the bytes it replaces, and writes atomically. The CLI therefore cannot write a file the app would refuse,
// and cannot overwrite a change the app made after the CLI read the file. The apps files have their own stores, so they go through the same
// actor by `writeProjectText`/`createProjectText` after the registry's `validate`.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { err, ok, type Result } from '../../../shared/core/result';
import type { CliError } from '../../../shared/properties/cli/stackiOutput';
import { isMetadataKind, parseDocumentText, refusalOfSource } from '../../../shared/properties/cli/stackiFiles';
import type { FileSchema } from '../../../shared/properties/cli/stackiSchema';
import type { MetadataKind } from '../../../shared/properties/projectMetadata';
import { createProjectText, writeProjectText } from '../../documents/documentWrites';
import { translateMain } from '../../lib/mainLocale';
import { readProjectMetadata, writeProjectMetadata } from '../projectMetadata';

export interface FileState {
  readonly schema: FileSchema;
  /** The file's exact text, or undefined when it does not exist. */
  readonly source: string | undefined;
}

export function digestOfText(source: string | undefined): string | undefined {
  return source === undefined ? undefined : createHash('sha256').update(source).digest('hex');
}

/** The nearest folder at or above `start` that holds a `.stacki` folder or an Astro config. */
export function findProject(start: string): Result<string, CliError> {
  let directory = path.resolve(start);
  for (let step = 0; step < 64; step += 1) {
    const hasStacki = fs.existsSync(path.join(directory, '.stacki'));
    const hasAstro = ['astro.config.mjs', 'astro.config.ts', 'astro.config.js', 'astro.config.mts'].some((name) => fs.existsSync(path.join(directory, name)));
    if (hasStacki || hasAstro) {
      return ok(fs.realpathSync(directory));
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  return err({ code: 'not-a-project', message: `No .stacki folder or Astro config found at or above ${start}; pass --project <dir>.` });
}

export function readFileState(root: string, schema: FileSchema): Result<FileState, CliError> {
  if (isMetadataKind(schema.metadataKind)) {
    const read = readProjectMetadata(root, schema.metadataKind satisfies MetadataKind);
    if (!read.ok) {
      return err({ code: 'refused', message: read.error.message });
    }
    return ok({ schema, source: read.value.source });
  }
  const target = path.join(root, schema.file);
  try {
    if (!fs.existsSync(target)) {
      return ok({ schema, source: undefined });
    }
    if (fs.lstatSync(target).isSymbolicLink()) {
      return err({ code: 'refused', message: `${schema.file} is a symbolic link; the CLI does not follow links in .stacki.` });
    }
    return ok({ schema, source: fs.readFileSync(target, 'utf8') });
  } catch (error: unknown) {
    return err({ code: 'refused', message: `${schema.file} could not be read: ${error instanceof Error ? error.message : String(error)}` });
  }
}

/** The file's JSON object, or the empty document when the file does not exist. */
export function documentOf(state: FileState): Result<Record<string, unknown>, CliError> {
  return state.source === undefined ? ok({ ...state.schema.empty }) : parseDocumentText(state.schema, state.source);
}

/** Replaces the file's text `base` with `source`; `base` undefined creates it. Maps a held lock to `locked`. */
export function writeFileText(root: string, schema: FileSchema, source: string, base: string | undefined): Result<void, CliError> {
  const refusal = refusalOfSource(schema, source);
  if (refusal !== undefined) {
    return err({ code: 'invalid-file', message: `${schema.file} would be refused by the app: ${refusal}` });
  }
  const absolute = path.join(root, schema.file);
  if (isMetadataKind(schema.metadataKind)) {
    const written = writeProjectMetadata(root, { kind: schema.metadataKind, source, ...(base === undefined ? {} : { base }) });
    if (written.ok) {
      return ok(undefined);
    }
    const held = translateMain('error.documents.lockHeld', { file: absolute });
    return err({
      code:
        written.error.message.includes(held) || written.error.code === 'conflict'
          ? written.error.code === 'conflict'
            ? 'conflict'
            : 'locked'
          : 'write-failed',
      message: written.error.message,
    });
  }
  try {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    if (base === undefined) {
      createProjectText(absolute, source);
    } else {
      writeProjectText(absolute, source, base);
    }
    return ok(undefined);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return err({ code: message.includes(translateMain('error.documents.lockHeld', { file: absolute })) ? 'locked' : 'write-failed', message });
  }
}

/** Removes a file the CLI created, to undo it. Only ever called for a file whose `before` was absent. */
export function removeFile(root: string, schema: FileSchema): Result<void, CliError> {
  try {
    fs.rmSync(path.join(root, schema.file), { force: true });
    return ok(undefined);
  } catch (error: unknown) {
    return err({ code: 'write-failed', message: `${schema.file} could not be removed: ${error instanceof Error ? error.message : String(error)}` });
  }
}
