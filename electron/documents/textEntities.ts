// A text run that spells some of its characters as entities (`&copy;`, `&#160;`,
// `&middot;`), edited as the characters it shows.
//
// A text node holds what the page says: `&copy; {year}` is the node "© ", and
// the Content field edits those characters (shared/page/htmlText.ts). The file
// keeps its own spelling, so the node's bytes are not the encoding of its value
// and the generic text path, which places a printed before/after pair on the
// bytes, has nothing to hold on to where the printer's `©` meets the file's
// `&copy;`: the edit was refused as an editor error. Typing after the copyright
// sign in a footer is the commonest such edit there is.
//
// Here the change is found on the characters, and each end of it is moved to a
// boundary the bytes have: an entity is one unit, never cut. The entities the
// edit does not touch stay exactly as the file spells them.
import { assert } from '../../shared/core/assert';
import type { RejectionReason, SourceEdit } from '../../shared/engine/intent';
import { decodeEntities, encodeText, textValue } from '../../shared/page/htmlText';
import { err, ok, type Result } from '../../shared/core/result';
import { toByteSpan } from '../../shared/core/span';

/** An entity as the parser reads it, or a run of whitespace (shared/page/htmlText.ts). The parser squeezes a run to one space before it decodes. */
const SQUEEZED = /&(?:#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);|\s+/gi;

/** A stretch of the run: its bytes, and the characters those decode to. A plain stretch decodes to itself. */
interface Unit {
  readonly rawStart: number;
  readonly rawEnd: number;
  readonly charStart: number;
  readonly charEnd: number;
  /** Whether the bytes are an entity. */
  readonly entity: boolean;
  /** Whether a change may start or end only at the unit's edges: an entity, or a whitespace run squeezed to one space. */
  readonly atomic: boolean;
}

/**
 * The hunks that turn `raw` (a text node's bytes, written with entities) into
 * the node whose characters are `nextValue`, placed on `raw` and counted in
 * UTF-8 bytes from its start. Undefined when this path does not apply: the run
 * spells no entity, or its characters are not `previousValue` (whitespace the
 * parser collapsed, say), and the generic path decides.
 */
export function entityTextHunks(raw: string, previousValue: string, nextValue: string): Result<readonly SourceEdit[], RejectionReason> | undefined {
  if (!raw.includes('&')) {
    return undefined; // No entity to spell: the generic path places the change.
  }
  const characters = textValue(raw);
  if (characters !== previousValue) {
    return undefined; // The run is not what the node says it is: not placeable by characters.
  }
  const change = changedMiddle(previousValue, nextValue);
  if (change === undefined) {
    return err('unsupported-operation'); // Nothing to write; the gesture had no change.
  }
  const units = unitsOf(raw);
  assert(units.length > 0, 'A run with an ampersand has units');
  if (!units.some((unit) => unit.entity)) {
    return undefined; // A stray `&` is text, not an entity.
  }
  const start = boundaryAtOrBefore(units, change.start);
  const end = boundaryAtOrAfter(units, change.end);
  assert(start.chars <= change.start, 'A boundary before the change starts at or before it');
  assert(end.chars >= change.end, 'A boundary after the change ends at or after it');
  // The characters of an entity the change only grazes are written again, as the characters they are.
  const replacement =
    previousValue.slice(start.chars, change.start) + nextValue.slice(change.start, change.nextEnd) + previousValue.slice(change.end, end.chars);
  const written = encodeText(replacement);
  const rewritten = raw.slice(0, start.raw) + written + raw.slice(end.raw);
  if (textValue(rewritten) !== nextValue) {
    return undefined; // A join of two entities or a stray `&`: leave it to the generic path, which refuses what it cannot place.
  }
  const span = toByteSpan(Buffer.byteLength(raw.slice(0, start.raw), 'utf8'), Buffer.byteLength(raw.slice(0, end.raw), 'utf8'));
  return ok([{ span, text: written }]);
}

/** The common start and end trimmed off, whole code points only: what differs in the middle. Undefined when nothing does. */
function changedMiddle(previousValue: string, nextValue: string): { readonly start: number; readonly end: number; readonly nextEnd: number } | undefined {
  if (previousValue === nextValue) {
    return undefined;
  }
  const shorter = Math.min(previousValue.length, nextValue.length);
  let start = 0;
  while (start < shorter && previousValue.charCodeAt(start) === nextValue.charCodeAt(start)) {
    start++;
  }
  let tail = 0;
  while (tail < shorter - start && previousValue.charCodeAt(previousValue.length - 1 - tail) === nextValue.charCodeAt(nextValue.length - 1 - tail)) {
    tail++;
  }
  // A boundary inside a surrogate pair moves out of it.
  if (splitsPair(previousValue, start)) {
    start--;
  }
  if (splitsPair(previousValue, previousValue.length - tail)) {
    tail--;
  }
  assert(start >= 0, 'The change starts inside the run');
  assert(tail >= 0, 'The change ends inside the run');
  return { start, end: previousValue.length - tail, nextEnd: nextValue.length - tail };
}

function splitsPair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) {
    return false;
  }
  const before = text.charCodeAt(offset - 1);
  const at = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff;
}

/** The run cut into plain stretches, the entities the decoder knows, and the whitespace runs the parser squeezes to one space. Bounded by the run's length: every unit takes at least one character. */
function unitsOf(raw: string): readonly Unit[] {
  const units: Unit[] = [];
  let rawAt = 0;
  let charAt = 0;
  const plainUntil = (rawEnd: number): void => {
    if (rawEnd > rawAt) {
      const plain = rawEnd - rawAt;
      units.push({ rawStart: rawAt, rawEnd, charStart: charAt, charEnd: charAt + plain, entity: false, atomic: false });
      charAt += plain;
      rawAt = rawEnd;
    }
  };
  for (const match of raw.matchAll(SQUEEZED)) {
    const text = match[0];
    const decoded = text.startsWith('&') ? decodeEntities(text) : ' ';
    if (decoded === text) {
      continue; // A name the decoder does not know, or a single space: plain text.
    }
    plainUntil(match.index);
    units.push({
      rawStart: match.index,
      rawEnd: match.index + text.length,
      charStart: charAt,
      charEnd: charAt + decoded.length,
      entity: text.startsWith('&'),
      atomic: true,
    });
    charAt += decoded.length;
    rawAt = match.index + text.length;
  }
  plainUntil(raw.length);
  return units;
}

/** A place in the run, in its characters and in its bytes. */
interface Boundary {
  readonly chars: number;
  readonly raw: number;
}

function boundaryAtOrBefore(units: readonly Unit[], chars: number): Boundary {
  for (const unit of units) {
    if (chars >= unit.charStart && chars <= unit.charEnd) {
      if (!unit.atomic) {
        return { chars, raw: unit.rawStart + (chars - unit.charStart) };
      }
      return chars === unit.charEnd ? { chars, raw: unit.rawEnd } : { chars: unit.charStart, raw: unit.rawStart };
    }
  }
  throw new Error(`Assertion failed: character ${chars} lies inside the run`);
}

function boundaryAtOrAfter(units: readonly Unit[], chars: number): Boundary {
  for (const unit of units) {
    if (chars >= unit.charStart && chars <= unit.charEnd) {
      if (!unit.atomic) {
        return { chars, raw: unit.rawStart + (chars - unit.charStart) };
      }
      return chars === unit.charStart ? { chars, raw: unit.rawStart } : { chars: unit.charEnd, raw: unit.rawEnd };
    }
  }
  throw new Error(`Assertion failed: character ${chars} lies inside the run`);
}
