import { cmsTransport } from '../../ipc/editorEnvironment';
import type { IpcResults, WireCollection, WireEntry, WireImageEdit, WireMove, WirePointer, WireValidationIssue } from '../../../shared/ipc/ipcResults';
import type { Parser } from '../../../shared/core/boundary';
import type { Data } from '../../../shared/core/boundary';
import type { Result } from '../../../shared/core/result';
import { boolean, count, data, list, object, optional, pathText, record, text } from '../../../shared/core/boundary';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { cleanError } from '../../lib/cleanError';

const locatorPart = (input: unknown): string | number => (typeof input === 'string' ? text(input) : count(input));
const schemaPath = list(locatorPart);
const loader = object({
  kind: optional(text),
  base: optional(pathText),
  pattern: optional((input: unknown) => (typeof input === 'string' ? text(input) : list(text)(input))),
  file: optional(pathText),
});

export type ContentEntry = Omit<WireEntry, 'data'> & { readonly data: Data };
export type ContentEntries = Omit<IpcResults['content:entries'], 'entries'> & {
  readonly entries: readonly ContentEntry[];
};

export function parseContentCollection(input: unknown): WireCollection {
  const value = record(input);
  return {
    name: text(value['name']),
    ...optionalFields({
      loader: optional(loader)(value['loader']),
      extensions: optional(list(text))(value['extensions']),
      hasBody: optional(boolean)(value['hasBody']),
      idFromFile: optional(boolean)(value['idFromFile']),
      crossFieldChecks: optional(boolean)(value['crossFieldChecks']),
      freeform: optional(boolean)(value['freeform']),
      error: optional(text)(value['error']),
      editable: optional(boolean)(value['editable']),
      schema: optional(data)(value['schema']),
    }),
  };
}

export function parseContentEntry(input: unknown): ContentEntry {
  const value = record(input);
  return {
    id: text(value['id']),
    file: pathText(value['file']),
    format: text(value['format']),
    locator: schemaPath(value['locator']),
    data: data(value['data']),
    title: text(value['title']),
    ...optionalFields({
      body: optional(text)(value['body']),
      hasBody: optional(boolean)(value['hasBody']),
      error: optional(text)(value['error']),
      keyed: optional(boolean)(value['keyed']),
    }),
  };
}

export function parseContentEntries(input: unknown): ContentEntries {
  const value = record(input);
  return {
    entries: list(parseContentEntry)(value['entries']),
    readOnly: boolean(value['readOnly']),
    collection: parseContentCollection(value['collection']),
    ...optionalFields({
      reason: optional(text)(value['reason']),
      idsAreGuesses: optional(boolean)(value['idsAreGuesses']),
      idNote: optional(text)(value['idNote']),
      shape: optional(text)(value['shape']),
      parsed: optional(boolean)(value['parsed']),
      parserNote: optional(text)(value['parserNote']),
    }),
  };
}

const validationIssue = object({ path: schemaPath, message: text, code: text });
export function parseContentValidation(input: unknown): IpcResults['content:validate'] {
  const value = record(input);
  return {
    issues: list(validationIssue)(value['issues']),
    ...optionalFields({
      unchecked: optional(boolean)(value['unchecked']),
      error: optional(text)(value['error']),
    }),
  };
}

function parseMove(input: unknown): WireMove {
  const value = record(input);
  switch (value['kind']) {
    case 'generated':
    case 'unknown':
      return { kind: value['kind'], note: text(value['note']) };
    case 'file':
      return { kind: 'file', from: pathText(value['from']), to: pathText(value['to']) };
    case 'key':
    case 'field':
      return {
        kind: value['kind'],
        file: pathText(value['file']),
        locator: schemaPath(value['locator']),
      };
    default:
      throw new Error('Content rename move: unknown kind');
  }
}

function parsePointer(input: unknown): WirePointer {
  const value = record(input);
  return {
    collection: text(value['collection']),
    entryId: text(value['entryId']),
    entryTitle: text(value['entryTitle']),
    file: pathText(value['file']),
    path: schemaPath(value['path']),
    entry: object({ file: pathText, locator: schemaPath })(value['entry']),
  };
}

function parseImageEdit(input: unknown): WireImageEdit {
  const value = record(input);
  return {
    path: schemaPath(value['path']),
    from: data(value['from']),
    value: pathText(value['value']),
  };
}

export function parseContentRenamePlan(input: unknown): IpcResults['content:renamePlan'] {
  const value = record(input);
  return {
    entry: object({ id: text, file: pathText })(value['entry']),
    collection: text(value['collection']),
    from: text(value['from']),
    to: text(value['to']),
    move: parseMove(value['move']),
    pointers: list(parsePointer)(value['pointers']),
    imageEdits: list(parseImageEdit)(value['imageEdits']),
  };
}

function parseWrite(input: unknown): void {
  const value = record(input);
  if (!boolean(value['ok'])) {
    throw new Error('Content write: expected success');
  }
  boolean(value['changed']);
}

function parseRename(input: unknown): void {
  const value = record(input);
  boolean(value['renamed']);
  count(value['pointers']);
  list(pathText)(value['files']);
}

async function request<Value>(parse: Parser<Value>, invoke: () => Promise<unknown>): Promise<Result<Value, string>> {
  let response: unknown;
  try {
    response = await invoke();
  } catch (error: unknown) {
    return { ok: false, error: cleanError(error) };
  }
  return { ok: true, value: parse(response) };
}

export function readContentEntries(projectPath: string, name: string) {
  const payload = parseIpcPayload('content:entries', { projectPath, name });
  return request(parseContentEntries, () => cmsTransport.contentEntries(payload));
}

export function readContentTargets(projectPath: string, name: string) {
  const payload = parseIpcPayload('content:targets', { projectPath, name });
  return request(
    (input) => list(object({ id: text, title: text }))(record(input)['targets']),
    () => cmsTransport.contentTargets(payload),
  );
}

export function writeContentEntry(
  projectPath: string,
  entry: { readonly file: string; readonly locator: readonly (string | number)[] },
  edits: readonly unknown[],
  body: string | undefined,
  expected?: { readonly data: unknown; readonly body: string | undefined },
) {
  const input = body === undefined ? { projectPath, entry, edits } : { projectPath, entry, edits, body };
  const payload = parseIpcPayload('content:writeEntry', input);
  return request(parseWrite, () => cmsTransport.writeContentEntry(payload, expected));
}

export function validateContentEntry(projectPath: string, collection: string, value: unknown) {
  const payload = parseIpcPayload('content:validate', { projectPath, collection, data: value });
  return request(parseContentValidation, () => cmsTransport.validateContentEntry(payload));
}

export function planContentRename(projectPath: string, name: string, from: string, to: string) {
  const payload = parseIpcPayload('content:renamePlan', { projectPath, name, from, to });
  return request(parseContentRenamePlan, () => cmsTransport.contentRenamePlan(payload));
}

export function renameContentEntry(projectPath: string, name: string, from: string, to: string) {
  const payload = parseIpcPayload('content:rename', { projectPath, name, from, to });
  return request(parseRename, () => cmsTransport.renameContentEntry(payload));
}

function optionalFields<Value extends Readonly<Record<string, unknown>>>(value: Value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

export type ContentValidationIssue = WireValidationIssue;
