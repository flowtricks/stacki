// Branded primitives (AGENTS.md §4): lookalike strings made distinct at compile
// time so a node id can never be passed where a file path belongs. Assertions
// exist only inside these validators, immediately after the check.

declare const brand: unique symbol;
export type Brand<T, B> = T & { readonly [brand]: B };

/** A page-tree node id: `n<digits>` for Astro nodes, `m<digits>` for Markdown, plus the two
 * well-known ids the app itself assigns — 'layout' (the detected page wrapper)
 * and `chunk<N>` (a serialization chunk group). */
export type NodeId = Brand<string, 'NodeId'>;

/** An absolute filesystem path as it crosses a boundary. POSIX or Windows
 * separators are both valid; the brand only proves non-emptiness. */
export type FilePath = Brand<string, 'FilePath'>;

/** The project root as configured in the app. Distinct from FilePath so a
 * scan request can never be pointed at a stray file path. */
export type ProjectPath = Brand<string, 'ProjectPath'>;

/** SHA-256 of a file's exact bytes as 64 lowercase hex characters: the token that
 * names which version of a file a read returned or an edit was authored against
 * (plan §3.1). Built only by toDigest — the wire parser and the main-process hash
 * function both go through it, so an unchecked string can never pose as one. */
export type Digest = Brand<string, 'Digest'>;

/** Node ids name nodes within one tree (plan §4: nothing keys on them across
 * snapshots). `n<path>` is the Astro parser's structural path (`n0.2.1`);
 * `m<N>` the Markdown parser's, until step 10; `layout` the layout wrapper.
 * The renderer carries its own handles across parses (src/editor/nodeHandles.ts):
 * `s<16 hex>.<path>` names a node by the snapshot it first appeared in, and
 * `g<32 hex>` a node a gesture created, before any parse has seen it. */
const NODE_ID_RE = /^(?:n\d+(?:\.\d+)*|m\d+|layout|s[0-9a-f]{16}\.\d+(?:\.\d+)*(?:~\d+)?|g[0-9a-f]{32})$/;

export function toNodeId(value: string): NodeId {
  if (!NODE_ID_RE.test(value)) {
    throw new Error(`NodeId: expected 'n<path>', 'm<N>', 'layout', 's<snapshot>.<path>' or 'g<gesture>', ` + `got ${JSON.stringify(value)}`);
  }
  return value as NodeId;
}

const DIGEST_RE = /^[0-9a-f]{64}$/;

export function toDigest(value: string): Digest {
  if (!DIGEST_RE.test(value)) {
    throw new Error('Digest: expected 64 lowercase hex characters');
  }
  return value as Digest;
}

export function toFilePath(value: string): FilePath {
  if (value.length === 0) {
    throw new Error('FilePath: expected non-empty string');
  }
  return value as FilePath;
}

export function toProjectPath(value: string): ProjectPath {
  if (value.length === 0) {
    throw new Error('ProjectPath: expected non-empty string');
  }
  return value as ProjectPath;
}

/** A position in a file's UTF-8 bytes: what splices, witnesses and anchors use
 * (plan §3.2). Distinct from Utf16Offset so the two can never be mixed; the one
 * conversion between them is utf16ToByteOffsets in shared/core/span.ts. */
export type ByteOffset = Brand<number, 'ByteOffset'>;

/** A position in a decoded source string, as JavaScript indexes it (UTF-16
 * code units): what the parser reports. */
export type Utf16Offset = Brand<number, 'Utf16Offset'>;

/** Names one submitted intent from authoring to its terminal outcome. Minted by
 * the submitting client; the pattern keeps it printable and bounded, so it can
 * appear in a log line without escaping (plan §9a). */
export type IntentId = Brand<string, 'IntentId'>;

const INTENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function toByteOffset(value: number): ByteOffset {
  if (!Number.isSafeInteger(value)) {
    throw new Error('ByteOffset: expected safe integer');
  }
  if (value < 0) {
    throw new Error('ByteOffset: expected nonnegative integer');
  }
  return value as ByteOffset;
}

export function toUtf16Offset(value: number): Utf16Offset {
  if (!Number.isSafeInteger(value)) {
    throw new Error('Utf16Offset: expected safe integer');
  }
  if (value < 0) {
    throw new Error('Utf16Offset: expected nonnegative integer');
  }
  return value as Utf16Offset;
}

export function toIntentId(value: string): IntentId {
  if (!INTENT_ID_RE.test(value)) {
    throw new Error('IntentId: expected 1 to 64 characters from [A-Za-z0-9_-]');
  }
  return value as IntentId;
}
