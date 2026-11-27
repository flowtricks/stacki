// Which required publish field is still empty, found before the parser runs.
// Why: `parsePublishConfig` throws on an empty identifier because malformed data at a boundary is a programmer
// or storage error. An empty field in the settings form is not: it is an expected failure the person can fix,
// so it is answered as a value (AGENTS.md §3) naming the field, and the form says exactly which one to fill.
import { err, ok, type Result } from '../core/result';
import type { PublishConfig } from './publishConfig';
import type { Destination } from './publishDestinations';

/** The empty fields a person can fill, in the order the form shows them. */
export type MissingPublishField = 'cloudflareAccount' | 'hostingProject' | 'vercelOrganization' | 'deployScript' | 'buildScript';
export interface MissingPublishError {
  readonly field: MissingPublishField;
}

// The parser accepts a hosting destination whether or not its toggle is on, so the toggle does not excuse
// an empty field here either: a check that passed what the parser then rejects would only move the vague toast.
export function findMissingPublishField(config: Pick<PublishConfig, 'hosting' | 'customHosting' | 'buildScript'>): Result<undefined, MissingPublishError> {
  const { hosting } = config;
  switch (hosting.provider) {
    case 'none':
      if (config.customHosting?.deploy === 'script' && config.customHosting.script.trim() === '') {
        return err({ field: 'deployScript' });
      }
      break;
    case 'cloudflare':
    case 'cloudflare-workers':
      if (hosting.accountId.trim() === '') {
        return err({ field: 'cloudflareAccount' });
      }
      if (hosting.project.trim() === '') {
        return err({ field: 'hostingProject' });
      }
      break;
    case 'vercel':
      if (hosting.projectId.trim() === '') {
        return err({ field: 'hostingProject' });
      }
      if (hosting.organizationId.trim() === '') {
        return err({ field: 'vercelOrganization' });
      }
      break;
    case 'netlify':
      if (hosting.siteId.trim() === '') {
        return err({ field: 'hostingProject' });
      }
      break;
    default: {
      const exhaustive: never = hosting;
      return exhaustive;
    }
  }
  if (config.buildScript.trim() === '') {
    return err({ field: 'buildScript' });
  }
  return ok(undefined);
}

export type MissingStagingField = 'stagingEnvironment' | 'stagingWorker' | 'stagingBranch' | 'stagingAlias' | 'stagingScript';

/** The staging field a person still has to fill, named before the parser would refuse the whole destination. */
export function findMissingStagingField(staging: Pick<Destination, 'target'>): Result<undefined, { readonly field: MissingStagingField }> {
  const { target } = staging;
  const empty = (value: string, field: MissingStagingField) => (value.trim() === '' ? err({ field }) : ok(undefined));
  switch (target.kind) {
    case 'cloudflare-environment':
      return empty(target.environment, 'stagingEnvironment');
    case 'cloudflare-worker':
      return empty(target.project, 'stagingWorker');
    case 'cloudflare-pages':
    case 'github-branch':
    case 'link':
      return empty(target.branch, 'stagingBranch');
    case 'netlify':
      return empty(target.alias, 'stagingAlias');
    case 'script':
      return empty(target.script, 'stagingScript');
    case 'vercel':
      return ok(undefined);
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}
