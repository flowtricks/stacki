import { Compartment, Facet, StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type PluginValue, type ViewUpdate } from '@codemirror/view';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { assert } from '../../../../shared/core/assert';
import type { Translator } from '../../../lib/i18n/localeContext';
import { MiniCurve } from '../EasingEditor';
import { ClipGlyph, clipPathType } from '../ClipPathRow';
import { tokenChipHtml } from '../TokenField';
import { ClockIcon } from '../TransitionsRow';
import { FilterGlyph } from '../TransformsRow';
import { transformTypeIcon } from '../transformIcons';
import { centralIcon } from '../../../ui/central/CentralIcon';
import { add as centralAdd, layers as centralLayers, listMenu as centralListMenu } from '../../../ui/central/centralGeometry';
import { keywordOption, type KeywordPropertyName } from './keywordOptions';
import { referenceChip } from '../VariableConnect';
import { BOX_SHADOW_PREVIEW_CHECKERBOARD } from '../BoxShadowsRow';
import { parseBoxShadows } from '../model/boxShadow';
import { parseShadows } from '../model/textShadow';
import { easingToBezier } from '../model/transition';
import { rootColorNow } from '../model/computedColor';
import type { ProjectVariable } from '../model/webflow';
import { currentCodeChipsMode, subscribeCodeChipsMode } from './codeChipsPreference';
import { variableChipShown, variableNames } from './chipTyping';
import { cssValueChips, type CssChipRange, type CssChipText, type CssValueChip, type LayeredProperty } from './cssValueChips';
import './codeChips.css';

// The CodeMirror half of a code editor's CSS chips (CodeChips.tsx holds the React half: the editors
// a chip opens). Every CSS code surface adds this one extension:
//
// - a variable reference is drawn as the Style panel's purple chip, over its text, once it names a
//   variable the project has and the caret is not inside it (chipTyping.ts). The range is atomic,
//   so the caret steps over it and a delete takes it whole, and it is only drawn: the document, a copy
//   (CodeMirror copies the document's text, never the drawing) and every save are the text as written;
// - an easing, a clip-path, a shadow layer, a gradient, a colour and a layered property's whole list
//   get a small preview in front of the value, and the value itself stays plain, editable text;
// - a value still to be written gets a create chip (a plus) where it goes, so a designer can make one
//   without knowing how to write it. A write to it inserts the value, with a space after the colon
//   and a `;` after the value when the line has none.
//
// Pressing a chip hands the React half what it stands for; the React half writes the edited value
// back with `writeChipValue`, which replaces exactly that chip's range and nothing around it. The
// "Show CSS chips in code" setting lives in a compartment, so turning it off drops every chip from each
// open editor at once, and turning it on draws them again, with no remount.

/** What the extension asks the editor's React half, read when needed so the extension is made once. */
export interface CodeChipHandlers {
  /** What the editor's text is; undefined while it is not CSS (a script in the same code window). */
  readonly text: () => CssChipText | undefined;
  /** The project's variables, for a chip's name, glyph and tooltip. */
  readonly variables: () => readonly ProjectVariable[];
  readonly translate: () => Translator;
  /** A chip was pressed: open its editor under `anchor` (the chip's box when pressed). */
  readonly onOpen: (request: CodeChipRequest) => void;
  /** The view as it mounts and as it goes, so the React half can ask it to redraw. */
  readonly onView: (view: EditorView, presence: 'mounted' | 'gone') => void;
}

export interface CodeChipRequest {
  readonly view: EditorView;
  readonly chip: CssValueChip;
  readonly anchor: DOMRect;
}

type HandlersRef = { readonly current: CodeChipHandlers };

/** Asks every chip to be drawn again: the variables arrived, or the text changed what it is. */
export const refreshCodeChips = StateEffect.define<'refresh'>();
const openChipEffect = StateEffect.define<CssChipRange | undefined>();

/**
 * The range of the chip whose editor is open, carried through every edit so a write lands on the value
 * as it is now, wherever typing elsewhere has moved it. Undefined when no editor is open, or once the
 * value it stood for has been deleted. A create chip's range is empty, and stays a place rather than a
 * value until its first write fills it.
 */
