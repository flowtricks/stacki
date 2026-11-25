// The renderer's side of the Page settings dialog: each reply is read at the boundary into a Result whose error keeps
// main's catalog reference, so a refusal shows in the language on screen.
import { boolean, count, record, text } from '../../shared/core/boundary';
import { parseOptionalMessageRef } from '../../shared/core/i18n/messageReference';
import { err, ok, type AppError, type Result } from '../../shared/core/result';
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import {
  parsePageSettingsApplied,
  parsePageSettingsSummary,
  type PageSettingsApplied,
  type PageSettingsDirection,
  type PageSettingsRequest,
  type PageSettingsSummary,
} from '../../shared/properties/pageSettings';
import type { DataSource } from '../../shared/properties/pageTemplate';
import { parseTemplateReading, type TemplateReading } from '../../shared/properties/pageTemplateReading';

export async function planPageSettings(projectPath: string, request: PageSettingsRequest): Promise<Result<PageSettingsSummary>> {
  const payload = parseIpcPayload('page:planSettings', { projectPath, request });
  return readReply(await window.avb.planPageSettings(payload), parsePageSettingsSummary);
}

export async function applyPageSettings(projectPath: string, request: PageSettingsRequest): Promise<Result<PageSettingsApplied>> {
  const payload = parseIpcPayload('page:applySettings', { projectPath, request });
  return readReply(await window.avb.applyPageSettings(payload), parsePageSettingsApplied);
}

export async function revertPageSettings(token: string, direction: PageSettingsDirection): Promise<Result<{ readonly files: number }>> {
  const payload = parseIpcPayload('page:revertSettings', { token, direction });
  return readReply(await window.avb.revertPageSettings(payload), (value) => ({ files: count(record(value)['files']) }));
}

export async function readPageTemplateSettings(projectPath: string, page: string): Promise<TemplateReading> {
  const payload = parseIpcPayload('page:readTemplate', { projectPath, page });
  return parseTemplateReading(await window.avb.readPageTemplate(payload));
}

export async function retargetPageTemplate(projectPath: string, page: string, source: DataSource): Promise<Result<PageSettingsApplied>> {
  const payload = parseIpcPayload('page:retargetTemplate', { projectPath, page, source });
  return readReply(await window.avb.retargetPageTemplate(payload), parsePageSettingsApplied);
}

export function parseSettingsError(input: unknown): AppError {
  const value = record(input);
  const code = text(value['code']);
  const message = text(value['message']);
  const messageRef = parseOptionalMessageRef(value['messageRef']);
  return messageRef === undefined ? { code, message } : { code, message, messageRef };
}

function readReply<T>(input: unknown, parseValue: (value: unknown) => T): Result<T> {
  const reply = record(input);
  if (boolean(reply['ok'])) {
    return ok(parseValue(reply['value']));
  }
  return err(parseSettingsError(reply['error']));
}
