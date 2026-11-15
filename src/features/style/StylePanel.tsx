import { ErrorToast } from '../../ui/ErrorToast';
import { requestSelectorFocus } from './embed/SelectorPicker';
import React, { useEffect, useRef, useState } from 'react';
import { useStyleFiles } from './useStyleFiles';
import type { HostState } from './model/host';
import { setHost } from './model/host';
import { prefetchComponentSources } from './model/componentSourceCache';
import { prefetchComputedStyles } from './model/computedStyle';
import { prepareScanSnapshot } from './embed/scanSnapshotCache';
import { assert } from '../../../shared/core/assert';
import { PX_LENGTHS, sameLengthUnit, type LengthUnit } from '../../../shared/properties/lengthUnit';
import EmbedEditor from './EmbedEditor';
import { useTranslate } from '../../lib/i18n/useTranslate';
import './tokens.css';
import './utilities.css';
import './embedEditor.css';
import { readAstroStyleFiles, readStyleFiles } from './stylePanelBridge';
import { clickNote } from '../../ui/sound';
import { SoundHere } from '../../ui/soundScope';
import usePopupOpen from './usePopupOpen';

interface StylePanelProps {
  readonly project: { readonly path: string } | undefined;
  readonly model?: { readonly nodes: HostState['nodes'] } | undefined;
  readonly node?: { readonly id: string } | undefined;
  readonly device?: string;
  readonly pathOf?: HostState['pathOf'];
  readonly onWriteStyleNode?: HostState['writeStyleNode'] | undefined;
  readonly onSelectNode?: HostState['selectNode'] | undefined;
  readonly onCanvasWidth?: HostState['setCanvasWidth'] | undefined;
  readonly onDesktopCanvas?: HostState['showDesktopCanvas'] | undefined;
  readonly onRecordUndo?: HostState['recordUndo'] | undefined;
  readonly onAddClass?: HostState['addClass'] | undefined;
  readonly onAddStyleBlock?: HostState['addStyleBlock'] | undefined;
  readonly onRemoveClass?: HostState['removeClass'] | undefined;
  readonly onRemoveAttribute?: HostState['removeAttribute'] | undefined;
  readonly onSetInlineStyle?: HostState['setInlineStyle'] | undefined;
  /** The open page's component files, read ahead for the chips' colours (HostState). */
  readonly pageComponentPaths?: readonly string[] | undefined;
  /** False while the canvas has not yet reported the selection's classes (HostState). Absent → known. */
  readonly renderedClassesKnown?: boolean | undefined;
  readonly onSpacingHover?: HostState['onSpacingHover'];
  readonly renderedClasses?: readonly string[] | undefined;
  readonly projectClasses?: readonly string[] | undefined;
  readonly historyTick?: number;
  readonly openFilePath?: string | undefined;
  readonly openFileKind?: HostState['openFileKind'];
  /** The page a component is being edited on, whose styles reach it (HostState). */
  readonly contextPagePath?: string | undefined;
  /** The component file the selected instance renders (HostState). */
  readonly selectedComponentPath?: string | undefined;
  readonly pseudoRequest?: HostState['pseudoRequest'];
  /** The navigator lists ::before and ::after rows (HostState). */
  readonly pseudoRows?: boolean;
  /** Counts ⌘Enter presses: each new one puts the caret in the selector field. */
  readonly selectorFocus?: number;
  /** The project's length unit, from its scan (HostState). Absent → px. */
  readonly lengthUnit?: LengthUnit | undefined;
}

type StyleFiles = HostState['files'];

const NO_PATHS: readonly string[] = [];

export default function StylePanel(props: StylePanelProps) {
  const files = useStyleFiles(props.project?.path, undefined, readStyleFiles);
  const translate = useTranslate();
  const astroFiles = useStyleFiles(props.project?.path, props.openFilePath, readAstroStyleFiles);
  const lengthUnit = useStableLengthUnit(props.lengthUnit ?? PX_LENGTHS);
  const renderedClasses = useStableList(props.renderedClasses ?? NO_PATHS);
  const projectClasses = useStableList(props.projectClasses ?? NO_PATHS);
  const selection = useSwitchHold(props, renderedClasses);
  const host = hostState(
    { ...props, ...selection.props },
    { files: files.files, astroFiles: astroFiles.files, lengthUnit, renderedClasses: selection.renderedClasses, projectClasses },
  );
  // Children read the bridge during their own effects, which run before the
  // parent's effects. Publishing here ensures their first read is current.
  setHost(host);
  useEffect(() => setHost(host), [host]);
  // Read with the page, not on the first instance picked: that pick then draws its settled colours.
  const pageComponentPaths = props.pageComponentPaths ?? NO_PATHS;
  useEffect(() => prefetchComponentSources(pageComponentPaths), [pageComponentPaths]);
  const hostRef = useRef<HTMLDivElement>(null);
  usePanelBounds(hostRef);
  useSelectorFocus(hostRef, props.selectorFocus ?? 0);
  const popupOpen = usePopupOpen(hostRef);
  if (!props.project) {
    return undefined;
  }
  return (
    <SoundHere>
      <div className={`style-panel-host ${popupOpen ? 'is-locked' : ''}`} ref={hostRef} onClick={playButtonNote}>
        {files.error || astroFiles.error ? (
          <ErrorToast message={translate('style.stylePanel.loadError', { error: files.error || astroFiles.error || '' })} />
        ) : undefined}
        {selection.props.node ? <EmbedEditor /> : <div className="props-empty">{translate('style.stylePanel.selectElement')}</div>}
      </div>
    </SoundHere>
  );
}

