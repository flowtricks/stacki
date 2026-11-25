// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// The output contract of the Stacki CLI and of the MCP tools over it: one JSON envelope, versioned, with the repository's
// `{ code, message }` error shape. Scripts and agents depend on it, so a golden test pins every field
// (test/shared/properties/cli/stackiOutput.test.ts) and a change to it bumps `CLI_SCHEMA_VERSION`.
import { assert } from '../../core/assert';
import { toArray, toRecord } from '../../core/record';

export const CLI_SCHEMA_VERSION = 1;

/** Every refusal code the CLI can answer, each with the process exit code it maps to (docs/stacki-cli.md). */
export const CLI_EXIT_CODES = {
  /** Wrong flags, a missing argument, an unknown command. Nothing was read or written. */
  usage: 2,
  'not-a-project': 2,
  'unknown-file': 2,
  'bad-path': 2,
  /** The request is understood and refused by a rule: nothing was written. */
  'unknown-key': 1,
  'invalid-value': 1,
  'invalid-file': 1,
  missing: 1,
  exists: 1,
  required: 1,
  refused: 1,
  'confirmation-required': 1,
  'apply-required': 1,
  'planner-unavailable': 1,
  'unsupported-file': 1,
  /** An app's command was asked for while the app is disabled, not trusted, or changed since it was trusted: `stacki apps enable <app>` first. */
  'app-untrusted': 1,
  /** Another writer holds the project or a file, or a file changed since the plan: retry. */
  locked: 3,
  conflict: 3,
  /** A write failed; everything already written was put back. */
  'write-failed': 4,
  internal: 4,
  /** The role chosen with `--role` may not change this file. */
  'role-denied': 5,
} as const satisfies Record<string, number>;

export type CliErrorCode = keyof typeof CLI_EXIT_CODES;

export interface CliError {
  readonly code: CliErrorCode;
  readonly message: string;
}

/** One difference inside a JSON file: a path, and the value before and after (absent when there was none). */
export interface JsonChange {
  readonly path: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface PlannedFile {
  /** Project-relative, with `/`. */
  readonly file: string;
  readonly action: 'create' | 'modify' | 'delete' | 'move';
  /** For a move: where the file was. */
  readonly from?: string;
  readonly beforeDigest?: string;
  readonly afterDigest?: string;
  /** What changes inside a JSON file, bounded; empty for a file that is not JSON. */
  readonly changes: readonly JsonChange[];
}

export type CliMode = 'plan' | 'apply' | 'read';

export interface CliSuccess {
  readonly schemaVersion: number;
  readonly ok: true;
  /** The command's name, `config set`. */
  readonly command: string;
  readonly mode: CliMode;
  /** True only when files were written. */
  readonly applied: boolean;
  readonly project: string;
  readonly role: string;
  /** The files the command changes (plan) or changed (apply). Empty for a read. */
  readonly files: readonly PlannedFile[];
  /** What a read command answers, or extra facts of a write; absent otherwise. */
  readonly result?: unknown;
  /** Things the person should know that did not stop the command. */
  readonly notes: readonly string[];
  /** The id `stacki undo` takes after an apply. */
  readonly undoId?: string;
  /** One line a person reads. */
  readonly summary: string;
}

export interface CliFailure {
  readonly schemaVersion: number;
  readonly ok: false;
  readonly command: string;
  readonly error: CliError;
  /** What a check found when the finding is the failure (`stacki doctor` with errors lists them here); absent otherwise. */
  readonly result?: unknown;
}

export type CliEnvelope = CliSuccess | CliFailure;

export function exitCodeOf(envelope: CliEnvelope): number {
  assert(envelope.schemaVersion >= 1, 'An envelope has a schema version');
  return envelope.ok ? 0 : CLI_EXIT_CODES[envelope.error.code];
}

export const DIFF_LIMITS = {
  /** Differences listed for one file; the rest are counted in the summary, not dropped silently. */
  changesMax: 200,
  /** Nesting walked. */
  depthMax: 16,
} as const satisfies Record<string, number>;

/** The differences between two JSON values as paths, bounded. `truncated` is true when more existed than are listed. */
export function diffJson(before: unknown, after: unknown): { readonly changes: readonly JsonChange[]; readonly truncated: boolean } {
  assert(DIFF_LIMITS.changesMax > 0, 'A diff lists at least one change');
  const changes: JsonChange[] = [];
  let truncated = false;
  const walk = (left: unknown, right: unknown, path: string, depth: number): void => {
    if (JSON.stringify(left) === JSON.stringify(right)) {
      return;
    }
    const leftRecord = toRecord(left);
    const rightRecord = toRecord(right);
    if (leftRecord !== undefined && rightRecord !== undefined && depth < DIFF_LIMITS.depthMax) {
      for (const key of new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])) {
        walk(leftRecord[key], rightRecord[key], path === '' ? key : `${path}.${key}`, depth + 1);
      }
      return;
    }
    const leftList = toArray(left);
    const rightList = toArray(right);
    if (
      leftList !== undefined &&
      rightList !== undefined &&
      depth < DIFF_LIMITS.depthMax &&
      Math.max(leftList.length, rightList.length) <= DIFF_LIMITS.changesMax
    ) {
      for (let index = 0; index < Math.max(leftList.length, rightList.length); index += 1) {
        walk(leftList[index], rightList[index], `${path}[${index}]`, depth + 1);
      }
      return;
    }
    if (changes.length >= DIFF_LIMITS.changesMax) {
      truncated = true;
      return;
    }
    changes.push({ path, ...(left === undefined ? {} : { before: left }), ...(right === undefined ? {} : { after: right }) });
  };
  walk(before, after, '', 0);
  return { changes, truncated };
}
