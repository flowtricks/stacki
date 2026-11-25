import { cmsTransport } from '../../ipc/editorEnvironment';
import type { Data, Parser } from '../../../shared/core/boundary';
import type { Result } from '../../../shared/core/result';
import { boolean, count, data, list, optional, pathText, record, text } from '../../../shared/core/boundary';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { cleanError } from '../../lib/cleanError';

export interface CmsPanelFile {
  readonly rel: string;
  readonly name: string;
  readonly dir: string;
  readonly data?: Data;
  readonly error?: string;
}

export interface CmsPanelContentCollection {
  readonly name: string;
  readonly editable: boolean;
  readonly loader?: {
    readonly kind: string;
    readonly base?: string;
    readonly file?: string;
  };
  readonly error: string | undefined;
  readonly count: number;
}

export interface CmsPanelContent {
  readonly collections: readonly CmsPanelContentCollection[];
  readonly covered: {
    readonly files: readonly string[];
    readonly dirs: readonly string[];
  };
  readonly configPath?: string;
}

const emptyContent: CmsPanelContent = {
  collections: [],
  covered: { files: [], dirs: [] },
};

export function parseCmsFiles(input: unknown): readonly CmsPanelFile[] {
  return list(parseCmsFile)(record(input)['files']);
}

export function parseContentCollections(input: unknown): CmsPanelContent {
  const value = record(input);
  const collections = list(parseContentCollection)(value['collections']);
  const coveredInput = value['covered'];
  if (coveredInput === undefined) {
    parseUnavailableContent(value, collections.length);
    const configPath = optional(pathText)(value['configPath']);
    return configPath === undefined ? emptyContent : { ...emptyContent, configPath };
  }
  const covered = record(coveredInput);
  const configPath = optional(pathText)(value['configPath']);
  return withOptionalConfigPath(
    {
      collections,
      covered: {
        files: list(pathText)(covered['files']),
        dirs: list(pathText)(covered['dirs']),
      },
    },
    configPath,
  );
}

export function parseCmsCreate(input: unknown): { readonly rel: string } {
  return { rel: pathText(record(input)['rel']) };
}

export function readCmsFiles(projectPath: string) {
  const payload = parseIpcPayload('cms:list', projectPath);
  return request(parseCmsFiles, () => cmsTransport.listCms(payload));
}

export function readContentCollections(projectPath: string) {
  const payload = parseIpcPayload('content:collections', projectPath);
  return request(parseContentCollections, () => cmsTransport.contentCollections(payload));
}

export function createCmsCollection(projectPath: string, name: string) {
  const payload = parseIpcPayload('cms:create', { projectPath, name });
  return request(parseCmsCreate, () => cmsTransport.createCms(payload));
}

function parseCmsFile(input: unknown): CmsPanelFile {
  const value = record(input);
  const parsed = {
    rel: pathText(value['rel']),
    name: text(value['name']),
    dir: pathText(value['dir']),
  };
  const fileData = optional(data)(value['data']);
  const error = optional(text)(value['error']);
  return {
    ...parsed,
    ...(fileData === undefined ? {} : { data: fileData }),
    ...(error === undefined ? {} : { error }),
  };
}

function parseContentCollection(input: unknown): CmsPanelContentCollection {
  const value = record(input);
  const loader = optional(parseLoader)(value['loader']);
  return {
    name: text(value['name']),
    editable: value['editable'] === undefined ? false : boolean(value['editable']),
    ...(loader === undefined ? {} : { loader }),
    error: optional(text)(value['error']),
    count: count(value['count']),
  };
}

function parseLoader(input: unknown): NonNullable<CmsPanelContentCollection['loader']> {
  const value = record(input);
  const base = optional(pathText)(value['base']);
  const file = optional(pathText)(value['file']);
  return {
    kind: text(value['kind']),
    ...(base === undefined ? {} : { base }),
    ...(file === undefined ? {} : { file }),
  };
}

function parseUnavailableContent(value: Readonly<Record<string, unknown>>, collectionCount: number): void {
  if (collectionCount !== 0) {
    throw new Error('Content collections: missing covered paths');
  }
  optional(text)(value['error']);
  const missing = optional(boolean)(value['missing']);
  if (missing === false) {
    throw new Error('Content collections: missing must be true');
  }
}

function withOptionalConfigPath(value: Omit<CmsPanelContent, 'configPath'>, configPath: string | undefined): CmsPanelContent {
  return configPath === undefined ? value : { ...value, configPath };
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
