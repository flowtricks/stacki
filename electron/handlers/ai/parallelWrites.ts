// Which files each running reply of a project writes, so replies that run at the same time (a chat's reply and one or
// more sends of pins) keep their reviews apart.
//
// Why: a reply's ledger reads the git tree when it starts and when it ends (changeLedger.ts), so what another reply
// changed meanwhile is in that difference too. Listed as this reply's, its "Undo" would put back the other's work.
// So while replies overlap, each hears which files the others' tool calls write, and the ledger then:
//   leaves out a file only another reply wrote;
//   keeps, but will not undo, a file both wrote, and a file no tool call of this reply named (a shell command made
//   the change: which reply's it was cannot be known).
// A reply that ran alone is tracked as before.
//
// Bounds: one entry per running reply (the host runs one per chat), each holding at most `ledgerFilesMax` paths per set.
import { assert } from '../../../shared/core/assert';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';

/** What one running reply knows about its own writes and the others'. */
export interface TurnWrites {
  /** Project-relative paths this reply's tool calls said they write. */
  readonly written: ReadonlySet<string>;
  /** Paths written by replies that ran while this one did. */
  readonly foreign: ReadonlySet<string>;
  /** Whether any other reply of the project ran while this one did. */
  readonly overlapped: boolean;
}

interface Running {
  readonly root: string;
  readonly written: Set<string>;
  readonly foreign: Set<string>;
  overlapped: boolean;
}

function note(paths: Set<string>, path: string): void {
  if (paths.size < AI_LIMITS.ledgerFilesMax) {
    paths.add(path);
  }
  assert(paths.size <= AI_LIMITS.ledgerFilesMax, 'parallelWrites: the paths of a reply are bounded');
}

export class ParallelWrites {
  private readonly running = new Set<Running>();

  /** A reply of the project starts: it and every reply of the project already running now overlap. */
  join(root: string): TurnWrites {
    const joined: Running = { root, written: new Set(), foreign: new Set(), overlapped: false };
    for (const other of this.running) {
      if (other.root === root) {
        other.overlapped = true;
        joined.overlapped = true;
        for (const path of other.written) {
          note(joined.foreign, path);
        }
      }
    }
    this.running.add(joined);
    return joined;
  }

  /** `writes`'s reply is about to write `path`: every reply running beside it hears. */
  wrote(writes: TurnWrites, path: string): void {
    for (const own of this.running) {
      if (own !== writes) {
        continue;
      }
      note(own.written, path);
      for (const other of this.running) {
        if (other !== own && other.root === own.root) {
          note(other.foreign, path);
        }
      }
    }
  }

  /** The reply ended: replies that start later do not overlap it. What it already told the others stays with them. */
  leave(writes: TurnWrites): void {
    for (const own of this.running) {
      if (own === writes) {
        this.running.delete(own);
      }
    }
  }
}
