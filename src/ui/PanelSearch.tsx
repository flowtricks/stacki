// The search box under a side panel's title, shared by the Components and Assets panels so the two
// look and behave alike: the same plain input in the same inset, and Escape empties it. The query is
// the caller's state (a panel's search is never remembered), so this holds nothing of its own.
// A panel that passes `clearLabel` also gets a clear button inside the box while it holds text, for a
// person working with the pointer, who has no Escape key in hand.
import React from 'react';
import { CloseIcon } from './Icons';
import TipAnchor from './TipAnchor';
import './panelSearch.css';

export interface PanelSearchProps {
  readonly value: string;
  readonly placeholder: string;
  readonly onChange: (value: string) => void;
  /**
   * A line shown as the box's tooltip, for a panel whose search reads more than plain words: the app's own tip
   * (TipAnchor), never the browser's title box, which drew over the app's tips beside it (the Navigator's).
   */
  readonly hint?: string;
  /** Names the clear button; without it the box has none, as before. */
  readonly clearLabel?: string;
}

export function PanelSearch({ value, placeholder, onChange, hint, clearLabel }: PanelSearchProps) {
  const clearable = clearLabel !== undefined && value.length > 0;
  return (
    <div className={clearable ? 'panel-search clearable' : 'panel-search'} style={{ padding: '0 12px 8px' }}>
      <TipAnchor text={hint}>
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          spellCheck={false}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            // Only a box with text takes the key, so Escape on an empty one still reaches the panel.
            if (event.key === 'Escape' && value.length > 0) {
              event.stopPropagation();
              onChange('');
            }
          }}
        />
      </TipAnchor>
      {clearable && (
        <button
          type="button"
          className="ghost panel-search-clear"
          aria-label={clearLabel}
          title={clearLabel}
          onClick={(event) => {
            // The box keeps the focus, so the person types the next search straight away.
            event.currentTarget.parentElement?.querySelector('input')?.focus();
            onChange('');
          }}
        >
          <CloseIcon size={12} />
        </button>
      )}
    </div>
  );
}
