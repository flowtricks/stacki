import type { PublishConfig } from '../../../shared/properties/publishConfig';
import type { GitHubWorkflow } from '../../../shared/properties/publishReview';
import Dropdown from '../../ui/Dropdown';

export function PublishWorkflow({ config, change }: { readonly config: PublishConfig; readonly change: (config: PublishConfig) => void }) {
  const reviewing = config.githubWorkflow?.kind === 'pull-request';
  return (
    <div className="publish-field">
      <span className="publish-label">GitHub workflow</span>
      <Dropdown<GitHubWorkflow['kind']>
        ariaLabel="GitHub workflow"
        value={reviewing ? 'pull-request' : 'direct'}
        options={[
          { value: 'direct', label: 'Publish to the current branch' },
          { value: 'pull-request', label: 'Open a pull request for review' },
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
      {reviewing && <span>Review submissions stay off the live site. Merge and deploy through GitHub.</span>}
    </div>
  );
}
