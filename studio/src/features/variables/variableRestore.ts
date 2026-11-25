import { record, sourcePath, string } from '../../shared/validation';
import { variableFiles, VARIABLE_ROOT, writeProjectText } from './variableWorkspace';

// History carries the exact expected source, rather than trusting a newer scan's
// version. Undo must not overwrite a collaborator's edits made since the command.
export function restoreVariableOperation(input: unknown) {
  const data = record(input);
  const expected = record(data['expected']);
  const texts = record(data['texts']);
  const files = Object.keys(texts);
  if (files.length > 1000) {
    throw new Error('Too many variable history files');
  }
  const changes = files.map((file) => ({
    path: VARIABLE_ROOT + '/' + sourcePath(file),
    source: string(texts[file]),
    base: string(expected[file]),
  }));
  for (const change of changes) {
    if (variableFiles.readFileSync(change.path, 'utf8') !== change.base) {
      return {
        ok: false,
        // i18n-ignore: a server reply carried to the panel as plain text; the renderer shows server text as received (playbook section 3).
        error: 'A collaborator changed this stylesheet. Undo would replace their edits.',
      };
    }
  }
  for (const change of changes) {
    writeProjectText(change.path, change.source);
  }
  return { ok: true };
}
