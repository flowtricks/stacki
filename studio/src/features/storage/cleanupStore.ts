import { gitDraftHeaders } from '../history/gitWorkspaceStorage';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { filePath, record, string } from '../../shared/validation';
import {
  assetPath,
  parseEntries,
  type CleanupCandidate,
  type StorageInventory,
} from './cleanupTypes';
export interface AssetBaseline {
  readonly sha: string;
  readonly assets: ReadonlyMap<string, string>;
}
export const assetDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const gitBlob = (bytes: Uint8Array) =>
  createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
export function localUploadPath(root: string, file: string) {
  return path.join(
    root,
    '.stacki/studio/state/uploads',
    Buffer.from(assetPath(file)).toString('base64url') + '.bin',
  );
}
export async function keepLocalUpload(root: string, file: string, bytes: Uint8Array) {
  const destination = localUploadPath(root, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination + '.tmp', bytes);
  await rename(destination + '.tmp', destination);
}
export class CleanupStore {
  constructor(
    readonly root: string,
    private readonly backend = process.env['STUDIO_BACKEND_URL'],
    private readonly token = process.env['STUDIO_CONTAINER_TOKEN'],
  ) {}
  async inventory(): Promise<StorageInventory> {
    if (this.backend) {
      return { location: 'r2', entries: parseEntries((await this.remote('/storage'))['entries']) };
    }
    const entries = [];
    for (const directory of ['.stacki/studio/state', '.stacki/studio/state/uploads']) {
      for (const name of await namesIn(path.join(this.root, directory))) {
        if (!name.endsWith('.bin')) {
          continue;
        }
        const filename = path.join(this.root, directory, name);
        const info = await lstat(filename);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 20_000_000) {
          throw new Error('Invalid stored file');
        }
        const file = Buffer.from(name.slice(0, -4), 'base64url').toString('utf8');
        const upload = directory.endsWith('/uploads');
        if (upload) {
          assetPath(file);
        }
        entries.push({
          key: (upload ? 'assets/' : 'documents/') + file,
          size: info.size,
          version: assetDigest(await readFile(filename)),
        });
      }
    }
    return { location: 'local', entries };
  }
  async baseline(): Promise<AssetBaseline> {
    if (this.backend) {
      return parseBaseline(await this.remote('/storage-baseline'));
    }
    try {
      return parseBaseline(
        JSON.parse(
          await readFile(
            path.join(this.root, '.stacki/studio/state/published-assets.json'),
            'utf8',
          ),
        ),
      );
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { sha: '', assets: new Map() };
      }
      throw error;
    }
  }
  async rememberPublished(sha: string, assets: ReadonlyMap<string, string>) {
    if (this.backend) {
      return;
    }
    const destination = path.join(this.root, '.stacki/studio/state/published-assets.json');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(
      destination + '.tmp',
      JSON.stringify({ sha, assets: [...assets].map(([file, sha]) => ({ file, sha })) }),
    );
    await rename(destination + '.tmp', destination);
  }
  async remove(candidate: CleanupCandidate) {
    if (this.backend) {
      return (await this.remote('/storage-remove', candidate))['removed'] === true;
    }
    const filename = localUploadPath(this.root, candidate.file);
    const bytes = await readFile(filename);
    if (assetDigest(bytes) !== candidate.version || assetDigest(bytes) !== candidate.digest) {
      throw new Error('Upload changed; scan again');
    }
    await rm(filename);
    return true;
  }
  private async remote(endpoint: string, body?: unknown) {
    const response = await fetch(this.backend + '/studio/internal' + endpoint, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(await gitDraftHeaders(this.root)),
        'x-studio-token': this.token ?? '',
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error('Storage inspection or cleanup failed. Refresh and try again.');
    }
    return record(await response.json());
  }
}
async function namesIn(directory: string) {
  try {
    const names = await readdir(directory);
    if (names.length > 2000) {
      throw new Error('Storage inventory exceeds inspection limit');
    }
    return names;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
function parseBaseline(value: unknown): AssetBaseline {
  const data = record(value);
  const entries = data['assets'];
  const sha = string(data['sha'], 40);
  if (!/^[a-f0-9]{40}$/.test(sha) || !Array.isArray(entries) || entries.length > 100_000) {
    throw new Error('Invalid published asset inventory');
  }
  const assets = new Map<string, string>();
  for (const input of entries) {
    const item = record(input);
    const file = filePath(item['file']);
    const hash = string(item['sha'], 40);
    if (!/^(src|public)\//.test(file) || !/^[a-f0-9]{40}$/.test(hash)) {
      throw new Error('Invalid published asset');
    }
    assets.set(file, hash);
  }
  return { sha, assets };
}
