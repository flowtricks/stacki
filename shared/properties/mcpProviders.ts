// i18n-ignore-file: provider names are brand names and the catalog holds no sentences; setup hints are settings.mcp.add.* keys.
// The MCP tab's catalog of common providers: what a designer picks from a list instead of pasting a
// command. Each entry says how Claude Code and Codex reach the service (a remote URL or a command to
// run), which secrets it needs by NAME, and where its own setup page is. Secret VALUES never live here:
// the form collects them, the Secrets store keeps them in `.env`, and the server entry written to
// `.mcp.json` refers to them as `${NAME}`.
//
// Only addresses the maintainers are sure of are listed. An entry marked `// verify` is believed
// right but was not checked against the provider's current documentation when it was added; confirm
// it before shipping a change that touches it. A provider with no stable public address is not listed.
//
// Logos live in the renderer (`src/ui/providerLogos.tsx`, vendored from simple-icons), keyed by the ids
// here; a provider with no mark there is drawn as a monogram tile.
import { assert } from '../core/assert';
import { err, ok, type Result } from '../core/result';
import { MCP_LIMITS, isMcpEnvName, isMcpUrl, type McpPair, type McpServerConfig, type McpTransport } from './mcpConfig';

/** Where a provider's secret goes in the server entry. */
export type McpSecretTarget =
  /** A request header: `Authorization: Bearer ${NAME}` is `{ kind: 'header', header: 'Authorization', prefix: 'Bearer ' }`. */
  | { readonly kind: 'header'; readonly header: string; readonly prefix: string }
  /** An environment variable of the command, with the same name as the secret. */
  | { readonly kind: 'env' }
  /** Already written in the command's arguments as `${NAME}`; the form only stores the value. */
  | { readonly kind: 'argument' };

export interface McpProviderSecret {
  /** The `.env` variable the value is stored under. */
  readonly name: string;
  readonly target: McpSecretTarget;
  /** An optional secret left empty is simply not sent. */
  readonly required: boolean;
}

/** A field the person fills in besides secrets. `url` is the whole address; `projectRef` is a `project_ref` query value. */
export const MCP_PROVIDER_OPTION_IDS = ['url', 'projectRef'] as const;
export type McpProviderOptionId = (typeof MCP_PROVIDER_OPTION_IDS)[number];

export interface McpProviderOption {
  readonly id: McpProviderOptionId;
  readonly required: boolean;
  readonly example: string;
}

export interface McpProviderEntry {
  readonly id: string;
  readonly name: string;
  readonly transport: McpTransport;
  /** The address of a remote server; absent when the person supplies it (`url` option) or for a command. */
  readonly url?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly secrets: readonly McpProviderSecret[];
  readonly options: readonly McpProviderOption[];
  /** The provider's own page about its MCP server. */
  readonly docsUrl: string;
}

export const MCP_PROVIDERS = [
  {
    id: 'airtable',
    name: 'Airtable',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'airtable-mcp-server'],
    secrets: [{ name: 'AIRTABLE_API_KEY', target: { kind: 'env' }, required: true }],
    options: [],
    docsUrl: 'https://airtable.com/developers/web/api/introduction',
  }, // verify
  {
    id: 'asana',
    name: 'Asana',
    transport: 'sse',
    url: 'https://mcp.asana.com/sse',
    secrets: [],
    options: [],
    docsUrl: 'https://developers.asana.com/docs/using-asanas-mcp-server',
  }, // verify
  {
    id: 'atlassian',
    name: 'Atlassian',
    transport: 'sse',
    url: 'https://mcp.atlassian.com/v1/sse',
    secrets: [],
    options: [],
    docsUrl: 'https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    transport: 'http',
    url: 'https://docs.mcp.cloudflare.com/mcp',
    secrets: [],
    options: [],
    docsUrl: 'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/',
  }, // verify
  {
    id: 'context7',
    name: 'Context7',
    transport: 'http',
    url: 'https://mcp.context7.com/mcp',
    secrets: [{ name: 'CONTEXT7_API_KEY', target: { kind: 'header', header: 'CONTEXT7_API_KEY', prefix: '' }, required: false }],
    options: [],
    docsUrl: 'https://github.com/upstash/context7',
  }, // verify
  {
    id: 'figma',
    name: 'Figma',
    transport: 'http',
    url: 'https://mcp.figma.com/mcp',
    secrets: [],
    options: [],
    docsUrl: 'https://help.figma.com/hc/en-us/articles/32132100833559',
  },
  {
    id: 'github',
    name: 'GitHub',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    secrets: [{ name: 'GITHUB_PERSONAL_ACCESS_TOKEN', target: { kind: 'header', header: 'Authorization', prefix: 'Bearer ' }, required: true }],
    options: [],
    docsUrl: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@hubspot/mcp-server'],
    secrets: [{ name: 'PRIVATE_APP_ACCESS_TOKEN', target: { kind: 'env' }, required: true }],
    options: [],
    docsUrl: 'https://developers.hubspot.com/mcp',
  }, // verify
  { id: 'linear', name: 'Linear', transport: 'http', url: 'https://mcp.linear.app/mcp', secrets: [], options: [], docsUrl: 'https://linear.app/docs/mcp' },
  {
    id: 'notion',
    name: 'Notion',
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    secrets: [],
    options: [],
    docsUrl: 'https://developers.notion.com/docs/mcp',
  },
  {
    id: 'playwright',
    name: 'Playwright',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    secrets: [],
    options: [],
    docsUrl: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    id: 'postgres',
    name: 'Postgres',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', '${DATABASE_URL}'],
    secrets: [{ name: 'DATABASE_URL', target: { kind: 'argument' }, required: true }],
    options: [],
    docsUrl: 'https://github.com/modelcontextprotocol/servers',
  }, // verify
  {
    id: 'sanity',
    name: 'Sanity',
    transport: 'http',
    url: 'https://mcp.sanity.io',
    secrets: [],
    options: [],
    docsUrl: 'https://www.sanity.io/docs/compute-and-ai/mcp-server',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    transport: 'http',
    url: 'https://mcp.sentry.dev/mcp',
    secrets: [],
    options: [],
    docsUrl: 'https://docs.sentry.io/product/sentry-mcp/',
  },
  { id: 'stripe', name: 'Stripe', transport: 'http', url: 'https://mcp.stripe.com', secrets: [], options: [], docsUrl: 'https://docs.stripe.com/mcp' },
  {
    id: 'supabase',
    name: 'Supabase',
    transport: 'http',
    url: 'https://mcp.supabase.com/mcp',
    secrets: [],
    options: [{ id: 'projectRef', required: false, example: 'abcdefghijklmnopqrst' }],
    docsUrl: 'https://supabase.com/docs/guides/getting-started/mcp',
  },
  {
    id: 'vercel',
    name: 'Vercel',
    transport: 'http',
    url: 'https://mcp.vercel.com',
    secrets: [],
    options: [],
    docsUrl: 'https://vercel.com/docs/mcp/vercel-mcp',
  },
  {
    id: 'zapier',
    name: 'Zapier',
    transport: 'http',
    secrets: [],
    options: [{ id: 'url', required: true, example: 'https://mcp.zapier.com/api/mcp/s/...' }],
    docsUrl: 'https://zapier.com/mcp',
  }, // verify
] as const satisfies readonly McpProviderEntry[];

