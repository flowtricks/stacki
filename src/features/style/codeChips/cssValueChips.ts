import { assert } from '../../../../shared/core/assert';
import { isEasing } from '../model/transition';
import { gradientFitsEditor, parseGradient } from '../model/gradient';
import { CSS_COLOR_NAMES } from './cssColorNames';
import { isKeywordOf, isKeywordProperty, type KeywordPropertyName } from './keywordOptions';

// Where CSS code holds a value the Style panel has a control for, so a code editor can draw a chip
// there (codeChipsExtension.ts): each `var(--…)` reference, each easing, each clip-path, each box- or
// text-shadow layer, each gradient the gradient editor can show, each colour, each keyword the panel
// offers as buttons or a list (display, position, text-align… keywordOptions.tsx), and, in front of a
// layered property (transition, transform, filters, shadows, background images), one chip for its
// whole list.
//
// A declaration whose value is still empty (`background-image:` as it is being typed) gets a create
// chip: a chip of the kind its property's editor is, over an empty range where the value goes. It is
// how a designer who does not know how to write the value makes one. A bare word that is not yet a
// value (`color: re`, `background-image: lin`) gets the same chip over that word, which a pick replaces.
//
// The scan reads the text as it is and never changes it. It is a bounded character scan rather than
// the editor's syntax tree because the same answer is needed for a stylesheet, for the `<style>`
// blocks inside markup (an Astro file, the style tag setting), and in a test with no editor at all;
// the tree for markup is a mixed parse that is only complete for the part on screen.
//
// A chip covers text the value already has: a variable chip is drawn over its reference, and every
// other chip sits in front of the value it opens. Writing a value back replaces exactly that range.

/** What the text is: a stylesheet (a CSS file, a rule), or markup whose `<style>` blocks hold CSS. */
export type CssChipText = 'stylesheet' | 'markup';

/** A range of the text, `from` inclusive and `to` exclusive. */
export interface CssChipRange {
  readonly from: number;
  readonly to: number;
}

/** The properties whose whole value is a list the Style panel edits as rows (its layer list). */
export const LAYERED_PROPERTIES = ['transition', 'transform', 'filter', 'backdrop-filter', 'box-shadow', 'text-shadow', 'background-image'] as const;
export type LayeredProperty = (typeof LAYERED_PROPERTIES)[number];

/**
 * A value a chip stands for, and where it sits. `value` is always the text of the range. Every kind
 * but a variable may have an empty range: a create chip, where a value is still to be written.
 */
export type CssValueChip =
  | (CssChipRange & {
      readonly kind: 'variable';
      readonly value: string;
      /** The declaration's property, for the picker's filter; undefined in a custom property's value. */
      readonly property: string | undefined;
      /** The whole declaration value around the reference, for where a pick lands in it. */
      readonly declaration: CssChipRange;
    })
  | (CssChipRange & { readonly kind: 'easing'; readonly value: string })
  | (CssChipRange & { readonly kind: 'clipPath'; readonly value: string })
  | (CssChipRange & { readonly kind: 'boxShadow'; readonly value: string })
  | (CssChipRange & { readonly kind: 'textShadow'; readonly value: string })
  | (CssChipRange & { readonly kind: 'gradient'; readonly value: string })
  | (CssChipRange & {
      readonly kind: 'color';
      readonly value: string;
      /** The custom property whose whole value this colour is, for its swatch (`:root`'s colour); else undefined. */
      readonly variable: string | undefined;
    })
  | (CssChipRange & { readonly kind: 'keyword'; readonly value: string; readonly property: KeywordPropertyName })
  | (CssChipRange & { readonly kind: 'layers'; readonly value: string; readonly property: LayeredProperty });

export type CssValueChipKind = CssValueChip['kind'];

/**
 * Text longer than this has no chips: the scan runs on every edit, and a stylesheet this size is
 * generated or minified rather than written by hand, where chips help nobody.
 */
