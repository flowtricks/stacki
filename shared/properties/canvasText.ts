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
  /**
   * Words written in the open file itself, never a shared value: only these
   * may be changed together with the text beside them, by one selection.
   */
  readonly literal?: true;
  /**
   * What Enter types in this text, from its component's editing settings (.stacki/components.json): `line` a line
   * break, `rich` a new paragraph. Absent: Enter finishes editing, as in a frame older than these settings.
   */
  readonly breaks?: CanvasTextBreaks;
  /** With `breaks: 'rich'`: the page path of the component instance whose blocks the editor edits as rich text. */
  readonly richRoot?: string;
}

/** What the canvas `+` makes of the block the caret is in; the host's menu sends it, the frame applies it. */
export type RichBlockChoice =
  | { readonly kind: 'block'; readonly block: RichBlockTag }
  | { readonly kind: 'list'; readonly list: 'ul' | 'ol' }
  | { readonly kind: 'rule' }
  | { readonly kind: 'link'; readonly href: string }
  | { readonly kind: 'media'; readonly media: 'image' | 'video'; readonly address: string };
export const RICH_BLOCK_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre'] as const;
export type RichBlockTag = (typeof RICH_BLOCK_TAGS)[number];
/** An address the `+` inserts (an image, a video, a link), bounded like an attribute and free of markup. */
const RICH_ADDRESS_CHARS_MAX = 2_048;

/** The host's answer to a `+` choice, checked by the frame before it edits anything. */
export function parseRichBlockRequest(input: unknown): { readonly session: string; readonly choice: RichBlockChoice } | undefined {
  const data = record(input);
  if (data['type'] !== 'avb:rich-block') {
    return undefined;
  }
  return { session: pathText(data['session']), choice: parseRichChoice(record(data['choice'])) };
}

function parseRichChoice(data: Readonly<Record<string, unknown>>): RichBlockChoice {
  switch (data['kind']) {
    case 'block': {
      const block = RICH_BLOCK_TAGS.find((tag) => tag === data['block']);
      if (block === undefined) {
        throw new Error('Expected a rich text block tag');
      }
      return { kind: 'block', block };
    }
    case 'list':
      if (data['list'] !== 'ul' && data['list'] !== 'ol') {
        throw new Error('Expected a list kind');
      }
      return { kind: 'list', list: data['list'] };
    case 'rule':
      return { kind: 'rule' };
    case 'link':
      return { kind: 'link', href: richAddress(data['href']) };
    case 'media':
      if (data['media'] !== 'image' && data['media'] !== 'video') {
        throw new Error('Expected image or video');
      }
      return { kind: 'media', media: data['media'], address: richAddress(data['address']) };
    default:
      throw new Error('Expected a rich text choice');
  }
}

