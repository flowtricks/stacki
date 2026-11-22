import { Component, Suspense, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { assert } from '../../../../shared/core/assert';
import { SLOT_MARK, slotOfMarked, type ValueSlot } from '../../../../shared/properties/valueSlot';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { SkeletonRows } from '../../../ui/Skeleton';
import { BoxShadowEditor, BoxShadowsRow } from '../BoxShadowsRow';
import { LayerEditor, isGradientType } from '../BackgroundLayerEditor';
import { typeOptions } from '../BackgroundLayerFields';
import { layerRow } from '../BackgroundSection';
import { PlusIcon } from '../components/MenuParts';
import LayerList, { LayerListOpensSingleRow } from '../LayerList';
import SegmentedControl from '../../../ui/SegmentedControl';
import { blankLayer, parseLayers, serializeLayers, type BgLayer, type LayerKind } from '../model/background';
import { openAfterRemoval } from '../model/fieldHooks';
import { displayOf } from '../model/styleDisplay';
import { ClipPathEditor } from '../ClipPathRow';
import ColorPicker from '../components/ColorPicker';
import EasingEditor from '../EasingEditor';
import { EffLabel, type Props as StyleRowProps } from '../EffectsKit';
import GradientEditor from '../GradientEditor';
import LayerPopover from '../LayerPopover';
import { ShadowEditor, TextShadowsRow } from '../TextStrokeShadow';
import { FiltersRow, TransformsRow } from '../TransformsRow';
import { TransitionsRow } from '../TransitionsRow';
import { VariablePicker } from '../VariablePicker';
import { useSharedVars } from '../sharedVars';
import { rootSwatchScope, subscribeRootColors, SwatchScopeContext } from '../model/computedColor';
import { declaredPropertyAt } from '../model/panelVariableList';
import { usePanelListing } from '../usePanelListing';
import { parseBoxShadows, serializeBoxShadows, type BoxShadow } from '../model/boxShadow';
import { blankGradientOf, parseGradient, serializeGradient, type Gradient, type GradientType } from '../model/gradient';
import type { ResolvedProp } from '../model/resolved';
import { parseShadows, serializeShadows, type Shadow } from '../model/textShadow';
import { isEasing } from '../model/transition';
import { centralIcon } from '../../../ui/central/CentralIcon';
import { check as centralCheck } from '../../../ui/central/centralGeometry';
import '../../../ui/menu.css';
import { KeywordChipControl, keywordControlOf } from './KeywordChipControl';
import { isKeywordOf, keywordChoices, type KeywordPropertyName } from './keywordOptions';
import { useChipTyping } from './ChipTypingChooser';
import { codeChipsExtension, refreshCodeChips, setOpenChip, writeChipValue, type CodeChipHandlers, type CodeChipRequest } from './codeChipsExtension';
import type { CssChipText, CssValueChip, LayeredProperty } from './cssValueChips';
import '../embedEditor.css';

// The React half of a code editor's CSS chips (codeChipsExtension.ts draws them). A pressed chip opens
// the Style panel's own editor for what it stands for, the same component the panel opens:
//
// | Chip        | Opens                                          | Writes back                     |
// |-------------|------------------------------------------------|---------------------------------|
// | variable    | VariablePicker, filtered to the property        | the picked `var(--…)`           |
// | easing      | EasingEditor                                   | the curve as a timing function  |
// | clip-path   | the clip-path editor (ClipPathRow.tsx)         | the whole clip-path value       |
// | box-shadow  | BoxShadowEditor, for that one layer            | that layer                      |
// | text-shadow | ShadowEditor, for that one layer               | that layer                      |
// | gradient    | GradientEditor                                 | that gradient                   |
// | color       | ColorPicker, in the notation the author used   | that colour                     |
// | layers      | the panel's row for the property: Transitions, | the whole declaration value     |
// |             | 2D & 3D transforms, Filters, Backdrop filters, |                                 |
// |             | Box shadows, Text shadows or Image & gradient  |                                 |
// |             | (add, remove, …); one layer opens on its fields |                                 |
//
// A create chip (an empty range, codeChipsExtension.ts) opens the same editor on a starting value;
// nothing is written until the editor changes something, so closing it leaves the document as it was.
//
// Every popup but the easing editor is a compact LayerPopover anchored under the chip, no wider than
// the Style panel's own (chipPopoverSpan), with its height bounded by the window and its own scroll;
// the easing editor is the panel's sheet, framed beside the chip. A popup opened from another popup
// sits above it (embedEditor.css, the layer table at the easing editor's rule).
//
// Each write replaces only the chip's own range (writeChipValue), so the rest of the user's CSS, its
// formatting and its scoping are never touched. A drag in an editor writes at most every
// LIVE_WRITE_MS, and the last value is written as the editor closes, so dragging a curve is a few
// edits rather than sixty a second, each of which a code window saves.
//
// Not offered from code, and why:
// - a background layer's size, position, repeat and attachment: they are the sibling longhands, which
//   the one `background-image` declaration a chip edits cannot hold (BackgroundLayersList);
// - an animations editor: the Style panel has none, so `animation` offers only its easing;
// - border-radius and opacity: the panel edits them as plain number fields, not visual editors.

/** What a code editor needs for its chips: the extension, and the popups a press opens. */
export interface CodeChips {
  readonly extension: Extension;
  /** The open chip's editor, portaled to <body>; render it anywhere beside the code editor. */
  readonly overlay: ReactNode;
}

// The open chip: the editor it is in, what it stands for, and where its popup hangs.
interface OpenChip {
  readonly view: EditorView;
  readonly chip: CssValueChip;
  readonly anchor: HTMLElement;
  /** The chip's box when pressed, which every popup is placed against. */
  readonly anchorRect: DOMRect;
}

const LIVE_WRITE_MS = 120;
// The Style panel's popovers are its own width, about 320px; a chip's popup is that size, so the
// shadow, filter and gradient rows lay out exactly as they do in the panel.
export const CHIP_POPOVER_WIDTH_PX = 340;
// The clip-path editor is the Style panel's own width too; its canvas is drawn compact in a chip's
// popover (codeChips.css, .code-chip-clip), so the whole editor stays about 480px tall.
export const CLIP_PATH_POPOVER_WIDTH_PX = 360;
// The easing editor's frame beside the chip: wide enough for its 320px minimum and a margin.
const EASING_FRAME_WIDTH_PX = 360;
/** The gap a chip's popup keeps from each side of the window. */
export const CHIP_POPOVER_EDGE_PX = 8;

/**
 * The boundary around one chip's popup. A render error in an editor the chip opened closes that popup
 * and is logged; the code view around it, and every other chip, keep working. Without it the code
 * view's own boundary caught the error and replaced the whole editor with its "Try again" card.
 */
export class ChipPopoverBoundary extends Component<{ readonly onFailure: () => void; readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[code chips] a chip’s popup failed and was closed', error, info.componentStack);
    this.props.onFailure();
  }

  override render(): ReactNode {
    return this.state.failed ? undefined : this.props.children;
  }
}

