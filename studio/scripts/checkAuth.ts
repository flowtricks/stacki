// `astro-studio check-project` for sign-in: reads the site's `studio/cloudflare/wrangler.jsonc` and reports, per chosen
// AUTH_PROVIDER, every variable that is missing or malformed, with the same parser the Worker uses at runtime. Secrets are
// not in the file, so they are listed as a reminder (`wrangler secret put`), never checked. A site without a Studio
// install has nothing to check and is not an error.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { authConfigProblems, parseAuthProviderId } from '../src/features/auth/providers/authConfig';

const REQUIRED_SECRETS: Readonly<Record<string, readonly string[]>> = {
  github: [],
  access: [],
  google: ['GOOGLE_CLIENT_SECRET'],
  oidc: ['OIDC_CLIENT_SECRET (omit for a public client)'],
  passkey: ['AUTH_SETUP_CODE (for the first-admin setup page)'],
};

export async function checkAuthProvider(root: string): Promise<void> {
  const file = path.join(root, 'studio', 'cloudflare', 'wrangler.jsonc');
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) {
    return;
  }
  const config: unknown = parseJsonc(text);
  const vars: unknown = typeof config === 'object' && config !== null ? Reflect.get(config, 'vars') : undefined;
  const environment: Record<string, unknown> = typeof vars === 'object' && vars !== null ? Object.fromEntries(Object.entries(vars)) : {};
  const chosen = parseAuthProviderId(environment['AUTH_PROVIDER']);
  if (!chosen.ok) {
    throw new Error(`studio/cloudflare/wrangler.jsonc: ${chosen.error}`);
  }
  // A secret that is also set as a plain var would be checked here; secrets themselves live in Cloudflare, not in the file.
  const secrets = REQUIRED_SECRETS[chosen.value] ?? [];
  const placeholder = Object.fromEntries(
    secrets.map((name) => [name.split(' ')[0] ?? name, environment[name.split(' ')[0] ?? name] ?? 'set-with-wrangler-secret']),
  );
  const problems = authConfigProblems({ ...placeholder, ...environment });
  if (problems.length > 0) {
    throw new Error(`Sign-in (AUTH_PROVIDER=${chosen.value}) is not configured correctly in studio/cloudflare/wrangler.jsonc:\n- ${problems.join('\n- ')}`);
  }
  const reminder = secrets.length === 0 ? '' : ` Secrets to set with wrangler secret put: ${secrets.join(', ')}.`;
  console.log(`Sign-in: ${chosen.value} is configured.${reminder}`);
}
