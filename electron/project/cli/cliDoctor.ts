// The health check of one settings file: the app's own parser first, then the key reference.
//
// Why two checks: the app's parsers refuse a file the app cannot use, but most ignore keys they do not know, so a misspelt key is silently
// dead. The registry check reports those as warnings, which is what `stacki doctor` adds over the app's own load.
import { parseDocumentText, refusalOfSource } from '../../../shared/properties/cli/stackiFiles';
import { checkValue, type FileSchema } from '../../../shared/properties/cli/stackiSchema';

export interface Finding {
  readonly file: string;
  readonly level: 'error' | 'warning' | 'ok';
  readonly message: string;
}

export function checkFile(schema: FileSchema, source: string): readonly Finding[] {
  const refusal = refusalOfSource(schema, source);
  if (refusal !== undefined) {
    return [{ file: schema.file, level: 'error', message: `The app refuses this file: ${refusal}` }];
  }
  const document = parseDocumentText(schema, source);
  if (!document.ok) {
    return [{ file: schema.file, level: 'error', message: document.error.message }];
  }
  const reason = checkValue({ kind: 'object', fields: schema.fields }, document.value, schema.file);
  return reason === undefined
    ? [{ file: schema.file, level: 'ok', message: 'Valid.' }]
    : [{ file: schema.file, level: 'warning', message: `The app accepts this file, but the key reference does not: ${reason}` }];
}
