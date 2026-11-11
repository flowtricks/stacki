// Where a Studio keeps app settings' secrets (electron/project/appSettingsStore.ts
// holds the format and the rule that a secret never goes under the project).
//
// Why here: a local Studio already keeps its other secrets, media connections'
// keys, in the user's home folder under `~/.stacki/`, one file per project named
// by a digest of its path (mediaHostingServer.ts LocalMediaConnections). App
// secrets follow that store's place and naming, in `~/.stacki/studio-app-secrets/`,
// and are sealed with AES-256-GCM under a random key kept beside them (mode
// 0600), so the vault file alone opens nothing.
//
// A hosted Studio (STUDIO_CONTAINER_TOKEN set) keeps its secrets in the Worker's
// sealed vault (src/cloudflare/cmsConnectionRoutes.ts), which the container does
// not reach for apps yet, and its own disk does not outlive a deployment. It
// refuses secret settings with that reason rather than keep them somewhere
// they would be lost; text and URL settings still save to the project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import type { SecretVault } from '../../../vendor/stacki/electron/project/appSettingsStore';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function studioSecretVault(home: string = os.homedir()): SecretVault {
  const directory = path.join(home, '.stacki', 'studio-app-secrets');
  const deployed = Boolean(process.env['STUDIO_CONTAINER_TOKEN']);
  const key = (): Buffer => {
    const file = path.join(directory, 'key');
    try {
      const existing = fs.readFileSync(file);
      assert(existing.byteLength === KEY_BYTES, 'The app secrets key is 32 bytes');
      return existing;
    } catch (error: unknown) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const created = randomBytes(KEY_BYTES);
    fs.writeFileSync(file, created, { flag: 'wx', mode: 0o600 });
    return created;
  };
  return {
    directory: () => directory,
    seal: {
      refusal: () => (deployed ? 'A hosted Studio does not keep secret settings yet; fill them in with Stacki Desktop or a local Studio.' : undefined),
      seal: (value) => {
        const nonce = randomBytes(NONCE_BYTES);
        const cipher = createCipheriv('aes-256-gcm', key(), nonce);
        const sealed = Buffer.concat([nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
        return sealed.toString('base64');
      },
      open: (sealed) => {
        const bytes = Buffer.from(sealed, 'base64');
        assert(bytes.byteLength >= NONCE_BYTES + TAG_BYTES, 'A sealed value holds its nonce and tag');
        const decipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, NONCE_BYTES));
        decipher.setAuthTag(bytes.subarray(bytes.byteLength - TAG_BYTES));
        return Buffer.concat([decipher.update(bytes.subarray(NONCE_BYTES, bytes.byteLength - TAG_BYTES)), decipher.final()]).toString('utf8');
      },
    },
  };
}
