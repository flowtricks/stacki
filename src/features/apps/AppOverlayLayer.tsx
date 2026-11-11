// App overlays, drawn in the canvas's overlay layer beside the selection and
// hover outlines (Desktop's PreviewPane, Studio's PreviewCanvas). Overlays are
// declarative: an app describes boxes, labels and heat maps, and Stacki draws
// them from the same measurements the outlines use, so they follow scroll and
// resize with no lag and cannot dress up as Stacki's own UI (hex colours only,
// text as text). For what a description cannot say (a 3D rotator), an item may
// be a `frame`: one of the app's own pages in its own sandboxed frame, placed
// on the element, with the app's grants and nothing more.
//
// Labels of one app that land too close together collapse into a count bubble
// (overlayClusters.ts); clicking the bubble lists them. While an app captures
// canvas clicks (canvasCapture.ts), a chip says whose click the next one is.
// The layer also hands each measurement to `node.measure` (overlayMeasure.ts).
//
// A `draggable` box or label is pressed and moved here (overlayDrag.ts holds
// the rules). While a press or a drag holds an item, a surface over the whole
// layer takes the pointer with pointer capture: the drag continues past the
// item and past the canvas, the canvas frame never sees the pointer, and the
// item the app redraws on each move may remount without losing the drag. The
// surface exists only while the drag store holds an item, so it is gone the
// moment a press or a drag ends or is cancelled.
//
// Only clicks and drags are an item's. Everything that takes no pointer (heat
// maps, plain boxes and labels, the layer itself, the capture chip) lets the
// pointer through to the canvas frame below; an interactive or draggable item,
// a count bubble and the drag surface take it, so a wheel over them is handed
// to the frame (`avb:app-wheel`, electron/preload/frameAppScroll.ts) to scroll
// the page, or pinch, as if it had landed there. A label takes the pointer on
// its drawn pill, never across the element it is anchored to, and the pill's
// hit area is at least LABEL_HIT_PX square (appCanvasTools.css), so a small pin
// is easy to click. Since items sit over the frame, a click on one is the
// item's even while an app captures canvas clicks; a click anywhere else still
// reaches the frame and the capture.
import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { assert } from '../../../shared/core/assert';
import type { AppSummary } from '../../../shared/properties/apps';
import { APP_RPC_LIMITS, type AppOverlayItem } from '../../../shared/properties/appsRpc';
import { tellCanvas } from '../../editor/canvasQuery';
import { AppFrame } from './AppFrame';
import { canvasCapture, emitToApp, insertDrag, noteOverlayHover, overlayDrag, setCanvasClientMapper, useAppsRuntime, useRefTargetLookup } from './appsRuntime';
import type { InsertDragView } from './insertDrag';
import { captureChipText, type CanvasCaptureOwner } from './canvasCapture';
import type { DragPoint, OverlayDragHeld } from './overlayDrag';
import { clusterOverlays, type OverlayCluster } from './overlayClusters';
import { overlayMeasure } from './overlayMeasure';
import {
  NO_REF_TARGETS,
  overlayPointerPoint,
  overlayWheelMessage,
  placeOverlays,
  type MeasuredRects,
  type OverlayPlacement,
  type RefTargetLookup,
} from './overlayPlacement';
import './appCanvasTools.css';

/** Labels an opened cluster lists; the rest are counted. */
const CLUSTER_LIST_MAX = 20;

const DEFAULT_COLOR = '#a855f7';

export function AppOverlayLayer({
  rects,
  scale,
  pathFor,
}: {
  readonly rects: MeasuredRects;
  readonly scale: number;
  readonly pathFor: (nodeId: string) => string | undefined;
}) {
  const runtime = useAppsRuntime();
  const capture = useSyncExternalStore(canvasCapture.subscribe, canvasCapture.owner);
  const held = useSyncExternalStore(overlayDrag.subscribe, overlayDrag.held);
  const refTarget = useRefTargetLookup();
  // Each measurement answers `node.measure` calls waiting on it; after the render, so no promise settles mid-render.
  useEffect(() => {
    overlayMeasure.note({ rects, pathFor });
  });
  const apps = new Map(runtime.running.map((running) => [running.app.manifest.id, running.app]));
  return (
    <AppOverlayView
      overlays={runtime.overlays}
      apps={apps}
      capture={capture}
      held={held}
      rects={rects}
      scale={scale}
      pathFor={pathFor}
      refTarget={refTarget}
      clickItem={clickOverlayItem}
    />
  );
}

