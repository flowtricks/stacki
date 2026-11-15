// Saving what the person ticks on the Breakpoints screen into `.stacki/breakpoint-sync.json` (shared/properties/breakpointSyncRecord.ts):
// one write per toggle, through the metadata transport (witnessed, atomic), read again just before so an edit from another window or a
// pull is never overwritten. Writes for one project run one after another. An unreadable record is never written over; a choice that
// changes nothing writes nothing, and nothing here runs when a scan merely finishes.
import { err, ok, type AppError, type Result } from '../../shared/core/result';
import { parseBreakpointSyncSource, recordsEqual, serializeBreakpointSyncRecord } from '../../shared/properties/breakpointSyncRecord';
import { recordWithChoices, type PlaceChoice } from '../../shared/properties/breakpointSyncSelection';
import { readMetadata, writeMetadata } from './projectMetadataBridge';

const chains = new Map<string, Promise<unknown>>();

/** Remembers `choices` for breakpoint `id`. An error value when the record cannot be read or written. */
export function saveChoices(projectPath: string, id: string, choices: readonly PlaceChoice[]): Promise<Result<void>> {
  const previous = chains.get(projectPath) ?? Promise.resolve();
  const run = previous.then(
    () => write(projectPath, id, choices),
    () => write(projectPath, id, choices),
  );
  chains.set(
    projectPath,
    run.catch(() => undefined),
  );
  return run;
}

async function write(projectPath: string, id: string, choices: readonly PlaceChoice[]): Promise<Result<void>> {
  try {
    const current = await readMetadata(projectPath, 'breakpointSync');
    const parsed = parseBreakpointSyncSource(current.source);
    if (!parsed.ok) {
      return parsed;
    }
    const next = recordWithChoices(parsed.value, id, choices);
    if (recordsEqual(next, parsed.value)) {
      return ok(undefined);
    }
    await writeMetadata(projectPath, {
      kind: 'breakpointSync',
      source: serializeBreakpointSyncRecord(next),
      ...(current.source === undefined ? {} : { base: current.source }),
    });
    return ok(undefined);
  } catch (error: unknown) {
    const failure: AppError = { code: 'breakpoint-sync-choices', message: error instanceof Error ? error.message : String(error) };
    return err(failure);
  }
}
