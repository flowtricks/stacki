// The renderer's side of the Pages panel's Select mode: each reply is read at the boundary into a Result whose error
// keeps main's catalog reference, so a refusal shows in the language on screen. Undo and Redo are the Page settings
// ones (pageSettingsBridge.ts `revertPageSettings`): the step lives in the same history.
import { boolean, record } from '../../shared/core/boundary';
import { err, ok, type Result } from '../../shared/core/result';
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import {
  parsePageBulkRemoveApplied,
  parsePageBulkRemoveSummary,
  type PageBulkRemoveApplied,
  type PageBulkRemoveRequest,
  type PageBulkRemoveSummary,
} from '../../shared/properties/pageBulkRemove';
import { parseSettingsError } from './pageSettingsBridge';

export async function planRemovePages(projectPath: string, request: PageBulkRemoveRequest): Promise<Result<PageBulkRemoveSummary>> {
  const payload = parseIpcPayload('page:planRemoveMany', { projectPath, request });
  return readReply(await window.avb.planRemovePages(payload), parsePageBulkRemoveSummary);
}

export async function removePages(projectPath: string, request: PageBulkRemoveRequest): Promise<Result<PageBulkRemoveApplied>> {
  const payload = parseIpcPayload('page:removeMany', { projectPath, request });
  return readReply(await window.avb.removePages(payload), parsePageBulkRemoveApplied);
}

function readReply<T>(input: unknown, parseValue: (value: unknown) => T): Result<T> {
  const reply = record(input);
  if (boolean(reply['ok'])) {
    return ok(parseValue(reply['value']));
  }
  return err(parseSettingsError(reply['error']));
}