// What the panel is told about the selected element. Everything here describes ONE
// element, so it is published to the host together (useSwitchHold).
type SelectionProps = Pick<StylePanelProps, 'node' | 'renderedClassesKnown' | 'selectedComponentPath' | 'pseudoRequest'>;
interface ShownSelection {
  readonly props: SelectionProps;
  readonly renderedClasses: string[];
}

// The longest the panel keeps showing the previous element after another is selected.
// The hold ends as soon as the next element's answer is in hand (about one canvas round
// trip); this bounds a canvas that is slow or never answers, after which the next element
// is shown with the placeholders its sections draw while they wait.
const SWITCH_HOLD_MS_MAX = 1500;

function selectionOf(props: StylePanelProps, renderedClasses: string[]): ShownSelection {
  return {
    props: {
      node: props.node,
      renderedClassesKnown: props.renderedClassesKnown,
      selectedComponentPath: props.selectedComponentPath,
      pseudoRequest: props.pseudoRequest,
    },
    renderedClasses,
  };
}

// From one element to another: the only change worth holding the previous one for.
function isSwitch(shownId: string | undefined, targetId: string | undefined): boolean {
  if (shownId === undefined) {
    return false;
  }
  if (targetId === undefined) {
    return false;
  }
  return shownId !== targetId;
}

/**
 * The selection the panel shows: the app's, except across a switch from one element to
 * another, where the previous element stays on screen until the next one's answer is in
 * hand (stale-while-revalidate, for the whole panel at once). The next element's match,
 * its chips and the page's computed values for its fields are read ahead
 * (prepareScanSnapshot, prefetchComputedStyles) and its rendered classes are waited for;
 * then the host gets the new element in one write and the panel draws it in one render.
 * Published as the app sends it, the header changed first, the fields showed "Default"
 * and empty values while the page was asked, and the previous element's chips and rows
 * outlived the header by a frame or more.
 *
 * Selecting nothing, or selecting from nothing, is shown at once: there is no element to
 * hold, and nothing to prepare. The hold is bounded by SWITCH_HOLD_MS_MAX from its start,
 * however often the selection moves during it.
 */
function useSwitchHold(props: StylePanelProps, renderedClasses: string[]): ShownSelection {
  const live = selectionOf(props, renderedClasses);
  const targetId = props.node?.id;
  const [shownId, setShownId] = useState(targetId);
  // The selection as it last stood for the element on screen: the app's props already
  // describe the next element (its classes, its component), so the held element's own
  // are kept from before the switch.
  const heldRef = useRef(live);
  const holdStartMsRef = useRef<number | undefined>(undefined);
  const holding = isSwitch(shownId, targetId);
  if (!holding && shownId !== targetId) {
    setShownId(targetId);
  }
  const classesKnown = props.renderedClassesKnown !== false;
  useEffect(() => {
    if (!holding || targetId === undefined) {
      holdStartMsRef.current = undefined;
      return undefined;
    }
    const startMs = holdStartMsRef.current ?? performance.now();
    holdStartMsRef.current = startMs;
    let cancelled = false;
    const release = () => {
      if (!cancelled) {
        setShownId(targetId);
      }
    };
    const remainingMs = Math.max(0, SWITCH_HOLD_MS_MAX - (performance.now() - startMs));
    const deadline = window.setTimeout(release, remainingMs);
    void Promise.all([prepareScanSnapshot(targetId), prefetchComputedStyles(targetId)])
      .catch(() => undefined)
      .then(() => {
        // The rendered classes are part of the element's answer (chip colours, the class
        // list): the app bounds their wait itself (AppPanes RENDERED_CLASSES_WAIT_MS).
        if (classesKnown) {
          release();
        }
      });
    return () => {
      cancelled = true;
      window.clearTimeout(deadline);
    };
  }, [holding, targetId, classesKnown]);
  if (holding) {
    assert(heldRef.current.props.node?.id === shownId, 'useSwitchHold: the held selection is the element on screen');
    return heldRef.current;
  }
  heldRef.current = live;
  return live;
}

