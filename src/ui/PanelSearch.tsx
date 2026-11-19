// The search box under a side panel's title, shared by the Components and Assets panels so the two
// look and behave alike: the same plain input in the same inset, and Escape empties it. The query is
// the caller's state (a panel's search is never remembered), so this holds nothing of its own.
import React from 'react';

export interface PanelSearchProps {
  readonly value: string;
  readonly placeholder: string;
  readonly onChange: (value: string) => void;
}

export function PanelSearch({ value, placeholder, onChange }: PanelSearchProps) {
  return (
    <div style={{ padding: '0 12px 8px' }}>
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
    </div>
  );
}