function richAddress(input: unknown): string {
  const value = text(input);
  if (value.length === 0 || value.length > RICH_ADDRESS_CHARS_MAX || /[\s<>"]/.test(value)) {
    throw new Error('Expected a bounded address without spaces or markup');
  }
  return value;
}

export const CANVAS_TEXT_BREAKS = ['line', 'rich'] as const;
export type CanvasTextBreaks = (typeof CANVAS_TEXT_BREAKS)[number];

/** Typed after a line break that ends its line, so the empty line has a caret; never saved. */
export const CANVAS_LINE_END = '\u200B';

/** Typed canvas words as they are saved: each typed line break without the space that held its empty line open. */
export function canvasTextWithoutLineEnds(value: string): string {
  const saved = value.replaceAll('\n' + CANVAS_LINE_END, '\n');
  assert(saved.length <= value.length, 'Removing line ends never adds characters');
  return saved;
}

export interface CanvasTextCatalog {
  readonly type: 'avb:text-catalog';
  readonly session: string;
  readonly file: string;
  readonly checksum: string;
  readonly targets: readonly CanvasTextTarget[];
  /** Data-bound texts a double click cannot edit in place (computed, joined, a call): the frame names them instead of staying silent. */
  readonly blocked?: readonly CanvasTextBlocked[];
}

/**
 * A text printed from data that has no string to write to. It has no words for
 * the frame to match, so the frame finds it by its source path: the element that
 * holds exactly that text. `key` is what the refusal names, and the editor
 * words why.
 */
export interface CanvasTextBlocked {
  readonly key: string;
  readonly path: string;
  /** For prop text of a component instance: the page instance it belongs to, so the frame marks it while that instance is selected. */
  readonly scope?: string;
}

/** The words of one text, in a save that changes several at once. */
export interface CanvasTextRunValue {
  readonly key: string;
  readonly value: string;
}

/**
 * Which content a canvas rich text edit is of, said with each of its messages, so the host can apply it to the page as
 * it is then, whatever catalog it holds by that time.
 */
export interface CanvasRichEditName {
  /** Names the edit from its first draft to its save. */
  readonly id: string;
  readonly file: string;
  /** The page path of the instance (rich), or of the edited words (a line of words). */
  readonly root: string;
  readonly breaks: CanvasTextBreaks;
}

function parseRichEditName(input: unknown): CanvasRichEditName {
  const data = record(input);
  return { id: pathText(data['id']), file: pathText(data['file']), root: pathText(data['root']), breaks: parseBreaks(data['breaks']) };
}

export type CanvasTextEvent =
  | {
      readonly type: 'avb:text-save';
      readonly session: string;
      readonly key: string;
      readonly value: string;
      /** The other texts one selection changed: all land together, or none. */
      readonly also?: readonly CanvasTextRunValue[];
    }
  | {
      readonly type: 'avb:text-draft';
      readonly session: string;
      readonly key: string;
      readonly value: string;
    }
  /** What the block editor holds while it is open, and the caret's block as element positions; nothing is saved by it. */
  | {
      readonly type: 'avb:rich-draft';
      readonly session: string;
      readonly key: string;
      readonly html: string;
      readonly caret: readonly number[];
      readonly edit: CanvasRichEditName;
    }
  /** The rich text a canvas edit left in a component instance, as HTML the host checks before writing it. */
  | {
      readonly type: 'avb:rich-save';
      readonly session: string;
      readonly key: string;
      readonly html: string;
      readonly edit: CanvasRichEditName;
      /** The content as the editor opened on it: a save never writes over content that changed since. */
      readonly base: string;
    }
  /** Where the `+` of an empty block goes, in the frame's pixels; absent when the caret is not in one. */
  | {
      readonly type: 'avb:rich-plus';
      readonly session: string;
      readonly rect?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
    }
  /** `reason` is the stable code of `message`, which the editor words in the person's language; the frame has no catalog. */
  | {
      readonly type: 'avb:text-refused';
      readonly message: string;
      readonly reason?: CanvasTextRefusal | undefined;
      /** For `source-blocked`: the blocked text the double click was on. */
      readonly key?: string | undefined;
    };

export const CANVAS_TEXT_LIMIT = 10_000;
/** The rich text of one instance, as one canvas save carries it. */
export const RICH_HTML_CHARS_MAX = 200_000;

function parseRichBox(data: Readonly<Record<string, unknown>>) {
  const read = (key: string) => {
    const value = data[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000) {
      throw new Error('Expected a finite box coordinate');
    }
    return value;
  };
  return { x: read('x'), y: read('y'), w: read('w'), h: read('h') };
}
export const CANVAS_TARGET_LIMIT = 2_000;
export const CANVAS_RUNS_SAVED_MAX = 100;
export const CANVAS_BLOCKED_LIMIT = 200;

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
    ...(data['blocked'] === undefined ? {} : { blocked: parseBlocked(data['blocked']) }),
  };
}

