// Which required publish field is still empty, found before the parser runs.
// Why: `parsePublishConfig` throws on an empty identifier because malformed data at a boundary is a programmer
// or storage error. An empty field in the settings form is not: it is an expected failure the person can fix,
// so it is answered as a value (AGENTS.md §3) naming the field, and the form says exactly which one to fill.
import { assert } from '../core/assert';
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

export type MissingDestinationField = 'environment' | 'worker' | 'branch' | 'alias' | 'script' | 'cloudflareAccount' | 'hostingProject' | 'vercelOrganization';

/** The destination field a person still has to fill, named before the parser would refuse the whole file. */
export function findMissingDestinationField(destination: Pick<Destination, 'target'>): Result<undefined, { readonly field: MissingDestinationField }> {
  const { target } = destination;
  const empty = (value: string, field: MissingDestinationField) => (value.trim() === '' ? err({ field }) : ok(undefined));
  switch (target.kind) {
    case 'cloudflare-environment':
      return empty(target.environment, 'environment');
    case 'cloudflare-worker':
      return empty(target.project, 'worker');
    case 'cloudflare-pages':
    case 'github-branch':
    case 'link':
      return empty(target.branch, 'branch');
    case 'netlify':
      return empty(target.alias, 'alias');
    case 'script':
      return empty(target.script, 'script');
    case 'vercel':
      return ok(undefined);
    case 'host': {
      // The same fields, in the same order, as production's; a destination's build script has a field of its own.
      const hosting = findMissingPublishField({ hosting: target.hosting, buildScript: 'build' });
      if (hosting.ok) {
        return ok(undefined);
      }
      const { field } = hosting.error;
      assert(field !== 'deployScript', 'A provider hosting has no deploy script');
      assert(field !== 'buildScript', 'The build script given is not empty');
      return err({ field });
    }
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}