export type McpProviderId = (typeof MCP_PROVIDERS)[number]['id'];

export function findMcpProvider(id: string): McpProviderEntry | undefined {
  return MCP_PROVIDERS.find((provider) => provider.id === id);
}

export type McpProviderProblem = 'missing-option' | 'bad-url' | 'bad-option' | 'bad-secret-name';

/** What the person typed: option values by id, and the optional secrets they chose to send. */
export interface McpProviderInput {
  readonly options: Readonly<Partial<Record<McpProviderOptionId, string>>>;
  readonly optionalSecrets: readonly string[];
}

/**
 * The server entry for a provider, with every secret as a `${NAME}` reference. The result holds no secret
 * value: storing the values is a separate step, so a failure here can never have written one.
 */
export function buildProviderConfig(provider: McpProviderEntry, input: McpProviderInput): Result<McpServerConfig, McpProviderProblem> {
  assert(provider.secrets.length <= MCP_LIMITS.secretsMax, 'A provider asks for a bounded number of secrets');
  for (const secret of provider.secrets) {
    if (!isMcpEnvName(secret.name)) {
      return err('bad-secret-name');
    }
  }
  const sent = provider.secrets.filter((secret) => secret.required || input.optionalSecrets.includes(secret.name));
  if (provider.transport === 'stdio') {
    return buildCommand(provider, sent);
  }
  const url = remoteUrl(provider, input);
  if (!url.ok) {
    return url;
  }
  const headers: McpPair[] = [];
  for (const secret of sent) {
    if (secret.target.kind === 'header') {
      headers.push({ name: secret.target.header, value: `${secret.target.prefix}\${${secret.name}}` });
    }
  }
  assert(url.value.length > 0, 'A remote provider has an address');
  return ok({ transport: provider.transport, url: url.value, headers });
}

function buildCommand(provider: McpProviderEntry, sent: readonly McpProviderSecret[]): Result<McpServerConfig, McpProviderProblem> {
  const command = provider.command;
  assert(command !== undefined, 'A command provider names its command');
  const env: McpPair[] = [];
  for (const secret of sent) {
    if (secret.target.kind === 'env') {
      env.push({ name: secret.name, value: `\${${secret.name}}` });
    }
  }
  return ok({ transport: 'stdio', command, args: provider.args ?? [], env });
}

function remoteUrl(provider: McpProviderEntry, input: McpProviderInput): Result<string, McpProviderProblem> {
  const typed = input.options.url?.trim();
  const base = provider.url ?? typed;
  if (base === undefined || base.length === 0) {
    return err('missing-option');
  }
  if (!isMcpUrl(base)) {
    return err('bad-url');
  }
  const projectRef = input.options.projectRef?.trim();
  if (projectRef === undefined || projectRef.length === 0) {
    return ok(base);
  }
  // A project reference is an identifier: letters, digits and dashes. Anything else is not put in a URL.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectRef)) {
    return err('bad-option');
  }
  const joined = `${base}${base.includes('?') ? '&' : '?'}project_ref=${projectRef}`;
  return isMcpUrl(joined) ? ok(joined) : err('bad-url');
}
