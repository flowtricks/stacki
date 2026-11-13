import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { described, type Described } from '../../shared/properties/i18n/messageRef';

// Git listings are structured data, not logs. Bound records and queued chunks separately.
export const PUBLISH_RECORD_LIMITS = {
  recordBytesMax: 16_384,
  chunkBytesMax: 1_048_576,
  chunksMax: 1_000_000,
  recordsMax: 100_000,
  timeoutMs: 600_000,
  diagnosticsBytesMax: 1_048_576,
} as const;

export class PublishRecords {
  private pending = Buffer.alloc(0);
  private count = 0;

  accept(input: unknown): Result<readonly string[]> {
    assert(this.pending.length <= PUBLISH_RECORD_LIMITS.recordBytesMax, 'Pending record is bounded');
    assert(this.count <= PUBLISH_RECORD_LIMITS.recordsMax, 'Accepted record count is bounded');
    if (!Buffer.isBuffer(input) || input.length > PUBLISH_RECORD_LIMITS.chunkBytesMax) {
      return err({ code: 'git-output', ...described('publish.git.error.invalidChunk') });
    }
    const bytes = Buffer.concat([this.pending, input]);
    const records: string[] = [];
    let start = 0;
    for (let index = 0; index < bytes.length; index++) {
      if (index - start > PUBLISH_RECORD_LIMITS.recordBytesMax) {
        return err({ code: 'git-output', ...described('publish.git.error.recordTooLarge') });
      }
      if (bytes[index] === 0) {
        if (this.count === PUBLISH_RECORD_LIMITS.recordsMax) {
          return err({
            code: 'git-limit',
            ...described('error.publish.sourceFileLimit'),
          });
        }
        const decoded = decodeRecord(bytes.subarray(start, index));
        if (!decoded.ok) {
          return decoded;
        }
        records.push(decoded.value);
        this.count += 1;
        start = index + 1;
      }
    }
    if (bytes.length - start > PUBLISH_RECORD_LIMITS.recordBytesMax) {
      return err({ code: 'git-output', ...described('publish.git.error.recordTooLarge') });
    }
    // Copy the suffix so a short partial record cannot retain the entire input chunk.
    this.pending = Buffer.from(bytes.subarray(start));
    return ok(records);
  }

  finish(): Result<void> {
    return this.pending.length === 0 ? ok(undefined) : err({ code: 'git-output', ...described('publish.git.error.incompleteListing') });
  }
}

/** The host supplies PATH; await each visitor so filesystem work cannot build a queue. */
export async function readPublishRecords(
  root: string,
  argumentsList: readonly string[],
  environment: NodeJS.ProcessEnv,
  visit: (record: string) => Promise<Result<void>>,
): Promise<Result<void>> {
  const child = spawn('git', [...argumentsList], {
    cwd: root,
    env: environment,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const monitor = monitorPublishRecords(child);
  const records = new PublishRecords();
  try {
    for await (const chunk of readPublishChunks(child.stdout)) {
      if (!chunk.ok) {
        return chunk;
      }
      const decoded = records.accept(chunk.value);
      if (!decoded.ok) {
        return decoded;
      }
      for (const record of decoded.value) {
        const failure = monitor.failure();
        if (!failure.ok) {
          return failure;
        }
        const visited = await visit(record);
        if (!visited.ok) {
          return visited;
        }
      }
    }
    const completed = await monitor.completion;
    const failure = monitor.failure();
    if (!failure.ok) {
      return failure;
    }
    return completed.ok ? records.finish() : completed;
  } finally {
    child.stdout.destroy();
    await monitor.dispose();
  }
}

function monitorPublishRecords(child: Pick<ChildProcess, 'once' | 'kill'> & { readonly stderr: Readable }) {
  let failure: Result<void> = ok(undefined);
  let diagnosticsBytes = 0;
  const stop = (problem: Described) => {
    if (failure.ok) {
      failure = err({ code: 'git-output', ...problem });
    }
    child.kill('SIGKILL');
  };
  const completion = new Promise<Result<void>>((resolve) => {
    child.once('error', () => resolve(err({ code: 'git-start', ...described('publish.git.error.startFailed') })));
    child.once('close', (code) => resolve(code === 0 ? ok(undefined) : err({ code: 'git-exit', ...described('publish.git.error.listingFailed') })));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    diagnosticsBytes += chunk.length;
    if (diagnosticsBytes > PUBLISH_RECORD_LIMITS.diagnosticsBytesMax) {
      stop(described('publish.git.error.diagnosticsLimit'));
    }
  });
  const timer = setTimeout(() => stop(described('publish.git.error.timeLimit')), PUBLISH_RECORD_LIMITS.timeoutMs);
  return {
    completion,
    failure: () => failure,
    dispose: async () => {
      child.kill('SIGKILL');
      await completion;
      clearTimeout(timer);
    },
  };
}

async function* readPublishChunks(stream: Readable): AsyncGenerator<Result<unknown>> {
  const iterator = stream[Symbol.asyncIterator]();
  for (let count = 0; count < PUBLISH_RECORD_LIMITS.chunksMax; count++) {
    // Catch only pipe I/O. Assertions and visitor errors never pass through this adapter.
    const next = await iterator.next().then(ok, () => err({ code: 'git-output', ...described('publish.git.error.listingUnreadable') }));
    if (!next.ok) {
      yield next;
      return;
    }
    if (next.value.done) {
      return;
    }
    const value: unknown = next.value.value;
    yield ok(value);
  }
  yield err({ code: 'git-output', ...described('publish.git.error.chunkLimit') });
}

function decodeRecord(bytes: Buffer): Result<string> {
  if (bytes.length === 0) {
    return err({ code: 'git-output', ...described('publish.git.error.emptyRecord') });
  }
  try {
    return ok(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return err({ code: 'git-output', ...described('publish.git.error.badFilename') });
  }
}
