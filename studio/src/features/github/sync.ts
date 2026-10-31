import { readGitWorkspace } from '../history/gitWorkspaceStorage';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { RepositoryAccess, IncomingFile } from './github';
import type { createRooms } from '../collaboration/rooms';
import { readSource, safePath } from '../project/projectServer';
import { changeFiles, type FileChange } from '../project/changeFiles';
import { record, string } from '../../shared/validation';
import { mergeSource } from './merge';

export type SyncState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'synced'; readonly sha: string }
  | { readonly kind: 'conflict'; readonly sha: string; readonly files: readonly string[] }
  | { readonly kind: 'failed'; readonly message: string };
export class RepositorySync {
  state: SyncState = { kind: 'idle' };
  private pending: Promise<SyncState> | undefined;
  constructor(
    readonly root: string,
    readonly repository: RepositoryAccess | undefined,
    readonly rooms: ReturnType<typeof createRooms>,
  ) {}
  sync(resolution?: { readonly sha: string; readonly side: 'draft' | 'github' }) {
    return this.pending ?? this.begin(resolution);
  }
  async latest() {
    await this.pending;
    const state = await (this.pending ?? this.begin(undefined, true));
    if (state.kind === 'failed') {
      throw new Error(state.message);
    }
    return state;
  }
  private begin(
    resolution?: { readonly sha: string; readonly side: 'draft' | 'github' },
    preferDraft = false,
  ) {
    const pending = this.run(resolution, preferDraft);
    this.pending = pending;
    void pending.finally(() => {
      this.pending = undefined;
    });
    return pending;
  }
  private async run(
    resolution?: { readonly sha: string; readonly side: 'draft' | 'github' },
    preferDraft = false,
  ): Promise<SyncState> {
    if (!this.repository) {
      return this.state;
    }
    if (await readGitWorkspace(this.root)) {
      // Explicit Git pulls own merging once local commits/branches exist.
      return this.state;
    }
    this.state = { kind: 'checking' };
    try {
      const repository = this.repository;
      const base = await this.baseline();
      const incoming = await repository.incoming(base);
      if (incoming.sha === base && !incoming.files.length) {
        this.state = { kind: 'synced', sha: base };
        return this.state;
      }
      if (resolution && resolution.sha !== incoming.sha) {
        throw new Error('GitHub changed again. Review the new conflicts before resolving.');
      }
      await this.rooms.coordinator.run(async () => {
        await this.rooms.persist();
        if ((await this.baseline()) !== base) {
          throw new Error('Published revision changed during sync. Try again.');
        }
        const planned = await Promise.all(
          incoming.files.map((change) =>
            this.plan(change, resolution?.side ?? (preferDraft ? 'draft' : undefined)),
          ),
        );
        const conflicts = planned
          .filter((item) => item.kind === 'conflict')
          .map((item) => item.file);
        if (conflicts.length) {
          this.state = { kind: 'conflict', sha: incoming.sha, files: conflicts };
          return;
        }
        const changes: FileChange[] = [];
        const deleted: string[] = [];
        for (const item of planned) {
          if (item.kind === 'write') {
            changes.push({ file: item.file, source: item.source });
          }
          if (item.kind === 'delete') {
            deleted.push(item.file);
          }
        }
        await changeFiles(this.root, this.rooms, changes);
        for (const file of deleted) {
          await this.rooms.remove(file);
          await rm(await safePath(this.root, file), { force: true });
        }
        await repository.acceptBase(incoming.sha);
        await this.writeBaseline(incoming.sha);
        this.state = { kind: 'synced', sha: incoming.sha };
        if (incoming.files.length) {
          this.rooms.projectChanged();
        }
      });
    } catch (error) {
      this.state = {
        kind: 'failed',
        message: error instanceof Error ? error.message : 'GitHub sync failed',
      };
    }
    return this.state;
  }
  private async plan(change: IncomingFile, side?: 'draft' | 'github') {
    let local: string | null = null;
    try {
      local = await readSource(this.root, change.file);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    if (change.after === null) {
      if (local !== null && local !== change.before && side === 'draft') {
        return { kind: 'write' as const, file: change.file, source: local };
      }
      return {
        kind:
          local === null || local === change.before || side === 'github'
            ? ('delete' as const)
            : ('conflict' as const),
        file: change.file,
      };
    }
    if (change.before !== null && local === null) {
      if (side === 'draft') {
        return { kind: 'delete' as const, file: change.file };
      }
      if (side === 'github') {
        return { kind: 'write' as const, file: change.file, source: change.after };
      }
      return { kind: 'conflict' as const, file: change.file };
    }
    const merged = await mergeSource(
      change.before ?? '',
      local ?? '',
      change.after,
      side === 'draft',
    );
    if (merged.kind === 'merged') {
      return { kind: 'write' as const, file: change.file, source: merged.source };
    }
    if (side) {
      return {
        kind: 'write' as const,
        file: change.file,
        source: side === 'github' ? change.after : (local ?? ''),
      };
    }
    return { kind: 'conflict' as const, file: change.file };
  }
  private async baseline() {
    return string(
      record(
        JSON.parse(
          await readFile(path.join(this.root, '.stacki/studio/state/github-base.json'), 'utf8'),
        ),
      )['sha'],
      64,
    );
  }
  private async writeBaseline(sha: string) {
    await mkdir(path.join(this.root, '.stacki/studio/state'), { recursive: true });
    await writeFile(
      path.join(this.root, '.stacki/studio/state/github-base.json'),
      JSON.stringify({ sha }),
    );
  }
}
