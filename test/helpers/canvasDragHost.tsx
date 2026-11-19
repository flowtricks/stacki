// The editor's half of a canvas drag, small enough for a test page: the real message parser (previewMessages.ts),
// the real drag controller (src/app/state/appCanvasDrag.ts), the real canvas overlay (CanvasDropOverlay.tsx) and
// the real Navigator (StructurePanel.tsx), in one React root, beside one canvas iframe. The test that bundles it
// (test/electron/preload/canvasDragChromium.test.js) runs the real preload in the iframe, so the press, the
// probes, the postMessage, the parser, the decision and both drawings are the shipped code.
//
// The left panel starts on a stand-in for Pages: a drag must open the Navigator and give Pages back. The edits a
// drop asks for are recorded and applied to the page model the way the app applies them (moveGesture), so the
// Navigator shows the result; nothing is written anywhere.
//
// The page reads `window.canvasDragHost`: what the controller was asked to do, and a per-frame record of what the
// canvas and the Navigator showed, taken in requestAnimationFrame after each commit.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { parsePreviewMessage } from '../../src/features/preview/previewMessages';
import { CanvasDropOverlay } from '../../src/features/preview/CanvasDropOverlay';
import StructurePanel from '../../src/features/structure/StructurePanel';
import { useCanvasDrag, type CanvasDragHost } from '../../src/app/state/appCanvasDrag';
import { moveGesture } from '../../src/editor/editGestures';
import type { EditorModel } from '../../src/editor/pageView';
import type { LeftTab } from '../../src/app/appTypes';
import type { OverlayInfo } from '../../src/features/preview/PreviewOverlays';

interface Sample {
  readonly frame: number;
  readonly line:
    { readonly orientation: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly refused: boolean } | undefined;
  readonly empty: boolean;
  readonly gap: { readonly parent: string; readonly index: number } | undefined;
  readonly into: string | undefined;
  readonly tab: string;
}

interface HostRecord {
  moves: { readonly id: string; readonly parentId: string | undefined; readonly index: number }[];
  inserts: number;
  selected: string | undefined;
  reveals: number;
  tab: string;
  overs: number;
  lastOver: { readonly x: number; readonly y: number } | undefined;
  samples: Sample[];
  mutationFrames: { readonly overlay: number[]; readonly navigator: number[] };
  ready: boolean;
}

const record: HostRecord = {
  moves: [],
  inserts: 0,
  selected: undefined,
  reveals: 0,
  tab: 'pages',
  overs: 0,
  lastOver: undefined,
  samples: [],
  mutationFrames: { overlay: [], navigator: [] },
  ready: false,
};
Reflect.set(window, 'canvasDragHost', record);

const modelInput: unknown = Reflect.get(window, '__canvasDragModel');
if (typeof modelInput !== 'object' || modelInput === null) {
  throw new Error('Assertion failed: the test page set the parsed model');
}
// The model comes from the shipped parser, run by the test in Node (astroParser.ts parsePage) and handed over as JSON.
function isEditorModel(value: unknown): value is EditorModel {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return Array.isArray(Reflect.get(value, 'nodes')) && Array.isArray(Reflect.get(value, 'imports'));
}
if (!isEditorModel(modelInput)) {
  throw new Error('Assertion failed: the parsed model has nodes and imports');
}
const initialModel: EditorModel = modelInput;

const canvasElement = document.querySelector('iframe');
const uiElement = document.querySelector('#ui');
if (!(canvasElement instanceof HTMLIFrameElement)) {
  throw new Error('Assertion failed: the host page holds the canvas iframe');
}
if (!(uiElement instanceof HTMLElement)) {
  throw new Error('Assertion failed: the host page holds the UI layer');
}
const canvas = canvasElement;
const STAGE_LEFT_PX = 300;

const overlayInfo = (path: string): OverlayInfo | undefined => ({
  label: path === '0.0' ? 'Container' : path,
  kind: 'element',
  tag: 'div',
  astroAsset: false,
  dynamicTag: false,
  nodeKind: 'element',
  childCount: 0,
  isLayout: false,
  bound: false,
});

function trailPath(model: EditorModel, id: string): string | undefined {
  const pending: { readonly node: EditorModel['nodes'][number]; readonly path: string }[] = model.nodes.map((node, index) => ({ node, path: String(index) }));
  for (let visited = 0; visited < pending.length; visited += 1) {
    if (visited > 10_000) {
      throw new Error('Assertion failed: the fixture page is small');
    }
    const entry = pending[visited];
    if (entry === undefined) {
      break;
    }
    if (entry.node.id === id) {
      return entry.path;
    }
    const children = 'children' in entry.node ? (entry.node.children ?? []) : [];
    children.forEach((child, index) => pending.push({ node: child, path: `${entry.path}.${index}` }));
  }
  return undefined;
}

