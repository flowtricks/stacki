// Changing a picture on the canvas, without the Settings panel: a double click on
// an image opens Desktop's own popup (CanvasImagePopup) over it, traced to the
// prop or attribute that decides the picture (canvasImageTrace.ts), with the
// Properties panel's own fields for the picture and its alt text. A choose button
// opens the Assets picker over the page.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CanvasImagePopup, imageFieldNames, type CanvasImageShown } from '../../../vendor/stacki/src/app/shell/CanvasImagePopup';
import { imageDecision, traceImage } from '../../../vendor/stacki/src/app/model/canvasImageTrace';
import { parsePreviewMessage } from '../../../vendor/stacki/src/features/preview/previewMessages';
import { frameContextPoint, type ContextPoint } from '../../../vendor/stacki/src/features/preview/contextPosition';
import { AssetPickOverlay } from '../../../vendor/stacki/src/ui/AssetPickOverlay';
import { clearAssetRequest, getPendingAsset } from '../../../vendor/stacki/src/ui/assetPick';
import type { RoleView } from '../../../vendor/stacki/shared/properties/projectRoles';
import { canvasGestures } from '../roles/canvasGestures';
import { AssetsPanel } from '../assets/AssetsPanel';
import { Settings } from '../settings/Settings';
import type { useEditor } from '../project/useEditor';
import type { EditorProps } from '../../app/Editor';
import { parsePage } from '../source/source';
import { componentScanOf, readComponent } from './studioCanvasText';
import { sameOrigin } from './useStudioCanvasGestures';

interface ImageRequest {
  readonly paths: readonly string[];
  readonly point: ContextPoint;
}

const ROOT = 'studio';

export function StudioCanvasImage({
  props,
  model,
  role,
}: {
  readonly props: EditorProps;
  readonly model: ReturnType<typeof useEditor>;
  readonly role: RoleView;
}): ReactNode {
  const popup = useImagePopup(props, model, role);
  const { shown, close } = popup;
  const pick = props.view.pick;
  if (shown === undefined) {
    return null;
  }
  const names = shown.outcome.kind === 'edit' ? shown.outcome.fieldNames : [];
  const ready = model.document !== undefined && model.selected === shown.nodeId;
  return (
    <>
      <CanvasImagePopup
        key={shown.generation}
        shown={shown}
        fields={
          ready && model.document !== undefined ? (
            <Settings
              document={model.document}
              node={model.node}
              component={model.component}
              project={props.project}
              selected={model.selected}
              nodes={model.nodes}
              error={props.report}
              imageFields={names}
            />
          ) : undefined
        }
        onClose={close}
      />
      {/* A CMS connection's workspace draws the picker itself; otherwise the popup's pick is answered here. */}
      {pick?.presentation === 'overlay' && props.view.cms?.kind !== 'remote' && (
        <AssetPickOverlay mediaKind={pick.mediaKind} onClose={clearAssetRequest}>
          <AssetsPanel project={props.project} refresh={props.refresh} error={props.report} pick={pick} />
        </AssetPickOverlay>
      )}
    </>
  );
}

function useImagePopup(props: EditorProps, model: ReturnType<typeof useEditor>, role: RoleView) {
  const [shown, setShown] = useState<CanvasImageShown>();
  // Which request is the latest, so an answer that arrives after another double click is dropped.
  const latest = useRef(0);
  const selected = useRef(false);
  const close = useCallback(() => {
    latest.current += 1;
    selected.current = false;
    if (getPendingAsset()) {
      clearAssetRequest();
    }
    setShown(undefined);
  }, []);
  const host = useRef({ props, model });
  host.current = { props, model };
  const offered = canvasGestures(role).images;
  const open = useCallback((request: ImageRequest) => {
    const { props, model } = host.current;
    latest.current += 1;
    const ticket = latest.current;
    void tracePicture(props, model, request)
      .then((next) => {
        if (ticket !== latest.current) {
          return;
        }
        selected.current = false;
        if (next?.nodeId !== undefined) {
          model.select(next.nodeId);
        }
        setShown(next === undefined ? undefined : { ...next, generation: ticket });
      })
      .catch(props.report);
  }, []);
  useImageMessages(model, offered ? open : undefined, close);
  // Selecting anything else closes it, as on Desktop.
  useEffect(() => {
    if (shown?.nodeId === undefined) {
      return;
    }
    if (model.selected === shown.nodeId) {
      selected.current = true;
    } else if (selected.current) {
      close();
    }
  }, [shown, model.selected, close]);
  // Another page, or a role that may no longer change pictures, is no place for it.
  useEffect(() => close(), [props.file, offered, props.view.device, close]);
  return { shown, close };
}

function useImageMessages(model: ReturnType<typeof useEditor>, open: ((request: ImageRequest) => void) | undefined, close: () => void): void {
  const { frame, url } = model.preview;
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      const element = frame.current;
      if (element === null || event.source !== element.contentWindow || !sameOrigin(url, event.origin)) {
        return;
      }
      const message = parsePreviewMessage(event.data);
      if (message?.kind === 'image-close') {
        // The canvas moved or was pressed elsewhere; an open picker is still answering this popup.
        if (!getPendingAsset()) {
          close();
        }
      } else if (message?.kind === 'image-edit') {
        open?.({ paths: message.paths, point: frameContextPoint(element, message) });
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [frame, url, open, close]);
}

// What the popup shows for a double click, or undefined when nothing on this page decides the picture.
async function tracePicture(
  props: EditorProps,
  model: ReturnType<typeof useEditor>,
  request: ImageRequest,
): Promise<Omit<CanvasImageShown, 'generation'> | undefined> {
  const source = model.document?.ready ? model.document.text.toString() : undefined;
  const parsed = source === undefined ? undefined : parsePage(source, { locs: true });
  if (parsed === undefined || !parsed.editable || !props.file.endsWith('.astro')) {
    return undefined;
  }
  const traced = await traceImage(
    {
      projectPath: ROOT,
      file: `${ROOT}/${props.file}`,
      openRel: props.file.startsWith('src/pages/') ? '' : props.file,
      nodes: model.nodes,
      imports: parsed.model.imports,
      components: props.project.components.map(componentScanOf),
      relative: (path) => path.slice(ROOT.length + 1),
      read: readComponent,
    },
    request.paths,
  );
  const decision = imageDecision(traced);
  if (decision.kind === 'nothing') {
    return undefined;
  }
  if (decision.kind === 'explain') {
    return { point: request.point, nodeId: undefined, name: '', outcome: { kind: 'refused', refusal: decision.refusal } };
  }
  const target = decision.target;
  const nodeId = target.kind === 'instance' ? target.instanceId : target.nodeId;
  const name = target.kind === 'instance' ? target.componentName : target.tag;
  return { point: request.point, nodeId, name, outcome: { kind: 'edit', target, fieldNames: imageFieldNames(target) } };
}
