// The page save contract (plan §11 step 0; since step 10 every page save is an
// edit). A page read carries the checksum of the exact bytes it returned; an
// edit names the checksum it was authored against, and main refuses it when
// it cannot be placed on the bytes the file holds now. That refusal is an
// expected operating failure, so it arrives as a Result value. A reply that
// breaks this shape is a programmer error and throws here.
import { toDigest, type Digest } from '../core/brand';
import { parseRejectionReason, type RejectionReason, type SourceEdit } from '../engine/intent';
import { LIMITS } from '../core/limits';
import { parsePageReadResult, type ParsePageResult } from '../page/pageNode';
import { toArray, toRecord } from '../core/record';
import { err, ok, type Result } from '../core/result';
import { parseByteSpan, spansAscending } from '../core/span';

/** A page as read from (or just written to) disk. */
export type PageDiskRead = ParsePageResult & {
  readonly source: string;
  readonly checksum: Digest;
};

/** A write that did not happen, or may have: none of these is a refusal of
 * the edit's content, which is `rejected` (PageEditError). */
export type PageWriteFailure =
  | { readonly code: 'missing'; readonly message: string }
  | { readonly code: 'filesystem'; readonly message: string }
  | { readonly code: 'write-race'; readonly message: string }
  /** The write may have landed; the file's actor could not verify it (§3.5). */
  | { readonly code: 'uncertain'; readonly message: string }
  /** The file's actor queue was full; the edit was never accepted (§7). */
  | { readonly code: 'backpressured'; readonly message: string };

/** An applied visual edit (step 6): the page as written, and the inverse
 * hunks Undo submits against its checksum. */
export type PageEdited = PageDiskRead & { readonly inverse: readonly SourceEdit[] };

/** Why a visual edit did not apply. A refusal names the actor's reason, for
 * the notice (plan §7), and what is on disk when it could be read. */
export type PageEditError =
  | {
      readonly code: 'rejected';
      readonly reason: RejectionReason;
      readonly message: string;
      readonly diskChecksum: Digest | undefined;
    }
  | PageWriteFailure;

export function parsePageEditResult(input: unknown): Result<PageEdited, PageEditError> {
  const record = toRecord(input);
  if (record === undefined) {
    throw new Error('PageEditResult: expected object');
  }
  if (record['ok'] === true) {
    return ok({ ...parsePageDiskRead(input), inverse: parseInverse(record['inverse']) });
  }
  if (record['ok'] === false) {
    return err(parsePageEditError(record['error']));
  }
  throw new Error('PageEditResult.ok: expected boolean');
}

function parseInverse(input: unknown): readonly SourceEdit[] {
  const hunks = toArray(input);
  if (hunks === undefined) {
    throw new Error('PageEdited.inverse: expected array');
  }
  if (hunks.length > LIMITS.splicesPerIntentMax) {
    throw new Error('PageEdited.inverse: exceeds limit');
  }
  const parsed = hunks.map((hunk, index) => {
    const record = toRecord(hunk);
    if (record === undefined) {
      throw new Error(`PageEdited.inverse[${index}]: expected object`);
    }
    const text = record['text'];
    if (typeof text !== 'string') {
      throw new Error(`PageEdited.inverse[${index}].text: expected string`);
    }
    if (text.length > LIMITS.intentPayloadBytesMax) {
      throw new Error(`PageEdited.inverse[${index}].text: exceeds limit`);
    }
    return { span: parseByteSpan(record['span'], `PageEdited.inverse[${index}].span`), text };
  });
  if (!spansAscending(parsed.map((hunk) => hunk.span))) {
    throw new Error('PageEdited.inverse: expected ascending disjoint spans');
  }
  return parsed;
}

function parsePageEditError(input: unknown): PageEditError {
  const record = toRecord(input);
  if (record === undefined) {
    throw new Error('PageEditError: expected object');
  }
  if (record['code'] === 'rejected') {
    const message = record['message'];
    if (typeof message !== 'string' || message.length > LIMITS.attrCharsMax) {
      throw new Error('PageEditError.message: expected bounded string');
    }
    const disk = record['diskChecksum'];
    return {
      code: 'rejected',
      reason: parseRejectionReason(record['reason'], 'PageEditError.reason'),
      message,
      diskChecksum: disk === undefined ? undefined : checksumField(disk, 'PageEditError.diskChecksum'),
    };
  }
  return parsePageWriteFailure(input);
}

export function parsePageDiskRead(input: unknown): PageDiskRead {
  const page = parsePageReadResult(input);
  const record = toRecord(input);
  if (record === undefined) {
    throw new Error('PageDiskRead: expected object');
  }
  return { ...page, checksum: checksumField(record['checksum'], 'PageDiskRead.checksum') };
}

function parsePageWriteFailure(input: unknown): PageWriteFailure {
  const record = toRecord(input);
  if (record === undefined) {
    throw new Error('PageWriteFailure: expected object');
  }
  const message = record['message'];
  if (typeof message !== 'string') {
    throw new Error('PageWriteFailure.message: expected string');
  }
  if (message.length > LIMITS.attrCharsMax) {
    throw new Error('PageWriteFailure.message: exceeds limit');
  }
  const code = record['code'];
  switch (code) {
    case 'missing':
    case 'filesystem':
    case 'write-race':
    case 'uncertain':
    case 'backpressured':
      return { code, message };
    default:
      throw new Error('PageWriteFailure.code: unknown value');
  }
}

function checksumField(input: unknown, where: string): Digest {
  if (typeof input !== 'string') {
    throw new Error(`${where}: expected string`);
  }
  try {
    return toDigest(input);
  } catch (error: unknown) {
    throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
