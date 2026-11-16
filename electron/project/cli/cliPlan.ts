// Turning edits into a plan: what each file would hold, checked, before anything is written.
//
// Why staging first: a plan is the same work as an apply minus the writes, so what a person approves is exactly what is written, and a refusal
// anywhere (one bad key in one of three files) stops the whole command before the first file changes: all files or none.
import { err, ok, type Result } from '../../../shared/core/result';
import { applyConfigOperation, type ConfigOperation } from '../../../shared/properties/cli/stackiConfigEdit';
import { diffJson, type CliError, type PlannedFile } from '../../../shared/properties/cli/stackiOutput';
import { parseDocumentText, refusalOfSource, serializeDocument } from '../../../shared/properties/cli/stackiFiles';
import type { FileSchema } from '../../../shared/properties/cli/stackiSchema';
import { digestOfText, documentOf, readFileState, type FileState } from './cliFiles';

export const PLAN_LIMITS = {
  /** Files one command may change. */
  filesMax: 64,
} as const satisfies Record<string, number>;

/** One file's change: the text the file should hold, from what it holds now. */
export interface Edit {
  readonly schema: FileSchema;
  /** The text the file should hold, or undefined to leave the file as it is (nothing to change). */
  readonly produce: (state: FileState) => Result<string | undefined, CliError>;
}

export interface StagedFile {
  readonly schema: FileSchema;
  readonly before: string | undefined;
  /** The text the file should hold; undefined removes the file (only an undo of a created file does). */
  readonly after: string | undefined;
}

/** An edit that applies config operations to the file's JSON and writes it the way the app writes it. */
export function configEdit(schema: FileSchema, operations: readonly ConfigOperation[]): Edit {
  return {
    schema,
    produce: (state) => {
      const document = documentOf(state);
      if (!document.ok) {
        return document;
      }
      let current: Record<string, unknown> = document.value;
      for (const operation of operations) {
        const next = applyConfigOperation(schema, current, operation);
        if (!next.ok) {
          return next;
        }
        current = next.value;
      }
      return ok(serializeDocument(schema, current));
    },
  };
}

/** An edit from a function of the file's document to the next document. */
export function documentEdit(schema: FileSchema, change: (document: Record<string, unknown>) => Result<Record<string, unknown>, CliError>): Edit {
  return {
    schema,
    produce: (state) => {
      const document = documentOf(state);
      if (!document.ok) {
        return document;
      }
      const next = change(document.value);
      return next.ok ? ok(serializeDocument(schema, next.value)) : next;
    },
  };
}

/** Reads each file, runs the edits in order (a later edit of the same file sees the earlier one), and keeps only files whose text changes. */
export function stage(root: string, edits: readonly Edit[]): Result<readonly StagedFile[], CliError> {
  if (edits.length > PLAN_LIMITS.filesMax) {
    return err({ code: 'refused', message: `A command may change at most ${PLAN_LIMITS.filesMax} files.` });
  }
  const order: string[] = [];
  const staged = new Map<string, { schema: FileSchema; before: string | undefined; after: string | undefined }>();
  for (const edit of edits) {
    const known = staged.get(edit.schema.file);
    const base = known === undefined ? readFileState(root, edit.schema) : { ok: true as const, value: { schema: edit.schema, source: known.after } };
    if (!base.ok) {
      return base;
    }
    const text = edit.produce(base.value);
    if (!text.ok) {
      return text;
    }
    if (text.value === undefined) {
      if (known === undefined) {
        order.push(edit.schema.file);
        staged.set(edit.schema.file, { schema: edit.schema, before: base.value.source, after: base.value.source });
      }
      continue;
    }
    const refusal = refusalOfSource(edit.schema, text.value);
    if (refusal !== undefined) {
      return err({ code: 'invalid-file', message: `${edit.schema.file} would be refused by the app: ${refusal}` });
    }
    if (known === undefined) {
      order.push(edit.schema.file);
      staged.set(edit.schema.file, { schema: edit.schema, before: base.value.source, after: text.value });
    } else {
      known.after = text.value;
    }
  }
  const files: StagedFile[] = [];
  for (const file of order) {
    const entry = staged.get(file);
    if (entry !== undefined && entry.after !== undefined && entry.after !== entry.before) {
      files.push({ schema: entry.schema, before: entry.before, after: entry.after });
    }
  }
  return ok(files);
}

export function plannedFiles(files: readonly StagedFile[]): readonly PlannedFile[] {
  return files.map((file) => {
    const before = file.before === undefined ? undefined : parseDocumentText(file.schema, file.before);
    const after = file.after === undefined ? undefined : parseDocumentText(file.schema, file.after);
    const changes = diffJson(before?.ok === true ? before.value : {}, after?.ok === true ? after.value : {});
    const beforeDigest = digestOfText(file.before);
    return {
      file: file.schema.file,
      action: file.after === undefined ? 'delete' : file.before === undefined ? 'create' : 'modify',
      ...(beforeDigest === undefined ? {} : { beforeDigest }),
      ...(file.after === undefined ? {} : { afterDigest: digestOfText(file.after) ?? '' }),
      changes: changes.changes,
    } satisfies PlannedFile;
  });
}