/** What an editor of `language` holds for its chips: a stylesheet, markup with `<style>` blocks, or neither. */
export function codeChipTextOf(language: string | undefined): CssChipText | undefined {
  if (language === 'css') {
    return 'stylesheet';
  }
  if (language === 'astro' || language === 'html') {
    return 'markup';
  }
  return undefined;
}

/**
 * Where a chip's popup sits across the window: `widthPx` wide, or the window less its edges when that
 * is narrower, starting at the chip and shifted left only as far as the window needs.
 */
export function chipPopoverSpan(anchor: Pick<DOMRect, 'left'>, widthPx: number, windowWidthPx: number): { readonly left: number; readonly width: number } {
  assert(widthPx > 0, 'chipPopoverSpan: a popup has a width');
  assert(windowWidthPx >= 0, 'chipPopoverSpan: the window has a width');
  const room = Math.max(0, windowWidthPx - CHIP_POPOVER_EDGE_PX * 2);
  const width = Math.min(widthPx, room);
  const left = Math.max(CHIP_POPOVER_EDGE_PX, Math.min(anchor.left, windowWidthPx - CHIP_POPOVER_EDGE_PX - width));
  assert(width <= widthPx, 'chipPopoverSpan: a popup is never wider than asked');
  return { left, width };
}

/**
 * Who offers the variable chooser as a reference is typed: these chips (a code window), or the editor
 * itself (the Style panel's CSS Code section, whose CodeVariables.tsx already does), so it opens once.
 */
export type CodeChipsTyping = 'offered' | 'elsewhere';