export const CHIP_TEXT_CHARS_MAX = 400_000;
/** The most chips one text gets; past it the rest of the text is shown as written. */
export const CHIPS_MAX = 4_000;
/** The most `<style>` blocks read in one markup text. */
export const STYLE_BLOCKS_MAX = 256;
/** How far ahead a line is read to see whether it starts a declaration of its own. */
const DECLARATION_START_CHARS_MAX = 128;

// A property name: a custom property, or a standard or vendor-prefixed one. A custom property's name
// may start with any name character after its `--`: Lumos' private variables are `--_gap-size`, and
// requiring a letter there dropped every one of their declarations, so `--_gap-size: var(--a)` had no
// chip for its reference while `gap: var(--_gap-size)` beside it had one.
const PROPERTY_NAME = /^(?:--[\w -￿-]+|-?[a-z][a-z0-9_-]*)$/i;
// A line that starts a declaration: the text after an unfinished one (`background-image:` and no `;`).
const DECLARATION_START = /^\s*(?:--[\w -￿-]+|-?[a-z][a-z0-9_-]*)\s*:(?!:)/i;
const VENDOR_PREFIX = /^-(?:webkit|moz|ms|o)-/;
// Values that only say "take it from the cascade": no editor has anything to show for them.
const WIDE_KEYWORDS = new Set(['none', 'inherit', 'initial', 'unset', 'revert', 'revert-layer']);
// The properties whose values hold easings, beside a custom property whose whole value is one.
const EASING_PROPERTIES = new Set(['transition', 'transition-timing-function', 'animation', 'animation-timing-function']);
// Of those, the ones whose whole value is one easing, so a bare unfinished word in them is one too.
const EASING_ONLY_PROPERTIES = new Set(['transition-timing-function', 'animation-timing-function']);
// The Style panel has no animations editor, so an empty `animation:` is offered the easing editor
// alone: `animation: ease` is a valid start. An unfinished word there is an animation's name, never
// an easing, so it gets no chip.
const EASING_CREATE_PROPERTIES = new Set(['transition-timing-function', 'animation-timing-function', 'animation']);
const CLIP_PATH_PROPERTIES = new Set(['clip-path']);
// `background-image` is layered (its create chip opens the layer list); the shorthand is offered a gradient.
const GRADIENT_CREATE_PROPERTIES = new Set(['background']);
const LAYERED: ReadonlySet<string> = new Set(LAYERED_PROPERTIES);
// Properties whose whole value is one colour: an empty one gets a colour create chip.
const COLOR_PROPERTIES = new Set([
  'color',
  'background-color',
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-block-color',
  'border-block-start-color',
  'border-block-end-color',
  'border-inline-color',
  'border-inline-start-color',
  'border-inline-end-color',
  'outline-color',
  'text-decoration-color',
  'text-emphasis-color',
  'text-stroke-color',
  'column-rule-color',
  'caret-color',
  'accent-color',
  'fill',
  'stroke',
  'stop-color',
  'flood-color',
  'lighting-color',
]);
// Shorthands that hold a colour among other words: their colours get chips, but an empty one is not
// offered a colour, because a colour alone is rarely what the shorthand is for.
const COLOR_SHORTHANDS = new Set([
  'background',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-block',
  'border-block-start',
  'border-block-end',
  'border-inline',
  'border-inline-start',
  'border-inline-end',
  'outline',
  'text-decoration',
  'text-emphasis',
  'text-stroke',
  'column-rule',
]);
const VARIABLE_START = /^var\(\s*--[A-Za-z0-9_-]/i;
const GRADIENT_START = /^(?:repeating-)?(?:linear|radial|conic)-gradient\(/i;
const WHOLE_VARIABLE = /^var\(\s*--[A-Za-z0-9_-]+\s*\)$/i;
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FUNCTION = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
// A word being typed that is not a value yet: letters, digits, `#` and dashes, nothing else.
const UNFINISHED_WORD = /^#?[a-z0-9-]+$/i;
// Words that are finished values in a colour property even though no picker can start from them.
const COLOR_KEYWORDS = new Set(['currentcolor', 'none', 'auto', ...WIDE_KEYWORDS]);

/** Every chip in `text` read as `kind`, in document order, none overlapping another's start. */
export function cssValueChips(text: string, kind: CssChipText): readonly CssValueChip[] {
  if (text.length > CHIP_TEXT_CHARS_MAX) {
    return [];
  }
  const chips: CssValueChip[] = [];
  const regions = kind === 'stylesheet' ? [{ from: 0, to: text.length }] : styleBlocks(text);
  for (const region of regions) {
    scanDeclarations(text, region, (declaration) => declarationChips(text, declaration, chips));
    if (chips.length >= CHIPS_MAX) {
      break;
    }
  }
  // A stable sort: chips at one offset keep the order they were found in, so a layered property's
  // whole-list chip stays in front of its first layer's.
  const kept = chips.slice(0, CHIPS_MAX).sort((left, right) => left.from - right.from);
  for (const chip of kept) {
    assert(chip.from <= chip.to, 'cssValueChips: a chip keeps its order');
    assert(text.slice(chip.from, chip.to) === chip.value, 'cssValueChips: a chip is the text it covers');
    if (chip.kind === 'variable') {
      assert(chip.from < chip.to, 'cssValueChips: a variable chip covers its reference');
    }
  }
  return kept;
}

/** The CSS inside each `<style>` block of markup: between the opening tag's `>` and `</style`. */
export function styleBlocks(text: string): readonly CssChipRange[] {
  const blocks: CssChipRange[] = [];
  const lower = text.toLowerCase();
  let cursor = 0;
  for (let count = 0; count < STYLE_BLOCKS_MAX; count++) {
    const open = lower.indexOf('<style', cursor);
    if (open < 0) {
      break;
    }
    const nameEnd = lower.charAt(open + '<style'.length);
    // `<styles>` or `<style-guide>` is another element.
    if (nameEnd !== '>' && nameEnd !== '/' && !/\s/.test(nameEnd)) {
      cursor = open + 1;
      continue;
    }
    const openEnd = lower.indexOf('>', open);
    if (openEnd < 0) {
      break;
    }
    const close = lower.indexOf('</style', openEnd);
    const to = close < 0 ? text.length : close;
    if (to > openEnd + 1) {
      blocks.push({ from: openEnd + 1, to });
    }
    if (close < 0) {
      break;
    }
    cursor = close + 1;
  }
  assert(blocks.length <= STYLE_BLOCKS_MAX, 'styleBlocks: the block count is bounded');
  return blocks;
}

/** One declaration as it was found: its property and the range of its value (empty while unwritten). */
export interface CssDeclaration {
  readonly property: string;
  readonly value: CssChipRange;
}

/**
 * Calls `onDeclaration` for each declaration in a stylesheet region. A declaration is a run that ends
 * at a top-level `;` or `}` (or the region's end), holds a `:`, and starts with a property name; a run
 * that ends at `{` is a selector or an at-rule prelude, whatever colons it has (`a:hover`).
 */
export function scanDeclarations(text: string, region: CssChipRange, onDeclaration: (declaration: CssDeclaration) => void): void {
  assert(region.from <= region.to, 'scanDeclarations: the region keeps its order');
  assert(region.to <= text.length, 'scanDeclarations: the region lies in the text');
  let start = region.from;
  let depth = 0;
  let index = region.from;
  // Each pass moves `index` forward by at least one, so the region's length bounds the loop.
  for (let step = 0; index < region.to; step++) {
    assert(step <= region.to - region.from, 'scanDeclarations: the scan moves forward');
    const character = text.charAt(index);
    if (character === '/' && text.charAt(index + 1) === '*') {
      const after = commentEnd(text, index, region.to);
      // A comment before a declaration is not part of its name.
      if (text.slice(start, index).trim() === '') {
        start = after;
      }
      index = after;
      continue;
    }
    if (character === '"' || character === "'") {
      index = quoteEnd(text, index, region.to);
      continue;
    }
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      if (character === ';' || character === '}') {
        declarationsIn(text, { from: start, to: index }, onDeclaration);
        start = index + 1;
      } else if (character === '{') {
        start = index + 1;
      }
    }
    index += 1;
  }
  declarationsIn(text, { from: start, to: region.to }, onDeclaration);
}

// The offset after the comment that opens at `open`, or `limit` when it does not close before it.
function commentEnd(text: string, open: number, limit: number): number {
  assert(text.startsWith('/*', open), 'commentEnd: a comment opens here');
  const close = text.indexOf('*/', open + 2);
  return close < 0 || close + 2 > limit ? limit : close + 2;
}

// The offset after the string that opens at `open`, or `limit` when it does not close.
function quoteEnd(text: string, open: number, limit: number): number {
  const quote = text.charAt(open);
  for (let index = open + 1; index < limit; index++) {
    const character = text.charAt(index);
    if (character === '\\') {
      index += 1;
    } else if (character === quote || character === '\n') {
      return index + 1;
    }
  }
  return limit;
}

// The declarations of one run. Most runs are one declaration; a run that holds an unfinished one
// (`background-image:` typed, no `;` yet, the next declaration on the line below) is cut where the
// next line starts a declaration of its own, so the unfinished one is seen as empty rather than as
// having the next line for its value.
function declarationsIn(text: string, run: CssChipRange, onDeclaration: (declaration: CssDeclaration) => void): void {
  let from = run.from;
  // Each pass either ends or moves `from` past a newline, so the run's length bounds the loop.
  for (let pass = 0; from < run.to; pass++) {
    assert(pass <= run.to - run.from, 'declarationsIn: each pass moves forward');
    const colon = text.indexOf(':', from);
    if (colon < 0 || colon >= run.to) {
      return;
    }
    const cut = nextDeclarationLine(text, { from: colon + 1, to: run.to });
    declarationIn(text, { from, to: cut ?? run.to }, colon, onDeclaration);
    if (cut === undefined) {
      return;
    }
    assert(cut > from, 'declarationsIn: a cut is past the run start');
    from = cut;
  }
}

// The start of the first line in `range` that begins a declaration, outside parentheses, strings and
// comments; undefined when there is none.
function nextDeclarationLine(text: string, range: CssChipRange): number | undefined {
  let depth = 0;
  let index = range.from;
  for (let step = 0; index < range.to; step++) {
    assert(step <= range.to - range.from, 'nextDeclarationLine: the scan moves forward');
    const character = text.charAt(index);
    if (character === '/' && text.charAt(index + 1) === '*') {
      index = commentEnd(text, index, range.to);
      continue;
    }
    if (character === '"' || character === "'") {
      index = quoteEnd(text, index, range.to);
      continue;
    }
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth = Math.max(0, depth - 1);
    } else if (character === '\n' && depth === 0) {
      const line = text.slice(index + 1, Math.min(range.to, index + 1 + DECLARATION_START_CHARS_MAX));
      if (DECLARATION_START.test(line)) {
        return index + 1;
      }
    }
    index += 1;
  }
  return undefined;
}