/** What the overlay draws, from the runtime's stores or a test's. */
export interface AppOverlayViewProps {
  readonly overlays: ReadonlyMap<string, readonly AppOverlayItem[]>;
  readonly apps: ReadonlyMap<string, AppSummary>;
  /** The app capturing canvas clicks: the chip says whose, and interactive items show the pointer over the capture's cursor. */
  readonly capture: CanvasCaptureOwner | undefined;
  /** The item a press or a drag holds: while one does, the drag surface covers the layer. */
  readonly held: OverlayDragHeld | undefined;
  readonly rects: MeasuredRects;
  readonly scale: number;
  readonly pathFor: (nodeId: string) => string | undefined;
  /** Where anchors on node refs are drawn (nodeRefs.ts); none resolve when left out. */
  readonly refTarget?: RefTargetLookup | undefined;
  /** Sends `overlay.click` for an interactive item that is not draggable (a draggable one clicks through the drag store). */
  readonly clickItem: (appId: string, itemId: string, nodeId: string | undefined) => void;
}

/** The overlay itself: the items, the count bubbles, the drag surface and the capture chip, in one root that lets the pointer through. */
export function AppOverlayView({ overlays, apps, capture, held, rects, scale, pathFor, refTarget, clickItem }: AppOverlayViewProps) {
  const root = useRef<HTMLDivElement>(null);
  const latestScale = useRef(scale);
  latestScale.current = scale;
  const [opened, setOpened] = useState<string | undefined>(undefined);
  // Native and not passive, so the editor neither scrolls nor zooms under the frame's own scroll.
  useEffect(() => {
    const element = root.current ?? undefined;
    assert(element !== undefined, 'The overlay root is mounted before its effects run');
    const onWheel = (event: WheelEvent): void => {
      forwardOverlayWheel(element, event, latestScale.current);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);
  // A drag to insert reports the pointer in the editor window; the layer is the canvas drawn at its zoom.
  useEffect(() => {
    const element = root.current ?? undefined;
    assert(element !== undefined, 'The overlay root is mounted before its effects run');
    setCanvasClientMapper((x, y) => {
      const origin = element.getBoundingClientRect();
      if (x < origin.left || x > origin.right || y < origin.top || y > origin.bottom) {
        return undefined; // Off the canvas: over a panel, or outside the window.
      }
      const point = overlayPointerPoint({ left: origin.left, top: origin.top }, { x, y }, latestScale.current);
      return { x: point.x, y: point.y };
    });
    return () => setCanvasClientMapper(undefined);
  }, []);
  const inserting = useSyncExternalStore(insertDrag.subscribe, insertDrag.view);
  const insertActive = inserting !== undefined;
  // Escape ends a drag to insert, wherever focus is in the editor; the app's own frame says it through its SDK.
  useEffect(() => {
    if (!insertActive) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && insertDrag.cancel()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [insertActive]);
  const chip = capture === undefined ? undefined : <span className="app-capture-chip">{captureChipText(capture)}</span>;
  const { singles, clusters } =
    overlays.size === 0
      ? { singles: [], clusters: [] }
      : clusterOverlays(placeOverlays(overlays, rects, scale, refTarget ?? NO_REF_TARGETS, pathFor), APP_RPC_LIMITS.clusterRadiusPx, held);
  const dragging = held?.phase === 'dragging' ? held : undefined;
  return (
    <div ref={root} className={`app-overlay-root${capture === undefined ? '' : ' capturing'}`}>
      {singles.map((placement) => (
        <OverlayItem
          key={`${placement.appId}:${placement.item.id}:${placement.copy}`}
          placement={placement}
          app={apps.get(placement.appId)}
          scale={scale}
          grabbed={dragging !== undefined && dragging.appId === placement.appId && dragging.itemId === placement.item.id}
          clickItem={clickItem}
        />
      ))}
      {clusters.map((cluster) => (
        <ClusterBubble
          key={cluster.key}
          cluster={cluster}
          opened={opened === cluster.key}
          toggle={() => setOpened((current) => (current === cluster.key ? undefined : cluster.key))}
          clickItem={clickItem}
        />
      ))}
      {held !== undefined && <DragSurface phase={held.phase} />}
      {inserting !== undefined && <InsertDropIndicator drag={inserting} scale={scale} />}
      {chip}
    </div>
  );
}

// Where a drag to insert will land: a line above or below the element, or the element outlined for a drop inside,
// in the editor's insertion accent; and a chip at the pointer naming what is dragged.
function InsertDropIndicator({ drag, scale }: { readonly drag: InsertDragView; readonly scale: number }) {
  assert(scale > 0, 'The canvas scale is positive');
  const target = drag.target;
  const box = target?.box;
  const line =
    target === undefined || box === undefined ? undefined : (
      <div
        className={`app-insert-drop ${target.line}`}
        style={{
          left: box.x * scale,
          top: (target.line === 'after' ? box.y + box.height : box.y) * scale,
          width: Math.max(0, box.width * scale),
          height: target.line === 'inside' ? Math.max(0, box.height * scale) : 0,
        }}
      />
    );
  const pointer = drag.pointer;
  return (
    <>
      {line}
      {pointer !== undefined && (
        <span className={`app-insert-chip${target === undefined ? ' refused' : ''}`} style={{ left: pointer.x * scale + 12, top: pointer.y * scale + 12 }}>
          {drag.preview}
        </span>
      )}
    </>
  );
}

function clickOverlayItem(appId: string, itemId: string, nodeId: string | undefined): void {
  emitToApp(appId, 'overlay.click', { itemId, nodeId });
}

// A wheel that landed on something of the overlay's that takes the pointer (an item, a bubble, the drag
// surface): the canvas frame scrolls by it, and the editor under the layer does not move.
function forwardOverlayWheel(root: HTMLElement, event: WheelEvent, scale: number): void {
  assert(scale > 0, 'The canvas scale is positive');
  event.preventDefault();
  const origin = root.getBoundingClientRect();
  // Chromium already coalesces wheel events to one per frame, so each goes on as it comes.
  tellCanvas(overlayWheelMessage({ left: origin.left, top: origin.top }, event, scale));
}

/** The pointer a press follows, and how its positions map to the canvas; one press at a time, as overlayDrag.ts allows. */
let following: { readonly pointerId: number; readonly pointAt: (event: PointerEvent) => DragPoint; readonly stop: () => void } | undefined;

// Covers the layer while a press or a drag holds an item, and takes the pointer the press began.
function DragSurface({ phase }: { readonly phase: 'pressed' | 'dragging' }) {
  const surface = useRef<HTMLDivElement>(null);
  // On mount, in the same task as the press (React commits a discrete event's update before the next event).
  useLayoutEffect(() => {
    const element = surface.current ?? undefined;
    const pointer = following;
    if (element === undefined || pointer === undefined) {
      return;
    }
    try {
      element.setPointerCapture(pointer.pointerId);
    } catch {
      // The pointer is no longer active (NotFoundError). Its pointerup may have
      // gone to the canvas frame, where the window never hears it: end the press
      // here, or the surface would stay over the canvas and take every wheel and click.
      if (following?.pointerId === pointer.pointerId) {
        pointer.stop();
        overlayDrag.cancel();
      }
    }
  }, []);
  return <div ref={surface} className={`app-overlay-drag-surface${phase === 'dragging' ? ' dragging' : ''}`} />;
}

// A pointer went down on a draggable item: the drag store holds it, and the window hears the pointer until it comes up.
function pressItem(event: React.PointerEvent<HTMLDivElement>, placement: OverlayPlacement, scale: number): void {
  const { item } = placement;
  if (event.button !== 0 || !event.isPrimary || following !== undefined) {
    return;
  }
  if (item.kind !== 'box' && item.kind !== 'label' && item.kind !== 'pin') {
    return; // Only boxes, labels and pins are draggable (shared/properties/appsRpc.ts parseOverlayItem).
  }
  const layer = event.currentTarget.offsetParent;
  if (!(layer instanceof HTMLElement)) {
    return; // Not in a layer yet: nothing to measure the pointer against.
  }
  const pointAt = (pointer: { readonly clientX: number; readonly clientY: number }): DragPoint => {
    const origin = layer.getBoundingClientRect();
    return overlayPointerPoint({ left: origin.left, top: origin.top }, { x: pointer.clientX, y: pointer.clientY }, scale);
  };
  const pressed = overlayDrag.press({
    appId: placement.appId,
    itemId: item.id,
    nodeId: placement.nodeId,
    interactive: item.interactive,
    point: pointAt(event),
  });
  if (!pressed) {
    return;
  }
  event.preventDefault(); // No text selection, no focus move: the press is the drag's.
  event.stopPropagation();
  followPointer(event.pointerId, pointAt);
}

function followPointer(pointerId: number, pointAt: (event: PointerEvent) => DragPoint): void {
  const onMove = (event: PointerEvent): void => {
    if (event.pointerId === pointerId) {
      overlayDrag.move(pointAt(event));
    }
  };
  const onUp = (event: PointerEvent): void => {
    if (event.pointerId === pointerId) {
      stop();
      overlayDrag.release(pointAt(event));
    }
  };
  // The system took the pointer (pointercancel), or the surface lost its capture before the pointer came up.
  const onLost = (event: PointerEvent): void => {
    if (event.pointerId === pointerId) {
      stop();
      overlayDrag.cancel();
    }
  };
  // Capture phase, before the editor's own Escape (leave a component, close the preview) sees it.
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && overlayDrag.cancel()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      stop();
    }
  };
  // The drag ended without this pointer (the app stopped, its item went): stop listening.
  const unsubscribe = overlayDrag.subscribe(() => {
    if (overlayDrag.held() === undefined) {
      stop();
    }
  });
  const stop = (): void => {
    if (following?.pointerId !== pointerId) {
      return;
    }
    following = undefined;
    unsubscribe();
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onLost, true);
    window.removeEventListener('lostpointercapture', onLost, true);
    window.removeEventListener('keydown', onKey, true);
  };
  following = { pointerId, pointAt, stop };
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onLost, true);
  window.addEventListener('lostpointercapture', onLost, true);
  window.addEventListener('keydown', onKey, true);
}

