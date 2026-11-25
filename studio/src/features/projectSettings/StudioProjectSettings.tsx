// Hosted Studio's Settings rail panel: Desktop's frame (ProjectSettingsShell) with the views a hosted project can
// show, each saying honestly what hosted Studio can do. Desktop's Secrets and MCP read `.env` and `.mcp.json`
// through its main process; the hosted Worker has no such channel and no MCP endpoint, so these views state that
// and point at Desktop instead of drawing controls that cannot work. Desktop's Instructions view is not ported,
// so its link is not drawn here. Nothing here reads, writes or shows a secret.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import ProjectSettingsShell from '../../../vendor/stacki/src/features/projectSettings/ProjectSettingsShell';
import type { SettingsViewId } from '../../../vendor/stacki/src/lib/settingsSections';
import type { MessageKey } from '../../../vendor/stacki/src/lib/i18n/localeContext';
import { useTranslate } from '../../../vendor/stacki/src/lib/i18n/useTranslate';
import { can } from '../../../vendor/stacki/shared/properties/projectRoles';
import { useStudioRole } from '../roles/useEditorRole';
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

// Roles is a real view in hosted Studio, listed in the shared frame's root (ProjectSettingsShell) beside Secrets and MCP
// and opened with the frame's own back button. Like the Roles view itself, its row is for those who may manage roles
// (`settings:roles`, admin).
export function StudioProjectSettings() {
  const role = useStudioRole();
  const views: readonly SettingsViewId[] = can(role, 'settings:roles') ? [...HOSTED_VIEWS, 'roles'] : HOSTED_VIEWS;
  return (
    <ProjectSettingsShell
      projectKey="studio"
      views={views}
      refreshable={false}
      renderView={(view) => {
        if (view === 'roles') {
          return <RolesView />;
        }
        return view === 'secrets' || view === 'mcp' ? <HostedViewNotice view={view} /> : undefined;
      }}
    />
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
