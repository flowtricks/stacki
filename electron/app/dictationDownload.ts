// Downloads one dictation model's files into the app data folder, byte for byte as pinned in
// shared/properties/voice/whisperModels.ts. Every rule below exists because the bytes end up
// executed by the ONNX runtime in the renderer:
//
//   - the address is pinned to a commit, and each redirect is followed by hand, only to a pinned
//     host (`isAllowedURL`), at most `redirectsMax` times;
//   - each file is streamed into `<file>.part`, never past its manifest size, and its SHA-256 is
//     computed on the way; a mismatch deletes the part and refuses the model;
//   - a finished file is renamed into place (atomic on one volume), so a reader sees the whole file
//     or none of it; the folder counts as installed only when `verified.json` lists every hash,
//     written last, the same way;
//   - an interrupted download keeps its `.part` file and resumes with a Range request; a server
//     that ignores the range starts the file again from zero;
//   - no headers within `connectMsMax`, or no byte for `stallMsMax`, ends the file as a timeout.
//
// The network and the clock are passed in (`DownloadDeps`) so the tests run against a local HTTP
// server with a loopback allow-list (test/electron/app/dictationDownload.test.ts).
import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { DICTATION_LIMITS } from '../../shared/properties/voice/dictationLimits';
import type { DownloadFailure, DownloadOutcome } from '../../shared/properties/voice/dictationModel';
import { isSafeModelPath, modelTotalBytes, type ModelFile, type WhisperModel } from '../../shared/properties/voice/whisperModels';

export interface DownloadDeps {
  readonly fetch: (
    url: string,
    init: { readonly redirect: 'manual'; readonly headers: Record<string, string>; readonly signal: AbortSignal },
  ) => Promise<Response>;
  /** Whether a file may be fetched from this address (the first one and every redirect). */
  readonly isAllowedURL: (url: URL) => boolean;
  /** The address of one file before any redirect. */
  readonly urlOf: (file: ModelFile) => string;
  /** The bytes received so far over the whole model, called as they arrive. */
  readonly onProgress: (receivedBytes: number, totalBytes: number) => void;
  readonly setTimer: (callback: () => void, delayMs: number) => () => void;
}

/** The file that marks a folder as complete: the model, its revision and every hash, written last. */
export const VERIFIED_FILE = 'verified.json';
export const PART_SUFFIX = '.part';

/** A failure on the way, carried to the one place that turns it into an outcome. */
class DownloadStop extends Error {
  constructor(readonly failure: DownloadFailure) {
    super(failure);
  }
}

/**
 * Downloads every file of `model` into `directory` that is not there yet, verified. Resolves to
 * the outcome; never rejects for a network or disk problem (those are outcomes), only for a
 * programmer error. `signal` cancels: the part files stay for a later resume.
 */
export async function downloadModel(model: WhisperModel, directory: string, signal: AbortSignal, deps: DownloadDeps): Promise<DownloadOutcome> {
  const totalBytes = modelTotalBytes(model);
  assert(path.isAbsolute(directory), 'downloadModel: the folder is absolute');
  let receivedBefore = 0;
  try {
    await mkdir(directory, { recursive: true });
    for (const file of model.files) {
      const target = fileTarget(directory, file);
      if (await isVerified(target, file)) {
        receivedBefore += file.sizeBytes;
        deps.onProgress(receivedBefore, totalBytes);
        continue;
      }
      await downloadFile(file, target, signal, deps, (fileBytes) => deps.onProgress(receivedBefore + fileBytes, totalBytes));
      receivedBefore += file.sizeBytes;
    }
    await writeVerified(model, directory);
  } catch (error: unknown) {
    return { kind: 'failed', failure: failureOf(error, signal) };
  }
  assert(receivedBefore === totalBytes, 'downloadModel: every byte of the model was received');
  return { kind: 'installed', sizeBytes: totalBytes };
}

/** The absolute path of one model file, checked to stay inside the model's folder. */
export function fileTarget(directory: string, file: ModelFile): string {
  assert(isSafeModelPath(file.path), 'fileTarget: the manifest path is safe');
  const target = path.resolve(directory, ...file.path.split('/'));
  assert(target.startsWith(path.resolve(directory) + path.sep), 'fileTarget: the file stays inside the model folder');
  return target;
}

