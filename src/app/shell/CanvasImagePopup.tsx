// The small popup a double click on a canvas image opens: change the picture and its alt text without
// opening the component the image sits in. The fields are the Properties panel's own (ImagePropFields.tsx), so
// choosing an image, binding dots, undo and the instant canvas update are the panel's. What decides which
// property is the picture and which is its alt text, whatever they are called, is canvasImageTrace.ts. What
// cannot be edited from here says why, in the same popup.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { assert } from '../../../shared/core/assert';
import Popup from '../../ui/Popup';
import { placeMenu } from '../../ui/menuModel';
import { CloseIcon } from '../../ui/Icons';
import { AssetPickPresentationContext } from '../../ui/assetPickPresentation';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import type { ContextPoint } from '../../features/preview/contextPosition';
import type { AltTarget, ImageRefusal, ImageTarget } from '../model/canvasImageTrace';
import './canvasImagePopup.css';

/** What the popup shows: the fields of an image that can be edited, or why it cannot. */
export type CanvasImageOutcome =
  | { readonly kind: 'edit'; readonly target: ImageTarget; readonly fieldNames: readonly string[] }
  | { readonly kind: 'refused'; readonly refusal: ImageRefusal };

export interface CanvasImageShown {
  /** A new request remounts the popup, so an earlier dismissal cannot close its replacement. */
  readonly generation: number;
  readonly point: ContextPoint;
  /** The node the popup edits: the selection while it is open. */
  readonly nodeId: string | undefined;
  readonly name: string;
  readonly outcome: CanvasImageOutcome;
}

/** How much of the popup stays inside the window when it is dragged to an edge: the header's width and height. */
export const DRAG_VISIBLE_PX = { horizontal: 72, vertical: 30 } as const;
const WIDTH_PX = 280;
const HEIGHT_ESTIMATE_PX = 230;

/** The popup's fields, in the order shown: the picture, then its alt text. */
export function imageFieldNames(target: ImageTarget): readonly string[] {
  if (target.kind === 'element') {
    return ['src', 'alt'];
  }
  const alt = target.alt;
  const altName = alt.kind === 'prop' && alt.prop !== target.srcProp ? [alt.prop] : [];
  return [target.srcProp, ...altName];
}

/** Where a popup of this size may sit in the window: never fully outside it, its header always partly in view. */
export function clampPopup(
  position: { readonly left: number; readonly top: number },
  size: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
) {
  assert(viewport.width > 0, 'The window has width');
  assert(viewport.height > 0, 'The window has height');
  const leftMin = DRAG_VISIBLE_PX.horizontal - size.width;
  const leftMax = viewport.width - DRAG_VISIBLE_PX.horizontal;
  const topMax = viewport.height - DRAG_VISIBLE_PX.vertical;
  return { left: Math.min(Math.max(position.left, leftMin), Math.max(leftMin, leftMax)), top: Math.min(Math.max(position.top, 0), Math.max(0, topMax)) };
}

// Dragging by the header: the window hears the moves wherever the pointer goes, the position is
// applied once per frame, and `dragging` puts a shield over the canvas so the page beneath sees nothing of it.
function useHeaderDrag(surface: React.RefObject<HTMLDivElement>, home: { readonly left: number; readonly top: number }) {
  const [moved, setMoved] = useState<{ readonly left: number; readonly top: number }>();
  const [dragging, setDragging] = useState(false);
  const grab = useRef<{ readonly x: number; readonly y: number; readonly left: number; readonly top: number }>();
  const frame = useRef<number>();
  const pending = useRef<{ readonly left: number; readonly top: number }>();
  useEffect(
    () => () => {
      if (frame.current !== undefined) {
        cancelAnimationFrame(frame.current);
      }
    },
    [],
  );
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const element = surface.current;
      if (element === null || event.button !== 0 || (event.target instanceof Element && event.target.closest('button') !== null)) {
        return;
      }
      const box = element.getBoundingClientRect();
      grab.current = { x: event.clientX, y: event.clientY, left: box.left, top: box.top };
      event.preventDefault();
      setDragging(true);
    },
    [surface],
  );
  // While held, the window hears the moves and the release (the shield keeps the canvas frame from taking them),
  // so a pointer that leaves the header, or the window's edge, still drags.
  useEffect(() => {
    if (!dragging) {
      return undefined;
    }
    const onMove = (event: PointerEvent): void => {
      const held = grab.current;
      const element = surface.current;
      if (held === undefined || element === null) {
        return;
      }
      pending.current = clampPopup(
        { left: held.left + event.clientX - held.x, top: held.top + event.clientY - held.y },
        { width: element.offsetWidth, height: element.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      );
      frame.current ??= requestAnimationFrame(() => {
        frame.current = undefined;
        setMoved(pending.current);
      });
    };
    const onEnd = (): void => {
      grab.current = undefined;
      setDragging(false);
      if (pending.current !== undefined) {
        setMoved(pending.current);
      }
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onEnd, true);
    window.addEventListener('pointercancel', onEnd, true);
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onEnd, true);
      window.removeEventListener('pointercancel', onEnd, true);
    };
  }, [dragging, surface]);
  return {
    left: moved?.left ?? home.left,
    top: moved?.top ?? home.top,
    dragging,
    handlers: { onPointerDown },
  };
}