function declarationIn(text: string, run: CssChipRange, colon: number, onDeclaration: (declaration: CssDeclaration) => void): void {
  assert(run.from <= colon, 'declarationIn: the colon is in the run');
  assert(colon < run.to, 'declarationIn: the value follows the colon');
  const property = text.slice(run.from, colon).trim();
  if (!PROPERTY_NAME.test(property)) {
    return;
  }
  const trimmed = trimmedValue(text, { from: colon + 1, to: run.to });
  const value = trimmed.from < trimmed.to ? trimmed : emptyValueAt(text, colon, run.to);
  onDeclaration({ property: property.startsWith('--') ? property : property.toLowerCase(), value });
}

// Where an empty value goes: after the colon and the spaces on its line, never past the line's end,
// so the chip sits where the caret is as `background-image: ` is typed.
function emptyValueAt(text: string, colon: number, limit: number): CssChipRange {
  let at = colon + 1;
  while (at < limit) {
    const character = text.charAt(at);
    if (character !== ' ' && character !== '\t') {
      break;
    }
    at += 1;
  }
  assert(at <= limit, 'emptyValueAt: the place is in the run');
  return { from: at, to: at };
}

// The value without the whitespace around it and without a trailing `!important`.
function trimmedValue(text: string, range: CssChipRange): CssChipRange {
  const raw = text.slice(range.from, range.to);
  const leading = raw.length - raw.trimStart().length;
  const kept = raw.trimEnd().replace(/\s*!\s*important$/i, '');
  const to = range.from + kept.trimEnd().length;
  const from = Math.min(range.from + leading, to);
  assert(from <= to, 'trimmedValue: the value keeps its order');
  return { from, to };
}

