// A double click on a canvas image, from the frame's request to the popup: trace the image's marker paths
// to the prop (or attribute) that decides it (canvasImageTrace.ts), select the node that owns it, and show
// the popup beside the image. The popup closes the moment anything else is selected, on Escape, on a press
// outside it, when the page or the canvas changes, and when another image is asked for: one at a time.
// Nothing here writes: the fields are the Properties panel's own, so every edit is the panel's edit.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ShellView } from '../App';
import type { ContextPoint } from '../../features/preview/contextPosition';
import { readPage } from '../../ipc/bridge';
import { projectRelativePath } from '../../lib/projectPath';
import { imageDecision, traceImage, type ImageTraceContext } from '../model/canvasImageTrace';
import type { ComponentSource } from '../model/canvasPropSites';
import { CanvasImagePopup, imageFieldNames, type CanvasImageShown } from './CanvasImagePopup';
import { editingOffFor } from '../../lib/editorGate';

export interface CanvasImageRequest {
  readonly paths: readonly string[];
  readonly point: ContextPoint;
}

/** `renderFields` draws the named fields of the selected node with the Properties panel's editors. */
export function useCanvasImagePopup(app: ShellView, renderFields: (fieldNames: readonly string[]) => ReactNode) {
  const [shown, setShown] = useState<CanvasImageShown>();
  // Which request is the latest, so an answer that arrives after another double click is dropped.
  const latest = useRef(0);
  // Whether the popup's node has been the selection yet: the clicks of the double click may select it a moment late.
  const selected = useRef(false);
  const close = useCallback(() => {
    latest.current += 1;
    selected.current = false;
    setShown(undefined);
  }, []);
  const { setSelectedId } = app;
  const open = useCallback(
    (request: CanvasImageRequest) => {
      const context = traceContext(app);
      if (context === undefined || editingOffFor('images') !== undefined) {
        return;
      }
      latest.current += 1;
      const ticket = latest.current;
      void traceImage(context, request.paths).then((traced) => {
        if (ticket !== latest.current) {
          return;
        }
        selected.current = false;
        const generation = ticket;
        const decision = imageDecision(traced);
        if (decision.kind === 'nothing') {
          // A closed component draws this picture itself: nothing on the instance changes it, so the double click opens nothing.
          setShown(undefined);
          return;
        }
        if (decision.kind === 'explain') {
          setShown({ generation, point: request.point, nodeId: undefined, name: '', outcome: { kind: 'refused', refusal: decision.refusal } });
          return;
        }
        const target = decision.target;
        const nodeId = target.kind === 'instance' ? target.instanceId : target.nodeId;
        setSelectedId(nodeId);
        const name = target.kind === 'instance' ? target.componentName : target.tag;
        setShown({ generation, point: request.point, nodeId, name, outcome: { kind: 'edit', target, fieldNames: imageFieldNames(target) } });
      });
    },
    // The context reads the live page: the open file, its tree and the scan.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt from `app` on each request
    [app.pageState, app.openEditableFile?.path, app.insertables, app.editedRel, app.project.path, setSelectedId],
  );
  // Selecting anything else closes it: another element on the canvas, a Navigator row, or code moving the selection.
  const nodeId = shown?.nodeId;
  useEffect(() => {
    if (shown === undefined || nodeId === undefined) {
      return;
    }
    if (app.selectedId === nodeId) {
      selected.current = true;
    } else if (selected.current) {
      close();
    }
  }, [shown, nodeId, app.selectedId, close]);
  // A refusal belongs to no node, so it closes on any selection that follows the one the double click made.
  const selection = app.selectedId;
  const refusedAt = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (shown?.outcome.kind !== 'refused') {
      refusedAt.current = undefined;
      return;
    }
    if (refusedAt.current === undefined) {
      refusedAt.current = selection ?? '';
    } else if (refusedAt.current !== (selection ?? '')) {
      close();
    }
  }, [shown, selection, close]);
  // Escape closes it wherever focus is: the popup does not hold focus after a pick or a click on the canvas.
  const isShown = shown !== undefined;
  useEffect(() => {
    if (!isShown) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isShown, close]);
  // Another page, another file or a reloaded canvas is no place for it.
  const file = app.openEditableFile?.path;
  useEffect(() => close(), [file, app.refreshKey, app.device, close]);
  const popup =
    shown === undefined ? undefined : (
      <CanvasImagePopup
        key={shown.generation}
        shown={shown}
        fields={app.selectedId === shown.nodeId ? renderFields(shown.outcome.kind === 'edit' ? shown.outcome.fieldNames : []) : undefined}
        onClose={close}
      />
    );
  return { open, close, popup };
}

// What the trace reads: the open page, the scan's components and each component's parsed template. Undefined when
// the page cannot be edited (the popup would have nothing to write to).
function traceContext(app: ShellView): ImageTraceContext | undefined {
  const state = app.pageState;
  const file = app.openEditableFile?.path;
  if (!file || !state?.editable || !file.endsWith('.astro')) {
    return undefined;
  }
  return {
    projectPath: app.project.path,
    file,
    openRel: app.editedRel ?? '',
    nodes: state.model.nodes,
    imports: 'imports' in state.model ? state.model.imports : [],
    components: app.insertables,
    relative: (path) => projectRelativePath(app.project.path, path, window.avb.platform),
    read: readComponent,
  };
}

// A component's parsed template. A component Stacki cannot edit visually has none to read.
async function readComponent(path: string): Promise<ComponentSource | undefined> {
  const read = await readPage(path);
  if (!read.editable || !('imports' in read.model)) {
    return undefined;
  }
  return { nodes: read.model.nodes, imports: read.model.imports, extraFrontmatter: read.model.extraFrontmatter };
}
