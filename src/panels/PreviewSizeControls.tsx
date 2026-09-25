import React, { useEffect, useState } from 'react';
import { PREVIEW_WIDTH_LIMITS, parsePreviewWidth } from './previewViewport';

export interface PreviewSizeControlsProps {
  readonly width: number;
  readonly scale: number;
  readonly onWidth: (width: number) => void;
  readonly onFit: () => void;
}

export function PreviewSizeControls({ width, scale, onWidth, onFit }: PreviewSizeControlsProps) {
  const [draft, setDraft] = useState(String(Math.round(width)));
  useEffect(() => setDraft(String(Math.round(width))), [width]);
  const commit = (): void => {
    const value = parsePreviewWidth(draft);
    if (value !== undefined) {
      onWidth(value);
    } else {
      setDraft(String(Math.round(width)));
    }
  };
  return (
    <div className="preview-size-controls">
      <label className="preview-width-field" title="Canvas width in pixels">
        <input
          type="text"
          inputMode="numeric"
          aria-label="Canvas width"
          maxLength={4}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            } else if (event.key === 'Escape') {
              setDraft(String(Math.round(width)));
            }
          }}
          aria-description={`Enter ${PREVIEW_WIDTH_LIMITS.minimum}–${PREVIEW_WIDTH_LIMITS.maximum}px`}
        />
        <span>px</span>
      </label>
      <output aria-label="Canvas scale" title="Preview scaled to fit the available space">
        {Math.round(scale * 100)}%
      </output>
      <button type="button" title="Reset canvas to available width" onClick={onFit}>
        Fit
      </button>
    </div>
  );
}
