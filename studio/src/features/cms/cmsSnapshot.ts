import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { walk, safePath } from '../project/projectServer';
import type { createRooms } from '../collaboration/rooms';
import { batchedRead } from '../../shared/batchedRead';
import { sourcePath, string } from '../../shared/validation';
import { stopServiceAndWait } from '../../../vendor/stacki/electron/content/contentConfig';
import { createHash } from 'node:crypto';
import { SerialQueue } from '../../shared/serialQueue';

export const CMS_SOURCE = /\.(astro|json|md|mdx|mdoc|markdown|css|[cm]?[jt]sx?|yaml|yml|toml|csv|ndjson)$/i;
export async function cmsSources(root: string, rooms?: ReturnType<typeof createRooms>) {
  const paths = [...(await walk(root, 'src')), ...(await walk(root, 'public'))];
  if (paths.length > 2000) {
    throw new Error('CMS scan exceeds 2,000 files');
  }
  let size = 0;
  const entries = await batchedRead(
    paths.filter((file) => CMS_SOURCE.test(file)),
    async (file) => {
      sourcePath(file);
      const source = rooms ? await rooms.read(file) : string(await readFile(await safePath(root, file), 'utf8'));
      size += Buffer.byteLength(source);
      if (size > 32_000_000) {
        throw new Error('CMS scan exceeds 32 MB');
      }
      return [file, source] as const;
    },
  );
  const configuration = await cmsConfiguration(root);
  return { sources: new Map(entries), paths, configuration };
}

// Read-only panel requests share one immutable staging directory. Keeping its path
// stable also lets Desktop's content engine reuse its compiled configuration.
export class CmsReadWorkspace {
  private readonly queue = new SerialQueue();
  private current: { readonly directory: string; readonly signature: string } | undefined;
  private closed = false;
  constructor(private readonly root: string) {}
  read<T>(snapshot: Awaited<ReturnType<typeof cmsSources>>, run: (stage: string) => Promise<T>) {
    return this.queue.run(async () => {
      if (this.closed) {
        throw new Error('The collection workspace has closed.');
      }
      const signature = cmsSignature(snapshot);
      if (this.current?.signature !== signature) {
        await this.dispose();
        const directory = await mkdtemp(path.join(tmpdir(), 'studio-cms-read-'));
        this.current = { directory, signature };
        try {
          await stageSources(this.root, directory, snapshot);
        } catch (error: unknown) {
          await this.dispose();
          throw error;
        }
      }
      return run(this.current.directory);
    });
  }
  close() {
    this.closed = true;
    return this.queue.run(() => this.dispose());
  }
  private async dispose() {
    const current = this.current;
    this.current = undefined;
    if (current) {
      await stopServiceAndWait(current.directory);
      await rm(current.directory, { recursive: true, force: true });
    }
  }
}

function cmsSignature(snapshot: Awaited<ReturnType<typeof cmsSources>>) {
  const digest = createHash('sha256');
  for (const file of [...snapshot.paths].sort()) {
    digest.update(JSON.stringify([file, snapshot.sources.get(file)]));
  }
  digest.update(JSON.stringify(snapshot.configuration));
  return digest.digest('hex');
}

async function cmsConfiguration(root: string) {
  const entries: (readonly [string, string])[] = [];
  for (const file of ['package.json', 'tsconfig.json', 'jsconfig.json']) {
    try {
      entries.push([file, string(await readFile(path.join(root, file), 'utf8'))]);
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
  }
  return entries;
}
export async function withCmsSnapshot<T>(root: string, snapshot: Awaited<ReturnType<typeof cmsSources>>, run: (stage: string) => Promise<T>) {
  const stage = await mkdtemp(path.join(tmpdir(), 'studio-cms-'));
  try {
    await stageSources(root, stage, snapshot);
    return await run(stage);
  } finally {
    await stopServiceAndWait(stage);
    await rm(stage, { recursive: true, force: true });
  }
}
async function stageSources(root: string, stage: string, snapshot: Awaited<ReturnType<typeof cmsSources>>) {
  await symlink(path.join(root, 'node_modules'), path.join(stage, 'node_modules'), 'dir');
  for (const [file, source] of snapshot.configuration) {
    await writeFile(path.join(stage, file), source);
  }
  // Asset placeholders allow import resolution without copying binary uploads.
  await batchedRead(snapshot.paths, async (file) => {
    const destination = await safePath(stage, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, snapshot.sources.get(file) ?? '');
  });
}