// A count bubble where several labels would overlap; clicking it lists them, and each listed label clicks as itself.
function ClusterBubble({
  cluster,
  opened,
  toggle,
  clickItem,
}: {
  readonly cluster: OverlayCluster;
  readonly opened: boolean;
  readonly toggle: () => void;
  readonly clickItem: AppOverlayViewProps['clickItem'];
}) {
  const [first] = cluster.members;
  const shown = cluster.members.slice(0, CLUSTER_LIST_MAX);
  // A bubble of pins takes the first pin's tone; a bubble of labels, the first label's background.
  const tone = first?.item.kind === 'pin' ? ` tone-${first.item.tone}` : '';
  const style =
    first?.item.kind === 'pin' ? undefined : { background: first?.item.kind === 'label' ? (first.item.background ?? DEFAULT_COLOR) : DEFAULT_COLOR };
  return (
    <div className="app-overlay-item interactive app-overlay-cluster" style={{ left: cluster.left, top: cluster.top }}>
      <button type="button" className={`app-overlay-cluster-count${tone}`} style={style} onClick={toggle} aria-expanded={opened}>
        {cluster.members.length}
      </button>
      {opened && (
        <div className="app-overlay-cluster-list">
          {shown.map((member) => (
            <ClusterMember key={`${member.item.id}:${member.copy}`} member={member} clickItem={clickItem} />
          ))}
          {cluster.members.length > shown.length && <span className="app-overlay-cluster-more">{`${cluster.members.length - shown.length} more`}</span>}
        </div>
      )}
    </div>
  );
}