function Host() {
  const [model, setModel] = useState<EditorModel>(initialModel);
  const [leftTab, setLeftTab] = useState<LeftTab>('pages');
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [revealTick, setRevealTick] = useState(0);
  record.tab = leftTab ?? 'none';
  record.selected = selectedId;
  record.reveals = revealTick;
  const host: CanvasDragHost = {
    pageState: { editable: true, model },
    editedRel: undefined,
    insertables: [{ name: 'Badge', slots: [], renderTag: { tag: 'span' } }],
    currentPage: { path: '/project/src/pages/index.astro' },
    moveNode: (nodeId, target) => {
      record.moves.push({ id: nodeId, parentId: target.parentId, index: target.index });
      const gesture = moveGesture(model, nodeId, target, { keepsSlot: () => true }, { urgency: true });
      if (gesture !== undefined) {
        setModel(gesture.apply(model));
      }
    },
    onDropComponent: () => {
      record.inserts += 1;
    },
    setSelectedId,
    setRevealTick,
    leftTab,
    setLeftTab,
    pathFor: (id) => (id === undefined ? undefined : trailPath(model, id)),
  };
  const onCanvasDrag = useCanvasDrag(host);
  useEffect(observeFrames, []);
  // The test opens the Navigator itself for the drags that must find it already open.
  useEffect(() => {
    Reflect.set(window, 'canvasDragHostOpenNavigator', () => setLeftTab('navigator'));
  }, []);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      if (event.source !== canvas.contentWindow) {
        return;
      }
      const message = parsePreviewMessage(event.data);
      if (message === undefined) {
        return;
      }
      if (message.kind === 'render') {
        canvas.contentWindow?.postMessage({ type: 'avb:track', paths: [], scope: '', focus: '', focusOcc: 0 }, '*');
        record.ready = true;
        return;
      }
      if (message.kind === 'canvas-drag') {
        if (message.drag.kind === 'drag-over') {
          record.overs += 1;
          record.lastOver = { x: message.drag.x, y: message.drag.y };
        }
        onCanvasDrag(message.drag, (reply) => canvas.contentWindow?.postMessage(reply, '*'));
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [onCanvasDrag]);
  return (
    <>
      <div className="left-panel" style={{ position: 'absolute', left: 0, top: 0, width: STAGE_LEFT_PX, bottom: 0, display: 'flex', flexDirection: 'column' }}>
        {leftTab === 'navigator' ? (
          <StructurePanel
            pageState={{ editable: true, model: { nodes: model.nodes, imports: model.imports }, source: '' }}
            layouts={[]}
            insertables={[{ name: 'Badge', renderTag: { tag: 'span' } }]}
            currentLayoutName=""
            selectedId={selectedId}
            revealTick={revealTick}
            onSelect={setSelectedId}
            onChangeLayout={() => undefined}
            onDropComponent={() => undefined}
            onMoveNode={host.moveNode}
            onRemoveNode={() => undefined}
            onCopyNode={() => undefined}
            onDuplicateNode={() => undefined}
            onPasteNode={() => undefined}
            onCodeChange={() => undefined}
            onOpenCodePanel={() => undefined}
          />
        ) : (
          <div data-testid="pages-panel">Pages</div>
        )}
      </div>
      <div
        className="stage-overlay"
        style={{ position: 'absolute', left: STAGE_LEFT_PX, top: 0, right: 0, bottom: 0, pointerEvents: 'none', overflow: 'hidden' }}
      >
        <CanvasDropOverlay scale={1} overlayInfo={overlayInfo} />
      </div>
    </>
  );
}

// One sample per animation frame: what the canvas line and the Navigator mark are in the same painted frame.
let frame = 0;
function sample(): void {
  frame += 1;
  const line = document.querySelector('[data-testid="canvas-drop-line"]');
  const lineBox = line?.getBoundingClientRect();
  const gap = document.querySelector('.nav-gap .drop-indicator')?.closest('.nav-gap');
  const intoRow = Array.from(document.querySelectorAll<HTMLElement>('.structure-node[data-node-id]')).find((row) =>
    row.style.background.includes('accent-soft'),
  );
  record.samples.push({
    frame,
    line:
      line === null || lineBox === undefined
        ? undefined
        : {
            orientation: line.getAttribute('data-orientation') ?? '',
            x: lineBox.x - STAGE_LEFT_PX,
            y: lineBox.y,
            w: lineBox.width,
            h: lineBox.height,
            refused: line.hasAttribute('data-refused'),
          },
    empty: document.querySelector('[data-testid="canvas-drop-empty"]') !== null,
    gap:
      gap === null || gap === undefined
        ? undefined
        : { parent: gap.getAttribute('data-drop-parent') ?? '', index: Number(gap.getAttribute('data-drop-index')) },
    into: intoRow?.getAttribute('data-node-id') ?? undefined,
    tab: record.tab,
  });
  if (record.samples.length > 5000) {
    record.samples.splice(0, 1000); // A long run keeps the newest frames.
  }
  requestAnimationFrame(sample);
}
requestAnimationFrame(sample);

// Which frame each picture changed in: the overlay layer and the left panel, observed separately.
function observeFrames(): void {
  const options = { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'data-orientation', 'data-verdict'] };
  const overlay = document.querySelector('.stage-overlay');
  const panel = document.querySelector('.left-panel');
  if (overlay === null || panel === null) {
    throw new Error('Assertion failed: both pictures are mounted');
  }
  new MutationObserver(() => record.mutationFrames.overlay.push(frame)).observe(overlay, options);
  new MutationObserver(() => record.mutationFrames.navigator.push(frame)).observe(panel, options);
}

createRoot(uiElement).render(<Host />);
