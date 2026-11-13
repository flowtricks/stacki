// A message reference carried inside an error's text, for failures that cross a boundary which keeps only the message string.
// Electron's `ipcRenderer.invoke` rejects with `Error invoking remote method ...: Error: <message>` and drops every other field of the
// thrown error, so a thrown refusal cannot carry a `messageRef` property the way a returned result can. The producer therefore appends
// the reference after an invisible separator; a reader that knows the format splits it off and translates, and a reader that does not
// (an older renderer, a log line) shows the English sentence followed by nothing visible but the JSON, which `splitReferencedMessage`
// callers strip. The English sentence always comes first, so it stays the fallback.
import { parseOptionalMessageRef, type MessageRef } from './messageReference';
import { CATALOG_LIMITS } from './catalog';

/** U+2063 INVISIBLE SEPARATOR: never part of a sentence a person writes, so it cannot be confused with the English text. */
export const REFERENCE_SEPARATOR = '⁣';

/** The longest reference JSON read back: a key plus the bounded parameter bag `parseMessageRef` accepts. */
const REFERENCE_JSON_CHARS_MAX = (CATALOG_LIMITS.paramsMax + 1) * CATALOG_LIMITS.messageCharsMax * 2;

/** `message` followed by the reference, or `message` alone when there is no reference. */
export function withReferencedMessage(message: string, reference: MessageRef | undefined): string {
  if (reference === undefined) {
    return message;
  }
  return `${message}${REFERENCE_SEPARATOR}${JSON.stringify(reference)}`;
}

/** The English sentence and, when the text carried one, its reference. Text without a valid reference comes back unchanged. */
export function splitReferencedMessage(text: string): { readonly message: string; readonly messageRef: MessageRef | undefined } {
  const at = text.lastIndexOf(REFERENCE_SEPARATOR);
  if (at < 0) {
    return { message: text, messageRef: undefined };
  }
  const json = text.slice(at + REFERENCE_SEPARATOR.length);
  const message = text.slice(0, at);
  if (json.length > REFERENCE_JSON_CHARS_MAX) {
    return { message, messageRef: undefined };
  }
  try {
    const parsed: unknown = JSON.parse(json);
    return { message, messageRef: parseOptionalMessageRef(parsed) };
  } catch {
    return { message, messageRef: undefined };
  }
}

/** The reference a thrown value carries as a `messageRef` property (a `ReferencedError`, in `shared/` or Studio's twin), or `undefined`. */
export function referenceOfError(error: unknown): MessageRef | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  return parseOptionalMessageRef(Reflect.get(error, 'messageRef'));
}
