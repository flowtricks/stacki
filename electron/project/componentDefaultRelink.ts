// A renamed or moved file keeps being the one a component default imports: `.stacki/components.json` is rewritten after the
// move. Without this the next insert would name a file that is not there.
//
// The move has already happened when this runs, so nothing here fails it. A settings file that does not read, or one that
// changed while this wrote, is left as it is: inserting then goes without the missing file and says so, and
// `check-project` names it.
import { parseDefaultsSource } from '../../shared/properties/componentDefaults';
import { relinkDefaultAssets } from '../../shared/properties/componentDefaultValues';
import { assert } from '../../shared/core/assert';
import { FILE_EXPLORER_LIMITS } from '../../shared/ipc/fileExplorer';
import { readProjectMetadata, writeProjectMetadata } from './projectMetadata';

/** `moves` are project-relative paths, of files or folders, `/`-separated. */
export function relinkMovedDefaultAssets(projectPath: string, moves: readonly { readonly from: string; readonly to: string }[]): void {
  assert(projectPath.length > 0, 'relinkMovedDefaultAssets: the project is named');
  assert(moves.length <= FILE_EXPLORER_LIMITS.batchItemsMax, 'relinkMovedDefaultAssets: one move batch is bounded');
  const stored = readProjectMetadata(projectPath, 'components');
  if (!stored.ok || stored.value.source === undefined) {
    return;
  }
  const parsed = parseDefaultsSource(stored.value.source);
  if (!parsed.ok) {
    return;
  }
  const relinked = moves.reduce((config, move) => (move.from === move.to ? config : relinkDefaultAssets(config, move.from, move.to)), parsed.value);
  if (relinked === parsed.value) {
    return;
  }
  const written = writeProjectMetadata(projectPath, { kind: 'components', source: `${JSON.stringify(relinked, undefined, 2)}\n`, base: stored.value.source });
  if (!written.ok) {
    console.warn('Component defaults were not relinked after a move:', written.error.message);
  }
}
