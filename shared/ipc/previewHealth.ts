// Can the page the dev server answered with be shown? The verdict the canvas notice is built from.
//
// A black canvas has more than one cause, and the dev server's HTTP status names only some of them. The worst one
// answers 200, starts streaming the page, and then a component throws: the status line is already sent, so the
// client gets a cut-off document (or a connection that dies mid-body) and the iframe paints nothing. So the verdict
// reads what arrived, not only how it was announced: the status, whether the body reached its closing html tag, whether
// anything visible is in it, and whether it is the dev server's own error screen. The caller fetches a bounded sample
// (electron/preview/previewInspect.ts) and this module, which is pure, judges it.
//
// The thrown error's text is not in the HTTP answer when the response was cut off: it went to the dev server's log.
// `extractThrownError` finds it there, so the notice can show the real message rather than "something went wrong".
import { assert } from '../core/assert';
import { BOUNDARY_LIMITS, count, record, text } from '../core/boundary';

export const PREVIEW_HEALTH_LIMITS = {
  /** Characters of an extracted error (message and frames) the notice shows. */
  thrownCharsMax: 2_000,
  /** Characters of the dev server's log the notice carries for its Copy details button. */
  logTailCharsMax: 8_000,
  /** Lines of stack or code frame kept after the line that names the error. */
  thrownFrameLinesMax: 8,
  /** Bytes of a response body read to judge it; a page larger than this is not judged for a missing end. */
  bodyBytesMax: 1_048_576,
} as const satisfies Record<string, number>;

export const PREVIEW_HEALTH_KINDS = ['ok', 'server-error', 'empty-page', 'truncated', 'dropped', 'error-overlay', 'unreachable'] as const;
export type PreviewHealthKind = (typeof PREVIEW_HEALTH_KINDS)[number];

export interface PreviewHealth {
  readonly kind: PreviewHealthKind;
  /** The HTTP status, or 0 when nothing answered. */
  readonly status: number;
  /** The error the page threw, when the response or the log says what it was. */
  readonly thrown: string | undefined;
  /** The end of the dev server's log, for Copy details; filled by the caller that has the log. */
  readonly logTail: string;
}

/** What one request to the dev server produced. */
export interface PreviewResponseSample {
  /** False when the request never got a response (refused, reset before the headers, timed out). */
  readonly reached: boolean;
  readonly status: number;
  readonly contentType: string | undefined;
  readonly body: string;
  /** `complete`: the body ended; `dropped`: the connection died after the headers; `capped`: the reader stopped at its byte limit. */
  readonly reading: 'complete' | 'dropped' | 'capped';
}

/** Judge one response. Pure: the same sample always gives the same verdict. */
export function classifyPreviewResponse(sample: PreviewResponseSample): PreviewHealth {
  assert(Number.isSafeInteger(sample.status), 'A response status is an integer');
  assert(sample.status >= 0, 'A response status is not negative');
  assert(sample.body.length <= PREVIEW_HEALTH_LIMITS.bodyBytesMax * 4, 'The body judged is the bounded sample, not a whole download');
  if (!sample.reached) {
    return verdict('unreachable', 0, undefined);
  }
  const { status } = sample;
  const html = isHtml(sample.contentType, sample.body);
  const overlayMessage = html ? overlayError(sample.body) : undefined;
  if (overlayMessage !== undefined) {
    return verdict('error-overlay', status, overlayMessage.length === 0 ? undefined : overlayMessage);
  }
  if (status >= 500) {
    return verdict('server-error', status, undefined);
  }
  if (!html) {
    return verdict('ok', status, undefined);
  }
  if (sample.reading === 'dropped') {
    return verdict('dropped', status, undefined);
  }
  if (visibleContent(sample.body).length === 0) {
    return verdict('empty-page', status, undefined);
  }
  if (sample.reading === 'complete' && isDocument(sample.body) && !endsDocument(sample.body)) {
    return verdict('truncated', status, undefined);
  }
  return verdict('ok', status, undefined);
}

/**
 * The thrown error in the dev server's log: its last error line, with the frames that follow it. Undefined when the
 * log holds no error. Colour codes are removed first, since the dev server colours its log for a terminal.
 */
