// Only bounded text values cross the frame boundary. Source ranges stay in the editor.
import { digest, list, pathText, record, text } from '../core/boundary';
import { assert } from '../core/assert';

export interface CanvasTextTarget {
  readonly kind: 'element' | 'component';
  readonly key: string;
  readonly path: string;
  readonly parent: string;
  readonly value: string;
  readonly label: string;
  readonly nested: boolean;
  readonly tag: string;
  readonly siblings: readonly string[];
  /**
   * The page instance this text belongs to, for text inside a component: only
   * a click inside that copy edits it, so two copies showing the same words
   * never edit each other's prop.
   */
  readonly scope?: string;
  /**
   * Text a page hands to a component instance: `slot` for the instance's own
   * content (`<Slider>Words</Slider>`), `prop` for one of its props
   * (`<Slider heading="Words" />`). The canvas marks it with a dashed outline
   * while that instance — not something inside it — is selected, so it reads
   * as editable. Like any text, a double click types in it; a single click
   * selects.
   */
  readonly from?: 'slot' | 'prop';
  /**
   * For a prop the component renders as HTML (`set:html`): which text node,
   * in document order, inside the element at `parent`. Markup from a prop
   * carries no canvas paths, so its runs are told apart by position.
   */
  readonly segment?: number;
}

export interface CanvasTextCatalog {
  readonly type: 'avb:text-catalog';
  readonly session: string;
  readonly file: string;
  readonly checksum: string;
  readonly targets: readonly CanvasTextTarget[];
}

export type CanvasTextEvent =
  | {
      readonly type: 'avb:text-save' | 'avb:text-draft';
      readonly session: string;
      readonly key: string;
      readonly value: string;
    }
  | { readonly type: 'avb:text-refused'; readonly message: string };

export const CANVAS_TEXT_LIMIT = 10_000;
export const CANVAS_TARGET_LIMIT = 2_000;

export function canvasTextValue(input: unknown): string {
  const value = text(input);
  if (value.length > CANVAS_TEXT_LIMIT) {
    throw new Error('Canvas text exceeds limit');
  }
  return value;
}

export function parseCanvasTextCatalog(input: unknown): CanvasTextCatalog {
  const data = record(input);
  if (data['type'] !== 'avb:text-catalog') {
    throw new Error('Expected canvas text catalog');
  }
  const targets = list(parseTarget)(data['targets']);
  if (targets.length > CANVAS_TARGET_LIMIT) {
    throw new Error('Too many canvas text targets');
  }
  return {
    type: 'avb:text-catalog',
    session: pathText(data['session']),
    file: pathText(data['file']),
    checksum: digest(data['checksum']),
    targets,
  };
}

function parseTarget(input: unknown): CanvasTextTarget {
  const data = record(input);
  if (data['kind'] !== 'element' && data['kind'] !== 'component') {
    throw new Error('Expected text container kind');
  }
  if (typeof data['nested'] !== 'boolean') {
    throw new Error('Expected nested text flag');
  }
  const siblings = list(pathText)(data['siblings']);
  if (siblings.length > 100) {
    throw new Error('Too many protected text siblings');
  }
  return {
    kind: data['kind'],
    tag: pathText(data['tag']),
    siblings,
    key: pathText(data['key']),
    path: pathText(data['path']),
    parent: pathText(data['parent']),
    value: canvasTextValue(data['value']),
    label: pathText(data['label']),
    nested: data['nested'],
    ...(data['scope'] === undefined ? {} : { scope: pathText(data['scope']) }),
    ...(data['from'] === undefined ? {} : { from: parseFrom(data['from']) }),
    ...(data['segment'] === undefined ? {} : { segment: parseSegment(data['segment']) }),
  };
}

function parseFrom(input: unknown): 'slot' | 'prop' {
  if (input !== 'slot' && input !== 'prop') {
    throw new Error('Expected where canvas text comes from');
  }
  return input;
}

// A text node's position inside its element: bounded like the element's text.
function parseSegment(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input)) {
    throw new Error('Expected a text segment index');
  }
  if (input < 0 || input >= CANVAS_TEXT_LIMIT) {
    throw new Error('Text segment index out of range');
  }
  return input;
}

export function parseCanvasTextEvent(input: unknown): CanvasTextEvent | undefined {
  const data = record(input);
  switch (data['type']) {
    case 'avb:text-save':
    case 'avb:text-draft':
      return {
        type: data['type'],
        session: pathText(data['session']),
        key: pathText(data['key']),
        value: canvasTextValue(data['value']),
      };
    case 'avb:text-refused':
      return { type: 'avb:text-refused', message: pathText(data['message']) };
    default:
      return undefined;
  }
}

// Positions in canvas text, counted the way HTML shows it: a run of ASCII
// whitespace is one space, and whitespace before the first word is nothing.
// The editor's text and the source text agree on this count even when their
// whitespace differs — a component's template indentation, a trimmed slot —
// which is the same sameness the frame requires before it opens an editor.
const FOLDABLE = /[\t\r\n ]/;

/** How many shown characters precede `offset` in `text`. */
export function canvasTextFolded(text: string, offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) {
    throw new Error('Canvas text offset is outside its text');
  }
  let count = 0;
  let started = false;
  let inSpace = false;
  assert(offset <= text.length, 'A folded offset lies inside its text');
  for (let index = 0; index < offset; index += 1) {
    if (FOLDABLE.test(text.charAt(index))) {
      if (started && !inSpace) {
        count += 1;
      }
      inSpace = true;
    } else {
      started = true;
      inSpace = false;
      count += 1;
    }
  }
  assert(count <= offset, 'Folding never adds characters');
  return count;
}

/**
 * The offset in `text` where `folded` shown characters have gone by: for a
 * start, at the next shown character; for an end, right after the last one.
 * Undefined when the text shows fewer characters than that.
 */
export function canvasTextUnfolded(
  text: string,
  folded: number,
  edge: 'start' | 'end',
): number | undefined {
  if (!Number.isSafeInteger(folded) || folded < 0) {
    throw new Error('Canvas text position must be a non-negative integer');
  }
  assert(text.length <= CANVAS_TEXT_LIMIT * 2, 'Unfolded text is within the editing bound');
  // One pass: `count` is canvasTextFolded(text, index) at each step.
  let count = 0;
  let started = false;
  let inSpace = false;
  for (let index = 0; index <= text.length; index += 1) {
    const shown = index < text.length && !FOLDABLE.test(text.charAt(index));
    if (count === folded) {
      if (edge === 'end' || shown || index === text.length) {
        return index;
      }
    }
    if (count > folded || index === text.length) {
      return undefined;
    }
    if (shown) {
      started = true;
      inSpace = false;
      count += 1;
    } else {
      if (started && !inSpace) {
        count += 1;
      }
      inSpace = true;
    }
  }
  return undefined;
}
