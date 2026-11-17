// The Secrets tab's calls to main (shared/properties/secrets.ts), each for the dev env file it names: each payload is checked before it
// leaves and each answer is parsed before use. The list carries names only; a value comes back from
// `readSecret` alone, for a person who revealed or began editing it.
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { assert } from '../../../shared/core/assert';
import type { Digest } from '../../../shared/core/brand';
import {
  parseSecretValueReply,
  parseSecretsListing,
  parseSecretsResult,
  type SecretValue,
  type SecretsChange,
  type SecretsFileName,
  type SecretsListing,
  type SecretsResult,
} from '../../../shared/properties/secrets';

/**
 * The running app does not have the Secrets channels: its main process or preload predates them
 * (a development app started before the update). Distinct from a read that failed, because the cure is a restart.
 */
export class SecretsUnavailableError extends Error {
  override readonly name = 'SecretsUnavailableError';

  constructor() {
    super('The Secrets channels are not available in this running app.');
  }
}

// Runs a channel call, turning "not exposed by the preload" and "no handler in main" into SecretsUnavailableError.
async function call(exposed: unknown, run: () => Promise<unknown>): Promise<unknown> {
  if (typeof exposed !== 'function') {
    throw new SecretsUnavailableError();
  }
  try {
    return await run();
  } catch (error: unknown) {
    if (error instanceof Error && /No handler registered/.test(error.message)) {
      throw new SecretsUnavailableError();
    }
    throw error;
  }
}

export async function listSecrets(projectPath: string, file: SecretsFileName): Promise<SecretsResult<SecretsListing>> {
  const input = parseIpcPayload('secrets:list', { projectPath, file });
  const result = parseSecretsResult(await call(window.avb.listSecrets, () => window.avb.listSecrets(input)), parseSecretsListing);
  assert(!result.ok || result.value.file === file, 'A secrets listing is for the file it was asked for');
  return result;
}

export async function readSecret(projectPath: string, file: SecretsFileName, revision: Digest, index: number): Promise<SecretsResult<SecretValue>> {
  const input = parseIpcPayload('secrets:read', { projectPath, file, revision, index });
  return parseSecretsResult(await call(window.avb.readSecret, () => window.avb.readSecret(input)), parseSecretValueReply);
}

export async function applySecretsChange(
  projectPath: string,
  file: SecretsFileName,
  revision: Digest,
  change: SecretsChange,
): Promise<SecretsResult<SecretsListing>> {
  const input = parseIpcPayload('secrets:apply', { projectPath, file, revision, change });
  const result = parseSecretsResult(await call(window.avb.applySecretsChange, () => window.avb.applySecretsChange(input)), parseSecretsListing);
  assert(!result.ok || result.value.file === file, 'A changed secrets listing is for the file that was changed');
  return result;
}

export async function ignoreSecretsFile(projectPath: string, file: SecretsFileName): Promise<SecretsResult<SecretsListing>> {
  const input = parseIpcPayload('secrets:ignore', { projectPath, file });
  return parseSecretsResult(await call(window.avb.ignoreSecretsFile, () => window.avb.ignoreSecretsFile(input)), parseSecretsListing);
}