/** A property's name with any vendor prefix taken off: `-webkit-box-shadow` is a box shadow. */
export function unprefixedProperty(property: string): string {
  return property.startsWith('--') ? property : property.replace(VENDOR_PREFIX, '');
}

// The chips of one declaration, pushed onto `chips` (the caller's one accumulator, bounded there).
function declarationChips(text: string, declaration: CssDeclaration, chips: CssValueChip[]): void {
  const { property, value } = declaration;
  if (value.from === value.to) {
    const create = createChip(unprefixedProperty(property), value.from);
    if (create !== undefined) {
      chips.push(create);
    }
    return;
  }
  const valueText = text.slice(value.from, value.to);
  if (property.startsWith('--')) {
    customPropertyChips(text, declaration, chips);
    return;
  }
  const base = unprefixedProperty(property);
  // A keyword the panel offers, as the whole value. Anything else (a variable, `inherit`, a calc(), a
  // keyword the panel has no button for) gets no keyword chip: a wrong button would look selected.
  if (isKeywordProperty(base) && isKeywordOf(base, valueText)) {
    chips.push({ kind: 'keyword', property: base, from: value.from, to: value.to, value: valueText });
  }
  const variables = variableChips(text, declaration);
  const insideVariable = (offset: number): boolean => variables.some((chip) => chip.from < offset && offset < chip.to);
  // The whole-list chip first, so it is drawn in front of the first layer's own chip.
  if (isLayered(base)) {
    const lower = valueText.toLowerCase();
    if (!WHOLE_VARIABLE.test(valueText) && (lower === 'none' || !WIDE_KEYWORDS.has(lower))) {
      chips.push({ kind: 'layers', property: base, from: value.from, to: value.to, value: valueText });
    }
  }
  chips.push(...variables);
  if (EASING_PROPERTIES.has(base)) {
    for (const token of topLevelTokens(text, value, /[\s,]/)) {
      if (isEasing(token.value)) {
        chips.push({ kind: 'easing', ...token });
      }
    }
    if (EASING_ONLY_PROPERTIES.has(base) && unfinishedWord(valueText) && !isEasing(valueText) && !WIDE_KEYWORDS.has(valueText.toLowerCase())) {
      chips.push({ kind: 'easing', from: value.from, to: value.to, value: valueText });
    }
  } else if (CLIP_PATH_PROPERTIES.has(base)) {
    if (!WIDE_KEYWORDS.has(valueText.toLowerCase())) {
      chips.push({ kind: 'clipPath', from: value.from, to: value.to, value: valueText });
    }
  } else if (base === 'box-shadow' || base === 'text-shadow') {
    for (const layer of topLevelTokens(text, value, /,/)) {
      if (!WIDE_KEYWORDS.has(layer.value.toLowerCase()) && !WHOLE_VARIABLE.test(layer.value)) {
        chips.push({ kind: base === 'box-shadow' ? 'boxShadow' : 'textShadow', ...layer });
      }
    }
  }
  pushGradients(text, value, chips, insideVariable);
  if (base === 'background-image' && unfinishedWord(valueText) && !WIDE_KEYWORDS.has(valueText.toLowerCase())) {
    chips.push({ kind: 'gradient', from: value.from, to: value.to, value: valueText });
  }
  if (COLOR_PROPERTIES.has(base) || COLOR_SHORTHANDS.has(base)) {
    pushColors(text, value, chips);
  }
  if (COLOR_PROPERTIES.has(base) && unfinishedWord(valueText) && !isColorLiteral(valueText) && !COLOR_KEYWORDS.has(valueText.toLowerCase())) {
    chips.push({ kind: 'color', from: value.from, to: value.to, value: valueText, variable: undefined });
  }
}

