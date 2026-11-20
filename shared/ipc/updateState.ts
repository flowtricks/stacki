// What the in-app update popup shows, and the pure model behind its progress bar.
//
// Main owns the truth (electron/app/autoUpdate.ts reads the auto updater's events) and sends the renderer one
// `UpdateState` per change on `update:state`; the renderer reads the current one on mount with `update:read` and answers
// with `update:act`. Every value that crosses is parsed here first (docs/contracts.md, "Update popup").
import { assert } from '../core/assert';
import { count, object, record, text } from '../core/boundary';

/** One tebibyte: far beyond any installer, so a larger number is a corrupt report, not a big download. */
export const UPDATE_BYTES_MAX = 2 ** 40;
const BYTES_PER_MEGABYTE = 1024 * 1024;
const VERSION_CHARS_MAX = 64;
const DETAIL_CHARS_MAX = 200;

export interface DownloadProgress {
  readonly transferredBytes: number;
  /** Absent while the feed has not said how large the download is. */
  readonly totalBytes: number | undefined;
  /** Whole percent, 0 to 100; 0 while the total is unknown. */
  readonly percent: number;
}

export const NO_DOWNLOAD_PROGRESS: DownloadProgress = { transferredBytes: 0, totalBytes: undefined, percent: 0 };

export type UpdateNotice = 'latest' | 'development' | 'alreadyChecking';
export type UpdateErrorStage = 'check' | 'download';

export type UpdateState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'downloading'; readonly version: string | undefined; readonly progress: DownloadProgress }
  | { readonly kind: 'ready'; readonly version: string }
  // An answer to the File menu's check that is not an update: shown once, never stored by main.
  | { readonly kind: 'notice'; readonly notice: UpdateNotice; readonly version: string }
  | { readonly kind: 'error'; readonly stage: UpdateErrorStage; readonly detail: string };

export type UpdateAction = 'install' | 'retry';

const NOTICES = ['latest', 'development', 'alreadyChecking'] as const satisfies readonly UpdateNotice[];
const ERROR_STAGES = ['check', 'download'] as const satisfies readonly UpdateErrorStage[];
const ACTIONS = ['install', 'retry'] as const satisfies readonly UpdateAction[];

/** The whole percent `transferred` of `total` is, held to 0..100; 0 while the total is unknown. */
export function percentOf(transferredBytes: number, totalBytes: number | undefined): number {
  assert(Number.isSafeInteger(transferredBytes), 'percentOf: transferred is a safe integer');
  assert(transferredBytes >= 0, 'percentOf: transferred is not negative');
  if (totalBytes === undefined) {
    return 0;
  }
  assert(totalBytes > 0, 'percentOf: a known total is positive');
  // Floor on purpose: 100% is shown only when every byte is in.
  const percent = Math.floor((Math.min(transferredBytes, totalBytes) * 100) / totalBytes);
  assert(percent >= 0, 'percentOf: percent is not negative');
  assert(percent <= 100, 'percentOf: percent is at most 100');
  return percent;
}

/** A byte count from an untrusted report, or undefined when it is not one (NaN, negative, infinite, absurd). */
function reportedBytes(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > UPDATE_BYTES_MAX) {
    return undefined;
  }
  return Math.floor(value);
}

/**
 * The progress after the updater reports `reported`, which is untrusted: the auto updater can send NaN for a download of
 * unknown length and a resumed one can restart its count. Bytes never go backwards, a total that is not a positive count is
 * "unknown" (the last known total stays), and the percent never falls, so the bar only ever moves forward.
 */
export function advanceProgress(previous: DownloadProgress, reported: { readonly transferred: unknown; readonly total: unknown }): DownloadProgress {
  const reportedTotal = reportedBytes(reported.total);
  const totalBytes = reportedTotal !== undefined && reportedTotal > 0 ? reportedTotal : previous.totalBytes;
  const reportedTransferred = reportedBytes(reported.transferred) ?? previous.transferredBytes;
  const transferredBytes = Math.max(previous.transferredBytes, totalBytes === undefined ? reportedTransferred : Math.min(reportedTransferred, totalBytes));
  const percent = Math.max(previous.percent, percentOf(transferredBytes, totalBytes));
  assert(transferredBytes >= previous.transferredBytes, 'advanceProgress: bytes do not go backwards');
  assert(percent >= previous.percent, 'advanceProgress: percent does not go backwards');
  return { transferredBytes, totalBytes, percent };
}