/** The chips of a code editor whose text is `text`; undefined draws none (text that is not CSS). */
export function useCodeChips(text: CssChipText | undefined, options: { readonly typing?: CodeChipsTyping } = {}): CodeChips {
  const translate = useTranslate();
  const [open, setOpen] = useState<OpenChip | undefined>(undefined);
  // Read by the press handler, which makes the stand-in anchor outside any state update.
  const openRef = useRef(open);
  openRef.current = open;
  // The catalog is loaded while the editor holds CSS: a reference is drawn as a chip only once it
  // names a variable the project has (chipTyping.ts), and the typed chooser lists the same variables.
  // The list is shared, so it loads once for every editor and picker.
  const { vars, loading } = useSharedVars({ active: text !== undefined });
  const typing = useChipTyping(options.typing === 'elsewhere' ? undefined : text, { vars, loading });
  const views = useRef(new Set<EditorView>());
  // Read through refs: the extension is made once per editor and must never reconfigure it.
  const latest = useRef({ text, vars, translate });
  latest.current = { text, vars, translate };
  const handlersRef = useRef<CodeChipHandlers>({
    text: () => latest.current.text,
    variables: () => latest.current.vars,
    translate: () => latest.current.translate,
    onOpen: (request) => {
      // A read-only editor shows its chips and opens nothing: there is nowhere to write a pick.
      if (request.view.state.readOnly) {
        return;
      }
      setOpen(openFrom(request, openRef.current));
    },
    onView: (view, presence) => {
      if (presence === 'mounted') {
        views.current.add(view);
      } else {
        views.current.delete(view);
      }
    },
  });
  const [chipExtension] = useState(() => codeChipsExtension(handlersRef));
  const extension = useMemo(() => [chipExtension, typing.extension], [chipExtension, typing.extension]);
  // A custom property's swatch is the colour the page computes on `:root`: redraw as answers arrive.
  useEffect(
    () =>
      subscribeRootColors(() => {
        for (const view of views.current) {
          view.dispatch({ effects: refreshCodeChips.of('refresh') });
        }
      }),
    [],
  );
  // A chip's name and glyph come from the variables and the language: redraw when either arrives.
  useEffect(() => {
    for (const view of views.current) {
      view.dispatch({ effects: refreshCodeChips.of('refresh') });
    }
  }, [vars, translate, text]);
  // The stand-in anchor lives on <body> while its popup is open, and goes with it.
  useEffect(() => {
    if (open === undefined) {
      return undefined;
    }
    const { anchor, view, chip } = open;
    const mounted = views.current;
    setOpenChip(view, { from: chip.from, to: chip.to });
    return () => {
      removeStandIn(anchor);
      // A view that has gone (the code window closed under its popup) has no state left to clear.
      if (mounted.has(view)) {
        setOpenChip(view, undefined);
      }
    };
  }, [open]);
  const close = (): void => {
    const view = open?.view;
    setOpen(undefined);
    view?.focus();
  };
  // Each popup has its own boundary, keyed by the chip it opened for: a render failure in one closes
  // that popup and leaves the code view, and the next chip's popup, untouched.
  const overlay = (
    <>
      {open === undefined ? undefined : (
        <ChipPopoverBoundary key={`${open.chip.kind}|${open.chip.from}`} onFailure={close}>
          <ChipEditor open={open} vars={vars} onClose={close} />
        </ChipPopoverBoundary>
      )}
      {typing.overlay}
    </>
  );
  return { extension, overlay };
}

// The press that opens a chip, or, on the open chip itself, the press that puts it away.
function openFrom(request: CodeChipRequest, current: OpenChip | undefined): OpenChip | undefined {
  if (current !== undefined && current.view === request.view && current.chip.from === request.chip.from && current.chip.kind === request.chip.kind) {
    return undefined;
  }
  return { view: request.view, chip: request.chip, anchor: standInAnchor(request.anchor), anchorRect: request.anchor };
}

// A fixed, empty box where the chip was pressed. The popups anchor to an element, and the chip's own
// element is replaced whenever its value is redrawn, which a write does; this one stays put. The box is
// a row with the anchor inside it, because the variable picker places itself against its anchor's
// parent (usePickerPosition): an anchor straight on <body> made the whole page that row, and the
// picker opened above the window, out of sight, so a press on a chip seemed to do nothing.
function standInAnchor(rect: DOMRect): HTMLElement {
  const row = document.createElement('span');
  row.className = 'code-chip-anchor';
  row.setAttribute('aria-hidden', 'true');
  Object.assign(row.style, {
    position: 'fixed',
    left: `${rect.left}px`, // physical: a measured client rect
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    pointerEvents: 'none',
  });
  const anchor = document.createElement('span');
  Object.assign(anchor.style, { display: 'block', width: '100%', height: '100%' });
  row.append(anchor);
  document.body.append(row);
  assert(anchor.parentElement === row, 'standInAnchor: the anchor sits in its own row');
  return anchor;
}

