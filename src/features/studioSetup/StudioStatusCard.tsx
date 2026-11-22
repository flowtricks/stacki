// The Studio tab's building blocks. The tab is two labelled sections, the same small uppercase heading every
// Settings tab uses, so the page keeps one rhythm: the status card (mark, name, one status line, the actions
// at the inline end, then whatever the state adds below), and the sign-in row. The caller picks which action
// is the primary one: at most one per state, so the page never offers two blue buttons that compete.
//
// The section markup repeats SettingsSection's (src/app/settings/SettingsLayout.tsx) and reuses its classes,
// because a feature may not import from the app layer; the look comes from settings.css either way.
import { useId, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { ChevronDownIcon, StackiMarkIcon } from '../../ui/Icons';
import InfoHint from '../../ui/InfoHint';
import { Skeleton } from '../../ui/Skeleton';

/** A section of the Studio tab: its small heading (with an (i) when `info` explains it), then its card. */
export function StudioSettingsSection(props: { readonly title: string; readonly info?: string; readonly children: ReactNode }) {
  const id = useId();
  assert(props.title.length > 0, 'StudioSettingsSection: a section is named');
  return (
    <section className="app-settings-section studio-settings-section" aria-labelledby={id}>
      <header className="app-settings-section-header">
        <div className="app-settings-section-title">
          <h4 id={id}>{props.title}</h4>
          {props.info !== undefined && <InfoHint text={props.info} />}
        </div>
      </header>
      {props.children}
    </section>
  );
}

/** What the status line says: words with an optional tag after them, or a placeholder while the check runs. */
export type StudioStatusLine =
  | { readonly kind: 'checking' }
  | { readonly kind: 'text'; readonly state: 'installed' | 'missing' | 'blocked' | 'failed'; readonly text: string; readonly tag: ReactNode };

/** The status card: the mark, "Stacki Studio" over one status line, the actions at the inline end, and the state's own rows below. */
export function StudioStatusCard(props: { readonly line: StudioStatusLine; readonly actions: ReactNode; readonly children?: ReactNode }) {
  const translate = useTranslate();
  return (
    <div className="studio-status-card">
      <div className="studio-status-header">
        <span className="studio-status-mark" aria-hidden="true">
          <StackiMarkIcon size={40} />
        </span>
        <div className="studio-status-text">
          <strong className="studio-status-name">{translate('studioSetup.name')}</strong>
          <StatusLine line={props.line} />
        </div>
        <div className="studio-status-actions">{props.actions}</div>
      </div>
      {props.children}
    </div>
  );
}

/** The placeholder for an action whose label is not known yet: a button-sized shape, never a word. */
export function StudioActionSkeleton() {
  return <Skeleton width="128px" height="30px" radius="6px" />;
}

/** A closed-by-default disclosure with the shared chevron, for the few who want the detail behind it. */
export function StudioDisclosure(props: { readonly summary: string; readonly children: ReactNode }) {
  assert(props.summary.length > 0, 'StudioDisclosure: the summary says what opens');
  return (
    <details className="studio-disclosure">
      <summary>
        <ChevronDownIcon size={12} className="studio-disclosure-chevron" />
        {props.summary}
      </summary>
      <div className="studio-disclosure-body">{props.children}</div>
    </details>
  );
}

function StatusLine({ line }: { readonly line: StudioStatusLine }) {
  const translate = useTranslate();
  switch (line.kind) {
    case 'checking':
      return (
        <span className="studio-install-status" role="status" aria-busy="true">
          <Skeleton width="140px" />
          <span className="ui-skeleton-status">{translate('studioSetup.entry.checking')}</span>
        </span>
      );
    case 'text':
      assert(line.text.length > 0, 'StudioStatusCard: the status line says something');
      return (
        <span className="studio-install-status" data-state={line.state} role="status">
          <span>{line.text}</span>
          {line.tag}
        </span>
      );
    default: {
      const exhaustive: never = line;
      return exhaustive;
    }
  }
}
