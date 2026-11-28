// The settings of a host Stacki has no integration for. Only "How it deploys" shows at first; choosing a script or
// a link reveals that one field, and the host's name and address stay behind their disclosure.
import { CUSTOM_DEPLOYS, PUBLISH_LIMITS, type CustomDeploy, type CustomHosting, type PublishConfig } from '../../../shared/properties/publishConfig';
import Dropdown from '../../ui/Dropdown';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { FieldLabel, MoreOptions, ScriptDropdown, TextField } from './publishFields';
import { PublishDeployLinkField } from './PublishDeployLinkField';
import { PublishedSiteField } from './PublishedSiteField';
import { useIsInvalidPublishField } from './publishInvalidField';
import { withDetail } from './customHosting';
import type { CustomHostInfo, LinkDraft } from './useCustomHostInfo';
import type { MessageKey } from '../../../shared/properties/i18n/messageRef';

interface Props {
  readonly config: PublishConfig;
  readonly custom: CustomHosting;
  readonly change: (config: PublishConfig) => void;
  readonly info: CustomHostInfo | undefined;
  readonly draft: LinkDraft;
  readonly changeDraft: (draft: LinkDraft) => void;
  readonly removeLink: () => void;
}

const MODE_LABELS = {
  github: 'publish.custom.mode.github',
  script: 'publish.custom.mode.script',
  link: 'publish.custom.mode.link',
} as const satisfies Record<CustomDeploy, MessageKey>;

const MODE_HINTS = {
  github: 'publish.custom.mode.githubHint',
  script: 'publish.custom.mode.scriptHint',
  link: 'publish.custom.mode.linkHint',
} as const satisfies Record<CustomDeploy, MessageKey>;

export function PublishCustomFields(props: Props) {
  const translate = useTranslate();
  const { config, custom, change, info } = props;
  const invalidScript = useIsInvalidPublishField('deployScript');
  const setCustom = (customHosting: CustomHosting) => change({ ...config, customHosting });
  // Studio keeps no deploy links, so the choice is listed with why it cannot be made there.
  const linksUnsupported = info?.links.production.kind === 'unsupported';
  return (
    <>
      <div className="publish-field">
        <FieldLabel label={translate('publish.custom.mode')} hint={translate(MODE_HINTS[custom.deploy])} />
        <Dropdown<CustomDeploy>
          ariaLabel={translate('publish.custom.mode')}
          value={custom.deploy}
          options={CUSTOM_DEPLOYS.map((deploy) => ({
            value: deploy,
            label: translate(MODE_LABELS[deploy]),
            ...(deploy === 'link' && linksUnsupported ? { disabled: true, description: translate('publish.custom.link.desktopOnly') } : {}),
          }))}
          menuClassName="publish-dropdown"
          livePreview={false}
          onChange={(deploy) => setCustom(withDeploy(custom, deploy))}
        />
      </div>
      {custom.deploy === 'script' && (
        <ScriptDropdown
          label={translate('publish.custom.script')}
          value={custom.script}
          scripts={info?.scripts}
          placeholder={translate('publish.custom.chooseScript')}
          invalid={invalidScript}
          change={(script) => setCustom({ ...custom, script })}
        />
      )}
      {custom.deploy === 'link' && (
        <PublishDeployLinkField state={info?.links.production} draft={props.draft} change={props.changeDraft} remove={props.removeLink} />
      )}
      <MoreOptions title={translate('publish.custom.more')}>
        <TextField
          label={translate('publish.custom.hostName')}
          value={custom.hostName ?? ''}
          maxLength={PUBLISH_LIMITS.hostNameCharsMax}
          change={(hostName) => setCustom(withDetail(custom, 'hostName', hostName))}
        />
        <PublishedSiteField config={config} change={change} />
      </MoreOptions>
    </>
  );
}

// Each way of deploying holds only its own settings; the host's name and address carry over.
function withDeploy(custom: CustomHosting, deploy: CustomDeploy): CustomHosting {
  const details = {
    ...(custom.hostName === undefined ? {} : { hostName: custom.hostName }),
    ...(custom.siteUrl === undefined ? {} : { siteUrl: custom.siteUrl }),
  };
  if (deploy !== 'script') {
    return { deploy, ...details };
  }
  // Never preselected: choosing what a publish runs is the person's own act, whatever the scripts are called.
  return { deploy, script: custom.deploy === 'script' ? custom.script : '', ...details };
}
