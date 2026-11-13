import type { PublishConfig } from '../../../shared/properties/publishConfig';
import type { GitHubWorkflow } from '../../../shared/properties/publishReview';
import Dropdown from '../../ui/Dropdown';
import { useTranslate } from '../../lib/i18n/useTranslate';

export function PublishWorkflow({ config, change }: { readonly config: PublishConfig; readonly change: (config: PublishConfig) => void }) {
  const translate = useTranslate();
  const reviewing = config.githubWorkflow?.kind === 'pull-request';
  return (
    <div className="publish-field">
      <span className="publish-label">{translate('publish.workflow.label')}</span>
      <Dropdown<GitHubWorkflow['kind']>
        ariaLabel={translate('publish.workflow.label')}
        value={reviewing ? 'pull-request' : 'direct'}
        options={[
          { value: 'direct', label: translate('publish.workflow.direct') },
          { value: 'pull-request', label: translate('publish.workflow.pullRequest') },
        ]}
        menuClassName="publish-dropdown"
        livePreview={false}
        onChange={(kind) => {
          change({
            ...config,
            githubWorkflow: { kind },
            defaultTarget: kind === 'pull-request' ? 'github' : config.defaultTarget,
          });
        }}
      />
      {reviewing && <span>{translate('publish.workflow.reviewNote')}</span>}
    </div>
  );
}
