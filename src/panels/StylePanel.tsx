import React, { useEffect, useRef, useState } from 'react';
import type { HostState } from '../style-panel/lib/host';
import { setHost } from '../style-panel/lib/host';
import EmbedEditor from '../style-panel/EmbedEditor';
import '../style-panel/tokens.css';
import '../style-panel/utilities.css';
import '../style-panel/embed-editor.css';
import { readAstroStyleFiles, readStyleFiles } from '../stylePanelBridge';
import { clickNote } from '../ui/sound.js';
import { SoundHere } from '../ui/soundScope';
import usePopupOpen from '../ui/usePopupOpen';

interface StylePanelProps {
  readonly project: { readonly path: string } | null;
  readonly model?: { readonly nodes: HostState['nodes'] } | null;
  readonly node?: { readonly id: string } | null;
  readonly device?: string;
  readonly pathOf?: HostState['pathOf'] | undefined;
  readonly onWriteStyleNode?: HostState['writeStyleNode'] | undefined;
  readonly onSelectNode?: HostState['selectNode'] | undefined;
  readonly onRecordUndo?: HostState['recordUndo'] | undefined;
  readonly onAddClass?: HostState['addClass'] | undefined;
  readonly onSpacingHover?: HostState['onSpacingHover'] | undefined;
  readonly renderedClasses?: readonly string[] | undefined;
  readonly projectClasses?: readonly string[] | undefined;
  readonly historyTick?: number;
  readonly openFilePath?: string | null;
  readonly openFileKind?: HostState['openFileKind'];
}

type StyleFiles = HostState['files'];

export default function StylePanel(props: StylePanelProps) {
  const files = useStyleFiles(props.project?.path, readStyleFiles);
  const astroFiles = useStyleFiles(props.project?.path, readAstroStyleFiles, props.openFilePath);
  const host = hostState(props, files, astroFiles);
  // Children read the bridge during their own effects, which run before the
  // parent's effects. Publishing here ensures their first read is current.
  setHost(host);
  useEffect(() => setHost(host), [host]);
  const hostRef = useRef<HTMLDivElement>(null);
  usePanelBounds(hostRef);
  const popupOpen = usePopupOpen(hostRef);
  if (!props.project) {
    return null;
  }
  return (
    <SoundHere>
      <div
        className={`style-panel-host ${popupOpen ? 'is-locked' : ''}`}
        ref={hostRef}
        onClick={playButtonNote}
      >
        {props.node ? (
          <EmbedEditor />
        ) : (
          <div className="props-empty">Select an element to style it.</div>
        )}
      </div>
    </SoundHere>
  );
}

function useStyleFiles(
  projectPath: string | undefined,
  read: (
    projectPath: string,
  ) => Promise<
    | { readonly ok: true; readonly value: StyleFiles }
    | { readonly ok: false; readonly error: string }
  >,
  refreshKey?: string | null,
): StyleFiles {
  const [files, setFiles] = useState<StyleFiles>([]);
  useEffect(() => {
    if (!projectPath) {
      setFiles([]);
      return;
    }
    let active = true;
    void read(projectPath).then((result) => {
      if (active) {
        setFiles(result.ok ? result.value : []);
      }
    });
    return () => {
      active = false;
    };
  }, [projectPath, read, refreshKey]);
  return files;
}

function hostState(
  props: StylePanelProps,
  files: StyleFiles,
  astroFiles: StyleFiles,
): Partial<HostState> {
  return {
    projectPath: props.project?.path ?? null,
    nodes: props.model?.nodes ?? [],
    selectedId: props.node?.id ?? null,
    pathOf: props.pathOf ?? null,
    device: props.device ?? 'desktop',
    files,
    astroFiles,
    openFilePath: props.openFilePath ?? null,
    openFileKind: props.openFileKind ?? null,
    writeStyleNode: props.onWriteStyleNode ?? null,
    selectNode: props.onSelectNode ?? null,
    recordUndo: props.onRecordUndo ?? null,
    addClass: props.onAddClass ?? null,
    onSpacingHover: props.onSpacingHover ?? null,
    renderedClasses: [...(props.renderedClasses ?? [])],
    projectClasses: [...(props.projectClasses ?? [])],
    historyTick: props.historyTick ?? 0,
  };
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