const openChipField = StateField.define<CssChipRange | undefined>({
  create: () => undefined,
  update: (range, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(openChipEffect)) {
        return effect.value;
      }
    }
    if (range === undefined) {
      return range;
    }
    if (!transaction.docChanged) {
      return range;
    }
    if (range.from === range.to) {
      // A place has no text to lose: text typed at it lands after it, and it stays where it was.
      const at = transaction.changes.mapPos(range.from, -1);
      return { from: at, to: at };
    }
    const from = transaction.changes.mapPos(range.from, 1);
    const to = transaction.changes.mapPos(range.to, -1);
    return from < to ? { from, to } : undefined;
  },
});

/** The extension that draws CSS chips; `handlersRef` is read on every redraw and press. */
export function codeChipsExtension(handlersRef: HandlersRef): Extension {
  const compartment = new Compartment();
  const chips = chipLayer(handlersRef);
  const shown = (): Extension => (currentCodeChipsMode() === 'shown' ? chips : []);
  const follower = ViewPlugin.define((view) => {
    // The store calls this from Settings' own event, never while this view is updating.
    const unsubscribe = subscribeCodeChipsMode(() => view.dispatch({ effects: compartment.reconfigure(shown()) }));
    handlersRef.current.onView(view, 'mounted');
    return {
      destroy: () => {
        unsubscribe();
        handlersRef.current.onView(view, 'gone');
      },
    };
  });
  return [openChipField, compartment.of(shown()), follower];
}

/** The open chip's range in `view`, for its editor's next write; undefined when it is gone. */
export function openChipRange(view: EditorView): CssChipRange | undefined {
  return view.state.field(openChipField, false);
}

/** Marks `range` as the chip whose editor is open, or, undefined, none. */
export function setOpenChip(view: EditorView, range: CssChipRange | undefined): void {
  if (range !== undefined) {
    assert(range.from <= range.to, 'setOpenChip: an open chip keeps its order');
    assert(range.to <= view.state.doc.length, 'setOpenChip: an open chip lies in the document');
  }
  view.dispatch({ effects: openChipEffect.of(range) });
}

/**
 * Writes `value` over the open chip's range and keeps that range on the new text. Answers whether it
 * was written: false when the value was deleted while its editor was open, or is already `value`.
 */
export function writeChipValue(view: EditorView, value: string): boolean {
  assert(value.length > 0, 'writeChipValue: a chip value is never empty');
  const range = openChipRange(view);
  if (range === undefined) {
    return false;
  }
  assert(range.to <= view.state.doc.length, 'writeChipValue: the open chip lies in the document');
  if (view.state.sliceDoc(range.from, range.to) === value) {
    return false;
  }
  const { before, after } = range.from === range.to ? createdValueFrame(view.state.doc.toString(), range.from) : { before: '', after: '' };
  const from = range.from + before.length;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: `${before}${value}${after}` },
    effects: openChipEffect.of({ from, to: from + value.length }),
    userEvent: 'input.chip',
  });
  const written = openChipRange(view);
  assert(written !== undefined, 'writeChipValue: the written value stays open');
  assert(view.state.sliceDoc(written.from, written.to) === value, 'writeChipValue: the open range is the written value');
  return true;
}

/**
 * What a value written into an empty declaration needs around it: a space after the colon when there
 * is none, and a `;` after it when the line has none (the declaration ends at a `}` or the line's end).
 * Only a created value gets these; a value that was already there is replaced as it stands.
 */
export function createdValueFrame(text: string, at: number): { readonly before: string; readonly after: string } {
  assert(at >= 0, 'createdValueFrame: the place is in the text');
  assert(at <= text.length, 'createdValueFrame: the place ends in the text');
  const before = text.charAt(at - 1) === ':' ? ' ' : '';
  let index = at;
  // The rest of the line: spaces and tabs only, so the line's length bounds the walk.
  while (index < text.length && (text.charAt(index) === ' ' || text.charAt(index) === '\t')) {
    index += 1;
  }
  if (text.charAt(index) === ';') {
    return { before, after: '' };
  }
  // `color: !important` typed with the value left out: the value goes before the flag, a space apart.
  if (/^!\s*important/i.test(text.slice(index, index + 16))) {
    return { before, after: index === at ? ' ' : '' };
  }
  return { before, after: ';' };
}

