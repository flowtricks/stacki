import { ErrorToast } from '../../ui/ErrorToast';
import { requestSelectorFocus } from './embed/SelectorPicker';
import React, { useEffect, useRef } from 'react';
import { useStyleFiles } from './useStyleFiles';
import type { HostState } from './model/host';
import { setHost } from './model/host';
import EmbedEditor from './EmbedEditor';
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
  readonly onRecordUndo?: HostState['recordUndo'] | undefined;
  readonly onAddClass?: HostState['addClass'] | undefined;
  readonly onRemoveClass?: HostState['removeClass'] | undefined;
  readonly onRemoveAttribute?: HostState['removeAttribute'] | undefined;
  readonly onSpacingHover?: HostState['onSpacingHover'];
  readonly renderedClasses?: readonly string[] | undefined;
  readonly projectClasses?: readonly string[] | undefined;
  readonly historyTick?: number;
  readonly openFilePath?: string | undefined;
  readonly openFileKind?: HostState['openFileKind'];
  /** The page a component is being edited on, whose styles reach it (HostState). */
  readonly contextPagePath?: string | undefined;
  readonly pseudoRequest?: HostState['pseudoRequest'];
  /** Counts ⌘Enter presses: each new one puts the caret in the selector field. */
  readonly selectorFocus?: number;
}

type StyleFiles = HostState['files'];

export default function StylePanel(props: StylePanelProps) {
  const files = useStyleFiles(props.project?.path, undefined, readStyleFiles);
  const astroFiles = useStyleFiles(props.project?.path, props.openFilePath, readAstroStyleFiles);
  const host = hostState(props, files.files, astroFiles.files);
  // Children read the bridge during their own effects, which run before the
  // parent's effects. Publishing here ensures their first read is current.
  setHost(host);
  useEffect(() => setHost(host), [host]);
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
        {files.error || astroFiles.error ? <ErrorToast message={`Could not load stylesheet sources. ${files.error || astroFiles.error}`} /> : undefined}
        {props.node ? <EmbedEditor /> : <div className="props-empty">Select an element to style it.</div>}
      </div>
    </SoundHere>
  );
}

function hostState(props: StylePanelProps, files: StyleFiles, astroFiles: StyleFiles): HostState {
  return {
    projectPath: props.project?.path,
    nodes: props.model?.nodes ?? [],
    selectedId: props.node?.id,
    pathOf: props.pathOf,
    device: props.device ?? 'desktop',
    files,
    astroFiles,
    openFilePath: props.openFilePath,
    openFileKind: props.openFileKind,
    contextPagePath: props.contextPagePath,
    writeStyleNode: props.onWriteStyleNode,
    selectNode: props.onSelectNode,
    recordUndo: props.onRecordUndo,
    addClass: props.onAddClass,
    removeClass: props.onRemoveClass,
    removeAttribute: props.onRemoveAttribute,
    onSpacingHover: props.onSpacingHover,
    renderedClasses: [...(props.renderedClasses ?? [])],
    projectClasses: [...(props.projectClasses ?? [])],
    historyTick: props.historyTick ?? 0,
    pseudoRequest: props.pseudoRequest,
  };
}

// The ⌘Enter presses already answered: the panel remounts with each tab
// switch, and an old press must not take the caret again.
let selectorFocusHandled = 0;
const SELECTOR_FOCUS_FRAMES_MAX = 30;

// Puts the caret in the selector field on a new ⌘Enter press, waiting a few
// frames for the field when the panel has only just been switched to.
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
