import { gitDraftHeaders } from '../history/gitWorkspaceStorage';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Durable cloud storage is acknowledged before the editor reports Saved. Local
// development uses the same contract with atomic filesystem replacement.
export class DraftStorage {
  private readonly saved = new Map<string, string>();
  constructor(readonly root: string) {}
  async remove(file: string) {
    this.saved.delete(file);
    const backend = process.env['STUDIO_BACKEND_URL'];
    if (backend) {
      const response = await this.remote(backend, file, 'DELETE');
      if (!response.ok) {
        throw new Error('Could not remove durable draft');
      }
    }
    await rm(await this.filename(file), { force: true });
  }
  async read(file: string): Promise<Uint8Array | undefined> {
    const backend = process.env['STUDIO_BACKEND_URL'];
    if (backend) {
      const response = await this.remote(backend, file, 'GET');
      if (response.status === 404) {
        return undefined;
      }
      if (!response.ok) {
        throw new Error('Could not restore the shared draft');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      this.saved.set(file, this.digest(bytes));
      return bytes;
    }
    try {
      const bytes = await readFile(await this.filename(file));
      this.saved.set(file, this.digest(bytes));
      return bytes;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }
  async write(file: string, bytes: Uint8Array) {
    const digest = this.digest(bytes);
    if (this.saved.get(file) === digest) {
      return;
    }
    const backend = process.env['STUDIO_BACKEND_URL'];
    if (backend) {
      const response = await this.remote(backend, file, 'PUT', bytes);
      if (!response.ok) {
        throw new Error('Draft storage is unavailable. Keep the studio open and retry.');
      }
    }
    const destination = await this.filename(file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination + '.tmp', bytes);
    await rename(destination + '.tmp', destination);
    this.saved.set(file, digest);
  }
  private digest(bytes: Uint8Array) {
    return createHash('sha256').update(bytes).digest('hex');
  }
  private async filename(file: string) {
    const namespace = (await gitDraftHeaders(this.root))['x-studio-draft'];
    const directory =
      namespace === 'legacy' ? '.stacki/studio/state' : '.stacki/studio/state/drafts/' + namespace;
    return path.join(this.root, directory, Buffer.from(file).toString('base64url') + '.bin');
  }
  private async remote(backend: string, file: string, method: string, bytes?: Uint8Array) {
    return fetch(`${backend}/studio/internal/state?file=${encodeURIComponent(file)}`, {
      method,
      headers: await gitDraftHeaders(this.root),
      ...(bytes ? { body: Buffer.from(bytes) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  }
}