/** The chips `view` draws now, in document order; empty while the setting is off. */
export function drawnCodeChips(view: EditorView): readonly CssValueChip[] {
  const plugin = view.state.facet(chipPluginFacet);
  if (plugin === undefined) {
    return [];
  }
  return view.plugin(plugin)?.drawing.chips ?? [];
}

// ─────────────────────────── The chip layer ───────────────────────────

interface ChipDrawing {
  /** Every chip of the document that is drawn, for a press to find its chip by. */
  readonly chips: readonly CssValueChip[];
  /** Every chip the scan found, references the project lacks and the one being edited among them. */
  readonly found: readonly CssValueChip[];
  /** Where the reference the caret is inside starts; undefined when it is in none. */
  readonly editing: number | undefined;
  /** The drawings of the chips in and near the viewport: a long stylesheet draws only what is seen. */
  readonly decorations: DecorationSet;
  readonly atomic: DecorationSet;
}

// How far past the visible lines chips are drawn, so a short scroll shows them already in place.
const VIEWPORT_MARGIN_CHARS = 2_000;

interface ChipLayerValue extends PluginValue {
  readonly drawing: ChipDrawing;
}

// The layer's plugin, provided with it: dropped by the setting's compartment, it is gone here too.
const chipPluginFacet = Facet.define<ViewPlugin<ChipLayerValue>, ViewPlugin<ChipLayerValue> | undefined>({ combine: (plugins) => plugins[0] });

function chipLayer(handlersRef: HandlersRef): Extension {
  // Every chip the text has, before the variables and the caret say which references are drawn.
  const scan = (view: EditorView): readonly CssValueChip[] => {
    const kind = handlersRef.current.text();
    return kind === undefined ? [] : cssValueChips(view.state.doc.toString(), kind);
  };
  let names: { readonly from: readonly ProjectVariable[]; readonly names: ReadonlySet<string> } | undefined = undefined;
  const namesOf = (variables: readonly ProjectVariable[]): ReadonlySet<string> => {
    if (names === undefined || names.from !== variables) {
      names = { from: variables, names: variableNames(variables) };
    }
    return names.names;
  };
  const draw = (view: EditorView, found: readonly CssValueChip[]): ChipDrawing => {
    const handlers = handlersRef.current;
    const variables = handlers.variables();
    const caret = view.hasFocus ? view.state.selection.main.head : undefined;
    const known = namesOf(variables);
    const chips = found.filter((chip) => chip.kind !== 'variable' || variableChipShown(chip, known, caret));
    assert(chips.length <= found.length, 'chipLayer: the drawn chips are among the found ones');
    const seen = chipsInViewport(chips, view.viewport, view.state.doc.length);
    return { ...chipDecorations(seen, { handlersRef, variables, translate: handlers.translate() }), chips, found, editing: editedReference(found, caret) };
  };
  const plugin = ViewPlugin.fromClass(
    class ChipLayer implements ChipLayerValue {
      drawing: ChipDrawing;
      constructor(view: EditorView) {
        // Drawn as the view is made, so its first frame already has its chips.
        this.drawing = draw(view, scan(view));
      }
      update(update: ViewUpdate): void {
        const asked = update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(refreshCodeChips)));
        if (update.docChanged || asked) {
          this.drawing = draw(update.view, scan(update.view));
        } else if (update.viewportChanged) {
          // A scroll draws the chips that came into view from the scan already made.
          this.drawing = draw(update.view, this.drawing.found);
        } else if (update.selectionSet || update.focusChanged) {
          // The caret entering or leaving a reference turns it to text or back to its chip; a caret
          // moving anywhere else redraws nothing.
          const caret = update.view.hasFocus ? update.state.selection.main.head : undefined;
          if (editedReference(this.drawing.found, caret) !== this.drawing.editing) {
            this.drawing = draw(update.view, this.drawing.found);
          }
        }
      }
    },
    { decorations: (layer) => layer.drawing.decorations },
  );
  const atomic = EditorView.atomicRanges.of((view) => view.plugin(plugin)?.drawing.atomic ?? Decoration.none);
  return [plugin, atomic, chipPluginFacet.of(plugin)];
}

