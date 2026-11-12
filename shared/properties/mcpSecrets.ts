// The MCP tab's "keep secrets out of the file": a pasted server often carries a token as a literal
// (`-e API_KEY=sk-...`, `-H "Authorization: Bearer sk-..."`). `.mcp.json` is meant to be committed, so
// each literal becomes a `${NAME}` reference and the value goes to `.env` through the Secrets store.
// This module only plans that: it returns the rewritten server and the secrets to store. It reads and
// writes no file. URLs and arguments are not touched (they are not pairs a person named as secret).
//
// A value that `.env` cannot hold (too long, a line break, edge whitespace) stays literal and its pair
// name is reported, so the panel can say so instead of silently dropping or truncating it.
import { assert } from '../core/assert';
import { envValueProblem } from './envFile';
import { MCP_LIMITS, mcpPlaceholders, type McpPair, type McpServerConfig } from './mcpConfig';

export interface McpSecretToStore {
  readonly name: string;
  readonly value: string;
}

export interface MovedSecrets {
  readonly config: McpServerConfig;
  readonly secrets: readonly McpSecretToStore[];
  /** Pair names whose literal value could not move to `.env` and stays in the file. */
  readonly leftLiteral: readonly string[];
}

/** Most secrets one server can move: every variable and every header. */
export const MCP_SECRETS_MAX = MCP_LIMITS.pairsMax * 2;

const SCHEME_PATTERN = /^(Bearer|Basic|Token|Digest)\s+(\S.*)$/i;
const SUFFIX_TRIES_MAX = MCP_SECRETS_MAX + 2;

/** `acme-tools` and `X-Api-Key` give `ACME_TOOLS_X_API_KEY`: a valid variable name. */
export function secretNameFor(serverName: string, headerName: string): string {
  const joined = `${serverName}_${headerName}`
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  const named = /^[0-9]/.test(joined) ? `_${joined}` : joined;
  assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(named) || named.length === 0, 'A derived secret name is a variable name');
  return named.length === 0 ? 'MCP_SECRET' : named;
}

function uniqueName(base: string, used: ReadonlySet<string>): string | undefined {
  if (!used.has(base)) {
    return base;
  }
  for (let suffix = 2; suffix < SUFFIX_TRIES_MAX; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

interface Plan {
  readonly used: Set<string>;
  readonly secrets: McpSecretToStore[];
  readonly leftLiteral: string[];
}

// One pair: a reference, an empty value, or a value that cannot move is returned as it is.
function movedPair(pair: McpPair, secretName: string, scheme: string, plan: Plan): McpPair {
  const secret = pair.value.slice(scheme.length);
  if (pair.value.length === 0) {
    return pair;
  }
  if (pair.value.length > MCP_LIMITS.argCharsMax) {
    plan.leftLiteral.push(pair.name);
    return pair;
  }
  if (mcpPlaceholders(pair.value).length > 0) {
    return pair;
  }
  if (secret.length === 0 || envValueProblem(secret) !== undefined || plan.secrets.length >= MCP_SECRETS_MAX) {
    plan.leftLiteral.push(pair.name);
    return pair;
  }
  const name = uniqueName(secretName, plan.used);
  if (name === undefined) {
    plan.leftLiteral.push(pair.name);
    return pair;
  }
  plan.used.add(name);
  plan.secrets.push({ name, value: secret });
  return { name: pair.name, value: `${scheme}\${${name}}` };
}

/** Plans the move of every literal variable and header value to a `${NAME}` reference plus a stored secret. */
export function moveLiteralsToSecrets(serverName: string, config: McpServerConfig, taken: ReadonlySet<string>): MovedSecrets {
  assert(serverName.length > 0, 'A server has a name before its secrets are named');
  assert(taken.size <= MCP_LIMITS.pairsMax * 64, 'The names already in .env are bounded');
  const plan: Plan = { used: new Set(taken), secrets: [], leftLiteral: [] };
  if (config.transport === 'stdio') {
    const env = config.env.map((pair) => movedPair(pair, pair.name, '', plan));
    return { config: { ...config, env }, secrets: plan.secrets, leftLiteral: plan.leftLiteral };
  }
  const headers = config.headers.map((pair) => {
    const scheme = SCHEME_PATTERN.exec(pair.value);
    const prefix = scheme?.[1] === undefined ? '' : pair.value.slice(0, pair.value.length - (scheme[2]?.length ?? 0));
    return movedPair(pair, secretNameFor(serverName, pair.name), prefix, plan);
  });
  assert(plan.secrets.length <= MCP_SECRETS_MAX, 'Secrets stay within their bound');
  return { config: { ...config, headers }, secrets: plan.secrets, leftLiteral: plan.leftLiteral };
}
