import { gitTransport } from '../../ipc/gitTransport';
// Renderer Git actions parse invoke results before deciding whether a merge can
// continue. Payload types share the main-process inventory; responses stay unknown
// until this boundary because preload does not validate response data.
import { boolean, count, BOUNDARY_LIMITS, pathText, list, object, optional, record, text } from '../../../shared/core/boundary';
import type { IpcPayloads } from '../../../shared/ipc/ipcPayloads';
import type { WireMergeOutcome, WireDeleteOutcome, WireConflictPart } from '../../../shared/ipc/ipcResults';

const mergeFile = object({ path: pathText });
const commonPart = object({ text });
const changedPart = object({ ours: text, theirs: text, merged: optional(text) });

export function parseConflictPart(input: unknown): WireConflictPart {
  const value = record(input);
  if (value['kind'] === 'same') {
    return { kind: 'same', ...commonPart(value) };
  }
  if (value['kind'] !== 'clash') {
    throw new Error('Merge part: expected same or clash');
  }
  const changedBy = value['changedBy'];
  if (changedBy !== 'ours' && changedBy !== 'theirs' && changedBy !== 'both') {
    throw new Error('Merge part: unknown changed side');
  }
  return { kind: 'clash', changedBy, ...changedPart(value) };
}
function parseMergeFiles(input: unknown) {
  let remaining = BOUNDARY_LIMITS.itemsMax;
  const files = list((entry) => {
    if (--remaining < 0) {
      throw new Error('Merge files: item limit exceeded');
    }
    const value = record(entry);
    const parts = optional(
      list((part) => {
        if (--remaining < 0) {
          throw new Error('Merge files: item limit exceeded');
        }
        return parseConflictPart(part);
      }),
    )(value['parts']);
    // A side that deleted the file has no text: the key stays, its value undefined.
    const ours = optional(text)(value['ours']);
    const theirs = optional(text)(value['theirs']);
    return { ...mergeFile(value), ours, theirs, parts };
  })(input);
  if (files.length === 0) {
    throw new Error('Merge files: at least one conflict is required');
  }
  return files;
}
const mergeSuccess = object({ changed: boolean, resolved: optional(count) });
const mergeConflict = object({ branch: text, files: parseMergeFiles });
const mergeDirty = object({ branch: text, files: list(text) });
const parkResult = object({
  ok: boolean,
  parked: optional(boolean),
  branch: optional(text),
  error: optional(text),
});
const unparkResult = object({ restored: boolean, error: optional(text) });

export function parseMergeResult(input: unknown): WireMergeOutcome {
  const value = record(input);
  if (value['ok'] === true) {
    return { ok: true, into: optional(text)(value['into']), ...mergeSuccess(value) };
  }
  if (value['ok'] !== false) {
    throw new Error('Merge result must declare success or failure');
  }
  const from = optional(text)(value['from']);
  if (value['conflicted'] === true) {
    return { ok: false, conflicted: true, from, ...mergeConflict(value) };
  }
  if (value['dirty'] === true) {
    return { ok: false, dirty: true, from, ...mergeDirty(value) };
  }
  throw new Error('Merge failure must identify dirty files or conflicts');
}
export function parseDeleteResult(input: unknown): WireDeleteOutcome {
  const value = record(input);
  if (value['ok'] === true) {
    return { ok: true };
  }
  if (value['ok'] === false && value['unmerged'] === true) {
    return { ok: false, unmerged: true, message: text(value['message']) };
  }
  throw new Error('Delete result must declare success or unmerged commits');
}
export async function gitMerge(payload: IpcPayloads['git:merge']): Promise<WireMergeOutcome> {
  return parseMergeResult(await gitTransport.gitMerge(payload));
}
export async function gitDeleteBranch(payload: IpcPayloads['git:deleteBranch']): Promise<WireDeleteOutcome> {
  return parseDeleteResult(await gitTransport.gitDeleteBranch(payload));
}
export async function gitPark(payload: IpcPayloads['git:park']) {
  return parkResult(await gitTransport.gitPark(payload));
}
export async function gitUnpark(payload: IpcPayloads['git:unpark']) {
  return unparkResult(await gitTransport.gitUnpark(payload));
}