// The start of the variable reference the caret is strictly inside, or undefined.
function editedReference(found: readonly CssValueChip[], caret: number | undefined): number | undefined {
  if (caret === undefined) {
    return undefined;
  }
  return found.find((chip) => chip.kind === 'variable' && chip.from < caret && caret < chip.to)?.from;
}

interface DrawContext {
  readonly handlersRef: HandlersRef;
  readonly variables: readonly ProjectVariable[];
  readonly translate: Translator;
}

/** The chips that touch the viewport widened by VIEWPORT_MARGIN_CHARS on each side, in order. */
export function chipsInViewport(chips: readonly CssValueChip[], viewport: CssChipRange, documentLength: number): readonly CssValueChip[] {
  assert(viewport.from <= viewport.to, 'chipsInViewport: the viewport keeps its order');
  assert(viewport.to <= documentLength, 'chipsInViewport: the viewport lies in the document');
  const from = Math.max(0, viewport.from - VIEWPORT_MARGIN_CHARS);
  const to = Math.min(documentLength, viewport.to + VIEWPORT_MARGIN_CHARS);
  return chips.filter((chip) => chip.to >= from && chip.from <= to);
}

function chipDecorations(chips: readonly CssValueChip[], context: DrawContext): Pick<ChipDrawing, 'decorations' | 'atomic'> {
  const all: Array<Range<Decoration>> = [];
  const atomic: Array<Range<Decoration>> = [];
  for (const chip of chips) {
    assert(chip.from <= chip.to, 'chipDecorations: a chip keeps its order');
    const widget = new ChipWidget(chip, chipFace(chip, context), context.handlersRef);
    if (chip.kind === 'variable') {
      const replaced = Decoration.replace({ widget }).range(chip.from, chip.to);
      all.push(replaced);
      atomic.push(replaced);
    } else {
      all.push(Decoration.widget({ widget, side: -1 }).range(chip.from));
    }
  }
  assert(atomic.length <= all.length, 'chipDecorations: every atomic chip is drawn');
  return { decorations: Decoration.set(all, true), atomic: Decoration.set(atomic, true) };
}

// ─────────────────────────── The widgets ───────────────────────────

/** How a chip looks: its markup, its label, and the key that says two faces are the same drawing. */
interface ChipFace {
  readonly key: string;
  readonly label: string;
  readonly build: () => HTMLElement;
}

// Static drawings of the panel's own glyphs, made once per value: a widget draws synchronously, and
// the same easing or clip shape repeats through a stylesheet.
const GLYPHS_CACHED_MAX = 256;
const glyphCache = new Map<string, string>();
function glyphMarkup(key: string, render: () => string): string {
  const cached = glyphCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const markup = render();
  if (glyphCache.size >= GLYPHS_CACHED_MAX) {
    glyphCache.clear();
  }
  glyphCache.set(key, markup);
  return markup;
}

// The Central icons a chip draws, as static markup (see glyphMarkup).
const AddGlyph = centralIcon(centralAdd);
const LayersGlyph = centralIcon(centralLayers);
const KeywordGlyph = centralIcon(centralListMenu);
function iconMarkup(key: string, icon: ComponentType): string {
  return glyphMarkup(key, () => renderToStaticMarkup(createElement(icon)));
}

