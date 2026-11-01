// One contract for all invoke channels. Payload parsers run in main before
// side effects; result types are checked at registration. Rejected operating
// errors keep Electron's existing Promise-rejection channel during migration.
import { count, pathText, record, text } from '../core/boundary';
import type { IpcChannel, IpcPayloads } from './ipcPayloads';
import type { IpcResults } from './ipcResults';
export { parseIpcPayload, IPC_PAYLOADS } from './ipcPayloads';
export type { IpcChannel, IpcPayloads } from './ipcPayloads';
export type { IpcResults } from './ipcResults';

/** What src:readSymbol / src:resolvePath return — a hand-rolled Result pair. */
export type SymbolReadResult =
  | { readonly ok: true; readonly rel: string; readonly text: string; readonly line: number }
  | { readonly ok: false; readonly reason?: 'not-found' | 'too-large' };

export type ResolvePathResult = { readonly ok: true; readonly rel: string } | { readonly ok: false };

export type IpcContract = {
  readonly [K in IpcChannel]: {
    readonly payload: IpcPayloads[K];
    readonly result: IpcResults[K];
  };
};

/** window.avb as the renderer sees it: one method per contracted channel. */
export type AvbBridge = {
  readonly [K in keyof IpcContract]: (payload: IpcContract[K]['payload']) => Promise<IpcContract[K]['result']>;
};

// --- Parsers for the small result unions -----------------------------------
// Built on the bounded boundary parsers, so a result's text, path and line obey
// the same wire limits as every payload.

export function parseSymbolReadResult(input: unknown): SymbolReadResult {
  const value = record(input);
  if (value['ok'] === false) {
    const reason = value['reason'];
    if (reason === undefined) {
      return { ok: false };
    }
    if (reason === 'not-found' || reason === 'too-large') {
      return { ok: false, reason };
    }
    throw new Error(`SymbolReadResult: unknown reason ${JSON.stringify(reason)}`);
  }
  if (value['ok'] !== true) {
    throw new Error('SymbolReadResult.ok: expected boolean');
  }
  return {
    ok: true,
    rel: pathText(value['rel']),
    text: text(value['text']),
    line: count(value['line']),
  };
}

export function parseResolvePathResult(input: unknown): ResolvePathResult {
  const value = record(input);
  if (value['ok'] === false) {
    return { ok: false };
  }
  if (value['ok'] !== true) {
    throw new Error('ResolvePathResult.ok: expected boolean');
  }
  return { ok: true, rel: pathText(value['rel']) };
}

export function parseTextResult(input: unknown): { readonly text: string } {
  return { text: text(record(input)['text']) };
}

export function parseOkResult(input: unknown): { readonly ok: true } {
  if (record(input)['ok'] !== true) {
    throw new Error('OkResult.ok: expected true');
  }
  return { ok: true };
}
