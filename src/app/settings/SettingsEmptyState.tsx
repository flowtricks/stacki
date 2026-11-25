// The empty state inside a Settings card: a dim icon, a one-line title, at most one short dim hint, then
// whatever action fits (quick-add chips, a button). It centres in the card it sits in, so the card keeps
// its shape when the first item arrives. Used where a list lives in a card (Settings → Instructions);
// SettingsEmpty (SettingsLayout.tsx) stays the whole-tab version for "open a project first".
import type { ReactNode } from 'react';
import './settingsEmptyState.css';

export function SettingsEmptyState(props: { readonly icon: ReactNode; readonly title: string; readonly hint?: string; readonly children?: ReactNode }) {
  return (
    <div className="settings-empty-state">
      <span className="settings-empty-state-icon" aria-hidden="true">
        {props.icon}
      </span>
      <div className="settings-empty-state-title">{props.title}</div>
      {props.hint !== undefined && <div className="settings-empty-state-hint">{props.hint}</div>}
      {props.children !== undefined && <div className="settings-empty-state-actions">{props.children}</div>}
    </div>
  );
}
