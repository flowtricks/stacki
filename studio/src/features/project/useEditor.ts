import { useLiveNumericStyles } from '../preview/useLiveNumericStyles';
import { useComponentExit } from './useComponentExit';
import { useLiveText } from '../preview/useLiveText';
import { insertTargetFor } from '../../../vendor/stacki/src/editor/insertTarget';
import { parsePageModel } from '../../../vendor/stacki/shared/page/pageNode';
import { useCursorPresence } from '../collaboration/useCursorPresence';
import { useCodeWindow } from '../code/useCodeWindow';
import { useCollaborators, useFollow, type FollowTarget } from '../collaboration/useCollaborators';
import { useEditorKeys } from '../navigator/useEditorKeys';
import { useEditorSelection } from './useEditorSelection';
import { componentAt, componentEntry } from './componentEntry';
import type { ComponentFocus, OpenFile } from './editorNavigation';
import { dropTarget } from '../navigator/dropTarget';
import type { DropLocation } from '../../../vendor/stacki/src/features/structure/structureModel';
import { useEffect, useMemo, useRef } from 'react';
import type { CanvasMove } from '../../../vendor/stacki/shared/page/canvasMove';
import type { Project } from './projectClient';
import { useDocument } from '../collaboration/useDocument';
import type { Session } from '../auth/useSession';
import { usePreview } from '../preview/usePreview';
import { componentImport } from '../source/imports';
import { flatten, parsePage, type TreeAction } from '../source/source';
export function useEditor(
  project: Project,
  file: string,
  report: (error: unknown) => void,
  onCanvasSelect: () => void,
  active = true,
  setCanPause?: (safe: boolean) => void,
  previewFile = file,
  open?: OpenFile,
  followTarget?: FollowTarget,
  session?: Session,
  canvasKeys = true,
  focus?: ComponentFocus,
) {
  const document = useDocument(file, active, project.workspaceId);
  useDocumentError(document?.error, report);
  usePauseReadiness(document?.status === 'Saved', setCanPause);
  const source = document?.text.toString() ?? '';
  const parsed = useParsed(file, source);
  const nodes = parsed?.editable ? parsed.model.nodes : [];
  const enter = componentEntry({ project, file, parsed, document, open, focus, report });
  const collection = /\.(json|md|mdx)$/.test(file) && !file.startsWith('src/pages/');
  const preview = usePreview(
    previewFile,
    (id, occurrence) => {
      selection.selectFromCanvas(id === '0' && nodes[0]?.id === 'layout' ? 'layout' : 'n' + id, occurrence);
      onCanvasSelect();
    },
    report,
    active,
    (id, occurrence) => enter('', id === '0' && nodes[0]?.id === 'layout' ? 'layout' : 'n' + id, occurrence),
  );
  useLiveText(file, source, nodes, preview);
  useComponentExit(file, previewFile, document, preview, open, report);
  useLiveNumericStyles(file, parsed, project, preview);
  useCursorPresence(document, previewFile, preview, session);
  const selection = useEditorSelection(file, previewFile, nodes, document, preview, focus);
  const { selected, select } = selection;
  const codeWindow = useCodeWindow(document, canvasKeys ? selected : '', report);
  useEditorKeys(document, canvasKeys ? selected : '', action, report, project.components);
  const component = componentAt(project, file, parsed, selected);
  const collaborators = useCollaborators(document, previewFile, preview, session);
  useFollow(followTarget, document?.ready ?? false, preview, select);
  function action(value: TreeAction) {
    void document?.action(value).catch(report);
  }
  const revertMove = useCanvasMoveRevert(preview.send);
  // A reorder shows on the canvas at once (electron/preload/frameMove.ts); the page the
  // server renders confirms it, and an action that is not sent or is refused takes it back.
  function move(value: TreeAction, canvasMove: CanvasMove | undefined) {
    if (canvasMove !== undefined) {
      preview.send({ type: 'avb:optimistic-move', move: canvasMove });
    }
    const pending = document?.action(value) ?? Promise.resolve(false);
    void pending.then(
      (sent) => {
        if (!sent && canvasMove !== undefined) {
          revertMove();
        }
      },
      (error: unknown) => {
        if (canvasMove !== undefined) {
          revertMove();
        }
        report(error);
      },
    );
  }
  return {
    codeWindow,
    document,
    collaborators,
    hover: selection.hover,
    selected,
    nodes,
    node: flatten(nodes).find((node) => node.id === selected),
    component,
    collection,
    preview,
    select,
    restoreSelection: selection.restore,
    action,
    move,
    openComponent: enter,
    insert: (componentFile: string, location?: DropLocation) => insertComponent(project, file, parsed, selected, action, componentFile, location),
    editable: !!parsed?.editable,
  };
}
// The canvas takes a shown reorder back when the server refuses the action
// (useDocument.ts says so with `studio:action-refused`).
function useCanvasMoveRevert(send: (message: unknown) => void): () => void {
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const refused = () => sendRef.current({ type: 'avb:move-revert' });
    window.addEventListener('studio:action-refused', refused);
    return () => window.removeEventListener('studio:action-refused', refused);
  }, []);
  return () => sendRef.current({ type: 'avb:move-revert' });
}
function useDocumentError(error: string | undefined, report: (error: unknown) => void) {
  useEffect(() => {
    if (error) {
      report(error);
    }
  }, [error, report]);
}
function usePauseReadiness(saved: boolean, setCanPause: ((safe: boolean) => void) | undefined) {
  useEffect(() => setCanPause?.(saved), [saved, setCanPause]);
}
function insertComponent(
  project: Project,
  file: string,
  parsed: ReturnType<typeof parsePage> | undefined,
  selected: string,
  action: (value: TreeAction) => void,
  componentFile: string,
  location?: DropLocation,
) {
  const component = project.components.find((item) => item.file === componentFile || item.name === componentFile);
  if (!component || !parsed?.editable) {
    return;
  }
  action({
    kind: 'insert',
    ...dropTarget(
      parsed.model.nodes,
      location ?? insertTargetFor(parsePageModel(parsed.model), selected, { type: 'component', name: component.name }, project.components),
    ),
    name: component.name,
    importPath: componentImport(file, component),
    paired: component.slots.includes('default') && component.slotText === true,
  });
}

function useParsed(file: string, source: string) {
  return useMemo(() => (file.endsWith('.astro') ? parsePage(source, { locs: true }) : undefined), [file, source]);
}