function ClusterMember({ member, clickItem }: { readonly member: OverlayPlacement; readonly clickItem: AppOverlayViewProps['clickItem'] }) {
  const { item } = member;
  if (item.kind !== 'label' && item.kind !== 'pin') {
    return undefined; // Only labels and pins cluster (overlayClusters.ts).
  }
  // A pin lists as its label in its tone, or a dot when it has none.
  const style = item.kind === 'pin' ? undefined : { background: item.background ?? DEFAULT_COLOR, color: item.color ?? '#fff' };
  const className = item.kind === 'pin' ? `app-overlay-cluster-member tone-${item.tone}` : 'app-overlay-cluster-member';
  const text = item.kind === 'pin' ? (item.label ?? '•') : item.text;
  if (item.interactive) {
    const click = () => clickItem(member.appId, item.id, member.nodeId);
    return (
      <button
        type="button"
        className={className}
        style={style}
        onClick={click}
        onPointerEnter={() => noteOverlayHover(member.appId, item.id)}
        onPointerLeave={() => noteOverlayHover(member.appId, undefined)}
      >
        {text}
      </button>
    );
  }
  return (
    <span className={className} style={style}>
      {text}
    </span>
  );
}

function OverlayItem({
  placement,
  app,
  scale,
  grabbed,
  clickItem,
}: {
  readonly placement: OverlayPlacement;
  readonly app: AppSummary | undefined;
  readonly scale: number;
  /** Whether this item is the one being dragged: it shows the grabbing cursor. */
  readonly grabbed: boolean;
  readonly clickItem: AppOverlayViewProps['clickItem'];
}) {
  const { item } = placement;
  const style: React.CSSProperties = { left: placement.left, top: placement.top, width: placement.width, height: placement.height };
  const click = () => clickItem(placement.appId, item.id, placement.nodeId);
  // An interactive item tells its app when the pointer is on it (`overlay.hover`, sent once per frame at most).
  const hover = (handles: { readonly interactive: boolean }) =>
    handles.interactive
      ? { onPointerEnter: () => noteOverlayHover(placement.appId, item.id), onPointerLeave: () => noteOverlayHover(placement.appId, undefined) }
      : {};
  // A draggable item clicks through the drag store (a press under the threshold), so it has no click handler of its own.
  const pointer = (handles: { readonly interactive: boolean; readonly draggable: boolean }) =>
    handles.draggable
      ? { onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => pressItem(event, placement, scale), ...hover(handles) }
      : { onClick: handles.interactive ? click : undefined, ...hover(handles) };
  // `app-overlay-box` takes the pointer across its box; `app-overlay-text` and `app-overlay-pin` only on what they draw (appCanvasTools.css).
  const classes = (kind: 'box' | 'text' | 'pin', handles: { readonly interactive: boolean; readonly draggable: boolean }) =>
    `app-overlay-item app-overlay-${kind}${handles.interactive ? ' interactive' : ''}${handles.draggable ? ' draggable' : ''}${grabbed ? ' dragging' : ''}`;
  switch (item.kind) {
    case 'box':
      return (
        <div
          className={classes('box', item)}
          style={{
            ...style,
            outline: `1.5px ${item.dashed ? 'dashed' : 'solid'} ${item.color ?? DEFAULT_COLOR}`,
            outlineOffset: -1,
            background: item.fill,
          }}
          {...pointer(item)}
        >
          {item.label !== undefined && (
            <span className="app-overlay-label" style={{ top: -17, left: 0, background: item.color ?? DEFAULT_COLOR, color: '#fff' }}>
              {item.label}
            </span>
          )}
        </div>
      );
    case 'label':
      return (
        <div className={classes('text', item)} style={style} {...pointer(item)}>
          <span
            className="app-overlay-label"
            style={{ ...labelPosition(item.placement), background: item.background ?? DEFAULT_COLOR, color: item.color ?? '#fff' }}
          >
            {item.text}
          </span>
        </div>
      );
    case 'pin':
      // The tail's tip is the container's top-left corner: the anchor point, or the element's corner.
      return (
        <div className={classes('pin', item)} style={{ left: placement.left, top: placement.top }} {...pointer(item)}>
          <span className={`app-overlay-pin-badge tone-${item.tone}${item.active ? ' active' : ''}`}>
            {item.avatarURL !== undefined && (
              <img className="app-overlay-pin-avatar" src={item.avatarURL} alt="" referrerPolicy="no-referrer" draggable={false} />
            )}
            {item.label !== undefined && <span className="app-overlay-pin-text">{item.label}</span>}
          </span>
        </div>
      );
    case 'heat':
      return <HeatMap style={style} item={item} />;
    case 'frame':
      if (app === undefined) {
        return undefined;
      }
      return (
        <div className="app-overlay-item" style={{ ...style, pointerEvents: item.interactive ? 'auto' : 'none' }}>
          <AppFrame
            app={app}
            path={item.path}
            title={`${app.manifest.name} overlay`}
            className="app-overlay-frame"
            interactive={item.interactive}
            overlayItem={item.id}
          />
        </div>
      );
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

function labelPosition(placement: 'top' | 'bottom' | 'center'): React.CSSProperties {
  switch (placement) {
    case 'top':
      return { top: -17, left: 0 };
    case 'bottom':
      return { bottom: -17, left: 0 };
    case 'center':
      return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
    default: {
      const exhaustive: never = placement;
      return exhaustive;
    }
  }
}

function HeatMap({ style, item }: { readonly style: React.CSSProperties; readonly item: Extract<AppOverlayItem, { readonly kind: 'heat' }> }) {
  const color = item.color ?? '#ef4444';
  return (
    <div
      className="app-overlay-item app-overlay-heat"
      style={{ ...style, gridTemplateColumns: `repeat(${item.columns}, 1fr)`, gridTemplateRows: `repeat(${item.rows}, 1fr)` }}
    >
      {item.values.map((value, index) => (
        <span key={index} style={{ background: color, opacity: Math.round(value * 70) / 100 }} />
      ))}
    </div>
  );
}