/** Megabytes to one decimal place, for the counter ("48.2 of 52.4 MB"). */
export function megabytesOf(bytes: number): number {
  assert(Number.isSafeInteger(bytes), 'megabytesOf: bytes is a safe integer');
  assert(bytes >= 0, 'megabytesOf: bytes is not negative');
  return Math.round((bytes * 10) / BYTES_PER_MEGABYTE) / 10;
}

/** Whether the popup would look different: a new percent or a new tenth of a megabyte. Keeps the event rate to what is visible. */
export function progressChangesDisplay(previous: DownloadProgress, next: DownloadProgress): boolean {
  if (previous.percent !== next.percent) {
    return true;
  }
  if (previous.totalBytes !== next.totalBytes) {
    return true;
  }
  return megabytesOf(previous.transferredBytes) !== megabytesOf(next.transferredBytes);
}

export function parseDownloadProgress(input: unknown): DownloadProgress {
  const value = record(input);
  const transferredBytes = count(value['transferredBytes']);
  if (transferredBytes > UPDATE_BYTES_MAX) {
    throw new Error('DownloadProgress.transferredBytes: exceeds limit');
  }
  const total = value['totalBytes'];
  let totalBytes: number | undefined = undefined;
  if (total !== undefined) {
    totalBytes = count(total);
    if (totalBytes === 0) {
      throw new Error('DownloadProgress.totalBytes: a known total is positive');
    }
    if (totalBytes > UPDATE_BYTES_MAX) {
      throw new Error('DownloadProgress.totalBytes: exceeds limit');
    }
    if (transferredBytes > totalBytes) {
      throw new Error('DownloadProgress: transferred exceeds total');
    }
  }
  const percent = count(value['percent']);
  if (percent !== percentOf(transferredBytes, totalBytes)) {
    throw new Error('DownloadProgress.percent: does not match the bytes');
  }
  return { transferredBytes, totalBytes, percent };
}

function boundedText(input: unknown, label: string, charsMax: number): string {
  const value = text(input);
  if (value.length === 0) {
    throw new Error(`${label}: expected non-empty text`);
  }
  if (value.length > charsMax) {
    throw new Error(`${label}: exceeds limit`);
  }
  return value;
}

const parseVersion = (input: unknown): string => boundedText(input, 'UpdateState.version', VERSION_CHARS_MAX);

function oneOf<T extends string>(input: unknown, allowed: readonly T[], label: string): T {
  const found = allowed.find((candidate) => candidate === input);
  if (found === undefined) {
    throw new Error(`${label}: unknown value`);
  }
  return found;
}

export function parseUpdateState(input: unknown): UpdateState {
  const value = record(input);
  const kind = value['kind'];
  switch (kind) {
    case 'idle':
      return { kind: 'idle' };
    case 'downloading':
      return {
        kind: 'downloading',
        version: value['version'] === undefined ? undefined : parseVersion(value['version']),
        progress: parseDownloadProgress(value['progress']),
      };
    case 'ready':
      return { kind: 'ready', version: parseVersion(value['version']) };
    case 'notice':
      return { kind: 'notice', notice: oneOf(value['notice'], NOTICES, 'UpdateState.notice'), version: parseVersion(value['version']) };
    case 'error':
      return {
        kind: 'error',
        stage: oneOf(value['stage'], ERROR_STAGES, 'UpdateState.stage'),
        // The detail may be empty: some failures carry no message worth showing.
        detail: text(value['detail']).slice(0, DETAIL_CHARS_MAX),
      };
    default:
      throw new Error('UpdateState.kind: unknown value');
  }
}

export const parseUpdateAction = (input: unknown): { readonly action: UpdateAction } =>
  object({ action: (action: unknown) => oneOf(action, ACTIONS, 'UpdateAction') })(input);

/** One `update:state` push. `reveal` says this is news to show even to a person who hid the popup; progress ticks are not. */
export interface UpdateEvent {
  readonly state: UpdateState;
  readonly reveal: boolean;
}

export function parseUpdateEvent(input: unknown): UpdateEvent {
  const value = record(input);
  if (typeof value['reveal'] !== 'boolean') {
    throw new Error('UpdateEvent.reveal: expected boolean');
  }
  return { state: parseUpdateState(value['state']), reveal: value['reveal'] };
}

/**
 * Whether the popup stays hidden after `event`, given how it was. A hidden download stays hidden while it only
 * advances; anything marked news (a new kind, a notice, an error, a finished download, a menu check) shows again.
 */
export function nextUpdateHidden(event: UpdateEvent, previous: { readonly hidden: boolean }): boolean {
  if (event.reveal) {
    return false;
  }
  if (event.state.kind === 'downloading') {
    return previous.hidden;
  }
  return false;
}
