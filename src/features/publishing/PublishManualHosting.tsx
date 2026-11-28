// The identifiers behind a hosting choice, typed by hand: production's Advanced fields and a destination's own host.
import type { Hosting } from '../../../shared/properties/publishConfig';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { TextField } from './publishFields';

function CloudflareFields({
  hosting,
  change,
}: {
  readonly hosting: Extract<Hosting, { provider: 'cloudflare' }>;
  readonly change: (hosting: Hosting) => void;
}) {
  const translate = useTranslate();
  return (
    <>
      <TextField label={translate('publish.settings.advanced.pagesProject')} value={hosting.project} change={(project) => change({ ...hosting, project })} />
      <TextField label={translate('publish.settings.advanced.productionBranch')} value={hosting.branch} change={(branch) => change({ ...hosting, branch })} />
      <TextField
        label={translate('publish.settings.advanced.outputDirectory')}
        value={hosting.directory}
        change={(directory) => change({ ...hosting, directory })}
      />
    </>
  );
}

export function ManualHosting({ hosting, change }: { readonly hosting: Hosting; readonly change: (hosting: Hosting) => void }) {
  const translate = useTranslate();
  return (
    <>
      {hosting.provider === 'cloudflare' && <CloudflareFields hosting={hosting} change={change} />}
      {hosting.provider === 'netlify' && (
        <TextField label={translate('publish.settings.advanced.netlifySite')} value={hosting.siteId} change={(siteId) => change({ ...hosting, siteId })} />
      )}
      {hosting.provider === 'vercel' && (
        <>
          <TextField
            label={translate('publish.settings.advanced.vercelOrganization')}
            value={hosting.organizationId}
            change={(organizationId) => change({ ...hosting, organizationId })}
          />
          <TextField
            label={translate('publish.settings.advanced.vercelProject')}
            value={hosting.projectId}
            change={(projectId) => change({ ...hosting, projectId })}
          />
        </>
      )}
    </>
  );
}
