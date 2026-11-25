import { assert } from '../core/assert';
import type { Hosting } from './publishConfig';

export interface PublishCommand {
  readonly executable: 'npm' | 'wrangler' | 'vercel';
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

export function scriptCommand(script: string): PublishCommand {
  assert(script.length > 0, 'Publish script must be named');
  assert(!script.startsWith('-'), 'Publish script cannot be an option');
  return { executable: 'npm', arguments: ['run', script], environment: {} };
}

export function hostingCommand(hosting: Exclude<Hosting, { provider: 'none' }>): PublishCommand {
  switch (hosting.provider) {
    case 'cloudflare':
      return {
        executable: 'wrangler',
        arguments: ['pages', 'deploy', hosting.directory, '--project-name', hosting.project, '--branch', hosting.branch, '--commit-dirty=true'],
        environment: { CLOUDFLARE_ACCOUNT_ID: hosting.accountId },
      };
    case 'cloudflare-workers':
      return {
        executable: 'wrangler',
        arguments: ['deploy', '--name', hosting.project],
        environment: { CLOUDFLARE_ACCOUNT_ID: hosting.accountId },
      };
    case 'vercel':
      return {
        executable: 'vercel',
        arguments: ['deploy', '--prod', '--yes'],
        environment: {
          VERCEL_ORG_ID: hosting.organizationId,
          VERCEL_PROJECT_ID: hosting.projectId,
        },
      };
    default: {
      const exhaustive: never = hosting;
      return exhaustive;
    }
  }
}