function parseBlocked(input: unknown): readonly CanvasTextBlocked[] {
  const blocked = list((entry) => {
    const data = record(entry);
    return { key: pathText(data['key']), path: pathText(data['path']), ...(data['scope'] === undefined ? {} : { scope: pathText(data['scope']) }) };
  })(input);
  if (blocked.length > CANVAS_BLOCKED_LIMIT) {
    throw new Error('Too many blocked canvas texts');
  }
  return blocked;
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
    ...(data['literal'] === undefined ? {} : { literal: parseLiteral(data['literal']) }),
    ...(data['breaks'] === undefined ? {} : { breaks: parseBreaks(data['breaks']) }),
    ...(data['richRoot'] === undefined ? {} : { richRoot: pathText(data['richRoot']) }),
  };
}

function parseBreaks(input: unknown): CanvasTextBreaks {
  const breaks = CANVAS_TEXT_BREAKS.find((value) => value === input);
  if (breaks === undefined) {
    throw new Error('Expected what Enter types in canvas text');
  }
  return breaks;
}

function parseLiteral(input: unknown): true {
  if (input !== true) {
    throw new Error('Expected literal canvas text to say so');
  }
  return input;
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
      return {
        type: 'avb:text-save',
        session: pathText(data['session']),
        key: pathText(data['key']),
        value: canvasTextValue(data['value']),
        ...(data['also'] === undefined ? {} : { also: parseRunValues(data['also']) }),
      };
    case 'avb:text-draft':
      return {
        type: 'avb:text-draft',
        session: pathText(data['session']),
        key: pathText(data['key']),
        value: canvasTextValue(data['value']),
      };
    case 'avb:rich-save':
      return {
        type: 'avb:rich-save',
        session: pathText(data['session']),
        key: pathText(data['key']),
        html: richHTML(data['html']),
        edit: parseRichEditName(data['edit']),
        base: richHTML(data['base']),
      };
    case 'avb:rich-draft':
      return {
        type: 'avb:rich-draft',
        session: pathText(data['session']),
        key: pathText(data['key']),
        html: richHTML(data['html']),
        caret: richCaret(data['caret']),
        edit: parseRichEditName(data['edit']),
      };
    case 'avb:rich-plus':
      return {
        type: 'avb:rich-plus',
        session: pathText(data['session']),
        ...(data['rect'] === undefined ? {} : { rect: parseRichBox(record(data['rect'])) }),
      };
    case 'avb:text-refused':
      return {
        type: 'avb:text-refused',
        message: pathText(data['message']),
        reason: canvasTextRefusal(data['reason']),
        ...(data['key'] === undefined ? {} : { key: pathText(data['key']) }),
      };
    default:
      return undefined;
  }
}

function richHTML(input: unknown): string {
  const html = text(input);
  if (html.length > RICH_HTML_CHARS_MAX) {
    throw new Error('Canvas rich text exceeds limit');
  }
  return html;
}

// A block, and an item of a list: no deeper.
const RICH_CARET_DEPTH_MAX = 2;

function richCaret(input: unknown): readonly number[] {
  const positions = list(parseSegment)(input);
  if (positions.length > RICH_CARET_DEPTH_MAX) {
    throw new Error('Canvas rich text caret exceeds limit');
  }
  return positions;
}

function parseRunValues(input: unknown): readonly CanvasTextRunValue[] {
  const values = list((entry) => {
    const data = record(entry);
    return { key: pathText(data['key']), value: canvasTextValue(data['value']) };
  })(input);
  if (values.length === 0 || values.length > CANVAS_RUNS_SAVED_MAX) {
    throw new Error('Expected a bounded list of canvas text runs');
  }
  return values;
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
export function canvasTextUnfolded(text: string, folded: number, edge: 'start' | 'end'): number | undefined {
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

/** Why the canvas frame refused a text edit; each code has a catalog sentence in the editor (useCanvasText). */
export const CANVAS_TEXT_REFUSALS = ['waiting-render', 'selection-reaches', 'unsafe', 'page-changed', 'source-blocked'] as const;
export type CanvasTextRefusal = (typeof CANVAS_TEXT_REFUSALS)[number];

function canvasTextRefusal(input: unknown): CanvasTextRefusal | undefined {
  return CANVAS_TEXT_REFUSALS.find((reason) => reason === input);
}
