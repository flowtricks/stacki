// Hosted Studio's Settings rail panel: Desktop's frame (ProjectSettingsShell) with the views a hosted project can
// show, each saying honestly what hosted Studio can do. Desktop's Secrets and MCP read `.env` and `.mcp.json`
// through its main process; the hosted Worker has no such channel and no MCP endpoint, so these views state that
// and point at Desktop instead of drawing controls that cannot work. Desktop's Instructions view is not ported,
// so its link is not drawn here. Nothing here reads, writes or shows a secret.
import { useState } from 'react';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import ProjectSettingsShell from '../../../vendor/stacki/src/features/projectSettings/ProjectSettingsShell';
import type { SettingsViewId } from '../../../vendor/stacki/src/lib/settingsSections';
import type { MessageKey } from '../../../vendor/stacki/src/lib/i18n/localeContext';
import { useTranslate } from '../../../vendor/stacki/src/lib/i18n/useTranslate';
import { ChevronRightIcon, LockIcon } from '../../../vendor/stacki/src/ui/Icons';
import { PanelHeader } from '../../../vendor/stacki/src/ui/PanelHeader';
import { RolesView } from '../roles/RolesView';
import InfoHint from '../../../vendor/stacki/src/ui/InfoHint';

interface ViewNotice {
  readonly titleKey: MessageKey;
  readonly lineKey: MessageKey;
  readonly infoKey: MessageKey;
}

/** The views hosted Studio lists, in order. Instructions is not ported. */
export const HOSTED_VIEWS = ['secrets', 'mcp'] as const satisfies readonly SettingsViewId[];
export type HostedViewId = (typeof HOSTED_VIEWS)[number];

/** What each hosted view says. A new hosted view is a compile error here until it has one. */
export const HOSTED_VIEW_NOTICES = {
  secrets: { titleKey: 'settings.secrets.title', lineKey: 'settings.hosted.secrets.line', infoKey: 'settings.hosted.secrets.info' },
  mcp: { titleKey: 'settings.mcp.title', lineKey: 'settings.hosted.mcp.line', infoKey: 'settings.hosted.mcp.info' },
} as const satisfies Record<HostedViewId, ViewNotice>;

// Roles is a real view in hosted Studio, drawn here beside the shared frame's Secrets and MCP rows rather than inside it:
// the frame's list of views is shared with Desktop (src/lib/settingsSections.ts), so adding a row there is a change for
// both hosts. The row uses the frame's own classes, so it looks like the others; opening it swaps the whole panel for
// the Roles view under the frame's own header, with the same back button.
export function StudioProjectSettings() {
  const translate = useTranslate();
  const [rolesOpen, setRolesOpen] = useState(false);
  if (rolesOpen) {
    return (
      <div
        className="panel-section grow settings-panel"
        onKeyDown={(event) => {
          const target = event.target;
          const typing = target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);
          if (event.key === 'Escape' && !event.defaultPrevented && !typing) {
            setRolesOpen(false);
          }
        }}
      >
        <PanelHeader back={{ label: translate('settings.back'), onBack: () => setRolesOpen(false) }} title={translate('roles.studio.title')} />
        <div className="panel-body settings-detail">
          <RolesView />
        </div>
      </div>
    );
  }
  return (
    <>
      <ProjectSettingsShell
        projectKey="studio"
        views={HOSTED_VIEWS}
        refreshable={false}
        renderView={(view) => (view === 'secrets' || view === 'mcp' ? <HostedViewNotice view={view} /> : undefined)}
      />
      <div className="settings-body" data-hosted-roles-link="">
        <button type="button" className="list-item settings-link" onClick={() => setRolesOpen(true)}>
          <span className="icon">
            <LockIcon size={14} />
          </span>
          <span className="label">{translate('roles.studio.title')}</span>
          <ChevronRightIcon size={12} />
        </button>
      </div>
    </>
  );
}

export function HostedViewNotice({ view }: { readonly view: HostedViewId }) {
  const translate = useTranslate();
  const notice: ViewNotice = HOSTED_VIEW_NOTICES[view];
  assert(notice.lineKey.startsWith('settings.hosted.'), 'A hosted view says it is hosted');
  return (
    <div className="secrets mcp" data-hosted-view={view}>
      <div className="secrets-head">
        <div className="secrets-heading">
          <h3>
            {translate(notice.titleKey)}
            <InfoHint text={translate(notice.infoKey)} />
          </h3>
          <p role="status">{translate(notice.lineKey)}</p>
        </div>
      </div>
    </div>
  );
}
