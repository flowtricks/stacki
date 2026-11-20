// Goal: the smallest CBOR reader WebAuthn needs (RFC 8949 subset): unsigned and negative integers, byte and text strings,
// arrays, maps with integer or text keys, and the simple values true, false and null.
// What is refused, on purpose: indefinite lengths, tags, floats, 64-bit integers past 2^53, duplicate map keys, nesting past
// `depthMax`, containers past `itemsMax`, strings past their byte bounds. An authenticator's answer is hostile input until
// it has been parsed, so every size is checked before memory is reserved (AGENTS.md §2 and §10).
import { err, ok, type Result } from '../../../../vendor/stacki/shared/core/result';

export const CBOR_LIMITS = { depthMax: 6, itemsMax: 32, byteStringBytesMax: 4_096, textBytesMax: 1_024, inputBytesMax: 8_192 } as const satisfies Record<
  string,
  number
>;

export type CborValue = number | string | boolean | undefined | Uint8Array | readonly CborValue[] | ReadonlyMap<string | number, CborValue>;

export interface CborRead {
  readonly value: CborValue;
  /** The offset just past the item, so a caller can read what follows (WebAuthn puts the COSE key before extensions). */
  readonly end: number;
}

export function decodeCbor(bytes: Uint8Array, offset = 0): Result<CborRead, string> {
  if (bytes.length > CBOR_LIMITS.inputBytesMax) {
    return err('cbor-too-large');
  }
  return readItem(bytes, offset, 0);
}

function readItem(bytes: Uint8Array, offset: number, depth: number): Result<CborRead, string> {
  if (depth > CBOR_LIMITS.depthMax) {
    return err('cbor-too-deep');
  }
  const first = bytes[offset];
  if (first === undefined) {
    return err('cbor-truncated');
  }
  const major = first >> 5;
  const info = first & 0x1f;
  const head = readLength(bytes, offset + 1, info);
  if (!head.ok) {
    return head;
  }
  const { length, end } = head.value;
  switch (major) {
    case 0:
      return ok({ value: length, end });
    case 1:
      return ok({ value: -1 - length, end });
    case 2: {
      if (length > CBOR_LIMITS.byteStringBytesMax || end + length > bytes.length) {
        return err('cbor-bytes');
      }
      return ok({ value: bytes.slice(end, end + length), end: end + length });
    }
    case 3: {
      if (length > CBOR_LIMITS.textBytesMax || end + length > bytes.length) {
        return err('cbor-text');
      }
      try {
        return ok({ value: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(end, end + length)), end: end + length });
      } catch {
        return err('cbor-text');
      }
    }
    case 4:
      return readArray(bytes, end, length, depth);
    case 5:
      return readMap(bytes, end, length, depth);
    case 7:
      return readSimple(info, end);
    default:
      // Major type 6 is a tag; WebAuthn structures carry none.
      return err('cbor-unsupported');
  }
}

function readLength(bytes: Uint8Array, offset: number, info: number): Result<{ length: number; end: number }, string> {
  if (info < 24) {
    return ok({ length: info, end: offset });
  }
  const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
  if (width === 0) {
    // 28 to 30 are reserved and 31 is an indefinite length.
    return err('cbor-unsupported');
  }
  if (offset + width > bytes.length) {
    return err('cbor-truncated');
  }
  let length = 0;
  for (let index = 0; index < width; index++) {
    length = length * 256 + (bytes[offset + index] ?? 0);
  }
  if (!Number.isSafeInteger(length)) {
    return err('cbor-integer');
  }
  return ok({ length, end: offset + width });
}

function readArray(bytes: Uint8Array, offset: number, count: number, depth: number): Result<CborRead, string> {
  if (count > CBOR_LIMITS.itemsMax) {
    return err('cbor-items');
  }
  const items: CborValue[] = [];
  let cursor = offset;
  for (let index = 0; index < count; index++) {
    const item = readItem(bytes, cursor, depth + 1);
    if (!item.ok) {
      return item;
    }
    items.push(item.value.value);
    cursor = item.value.end;
  }
  return ok({ value: items, end: cursor });
}

function readMap(bytes: Uint8Array, offset: number, count: number, depth: number): Result<CborRead, string> {
  if (count > CBOR_LIMITS.itemsMax) {
    return err('cbor-items');
  }
  const entries = new Map<string | number, CborValue>();
  let cursor = offset;
  for (let index = 0; index < count; index++) {
    const key = readItem(bytes, cursor, depth + 1);
    if (!key.ok) {
      return key;
    }
    const name = key.value.value;
    if ((typeof name !== 'string' && typeof name !== 'number') || entries.has(name)) {
      return err('cbor-key');
    }
    const value = readItem(bytes, key.value.end, depth + 1);
    if (!value.ok) {
      return value;
    }
    entries.set(name, value.value.value);
    cursor = value.value.end;
  }
  return ok({ value: entries, end: cursor });
}

function readSimple(info: number, end: number): Result<CborRead, string> {
  switch (info) {
    case 20:
      return ok({ value: false, end });
    case 21:
      return ok({ value: true, end });
    case 22:
    case 23:
      return ok({ value: undefined, end });
    default:
      return err('cbor-unsupported');
  }
}
