// `/studio/api/variables` in the page. The server's own CSS variable engine reads and
// edits the stylesheets as the visitor has them, and every changed file is written
// through its room, as the Style panel's writes are, so the canvas repaints and the
// edit is saved with the others. CSS custom properties need no Astro to show.
import { readVariables } from '../vendor/stacki/electron/project/cssVarModel';
import { assert } from '../vendor/stacki/shared/core/assert';
import { applyVariableOperation } from '../src/features/variables/variableOperations';
import { VARIABLE_ROOT, withVariableWorkspace } from '../src/features/variables/variableWorkspace';
import { record, string } from '../src/shared/validation';
import { sha256Hex } from './nodeCrypto';

const VARIABLE_FILE = /\.(astro|css)$/;
const VARIABLE_FILES_MAX = 1_000;
export const VARIABLE_CONFLICT = 'A collaborator changed this source. Refresh and try again.';

export interface VariableFiles {
  /** Every project file the engine may read, as the visitor has it now. */
  readonly sources: () => ReadonlyMap<string, string>;
  readonly write: (file: string, source: string) => void;
}

function variableSources(files: VariableFiles): Map<string, string> {
  const sources = new Map([...files.sources()].filter(([file]) => VARIABLE_FILE.test(file)));
  if (sources.size > VARIABLE_FILES_MAX) {
    throw new Error('Variable scan exceeds 1,000 source files');
  }
  return sources;
}

function versionsOf(sources: ReadonlyMap<string, string>): Readonly<Record<string, string>> {
  return Object.fromEntries([...sources].map(([file, text]) => [file, sha256Hex(text)]));
}

/** What the server's GET answers: the variable tree plus a version per file. */
export function readDemoVariables(files: VariableFiles): unknown {
  const sources = variableSources(files);
  return withVariableWorkspace(sources, () => ({ ...readVariables(VARIABLE_ROOT), versions: versionsOf(sources) }));
}

/** What the server's POST answers. Nothing is written unless every changed file is current. */
export function editDemoVariables(files: VariableFiles, body: unknown): unknown {
  const input = record(body);
  const operation = string(input['operation'], 50);
  const before = variableSources(files);
  const next = new Map(before);
  const result: unknown = withVariableWorkspace(next, () => applyVariableOperation(operation, input['payload']));
  if (record(result)['ok'] !== true) {
    return result;
  }
  const versions = record(input['versions']);
  const changed = [...next].filter(([file, text]) => before.get(file) !== text);
  for (const [file] of changed) {
    if (operation !== 'restoreCssVariables' && versions[file] !== sha256Hex(before.get(file) ?? '')) {
      return { ok: false, error: VARIABLE_CONFLICT };
    }
  }
  for (const [file, text] of changed) {
    assert(before.has(file), 'Variables only edit files that exist');
    files.write(file, text);
  }
  return { ok: true };
}