/** The SHA-256 of a file on disk, read as a stream (a model file is tens of megabytes). */
export async function hashFile(filePath: string, into: Hash = createHash('sha256')): Promise<Hash> {
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    into.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return into;
}

// A finished file of the right size whose bytes hash to the manifest's.
async function isVerified(target: string, file: ModelFile): Promise<boolean> {
  const size = await sizeOf(target);
  if (size !== file.sizeBytes) {
    if (size !== undefined) {
      await rm(target, { force: true });
    }
    return false;
  }
  const digest = (await hashFile(target)).digest('hex');
  if (digest === file.sha256) {
    return true;
  }
  await rm(target, { force: true });
  return false;
}

async function sizeOf(filePath: string): Promise<number | undefined> {
  try {
    return (await stat(filePath)).size;
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function downloadFile(file: ModelFile, target: string, signal: AbortSignal, deps: DownloadDeps, onBytes: (fileBytes: number) => void): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const part = target + PART_SUFFIX;
  let offset = (await sizeOf(part)) ?? 0;
  // A part at the full size cannot be resumed either: a cancel or a stall after the last byte leaves one, and a
  // range starting at the end is refused (416) every time.
  if (offset >= file.sizeBytes) {
    await rm(part, { force: true });
    offset = 0;
  }
  const response = await request(file, offset, signal, deps);
  // A server that ignores the range sends the whole file: start again from its first byte.
  const resumed = response.status === 206 && rangeStart(response) === offset;
  if (!resumed) {
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new DownloadStop('httpStatus');
    }
    offset = 0;
  }
  const hash = createHash('sha256');
  if (offset > 0) {
    await hashFile(part, hash);
  }
  const written = await streamInto(response, part, { offset, file, hash, signal, deps, onBytes });
  if (written !== file.sizeBytes) {
    throw new DownloadStop('httpStatus'); // The body ended early: the part stays for a resume.
  }
  if (hash.digest('hex') !== file.sha256) {
    await rm(part, { force: true });
    throw new DownloadStop('hashMismatch');
  }
  await rename(part, target);
  assert((await sizeOf(target)) === file.sizeBytes, 'downloadFile: the renamed file has the manifest size');
}

// The response for one file, following redirects by hand so every hop is checked.
async function request(file: ModelFile, offset: number, signal: AbortSignal, deps: DownloadDeps): Promise<Response> {
  let url = new URL(deps.urlOf(file));
  for (let hop = 0; hop <= DICTATION_LIMITS.redirectsMax; hop += 1) {
    if (!deps.isAllowedURL(url)) {
      throw new DownloadStop('hostRefused');
    }
    const headers: Record<string, string> = offset > 0 ? { Range: `bytes=${offset}-` } : {};
    const response = await withDeadline(signal, deps, DICTATION_LIMITS.connectMsMax, (bounded) =>
      deps.fetch(url.toString(), { redirect: 'manual', headers, signal: bounded }),
    );
    if (response.status < 300 || response.status >= 400) {
      return response;
    }
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (location === null) {
      throw new DownloadStop('httpStatus');
    }
    url = new URL(location, url);
  }
  throw new DownloadStop('hostRefused'); // More redirects than any pinned host needs.
}

