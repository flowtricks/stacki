import { record } from '../../shared/core/boundary';
import {
  discoveryList,
  discoveryIdentifier,
  discoveryLabel,
  DISCOVERY_LIMITS,
  type PublishAccount,
  type PublishProject,
} from '../../shared/properties/publishDiscovery';
import { discoveryCommand } from './publishDiscoveryCommand';

export async function vercelAccounts(root: string): Promise<readonly PublishAccount[]> {
  const teams = await vercelPages(root, '/v2/teams', 'teams', '');
  return teams.map((entry) => {
    const team = record(entry);
    return { id: discoveryIdentifier(team['id']), name: discoveryLabel(team['name']) };
  });
}

export async function vercelProjects(root: string, account: string): Promise<readonly PublishProject[]> {
  const values = await vercelPages(root, '/v9/projects', 'projects', account);
  return values.map((entry) => {
    const value = record(entry);
    const organizationId = discoveryIdentifier(value['accountId']);
    if (organizationId !== account) {
      throw new Error('Vercel returned a project from a different account.');
    }
    return {
      name: discoveryLabel(value['name']),
      hosting: { provider: 'vercel', organizationId, projectId: discoveryIdentifier(value['id']) },
    };
  });
}

export async function vercelPages(root: string, endpoint: string, field: string, account: string) {
  const values: unknown[] = [];
  let cursor = '';
  for (let page = 0; page < DISCOVERY_LIMITS.pagesMax; page++) {
    const args = ['api', `${endpoint}?limit=100${cursor}`, '--method', 'GET', '--raw'];
    if (account) {
      args.push('--scope', account);
    }
    const data = record(await discoveryCommand(root, 'vercel', args));
    values.push(...discoveryList(data[field]));
    discoveryList(values);
    const pagination = record(data['pagination']);
    const next = pagination['next'];
    // Vercel uses JSON null for the end cursor; keep it out of the application model.
    if (next === null || next === undefined) {
      return values;
    }
    if (typeof next !== 'number' || !Number.isSafeInteger(next) || next < 0) {
      throw new Error('Invalid Vercel pagination cursor.');
    }
    const following = `&until=${next}`;
    if (following === cursor) {
      throw new Error('Vercel pagination did not advance.');
    }
    cursor = following;
  }
  throw new Error('Vercel has too many entries to list. Use manual configuration.');
}