/** Takes the stand-in anchor, and the row it sits in, off the page. */
function removeStandIn(anchor: HTMLElement): void {
  (anchor.parentElement ?? anchor).remove();
}

// Writes as an editor drags: the first value at once, then at most one per LIVE_WRITE_MS, and the
// last one when the editor closes, so no value is lost and the code follows the drag.
function useLiveWrite(view: EditorView): { readonly write: (value: string) => void; readonly flush: () => void } {
  const pending = useRef<string | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const flush = (): void => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
    const value = pending.current;
    pending.current = undefined;
    if (value !== undefined && value.length > 0) {
      writeChipValue(view, value);
    }
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);
  const write = (value: string): void => {
    pending.current = value;
    if (timer.current === undefined) {
      flushRef.current();
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        flushRef.current();
      }, LIVE_WRITE_MS);
    }
  };
  return { write, flush };
}

function ChipEditor({
  open,
  vars,
  onClose,
}: {
  readonly open: OpenChip;
  readonly vars: ReturnType<typeof useSharedVars>['vars'];
  readonly onClose: () => void;
}) {
  const { chip } = open;
  switch (chip.kind) {
    case 'variable':
      return <VariableChipEditor open={open} chip={chip} vars={vars} onClose={onClose} />;
    case 'easing':
      return <EasingChipEditor open={open} onClose={onClose} />;
    case 'clipPath':
      return <ClipPathChipEditor open={open} onClose={onClose} />;
    case 'boxShadow':
      return <BoxShadowChipEditor open={open} onClose={onClose} />;
    case 'textShadow':
      return <TextShadowChipEditor open={open} onClose={onClose} />;
    case 'gradient':
      return <GradientChipEditor open={open} onClose={onClose} />;
    case 'color':
      return <ColorChipEditor open={open} onClose={onClose} />;
    case 'layers':
      return <LayersChipEditor open={open} property={chip.property} onClose={onClose} />;
    case 'keyword':
      return <KeywordChipEditor open={open} property={chip.property} onClose={onClose} />;
    default: {
      // A kind with no editor is a programmer error, and it fails loudly here. Returning the value, the
      // usual exhaustive check, made it a React child: a chip object, which threw "Objects are not
      // valid as a React child" from inside the code view when a new kind reached a module that was
      // not updated with it (a hot reload between the scanner and this file).
      const exhaustive: never = chip;
      throw new Error(`Assertion failed: ChipEditor: no editor for a chip ${JSON.stringify(exhaustive)}`);
    }
  }
}

// The chooser a variable chip opens. In a custom property's value (`--x: var(--a)`) it lists the
// Variables panel's variables, in its groups and order, less the one being declared
// (panelVariableList.ts); anywhere else, the variables that fit the property where the chip sits.
function VariableChipEditor({
  open,
  chip,
  vars,
  onClose,
}: {
  readonly open: OpenChip;
  readonly chip: Extract<CssValueChip, { kind: 'variable' }>;
  readonly vars: ReturnType<typeof useSharedVars>['vars'];
  readonly onClose: () => void;
}) {
  const customValue = chip.property === undefined;
  const [self] = useState(() => (customValue ? declaredPropertyAt(open.view.state.doc.toString(), chip.declaration.from) : undefined));
  const listing = usePanelListing({ active: customValue }, self, vars);
  return (
    <SwatchScopeContext.Provider value={rootSwatchScope(vars)}>
      <VariablePicker
        anchor={open.anchor}
        vars={listing === undefined ? vars : [...listing.variables]}
        loading={false}
        {...(listing === undefined ? {} : { panel: { blocks: listing.blocks } })}
        {...(chip.property === undefined ? {} : { prop: chip.property })}
        selectedBinding={chip.value}
        {...slotProp(open.view, chip)}
        onPick={(binding) => {
          writeChipValue(open.view, binding);
          onClose();
        }}
        onClose={onClose}
      />
    </SwatchScopeContext.Provider>
  );
}

// Where the pick lands in the declaration's value, so the picker judges each variable there.
function slotProp(view: EditorView, chip: Extract<CssValueChip, { kind: 'variable' }>): { readonly slot?: ValueSlot } {
  if (chip.property === undefined) {
    return {};
  }
  const { declaration } = chip;
  assert(declaration.from <= chip.from, 'slotProp: the reference sits in its declaration');
  assert(chip.to <= declaration.to, 'slotProp: the reference ends in its declaration');
  const before = view.state.sliceDoc(declaration.from, chip.from);
  const after = view.state.sliceDoc(chip.to, declaration.to);
  const slot = slotOfMarked(`${before}${SLOT_MARK}${after}`);
  return slot === undefined ? {} : { slot };
}