export function CanvasImagePopup(props: { readonly shown: CanvasImageShown; readonly fields: ReactNode; readonly onClose: () => void }) {
  const translate = useTranslate();
  const { shown } = props;
  const title = shown.name === '' ? translate('preview.image.titleFallback') : translate('preview.image.title', { name: shown.name });
  const place = useMemo(
    () =>
      placeMenu(
        { left: shown.point.left, top: shown.point.top, width: 1, height: 1 },
        { width: WIDTH_PX, height: HEIGHT_ESTIMATE_PX },
        { width: window.innerWidth, height: window.innerHeight },
        'below-start',
      ),
    [shown.point.left, shown.point.top],
  );
  const surface = useRef<HTMLDivElement>(null);
  const drag = useHeaderDrag(surface, place);
  return (
    <Popup
      ref={surface}
      mode="popover"
      keepOnScroll
      onClose={props.onClose}
      role="dialog"
      label={title}
      className="canvas-image-popup"
      style={{ position: 'fixed', left: drag.left, top: drag.top, width: WIDTH_PX, ...(place.heightMax === undefined ? {} : { maxHeight: place.heightMax }) }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          props.onClose();
        }
      }}
    >
      <header className={`canvas-image-head${drag.dragging ? ' is-dragging' : ''}`} {...drag.handlers}>
        <strong>{title}</strong>
        <button type="button" className="ghost" aria-label={translate('preview.image.close')} onClick={props.onClose}>
          <CloseIcon size={14} />
        </button>
      </header>
      {drag.dragging && createPortal(<div className="canvas-image-shield" />, document.body)}
      <div className="canvas-image-body">
        <AssetPickPresentationContext.Provider value="overlay">
          {shown.outcome.kind === 'edit' ? props.fields : undefined}
        </AssetPickPresentationContext.Provider>
        <ImageNotes outcome={shown.outcome} translate={translate} />
      </div>
    </Popup>
  );
}

function ImageNotes({ outcome, translate }: { readonly outcome: CanvasImageOutcome; readonly translate: Translator }) {
  const note = outcome.kind === 'refused' ? refusalNote(outcome.refusal, translate) : altNote(outcome.target.alt, translate);
  return note === undefined ? undefined : <p className="canvas-image-note">{note}</p>;
}

/** Why the image cannot be edited from the popup, in the person's language. */
export function refusalNote(refusal: ImageRefusal, translate: Translator): string {
  switch (refusal.kind) {
    case 'fixed':
      return translate('preview.image.refused.fixed', { file: fileName(refusal.file) });
    case 'bound':
      return translate('preview.image.refused.bound', { expression: refusal.expression });
    case 'loop':
      return translate('preview.image.refused.loop');
    case 'outside':
      return refusal.file === '' ? translate('preview.image.refused.unknown') : translate('preview.image.refused.outside', { file: fileName(refusal.file) });
    case 'computed':
      return translate('preview.image.refused.computed', { file: fileName(refusal.file), expression: refusal.expression });
    case 'unreadable':
      return refusal.file === '' ? translate('preview.image.refused.unknown') : translate('preview.image.refused.unreadable', { file: fileName(refusal.file) });
    default: {
      const exhaustive: never = refusal;
      return exhaustive;
    }
  }
}

// The note under the fields when the alt text has no field of its own to show.
function altNote(alt: AltTarget, translate: Translator): string | undefined {
  switch (alt.kind) {
    case 'prop':
    case 'attribute':
      return undefined;
    case 'none':
      return translate('preview.image.alt.none');
    case 'fixed':
      return translate('preview.image.alt.fixed', { file: fileName(alt.file) });
    case 'blocked':
      return translate('preview.image.alt.blocked', { expression: alt.expression });
    default: {
      const exhaustive: never = alt;
      return exhaustive;
    }
  }
}

// A file's own name: the popup names where to go, and a whole path would not fit in it.
function fileName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}
