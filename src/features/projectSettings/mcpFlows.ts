// The MCP tab's two-step writes: a server that needs secrets stores their values in `.env` (through the Secrets
// store's own channels, so the `.env` rules hold: private file, atomic write, revision check) and then writes the
// server, whose entry holds only `${NAME}` references, to `.mcp.json`. Values are written first, so a failed second
// step leaves a harmless unused variable and never a server pointing at a name `.env` lacks. A name already in
// `.env` is never overwritten here.
import type { Digest } from '../../../shared/core/brand';
import type { McpChange, McpListing } from '../../../shared/properties/mcp';
import type { McpServerConfig } from '../../../shared/properties/mcpConfig';
import type { MessageKey } from '../../lib/i18n/localeContext';
import { applyMcpChange } from './mcpBridge';
import { MCP_ERROR_KEYS } from './mcpModel';
import { applySecretsChange, listSecrets } from './secretsBridge';
import { problemKey } from './secretsModel';

export interface SecretToStore {
  readonly name: string;
  readonly value: string;
}

export type FlowResult =
  { readonly ok: true; readonly listing: McpListing } | { readonly ok: false; readonly messageKey: MessageKey; readonly secretsSaved: boolean };

/** The names in `.env`, or `undefined` when they cannot be read (a card then claims nothing about secrets). */
export async function envNamesOf(projectPath: string): Promise<ReadonlySet<string> | undefined> {
  try {
    const listed = await listSecrets(projectPath);
    return listed.ok ? new Set(listed.value.entries.map((entry) => entry.name)) : undefined;
  } catch {
    return undefined;
  }
}

/** Stores each secret that `.env` does not already have; answers with the message of the first failure. */
export async function storeSecrets(projectPath: string, secrets: readonly SecretToStore[]): Promise<MessageKey | undefined> {
  if (secrets.length === 0) {
    return undefined;
  }
  const listed = await listSecrets(projectPath);
  if (!listed.ok) {
    return problemKey(listed.error.code);
  }
  let listing = listed.value;
  if (!listing.exists) {
    const created = await applySecretsChange(projectPath, listing.revision, { kind: 'create' });
    if (!created.ok) {
      return problemKey(created.error.code);
    }
    listing = created.value;
  }
  for (const secret of secrets) {
    if (listing.entries.some((entry) => entry.name === secret.name)) {
      continue;
    }
    const added = await applySecretsChange(projectPath, listing.revision, { kind: 'add', name: secret.name, value: secret.value });
    if (!added.ok) {
      return problemKey(added.error.code);
    }
    listing = added.value;
  }
  return undefined;
}

/** Stores the secrets, then adds the server to `.mcp.json` at `revision`. */
export async function addServerWithSecrets(
  projectPath: string,
  revision: Digest,
  name: string,
  config: McpServerConfig,
  secrets: readonly SecretToStore[],
): Promise<FlowResult> {
  const stored = await storeSecrets(projectPath, secrets);
  if (stored !== undefined) {
    return { ok: false, messageKey: stored, secretsSaved: false };
  }
  return changeServer(projectPath, revision, { kind: 'add', name, config }, { secretsSaved: secrets.length > 0 });
}

export async function changeServer(projectPath: string, revision: Digest, change: McpChange, options: { readonly secretsSaved: boolean }): Promise<FlowResult> {
  const applied = await applyMcpChange(projectPath, revision, change);
  return applied.ok ? { ok: true, listing: applied.value } : { ok: false, messageKey: MCP_ERROR_KEYS[applied.error.code], secretsSaved: options.secretsSaved };
}
