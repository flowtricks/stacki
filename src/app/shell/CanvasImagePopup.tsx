// The small popup a double click on a canvas image opens: change the picture and its alt text without
// opening the component the image sits in. The fields are the Properties panel's own (ImagePropFields.tsx), so
// choosing an image, binding dots, undo and the instant canvas update are the panel's. What decides which
// property is the picture and which is its alt text, whatever they are called, is canvasImageTrace.ts. What
// cannot be edited from here says why, in the same popup.

import { useMemo } from 'react';
import type { ReactNode } from 'react';
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

const WIDTH_PX = 300;
const HEIGHT_ESTIMATE_PX = 360;

/** The popup's fields, in the order shown: the picture, then its alt text. */
export function imageFieldNames(target: ImageTarget): readonly string[] {
  if (target.kind === 'element') {
    return ['src', 'alt'];
  }
  const alt = target.alt;
  const altName = alt.kind === 'prop' && alt.prop !== target.srcProp ? [alt.prop] : [];
  return [target.srcProp, ...altName];
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
  return (
    <Popup
      mode="popover"
      keepOnScroll
      onClose={props.onClose}
      role="dialog"
      label={title}
      className="canvas-image-popup"
      style={{ position: 'fixed', left: place.left, top: place.top, width: WIDTH_PX, ...(place.heightMax === undefined ? {} : { maxHeight: place.heightMax }) }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          props.onClose();
        }
      }}
    >
      <header className="canvas-image-head">
        <strong>{title}</strong>
        <button type="button" className="ghost" aria-label={translate('preview.image.close')} onClick={props.onClose}>
          <CloseIcon size={14} />
        </button>
      </header>
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