// A rescan builds a new setting object each time; the host compares by identity,
// so the same setting keeps the object it had and wakes no subscriber.
function useStableLengthUnit(next: LengthUnit): LengthUnit {
  const held = useRef(next);
  if (!sameLengthUnit(held.current, next)) {
    held.current = next;
  }
  return held.current;
}

// The same list, by content, keeps the array it had. The host compares every field by
// identity (setHost), and a copy made on each render woke every host subscriber on every
// render of the app around the panel: each computed-value hook in every field re-rendered
// on a hover elsewhere in the app.
function useStableList(next: readonly string[]): string[] {
  const held = useRef<string[]>([...next]);
  const same = held.current.length === next.length && held.current.every((item, index) => item === next[index]);
  if (!same) {
    held.current = [...next];
  }
  return held.current;
}

const NO_NODES: HostState['nodes'] = [];

interface HostInputs {
  readonly files: StyleFiles;
  readonly astroFiles: StyleFiles;
  readonly lengthUnit: LengthUnit;
  readonly renderedClasses: string[];
  readonly projectClasses: string[];
}

function hostState(props: StylePanelProps, inputs: HostInputs): HostState {
  const { files, astroFiles, lengthUnit } = inputs;
  return {
    projectPath: props.project?.path,
    nodes: props.model?.nodes ?? NO_NODES,
    selectedId: props.node?.id,
    pathOf: props.pathOf,
    device: props.device ?? 'desktop',
    files,
    astroFiles,
    openFilePath: props.openFilePath,
    openFileKind: props.openFileKind,
    contextPagePath: props.contextPagePath,
    selectedComponentPath: props.selectedComponentPath,
    writeStyleNode: props.onWriteStyleNode,
    selectNode: props.onSelectNode,
    setCanvasWidth: props.onCanvasWidth,
    showDesktopCanvas: props.onDesktopCanvas,
    recordUndo: props.onRecordUndo,
    addClass: props.onAddClass,
    addStyleBlock: props.onAddStyleBlock,
    removeClass: props.onRemoveClass,
    removeAttribute: props.onRemoveAttribute,
    setInlineStyle: props.onSetInlineStyle,
    pageComponentPaths: props.pageComponentPaths ?? NO_PATHS,
    renderedClassesKnown: props.renderedClassesKnown ?? true,
    onSpacingHover: props.onSpacingHover,
    renderedClasses: inputs.renderedClasses,
    projectClasses: inputs.projectClasses,
    historyTick: props.historyTick ?? 0,
    pseudoRequest: props.pseudoRequest,
    pseudoRows: props.pseudoRows === true,
    lengthUnit,
  };
}

// The ⌘Enter presses already answered: the panel can remount (a new
// project, a reset panel boundary), and an old press must not take the caret again.
let selectorFocusHandled = 0;
const SELECTOR_FOCUS_FRAMES_MAX = 30;

// Puts the caret in the selector field on a new ⌘Enter press, waiting a few
// frames for the field when the panel has only just been shown or mounted.
function useSelectorFocus(hostRef: React.RefObject<HTMLDivElement>, tick: number): void {
  useEffect(() => {
    if (tick <= selectorFocusHandled) {
      return undefined;
    }
    selectorFocusHandled = tick;
    let frames = 0;
    let request = 0;
    // The field's input is only mounted once the well is opened, so the
    // picker is asked to open it; it waits for a picker that has mounted.
    const tryFocus = (): void => {
      if (requestSelectorFocus()) {
        return;
      }
      frames += 1;
      if (frames < SELECTOR_FOCUS_FRAMES_MAX) {
        request = requestAnimationFrame(tryFocus);
      }
    };
    tryFocus();
    return () => cancelAnimationFrame(request);
  }, [hostRef, tick]);
}

function usePanelBounds(hostRef: React.RefObject<HTMLDivElement>): void {
  useEffect(() => {
    const element = hostRef.current;
    if (!element) {
      return;
    }
    const publish = (): void => {
      const bounds = element.getBoundingClientRect();
      const style = document.documentElement.style;
      style.setProperty('--style-panel-left', `${bounds.left}px`);
      style.setProperty('--style-panel-top', `${bounds.top}px`);
      style.setProperty('--style-panel-width', `${bounds.width}px`);
      style.setProperty('--style-panel-height', `${bounds.height}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    window.addEventListener('resize', publish);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', publish);
    };
  }, [hostRef]);
}

function playButtonNote(event: React.MouseEvent<HTMLDivElement>): void {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const button = target.closest('button');
  if (button && !button.disabled) {
    clickNote();
  }
}