interface ChipEditorProps {
  readonly open: OpenChip;
  readonly onClose: () => void;
}

// The compact popover every chip but the easing editor and the colour picker opens in: under the chip,
// `widthPx` wide at most, its height bounded by the window with its own scroll (LayerPopover).
function ChipPopover({
  open,
  widthPx,
  label,
  onClose,
  children,
}: {
  readonly open: OpenChip;
  readonly widthPx: number;
  readonly label: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  // Placed once, as the popover opens: a write redraws the chip, and the popup must not follow it.
  const [span] = useState(() => chipPopoverSpan(open.anchorRect, widthPx, window.innerWidth));
  return (
    <LayerPopover anchorEl={open.anchor} span={span} onClose={onClose} ariaLabel={label}>
      {children}
    </LayerPopover>
  );
}

function EasingChipEditor({ open, onClose }: ChipEditorProps) {
  const live = useLiveWrite(open.view);
  // A create chip, or a word that is not an easing yet, starts from the browser's default curve.
  const [initial] = useState(() => (isEasing(open.chip.value) ? open.chip.value : 'ease'));
  const [frame] = useState(() => chipPopoverSpan(open.anchorRect, EASING_FRAME_WIDTH_PX, window.innerWidth));
  return (
    <EasingEditor
      value={initial}
      frame={frame}
      onChange={live.write}
      onClose={() => {
        live.flush();
        onClose();
      }}
    />
  );
}

function ClipPathChipEditor({ open, onClose }: ChipEditorProps) {
  const translate = useTranslate();
  const live = useLiveWrite(open.view);
  const closeAll = (): void => {
    live.flush();
    onClose();
  };
  return (
    <ChipPopover open={open} widthPx={CLIP_PATH_POPOVER_WIDTH_PX} label={translate('style.clipPathRow.clipPath')} onClose={closeAll}>
      <ClipPathChipBody initialValue={open.chip.value} onApply={live.write} onClear={() => live.write('none')} />
    </ChipPopover>
  );
}

/**
 * The clip-path editor as a chip's popover holds it: the panel's own header and editor, in the
 * compact frame codeChips.css gives `.code-chip-clip` (a smaller canvas, no empty bands, the code box
 * its content's height, the whole bounded by the window).
 */
export function ClipPathChipBody({
  initialValue,
  onApply,
  onClear,
}: {
  readonly initialValue: string;
  readonly onApply: (value: string) => void;
  readonly onClear: () => void;
}) {
  const translate = useTranslate();
  return (
    <div className="code-chip-clip">
      <div className="embed-editor_clip-modal-head">
        <span className="embed-editor_clip-modal-title">{translate('style.clipPathRow.clipPath')}</span>
        <div className="embed-editor_clip-modal-actions">
          {/* The clip-path editor puts its shortcut help here, as it does in the Style panel's popover. */}
          <div id="clip-path_header-shortcuts" />
        </div>
      </div>
      <div className="embed-editor_clip-modal-body">
        <Suspense
          fallback={
            <div className="embed-editor_clip-loading">
              <SkeletonRows count={4} />
            </div>
          }
        >
          <ClipPathEditor onApply={onApply} onClear={onClear} hideClassPicker initialValue={initialValue} />
        </Suspense>
      </div>
    </div>
  );
}

function BoxShadowChipEditor({ open, onClose }: ChipEditorProps) {
  const translate = useTranslate();
  const live = useLiveWrite(open.view);
  const [shadow, setShadow] = useState<BoxShadow | undefined>(() => parseBoxShadows(open.chip.value)[0]);
  if (shadow === undefined) {
    return undefined;
  }
  return (
    <ChipPopover
      open={open}
      widthPx={CHIP_POPOVER_WIDTH_PX}
      label={translate('style.boxShadowsRow.boxShadow')}
      onClose={() => {
        live.flush();
        onClose();
      }}
    >
      <BoxShadowEditor
        shadow={shadow}
        busy={false}
        onChange={(patch) => {
          const next = { ...shadow, ...patch };
          setShadow(next);
          live.write(serializeBoxShadows([next]));
        }}
      />
    </ChipPopover>
  );
}

function TextShadowChipEditor({ open, onClose }: ChipEditorProps) {
  const translate = useTranslate();
  const live = useLiveWrite(open.view);
  const [shadow, setShadow] = useState<Shadow | undefined>(() => parseShadows(open.chip.value)[0]);
  if (shadow === undefined) {
    return undefined;
  }
  return (
    <ChipPopover
      open={open}
      widthPx={CHIP_POPOVER_WIDTH_PX}
      label={translate('style.textStrokeShadow.textShadow')}
      onClose={() => {
        live.flush();
        onClose();
      }}
    >
      <ShadowEditor
        shadow={shadow}
        busy={false}
        onChange={(patch) => {
          const next = { ...shadow, ...patch };
          setShadow(next);
          live.write(serializeShadows([next]));
        }}
      />
    </ChipPopover>
  );
}

function GradientChipEditor({ open, onClose }: ChipEditorProps) {
  const translate = useTranslate();
  const live = useLiveWrite(open.view);
  // A create chip, or a word that is not a gradient yet, starts from the panel's own new gradient layer.
  const [gradient, setGradient] = useState<Gradient>(
    () => parseGradient(open.chip.value) ?? parseGradient(blankLayer('linear').image) ?? blankGradientOf('linear'),
  );
  const change = (next: Gradient): void => {
    setGradient(next);
    live.write(serializeGradient(next));
  };
  return (
    <ChipPopover
      open={open}
      widthPx={CHIP_POPOVER_WIDTH_PX}
      label={translate('style.backgroundLayerEditor.gradient')}
      onClose={() => {
        live.flush();
        onClose();
      }}
    >
      <div className="embed-editor_bg-editor">
        <GradientTypeRow type={gradient.type} onChange={(type) => change({ ...gradient, type })} />
        <GradientEditor gradient={gradient} busy={false} onChange={change} />
      </div>
    </ChipPopover>
  );
}

/**
 * The Style panel's layer Type row, with the gradient kinds it offers. A switch keeps the stops and
 * their positions: a gradient's model holds every kind's geometry side by side, so only its kind
 * changes. An image or a colour overlay is a background layer, not a gradient, and is chosen from
 * the `background-image` list chip, which edits layers.
 */
function GradientTypeRow({ type, onChange }: { readonly type: GradientType; readonly onChange: (type: GradientType) => void }) {
  const translate = useTranslate();
  const options = typeOptions(translate).filter((option) => isGradientType(option.value));
  return (
    <div className="embed-editor_size-row">
      <span className="embed-editor_size-label embed-editor_bg-caption">{translate('style.backgroundLayerEditor.type')}</span>
      <SegmentedControl<LayerKind>
        options={options}
        value={type}
        onChange={(next) => {
          if (isGradientType(next)) {
            onChange(next);
          }
        }}
        ariaLabel={translate('style.backgroundLayerEditor.layerType')}
      />
    </div>
  );
}

const CheckGlyph = centralIcon(centralCheck);

/**
 * A keyword property's choice, as the Style panel offers it. A property the panel edits with a
 * segmented bar opens that same bar (KeywordChipControl.tsx): its segments, the rest of its values
 * and Custom behind the arrow, the current value selected. A property the panel offers as a dropdown
 * opens that dropdown's list, the current value's check at the row's end. A pick writes the keyword
 * over the value (`!important` stays outside the range) and closes the popover: a keyword is one
 * value, so the pick is the whole edit. A custom value keeps it open while it is typed.
 */
function KeywordChipEditor({ open, property, onClose }: ChipEditorProps & { readonly property: KeywordPropertyName }) {
  const translate = useTranslate();
  const [value, setValue] = useState(open.chip.value);
  const current = value.trim().toLowerCase();
  const pick = (next: string): void => {
    writeChipValue(open.view, next);
    onClose();
  };
  if (keywordControlOf(property) !== 'list') {
    const commit = (next: string): void => {
      setValue(next);
      writeChipValue(open.view, next);
      // A keyword or a variable is the whole edit; `unset` from Custom, or a value being typed, is not yet.
      if (isKeywordOf(property, next) || /^var\(/i.test(next)) {
        onClose();
      }
    };
    return (
      <ChipPopover open={open} widthPx={CHIP_POPOVER_WIDTH_PX} label={property} onClose={onClose}>
        <div className="code-chip-keywords">
          <KeywordChipControl property={property} value={value} onCommit={commit} />
        </div>
      </ChipPopover>
    );
  }
  const { segments, list: rest } = keywordChoices(property, translate);
  const list = [...segments, ...rest];
  return (
    <ChipPopover open={open} widthPx={CHIP_POPOVER_WIDTH_PX} label={property} onClose={onClose}>
      <div className="code-chip-keywords">
        {list.length > 0 ? (
          <div className="code-chip-keyword-list" role="listbox" aria-label={property}>
            {list.map((option) => {
              const selected = option.value.toLowerCase() === current;
              return (
                <button key={option.value} type="button" role="option" aria-selected={selected} className="menu-row" onClick={() => pick(option.value)}>
                  {option.icon === undefined ? undefined : <span className="menu-icon">{option.icon}</span>}
                  <span className="menu-label">{option.text}</span>
                  {selected ? (
                    <span className="menu-end">
                      <span className="menu-check">
                        <CheckGlyph />
                      </span>
                    </span>
                  ) : undefined}
                </button>
              );
            })}
          </div>
        ) : undefined}
      </div>
    </ChipPopover>
  );
}

// The panel's colour picker, placed against the chip by itself (usePickerPosition). It writes the
// colour in the notation it was written in (hex, rgb or hsl); a named colour comes back as hex, the
// notation a picked colour is always written in.
function ColorChipEditor({ open, onClose }: ChipEditorProps) {
  const live = useLiveWrite(open.view);
  const [value, setValue] = useState(open.chip.value);
  return (
    <ColorPicker
      value={value}
      anchor={open.anchorRect}
      onChange={(color, dragging) => {
        setValue(color);
        live.write(color);
        if (!dragging) {
          live.flush();
        }
      }}
      onClose={() => {
        live.flush();
        onClose();
      }}
    />
  );
}

// A layered property's whole list, as the Style panel shows it: its rows, add, remove, reorder, hide,
// and each row's own editor. The row reads and writes the declaration through chipDeclarationProps.
function LayersChipEditor({ open, property, onClose }: ChipEditorProps & { readonly property: LayeredProperty }) {
  const translate = useTranslate();
  const live = useLiveWrite(open.view);
  const [original] = useState(open.chip.value);
  const [value, setValue] = useState(original);
  const put = (next: string, phase: 'live' | 'commit'): void => {
    setValue(next);
    live.write(next);
    if (phase === 'commit') {
      live.flush();
    }
  };
  const props = chipDeclarationProps({ property, value, original }, put);
  return (
    <ChipPopover
      open={open}
      widthPx={CHIP_POPOVER_WIDTH_PX}
      label={layersTitle(property, translate)}
      onClose={() => {
        live.flush();
        onClose();
      }}
    >
      {/* A one-layer value opens on that layer's fields: the press on the chip was the choice. */}
      <LayerListOpensSingleRow.Provider value={true}>
        <LayersRow property={property} props={props} />
      </LayerListOpensSingleRow.Provider>
    </ChipPopover>
  );
}

function LayersRow({ property, props }: { readonly property: LayeredProperty; readonly props: StyleRowProps }) {
  const translate = useTranslate();
  switch (property) {
    case 'transition':
      return <TransitionsRow props={props} />;
    case 'transform':
      return <TransformsRow props={props} />;
    case 'filter':
      return <FiltersRow prop="filter" label={translate('style.effectsSection.filters')} props={props} />;
    case 'backdrop-filter':
      return <FiltersRow prop="backdrop-filter" label={translate('style.effectsSection.backdropFilters')} props={props} />;
    case 'box-shadow':
      return <BoxShadowsRow props={props} />;
    case 'text-shadow':
      return <TextShadowsRow {...props} />;
    case 'background-image':
      return <BackgroundLayersList props={props} />;
    default: {
      // As in ChipEditor: never render the unknown value itself.
      const exhaustive: never = property;
      throw new Error(`Assertion failed: LayersRow: no list for ${String(exhaustive)}`);
    }
  }
}

function layersTitle(property: LayeredProperty, translate: ReturnType<typeof useTranslate>): string {
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
      return exhaustive;
    }
  }
}