function chipFace(chip: CssValueChip, context: DrawContext): ChipFace {
  const { translate } = context;
  // A value still to be written: a plus, named for the editor that makes it.
  if (chip.kind !== 'variable' && chip.value === '') {
    const label = chipLabel(chip, translate);
    return { key: `create|${chip.kind}|${label}`, label, build: () => iconChip('is-create', iconMarkup('icon|add', AddGlyph)) };
  }
  switch (chip.kind) {
    case 'variable': {
      const token = referenceChip(chip.value, [...context.variables]);
      const markup = tokenChipHtml(token);
      return {
        key: `variable|${markup}`,
        label: translate('styleModel.shared.connectVariable', { label: chip.property ?? token.name }),
        build: () => elementFrom(markup),
      };
    }
    case 'easing': {
      const markup = glyphMarkup(`ease|${chip.value}`, () => renderToStaticMarkup(createElement(MiniCurve, { b: easingToBezier(chip.value) })));
      return { key: `easing|${chip.value}`, label: translate('style.easingEditor.easingEditor'), build: () => iconChip('is-ease', markup) };
    }
    case 'clipPath': {
      const type = clipPathType(chip.value);
      const markup = glyphMarkup(`clip|${type}`, () => renderToStaticMarkup(createElement(ClipGlyph, { type })));
      return { key: `clip|${type}`, label: translate('style.clipPathRow.clipPath'), build: () => iconChip('is-clip', markup) };
    }
    case 'boxShadow': {
      const color = parseBoxShadows(chip.value)[0]?.color ?? '';
      return { key: `box|${color}`, label: translate('style.boxShadowsRow.boxShadow'), build: () => swatchChip(`linear-gradient(${color}, ${color})`) };
    }
    case 'textShadow': {
      const color = parseShadows(chip.value)[0]?.color ?? '';
      return { key: `text|${color}`, label: translate('style.textStrokeShadow.textShadow'), build: () => swatchChip(`linear-gradient(${color}, ${color})`) };
    }
    case 'gradient':
      return { key: `gradient|${chip.value}`, label: translate('style.backgroundLayerEditor.gradient'), build: () => swatchChip(chip.value) };
    case 'color': {
      // A custom property's colour is painted as the page computes that variable on `:root`
      // (rootColors.ts), once it has answered; until then, and without a canvas, as written.
      const paint = chip.variable === undefined ? chip.value : (rootColorNow(`var(${chip.variable})`) ?? chip.value);
      return { key: `color|${paint}`, label: chipLabel(chip, translate), build: () => swatchChip(`linear-gradient(${paint}, ${paint})`) };
    }
    case 'layers': {
      const label = chipLabel(chip, translate);
      return { key: `layers|${chip.property}|${label}`, label, build: () => iconChip('is-layers', layersMarkup(chip.property)) };
    }
    case 'keyword': {
      const label = chipLabel(chip, translate);
      const markup = keywordMarkup(chip.property, chip.value, translate);
      return { key: `keyword|${markup}|${label}`, label, build: () => iconChip('is-keyword', markup) };
    }
    default: {
      const exhaustive: never = chip;
      // Never hand an unknown value on as if it were a face, a glyph or a name: fail loudly.
      throw new Error(`Assertion failed: code chips: unknown chip ${JSON.stringify(exhaustive)}`);
    }
  }
}

// A keyword chip's glyph: the panel's icon for the current value (text-align: center's centred lines),
// or a generic list glyph for a value the panel names only in words (display: flex).
function keywordMarkup(property: KeywordPropertyName, value: string, translate: Translator): string {
  const icon = keywordOption(property, value, translate)?.icon;
  if (icon === undefined || icon === null) {
    return iconMarkup('icon|keyword', KeywordGlyph);
  }
  return glyphMarkup(`keyword|${property}|${value.toLowerCase()}`, () => renderToStaticMarkup(createElement('span', { className: 'code-chip-glyph' }, icon)));
}

