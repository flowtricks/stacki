import React, { useEffect, useRef, useState } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { PREVIEW_WIDTH_LIMITS, parsePreviewWidth } from './previewViewport';

export interface PreviewSizeControlsProps {
  readonly width: number;
  readonly scale: number;
  readonly onWidth: (width: number) => void;
  readonly onFit: () => void;
}

export function PreviewSizeControls({ width, scale, onWidth, onFit }: PreviewSizeControlsProps) {
  const translate = useTranslate();
  const [draft, setDraft] = useState(String(Math.round(width)));
  // Whether the person has typed since the field last showed the canvas width. Asking for a width takes the
  // canvas off Desktop or a breakpoint, so leaving a field that was only looked at must ask for nothing.
  const edited = useRef(false);
  const revert = (): void => {
    edited.current = false;
    setDraft(String(Math.round(width)));
  };
  useEffect(revert, [width]);
  const commit = (): void => {
    if (!edited.current) {
      return;
    }
    edited.current = false;
    const value = parsePreviewWidth(draft);
    if (value !== undefined) {
      onWidth(value);
    } else {
      revert();
    }
  };
  return (
    <div className="preview-size-controls">
      <label className="preview-width-field" data-tooltip={translate('preview.size.widthTip')}>
        <input
          type="text"
          inputMode="numeric"
          aria-label={translate('preview.size.width')}
          maxLength={4}
          value={draft}
          onChange={(event) => {
            edited.current = true;
            setDraft(event.currentTarget.value);
          }}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            } else if (event.key === 'Escape') {
              revert();
            }
          }}
          aria-description={translate('preview.size.widthHint', { minimum: PREVIEW_WIDTH_LIMITS.minimum, maximum: PREVIEW_WIDTH_LIMITS.maximum })}
        />
        <span>px</span>
      </label>
      <output aria-label={translate('preview.size.scale')} data-tooltip={translate('preview.size.scaleTip')}>
        {Math.round(scale * 100)}%
      </output>
      <button type="button" data-tooltip={translate('preview.size.fitTip')} onClick={onFit}>
        {translate('preview.canvas.fit')}
      </button>
    </div>
  );
}