/**
 * The Style panel's "Image & gradient" list for one `background-image` declaration: its rows (the
 * panel's own thumbnails and names), add, remove and reorder, and the open layer's editor (Type, then
 * the gradient editor or the image fields) below the list, in this popover rather than the panel's
 * sheet. Only `background-image` is written, as the serialized layer list. The layer editor's size,
 * position, repeat and attachment fields write the sibling longhands, which this one declaration does
 * not hold, so those writes are left out (chipDeclarationProps). An image layer's "Choose image" asks
 * the app's Assets panel (chooseAsset), as it does from the panel, so it needs nothing the code editor
 * lacks. Background layers have no hide switch in the panel, so none here either.
 */
function BackgroundLayersList({ props }: { readonly props: StyleRowProps }) {
  const translate = useTranslate();
  const value = displayOf(props.read('background-image')).value;
  const layers = parseLayers({ image: value, size: '', position: '', repeat: '', attachment: '' });
  const [openLayer, setOpenLayer] = useState<number | undefined>(undefined);
  const applyLayers = (next: BgLayer[]): void => {
    const image = serializeLayers(next).image;
    if (image.length > 0) {
      props.setProp('background-image', image, false);
    } else {
      props.clearProp('background-image');
    }
  };
  const add = (): void => {
    // A new layer is an image, as in the panel (switch it to a gradient with Type), on top.
    applyLayers([blankLayer('image'), ...layers]);
    setOpenLayer(0);
  };
  const remove = (index: number): void => {
    applyLayers(layers.filter((_, other) => other !== index));
    setOpenLayer((current) => openAfterRemoval(current, index));
  };
  const reorder = (from: number, to: number): void => {
    const next = [...layers];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) {
      return;
    }
    next.splice(to, 0, moved);
    applyLayers(next);
    setOpenLayer((current) => (current === from ? to : current));
  };
  return (
    <div className="embed-editor_type-shadows">
      <div className="embed-editor_bg-layers-head">
        <EffLabel label={translate('style.backgroundSection.imageAndGradient')} prop="background-image" props={props} />
        <button
          type="button"
          className="embed-editor_icon-btn"
          onClick={add}
          title={translate('style.backgroundSection.addLayer')}
          aria-label={translate('style.backgroundSection.addBackgroundLayer')}
        >
          <PlusIcon />
        </button>
      </div>
      <LayerList
        count={layers.length}
        busy={false}
        ariaLabel={translate('style.backgroundSection.backgroundLayers')}
        onOpen={(index) => setOpenLayer((current) => (current === index ? undefined : index))}
        onReorder={reorder}
        onRemove={remove}
        renderRow={(index) => layerRow(layers, index, translate)}
      />
      {openLayer !== undefined && layers[openLayer] !== undefined ? (
        <LayerEditor
          layers={layers}
          index={openLayer}
          busy={false}
          setProp={props.setProp}
          clearProp={props.clearProp}
          liveSetProp={props.liveSetProp}
          applyLayers={applyLayers}
        />
      ) : undefined}
    </div>
  );
}