// A custom property's value has the chips its whole value is: a variable, an easing, a colour, and
// the gradients in it.
function customPropertyChips(text: string, declaration: CssDeclaration, chips: CssValueChip[]): void {
  const { value } = declaration;
  const valueText = text.slice(value.from, value.to);
  const variables = variableChips(text, declaration);
  chips.push(...variables);
  if (isEasing(valueText)) {
    chips.push({ kind: 'easing', from: value.from, to: value.to, value: valueText });
  } else if (isColorLiteral(valueText)) {
    chips.push({ kind: 'color', from: value.from, to: value.to, value: valueText, variable: declaration.property });
  }
  pushGradients(text, value, chips, (offset) => variables.some((chip) => chip.from < offset && offset < chip.to));
}

function pushGradients(text: string, value: CssChipRange, chips: CssValueChip[], insideVariable: (offset: number) => boolean): void {
  for (const gradient of functionCalls(text, value, GRADIENT_START)) {
    const parsed = parseGradient(gradient.value);
    if (parsed !== undefined && gradientFitsEditor(parsed) && !insideVariable(gradient.from)) {
      chips.push({ kind: 'gradient', ...gradient });
    }
  }
}

function pushColors(text: string, value: CssChipRange, chips: CssValueChip[]): void {
  for (const token of valueWords(text, value)) {
    if (isColorLiteral(token.value)) {
      chips.push({ kind: 'color', ...token, variable: undefined });
    }
  }
}

