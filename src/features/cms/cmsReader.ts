import type { Result } from '../../../shared/core/result';
import type { Collection } from './cmsSchema';
import type { DeclaredTypes } from './cmsTypes';
import type { createCmsWriter } from './cmsWriter';
import { collectionOf } from './cmsSchema';
import { readCms, readCmsMeta } from './cmsBridge';
import { assert } from '../../../shared/core/assert';
import { createCoalescedRun } from '../../lib/coalescedRun';

export interface CmsSnapshot {
  readonly collection: Collection;
  readonly items: readonly unknown[];
  readonly declared: DeclaredTypes;
}
interface ReaderOptions {
  readonly projectPath: string;
  readonly rel: string;
  readonly writer: ReturnType<typeof createCmsWriter>;
  readonly publish: (result: Result<CmsSnapshot, string>) => void;
  readonly report: (message: string) => void;
}
type ReadState = { readonly kind: 'open' | 'disposed' };

export function createCmsReader(options: ReaderOptions) {
  return new CmsReader(options);
}
export function cmsCollection(rel: string, data: unknown, error?: string): Collection {
  const slash = rel.lastIndexOf('/');
  const file = {
    rel,
    name: collectionName(rel.slice(slash + 1)),
    dir: slash < 0 ? '' : rel.slice(0, slash),
  };
  return error === undefined ? collectionOf({ ...file, data }) : collectionOf({ ...file, error });
}

// The name a collection goes by, as the panel shows it. One inside a source file
// is addressed as `consts.ts#CAMPUSES`, and a file's single values as
// `consts.ts#*general`; neither address is a name. The single values go by
// the file's own name.
function collectionName(file: string): string {
  const hash = file.indexOf('#');
  if (hash === -1) {
    return file;
  }
  const inside = file.slice(hash + 1);
  return inside === '*general' ? file.slice(0, hash) : inside;
}

// One active read and one pending refresh bound watcher bursts
// (src/lib/coalescedRun.ts: a burst costs at most two reads). The writer's
// revision prevents a read that started before an edit from replacing that edit.
class CmsReader {
  private state: ReadState = { kind: 'open' };
  private readonly reads = createCoalescedRun(() => this.flushThenRead());
  constructor(private readonly options: ReaderOptions) {}
  refresh(): Promise<void> {
    if (this.state.kind === 'disposed') {
      return Promise.resolve();
    }
    assert(this.state.kind === 'open', 'CMS read: an open reader reads');
    return this.reads.request();
  }
  dispose(): void {
    this.state = { kind: 'disposed' };
  }
  private disposed(): boolean {
    return this.state.kind === 'disposed';
  }
  // One tick: unsaved edits reach disk first — a failed save is never replaced
  // by a reload — then one read.
  private async flushThenRead(): Promise<void> {
    if (this.disposed()) {
      return;
    }
    if (!(await this.options.writer.flush())) {
      return;
    }
    if (this.disposed()) {
      return;
    }
    await this.read();
  }
  private async read(): Promise<void> {
    const { writer, projectPath, rel, publish, report } = this.options;
    const revision = writer.revision();
    const [content, metadata] = await Promise.all([
      readCms(projectPath, rel),
      readCmsMeta(projectPath),
    ]);
    if (this.disposed()) {
      return;
    }
    if (revision !== writer.revision()) {
      return;
    }
    if (!content.ok) {
      publish(content);
      return;
    }
    const collection = cmsCollection(rel, content.value.data);
    writer.accept(collection, content.value.data);
    if (!metadata.ok) {
      report(metadata.error);
    }
    publish({
      ok: true,
      value: {
        collection,
        items: collection.items,
        declared: metadata.ok ? (metadata.value.meta[rel] ?? {}) : {},
      },
    });
  }
}