/**
 * The Style panel's row props for one declaration in code: `read` answers the declaration's value as
 * the selected rule's own (so the row shows it as set, in blue), and every write of that property
 * becomes `put`. A row's writes to other properties (the transform settings' perspective and origin)
 * have no declaration here to land in and are left out: the chip edits one declaration, and inventing
 * another in the user's CSS would be a change they did not make. A cleared value is written as `none`,
 * which every layered property takes; a live write undone (`undefined`) puts back what was there.
 */
export function chipDeclarationProps(
  declaration: { readonly property: LayeredProperty; readonly value: string; readonly original: string },
  put: (value: string, phase: 'live' | 'commit') => void,
): StyleRowProps {
  const { property, value, original } = declaration;
  const resolved = declarationResolved(property, value);
  const accept = (prop: string, next: string | undefined, phase: 'live' | 'commit'): void => {
    if (prop !== property) {
      return;
    }
    const text = (next ?? original).trim();
    if (text.length > 0) {
      put(text, phase);
    }
  };
  return {
    read: (prop) => (prop === property ? resolved : undefined),
    busy: false,
    setProp: (prop, next) => accept(prop, next, 'commit'),
    liveSetProp: (prop, next) => accept(prop, next, 'live'),
    clearProp: (prop) => {
      const props = typeof prop === 'string' ? [prop] : prop;
      if (props.includes(property)) {
        put('none', 'commit');
      }
    },
    onProvenance: () => undefined,
    onSelectSelector: () => undefined,
  };
}

// A declaration's value as the panel's resolved shape: set on the selected rule, winning, alone.
function declarationResolved(property: string, value: string): ResolvedProp {
  const winner = {
    selectorText: '',
    value,
    important: false,
    specificity: [0, 0, 0] as const,
    order: 0,
    ruleId: 'code-chip',
    origin: 'embed' as const,
    isSelected: true,
    winning: true,
    complexOnly: false,
  };
  return {
    prop: property,
    source: 'selected',
    selectedOrigin: 'embed',
    selectedValue: { value, important: false },
    winner,
    overridden: false,
    contributors: [],
  };
}
