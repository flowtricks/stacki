// Hosted Studio's Settings rail panel: Desktop's frame (ProjectSettingsShell) with the same tabs, each saying
// honestly what hosted Studio can do with it. Desktop's tabs read `.env` and `.mcp.json` through its main
// process; the hosted Worker has no such channel and no MCP endpoint, so the tabs state that and point at
// Desktop instead of drawing controls that cannot work. Nothing here reads, writes or shows a secret.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import ProjectSettingsShell from '../../../vendor/stacki/src/features/projectSettings/ProjectSettingsShell';
import type { ProjectSettingsTabId } from '../../../vendor/stacki/src/features/projectSettings/settingsTabs';
import type { MessageKey } from '../../../vendor/stacki/src/lib/i18n/localeContext';
import { useTranslate } from '../../../vendor/stacki/src/lib/i18n/useTranslate';
import InfoHint from '../../../vendor/stacki/src/ui/InfoHint';

interface TabNotice {
  readonly titleKey: MessageKey;
  readonly lineKey: MessageKey;
  readonly infoKey: MessageKey;
}

/** What each Settings tab says in hosted Studio. A new tab in settingsTabs.ts is a compile error here until it has one. */
export const HOSTED_TAB_NOTICES = {
  secrets: { titleKey: 'settings.secrets.title', lineKey: 'settings.hosted.secrets.line', infoKey: 'settings.hosted.secrets.info' },
  mcp: { titleKey: 'settings.mcp.title', lineKey: 'settings.hosted.mcp.line', infoKey: 'settings.hosted.mcp.info' },
} as const satisfies Record<ProjectSettingsTabId, TabNotice>;

export function StudioProjectSettings() {
  return <ProjectSettingsShell renderTab={(tab) => <HostedTabNotice tab={tab} />} />;
}

export function HostedTabNotice({ tab }: { readonly tab: ProjectSettingsTabId }) {
  const translate = useTranslate();
  const notice: TabNotice = HOSTED_TAB_NOTICES[tab];
  assert(notice.lineKey.startsWith('settings.hosted.'), 'A hosted tab says it is hosted');
  return (
    <div className="secrets mcp" data-hosted-tab={tab}>
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