// The glyph of a layered property's whole-list chip: the icon its Style panel rows draw.
function layersMarkup(property: LayeredProperty): string {
  switch (property) {
    case 'transition':
      return iconMarkup('icon|clock', ClockIcon);
    case 'transform':
      return glyphMarkup('icon|transform', () => renderToStaticMarkup(createElement('span', { className: 'code-chip-glyph' }, transformTypeIcon('move'))));
    case 'filter':
    case 'backdrop-filter':
      return iconMarkup('icon|filter', FilterGlyph);
    case 'box-shadow':
    case 'text-shadow':
    case 'background-image':
      return iconMarkup('icon|layers', LayersGlyph);
    default: {
      const exhaustive: never = property;
      // Never hand an unknown value on as if it were a face, a glyph or a name: fail loudly.
      throw new Error(`Assertion failed: code chips: unknown property ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** A chip's accessible name: the editor it opens, as the Style panel names it. */
export function chipLabel(chip: Exclude<CssValueChip, { kind: 'variable' }>, translate: Translator): string {
  switch (chip.kind) {
    case 'easing':
      return translate('style.easingEditor.easingEditor');
    case 'clipPath':
      return translate('style.clipPathRow.clipPath');
    case 'boxShadow':
      return translate('style.boxShadowsRow.boxShadow');
    case 'textShadow':
      return translate('style.textStrokeShadow.textShadow');
    case 'gradient':
      return translate('style.backgroundLayerEditor.gradient');
    case 'color':
      return translate('style.effectsSection.color');
    case 'layers':
      return layersLabel(chip.property, translate);
    case 'keyword':
      // The CSS property itself, as the panel's control is captioned by the property it sets.
      return chip.property;
    default: {
      const exhaustive: never = chip;
      // Never hand an unknown value on as if it were a face, a glyph or a name: fail loudly.
      throw new Error(`Assertion failed: code chips: unknown chip ${JSON.stringify(exhaustive)}`);
    }
  }
}

function layersLabel(property: LayeredProperty, translate: Translator): string {
  switch (property) {
    case 'transition':
      return translate('style.transitionsRow.transitions');
    case 'transform':
      return translate('style.transformsRow.transforms2d3d');
    case 'filter':
      return translate('style.effectsSection.filters');
    case 'backdrop-filter':
      return translate('style.effectsSection.backdropFilters');
    case 'box-shadow':
      return translate('style.boxShadowsRow.boxShadows');
    case 'text-shadow':
      return translate('style.textStrokeShadow.textShadows');
    case 'background-image':
      return translate('style.backgroundSection.imageAndGradient');
    default: {
      const exhaustive: never = property;
      // Never hand an unknown value on as if it were a face, a glyph or a name: fail loudly.
      throw new Error(`Assertion failed: code chips: unknown property ${JSON.stringify(exhaustive)}`);
    }
  }
}

// The variable chip's markup is the Style panel's own (TokenField.tsx), every value in it escaped there.
function elementFrom(markup: string): HTMLElement {
  const holder = document.createElement('span');
  holder.innerHTML = markup;
  const element = holder.firstElementChild;
  assert(element instanceof HTMLElement, 'elementFrom: the chip markup is one element');
  return element;
}

function iconChip(modifier: string, glyph: string): HTMLElement {
  const element = document.createElement('span');
  element.className = `code-chip ${modifier}`;
  element.innerHTML = glyph;
  return element;
}

// A swatch painted with the value itself, over the checkerboard a translucent colour needs, as the
// panel's layer rows draw it. Set through the style object, so a value is never parsed as markup.
function swatchChip(paint: string): HTMLElement {
  const element = document.createElement('span');
  element.className = 'code-chip is-swatch';
  const swatch = document.createElement('span');
  swatch.className = 'code-chip-swatch';
  swatch.style.background = `${paint}, ${BOX_SHADOW_PREVIEW_CHECKERBOARD}`;
  element.append(swatch);
  return element;
}

class ChipWidget extends WidgetType {
  constructor(
    private readonly chip: CssValueChip,
    private readonly face: ChipFace,
    private readonly handlersRef: HandlersRef,
  ) {
    super();
  }
  override eq(other: ChipWidget): boolean {
    return other.face.key === this.face.key && other.face.label === this.face.label;
  }
  override toDOM(view: EditorView): HTMLElement {
    const element = this.face.build();
    element.dataset['codeChip'] = this.chip.kind;
    element.setAttribute('role', 'button');
    element.setAttribute('aria-label', this.face.label);
    if (!element.hasAttribute('title')) {
      element.title = this.face.label;
    }
    // A press opens the chip's editor and leaves the caret and the selection where they were.
    element.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.press(view, element);
    });
    return element;
  }
  // The chip as it is now: a kept widget's element outlives the chip it was first drawn for, so the
  // press finds it again by where the element sits in the document.
  private press(view: EditorView, element: HTMLElement): void {
    const from = view.posAtDOM(element);
    const chip = drawnCodeChips(view).find((candidate) => candidate.from === from && candidate.kind === this.chip.kind);
    if (chip === undefined) {
      return;
    }
    this.handlersRef.current.onOpen({ view, chip, anchor: element.getBoundingClientRect() });
  }
  // The editor leaves events inside a chip to the chip.
  override ignoreEvent(): boolean {
    return true;
  }
}