// The chip an empty value of `property` gets: the kind of the editor that makes its value.
function createChip(property: string, at: number): CssValueChip | undefined {
  const empty = { from: at, to: at, value: '' };
  if (isLayered(property)) {
    return { kind: 'layers', property, ...empty };
  }
  if (CLIP_PATH_PROPERTIES.has(property)) {
    return { kind: 'clipPath', ...empty };
  }
  if (GRADIENT_CREATE_PROPERTIES.has(property)) {
    return { kind: 'gradient', ...empty };
  }
  if (EASING_CREATE_PROPERTIES.has(property)) {
    return { kind: 'easing', ...empty };
  }
  if (COLOR_PROPERTIES.has(property)) {
    return { kind: 'color', ...empty, variable: undefined };
  }
  if (isKeywordProperty(property)) {
    return { kind: 'keyword', property, ...empty };
  }
  return undefined;
}

function isLayered(property: string): property is LayeredProperty {
  return LAYERED.has(property);
}

function unfinishedWord(value: string): boolean {
  return UNFINISHED_WORD.test(value);
}

/** Whether `token` is a colour written out: a hex, a colour function or a named colour. */
export function isColorLiteral(token: string): boolean {
  const trimmed = token.trim();
  if (HEX_COLOR.test(trimmed)) {
    return true;
  }
  if (COLOR_FUNCTION.test(trimmed)) {
    // A channel held in a variable is a colour only once the variable is read; the variable's own
    // chip is what edits it.
    return trimmed.endsWith(')') && !/var\(/i.test(trimmed);
  }
  return CSS_COLOR_NAMES.has(trimmed.toLowerCase());
}

function variableChips(text: string, declaration: CssDeclaration): CssValueChip[] {
  const property = declaration.property.startsWith('--') ? undefined : declaration.property;
  return functionCalls(text, declaration.value, VARIABLE_START).map((call) => ({ kind: 'variable', ...call, property, declaration: declaration.value }));
}

/**
 * Each call in `range` whose text starts as `start` matches, from its name to its balanced `)`. A call
 * nested in one already found is part of it (`var(--a, var(--b))` is one reference), and a call that
 * never closes is not one.
 */
export function functionCalls(text: string, range: CssChipRange, start: RegExp): Array<CssChipRange & { readonly value: string }> {
  const calls: Array<CssChipRange & { readonly value: string }> = [];
  let index = range.from;
  for (let step = 0; index < range.to; step++) {
    assert(step <= range.to - range.from, 'functionCalls: the scan moves forward');
    const character = text.charAt(index);
    // A string's text is never a call (`content: "var(--a)"`), nor is a comment's.
    if (character === '"' || character === "'") {
      index = quoteEnd(text, index, range.to);
      continue;
    }
    if (character === '/' && text.charAt(index + 1) === '*') {
      index = commentEnd(text, index, range.to);
      continue;
    }
    const before = index === range.from ? '' : text.charAt(index - 1);
    if (!/[\w-]/.test(before) && start.test(text.slice(index, Math.min(range.to, index + 64)))) {
      const close = closingParen(text, text.indexOf('(', index), range.to);
      if (close !== undefined) {
        calls.push({ from: index, to: close + 1, value: text.slice(index, close + 1) });
        index = close + 1;
        continue;
      }
    }
    index += 1;
  }
  return calls;
}

// The `)` that closes the `(` at `open`, before `limit`; undefined when it does not close.
function closingParen(text: string, open: number, limit: number): number | undefined {
  assert(text.charAt(open) === '(', 'closingParen: it starts at an opening paren');
  let depth = 0;
  for (let index = open; index < limit; index++) {
    const character = text.charAt(index);
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}

/** The pieces of `range` between top-level `separator` characters, trimmed, empty pieces left out. */
export function topLevelTokens(text: string, range: CssChipRange, separator: RegExp): Array<CssChipRange & { readonly value: string }> {
  const tokens: Array<CssChipRange & { readonly value: string }> = [];
  const push = (from: number, to: number): void => {
    const trimmed = trimmedValue(text, { from, to });
    if (trimmed.from < trimmed.to) {
      tokens.push({ ...trimmed, value: text.slice(trimmed.from, trimmed.to) });
    }
  };
  let depth = 0;
  let start = range.from;
  for (let index = range.from; index < range.to; index++) {
    const character = text.charAt(index);
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && separator.test(character)) {
      push(start, index);
      start = index + 1;
    }
  }
  push(start, range.to);
  return tokens;
}

/**
 * The words of a value at its top level: split at whitespace, commas and slashes, a call kept whole,
 * and nothing from inside a string or a comment (`color: /* red *\/ blue` has one word, `blue`).
 */
export function valueWords(text: string, range: CssChipRange): Array<CssChipRange & { readonly value: string }> {
  const words: Array<CssChipRange & { readonly value: string }> = [];
  let start: number | undefined = undefined;
  let depth = 0;
  const end = (at: number): void => {
    if (start !== undefined && start < at) {
      words.push({ from: start, to: at, value: text.slice(start, at) });
    }
    start = undefined;
  };
  let index = range.from;
  for (let step = 0; index < range.to; step++) {
    assert(step <= range.to - range.from, 'valueWords: the scan moves forward');
    const character = text.charAt(index);
    if (depth === 0 && character === '/' && text.charAt(index + 1) === '*') {
      end(index);
      index = commentEnd(text, index, range.to);
      continue;
    }
    if (character === '"' || character === "'") {
      // A string is a word of its own that is never a colour; it is skipped whole.
      end(index);
      index = quoteEnd(text, index, range.to);
      continue;
    }
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && /[\s,/]/.test(character)) {
      end(index);
      index += 1;
      continue;
    }
    if (start === undefined) {
      start = index;
    }
    index += 1;
  }
  end(range.to);
  return words;
}
