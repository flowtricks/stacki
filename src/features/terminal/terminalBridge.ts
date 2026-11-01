import type { IpcPayloads } from '../../../shared/ipc/ipcPayloads';
import type { IpcResults } from '../../../shared/ipc/ipcResults';
import type { Parser } from '../../../shared/core/boundary';
import { boolean, count, pathText, record, text } from '../../../shared/core/boundary';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import type { Result } from '../../../shared/core/result';
import { cleanError } from '../../lib/cleanError';

export const TERMINAL_IMAGE_BYTES_MAX = 20 * 1024 * 1024;

export interface TerminalDataEvent {
  readonly id: string;
  readonly data: string;
}
export interface TerminalExitEvent {
  readonly id: string;
  readonly exitCode: number;
}
export interface TerminalProcessEvent {
  readonly id: string;
  readonly name: string;
}

export function startTerminal(options: IpcPayloads['terminal:start']) {
  const payload = parseIpcPayload('terminal:start', options);
  return terminalRequest(parseStartResult, () => window.avb.startTerminal(payload));
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  const payload = parseIpcPayload('terminal:resize', { id, cols, rows });
  return terminalRequest(parseBooleanResult, () => window.avb.resizeTerminal(payload));
}

export function closeTerminal(id: string) {
  const payload = parseIpcPayload('terminal:close', { id });
  return terminalRequest(parseBooleanResult, () => window.avb.closeTerminal(payload));
}

export function saveTerminalClipboardImage(bytes: Uint8Array, mime: string) {
  if (bytes.byteLength > TERMINAL_IMAGE_BYTES_MAX) {
    return Promise.resolve({ ok: false, error: 'Clipboard image exceeds 20 MB.' } as const);
  }
  return terminalRequest(parseClipboardResult, () => window.avb.terminalClipboardImage(bytes, text(mime)));
}

export function sendTerminalInput(id: string, data: string): void {
  window.avb.terminalInput(text(id), text(data));
}

export function acknowledgeTerminalData(id: string, characters: number): void {
  window.avb.terminalAck(text(id), count(characters));
}

export function requestNativePaste(): void {
  const payload = parseIpcPayload('native:paste', undefined);
  void terminalRequest(parseSuccess, () => window.avb.nativePaste(payload));
}

export function terminalFilePath(file: File): string {
  const value = window.avb.getFilePath(file);
  return value === undefined ? '' : pathText(value);
}

export function onTerminalData(callback: (event: TerminalDataEvent) => void): () => void {
  return window.avb.onTerminalData((input) => callback(parseTerminalData(input)));
}

export function onTerminalExit(callback: (event: TerminalExitEvent) => void): () => void {
  return window.avb.onTerminalExit((input) => callback(parseTerminalExit(input)));
}

export function onTerminalProcess(callback: (event: TerminalProcessEvent) => void): () => void {
  return window.avb.onTerminalProcess((input) => callback(parseTerminalProcess(input)));
}

export function parseTerminalData(input: unknown): TerminalDataEvent {
  const value = record(input);
  return { id: text(value['id']), data: text(value['data']) };
}

export function parseTerminalExit(input: unknown): TerminalExitEvent {
  const value = record(input);
  return { id: text(value['id']), exitCode: count(value['exitCode']) };
}

export function parseTerminalProcess(input: unknown): TerminalProcessEvent {
  const value = record(input);
  return { id: text(value['id']), name: text(value['name']) };
}

function parseStartResult(input: unknown): IpcResults['terminal:start'] {
  const value = record(input);
  if (boolean(value['ok'])) {
    return { ok: true, id: text(value['id']) };
  }
  return { ok: false, error: text(value['error']) };
}

function parseBooleanResult(input: unknown): { readonly ok: boolean } {
  return { ok: boolean(record(input)['ok']) };
}

function parseClipboardResult(input: unknown): IpcResults['terminal:clipboardImage'] {
  const value = record(input);
  if (boolean(value['ok'])) {
    return { ok: true, path: pathText(value['path']) };
  }
  return { ok: false, error: text(value['error']) };
}

function parseSuccess(input: unknown): { readonly ok: true } {
  if (!boolean(record(input)['ok'])) {
    throw new Error('Terminal operation: expected success');
  }
  return { ok: true };
}

async function terminalRequest<Value>(parse: Parser<Value>, invoke: () => Promise<unknown>): Promise<Result<Value, string>> {
  let response: unknown;
  try {
    response = await invoke();
  } catch (error: unknown) {
    return { ok: false, error: cleanError(error) };
  }
  return { ok: true, value: parse(response) };
}