function rangeStart(response: Response): number | undefined {
  const match = /^bytes (\d+)-\d+\/(\d+|\*)$/u.exec(response.headers.get('content-range') ?? '');
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

interface StreamOptions {
  readonly offset: number;
  readonly file: ModelFile;
  readonly hash: Hash;
  readonly signal: AbortSignal;
  readonly deps: DownloadDeps;
  readonly onBytes: (fileBytes: number) => void;
}

// Writes the body after `offset` bytes of the part file; returns the file's size when the body ends.
async function streamInto(response: Response, part: string, options: StreamOptions): Promise<number> {
  const { file, hash, signal, deps } = options;
  const body = response.body;
  if (body === null) {
    throw new DownloadStop('httpStatus');
  }
  const handle = await open(part, options.offset > 0 ? 'a' : 'w');
  const reader = body.getReader();
  let written = options.offset;
  try {
    // Each read returns at least one byte or ends the body, and the size check below throws past the
    // manifest size, so the loop runs at most `sizeBytes` times.
    for (let reads = 0; reads <= file.sizeBytes; reads += 1) {
      const chunk = await withDeadline(signal, deps, DICTATION_LIMITS.stallMsMax, () => reader.read());
      if (chunk.done) {
        break;
      }
      const bytes: unknown = chunk.value;
      if (!(bytes instanceof Uint8Array)) {
        throw new DownloadStop('httpStatus');
      }
      if (written + bytes.byteLength > file.sizeBytes) {
        await reader.cancel();
        await handle.close();
        await rm(part, { force: true });
        throw new DownloadStop('tooLarge');
      }
      await handle.write(bytes);
      hash.update(bytes);
      written += bytes.byteLength;
      options.onBytes(written);
    }
  } finally {
    await handle.close().catch(() => undefined);
    reader.releaseLock();
  }
  assert(written <= file.sizeBytes, 'streamInto: never past the manifest size');
  return written;
}

// Runs `work` with an abort that fires on the person's cancel or after `deadlineMs`, whichever is first.
async function withDeadline<T>(signal: AbortSignal, deps: DownloadDeps, deadlineMs: number, work: (bounded: AbortSignal) => Promise<T>): Promise<T> {
  if (signal.aborted) {
    throw new DownloadStop('cancelled');
  }
  const bounded = new AbortController();
  let timedOut = false;
  const cancel = (): void => bounded.abort();
  signal.addEventListener('abort', cancel, { once: true });
  const clear = deps.setTimer(() => {
    timedOut = true;
    bounded.abort();
  }, deadlineMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    bounded.signal.addEventListener('abort', () => reject(new DownloadStop(timedOut ? 'timeout' : 'cancelled')), { once: true });
  });
  try {
    return await Promise.race([work(bounded.signal), aborted]);
  } finally {
    clear();
    signal.removeEventListener('abort', cancel);
  }
}

/** Writes the marker that says every file is verified, through a temporary file and a rename. */
async function writeVerified(model: WhisperModel, directory: string): Promise<void> {
  const marker = { id: model.id, revision: model.revision, files: model.files.map((file) => ({ path: file.path, sha256: file.sha256 })) };
  assert(marker.files.length === model.files.length, 'writeVerified: the marker lists every file');
  const target = path.join(directory, VERIFIED_FILE);
  await writeFile(target + PART_SUFFIX, `${JSON.stringify(marker)}\n`, 'utf8');
  await rename(target + PART_SUFFIX, target);
}

// The outcome for whatever stopped the download.
function failureOf(error: unknown, signal: AbortSignal): DownloadFailure {
  if (error instanceof DownloadStop) {
    return error.failure;
  }
  if (signal.aborted) {
    return 'cancelled';
  }
  const code = errorCode(error);
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return 'diskFull';
  }
  if (code !== undefined && /^E[A-Z]+$/u.test(code) && !code.startsWith('ECONN') && code !== 'ENOTFOUND' && code !== 'EAI_AGAIN') {
    return 'writeFailed';
  }
  // Undici reports an unreachable host or a dropped connection as a TypeError ("fetch failed").
  return 'offline';
}

function errorCode(error: unknown): string | undefined {
  // An error's code may sit on its cause (undici wraps the socket's error); the chain is short.
  let current: unknown = error;
  for (let depth = 0; depth < ERROR_CAUSE_DEPTH_MAX; depth += 1) {
    if (typeof current === 'object' && current !== null && 'code' in current && typeof current.code === 'string') {
      return current.code;
    }
    if (!(current instanceof Error) || current.cause === undefined) {
      return undefined;
    }
    current = current.cause;
  }
  return undefined;
}

/** Causes followed when looking for an error's code: undici nests two at most. */
const ERROR_CAUSE_DEPTH_MAX = 4;