export function extractThrownError(log: string): string | undefined {
  assert(typeof log === 'string', 'A log is text');
  assert(PREVIEW_HEALTH_LIMITS.thrownCharsMax > 0, 'The extracted error has room');
  const lines = stripColour(log).split('\n');
  let found = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (ERROR_LINE.test(lines[index] ?? '')) {
      found = index;
      break;
    }
  }
  if (found < 0) {
    return undefined;
  }
  const kept = [(lines[found] ?? '').trimEnd()];
  for (let index = found + 1; index < lines.length && kept.length <= PREVIEW_HEALTH_LIMITS.thrownFrameLinesMax; index++) {
    const line = lines[index] ?? '';
    // A frame, a code excerpt or a continuation is indented; the next log entry starts at the margin.
    if (/^\s+\S/.test(line)) {
      kept.push(line.trimEnd());
    } else {
      break;
    }
  }
  return kept.join('\n').slice(0, PREVIEW_HEALTH_LIMITS.thrownCharsMax);
}

/** The wire form of a verdict: main's answer to `dev:inspect`. */
export function parsePreviewHealth(input: unknown): PreviewHealth {
  const value = record(input);
  const kind = text(value['kind']);
  const known = PREVIEW_HEALTH_KINDS.find((candidate) => candidate === kind);
  if (known === undefined) {
    throw new Error('Preview health: unknown kind');
  }
  const status = count(value['status']);
  const logTail = text(value['logTail']);
  if (logTail.length > PREVIEW_HEALTH_LIMITS.logTailCharsMax) {
    throw new Error('Preview health: log tail exceeds limit');
  }
  const thrownInput = value['thrown'];
  if (thrownInput === undefined) {
    return { kind: known, status, thrown: undefined, logTail };
  }
  const thrown = text(thrownInput);
  if (thrown.length > PREVIEW_HEALTH_LIMITS.thrownCharsMax) {
    throw new Error('Preview health: thrown text exceeds limit');
  }
  assert(BOUNDARY_LIMITS.textLengthMax >= PREVIEW_HEALTH_LIMITS.thrownCharsMax, 'The wire carries an error of the size the notice shows');
  return { kind: known, status, thrown, logTail };
}

// An error line of the dev server's log: a timestamped [ERROR] entry, or an error's own name as the line starts.
const ERROR_LINE = /\[(?:ERROR|error)\]|^\s*(?:[A-Z][A-Za-z]*Error|AstroUserError|Error)\b[:\s]/;

function verdict(kind: PreviewHealthKind, status: number, thrown: string | undefined): PreviewHealth {
  assert(PREVIEW_HEALTH_KINDS.includes(kind), 'A verdict is one of the known kinds');
  assert(status >= 0, 'A verdict carries a status');
  return { kind, status, thrown: thrown === undefined ? undefined : thrown.slice(0, PREVIEW_HEALTH_LIMITS.thrownCharsMax), logTail: '' };
}

// Anything that announces HTML, or says nothing and looks like it. An answer that says it is something else (JSON, an
// image) is judged by status alone: a missing closing tag means nothing in it.
function isHtml(contentType: string | undefined, body: string): boolean {
  if (contentType === undefined) {
    return /^\s*<(?:!doctype|html)/i.test(body);
  }
  return /html/i.test(contentType);
}

function isDocument(body: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html)/i.test(body);
}

// A document ends at its closing html tag, then only what the dev server and Stacki append after it: the page-mark
// comments (`<!--avb-e:0-->`, the stamp) and the page's script modules. Judging the bare tail called every marked
// page cut off, so a healthy canvas looked broken and a recovered one never looked healthy.
const DOCUMENT_TAIL_CHARS = 4_096;
const AFTER_CLOSING_HTML = /<\/html\s*>(?:\s|<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>)*$/i;

function endsDocument(body: string): boolean {
  return AFTER_CLOSING_HTML.test(body.slice(-DOCUMENT_TAIL_CHARS));
}

// The dev server's error screen: Vite's overlay element, or the script that creates it. The message is in the
// overlay's JSON; an empty string means the screen is there and its message could not be read.
function overlayError(body: string): string | undefined {
  if (!/vite-error-overlay|ErrorOverlay\(/.test(body)) {
    return undefined;
  }
  const match = /"message"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(body);
  if (match?.[1] === undefined) {
    return '';
  }
  try {
    const parsed: unknown = JSON.parse(match[1]);
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return '';
  }
}

// What a person could see: the body with scripts, styles and comments removed. Tags count (an empty div is a layout),
// bare whitespace does not.
function visibleContent(body: string): string {
  const inner = /<body[^>]*>([\s\S]*?)(?:<\/body\s*>|$)/i.exec(body);
  const scope = inner?.[1] ?? (isDocument(body) ? '' : body);
  return scope
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

function stripColour(value: string): string {
  // Built from a string so the escape character is not written into the source.
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
}
