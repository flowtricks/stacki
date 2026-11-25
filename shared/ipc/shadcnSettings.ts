import { boolean, object, record, text } from '../core/boundary';
import { err, ok, type Result } from '../core/result';
import { parseAbsolutePath } from './astroCopy';

export const parseShadcnSettingsRequest = object({ projectPath: parseAbsolutePath });
export const parseShadcnSettingsChange = object({ projectPath: parseAbsolutePath, setting: parseSetting, enabled: boolean });
const parseSettings = object({ pointer: boolean, rtl: boolean });
const parseError = object({ message: text });

export type ShadcnSettings = ReturnType<typeof parseSettings>;
export type ShadcnSettingsChange = ReturnType<typeof parseShadcnSettingsChange>;
export type ShadcnSettingsReply = Result<ShadcnSettings | undefined, { readonly message: string }>;

export function parseShadcnSettingsReply(input: unknown): ShadcnSettingsReply {
  const fields = record(input);
  if (!boolean(fields['ok'])) {
    return err(parseError(fields['error']));
  }
  return ok(fields['value'] === undefined ? undefined : parseSettings(fields['value']));
}

function parseSetting(input: unknown): 'pointer' | 'rtl' {
  if (input === 'pointer' || input === 'rtl') {
    return input;
  }
  throw new Error('Unknown shadcn setting.');
}
