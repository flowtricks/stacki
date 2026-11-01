// What a document host answers with and is built from: write and edit
// reports, an edit's base, statement and plan, the disk it reads, its options,
// and the state and errors of a current read (documentActors.ts).

import { type Digest } from '../../shared/core/brand';
import { type Planner, type Projector, type Reconciliation } from '../../shared/engine/documentActor';
import { type Intent, type RejectionReason, type SourceEdit } from '../../shared/engine/intent';
import type { Snapshot } from '../../shared/page/snapshot';
import { type ByteString } from '../../shared/core/span';
import { NodeDocumentDisk } from './documentDisk';
import { type DocumentTelemetry } from './documentTelemetry';

/** What one write came to, for the IPC layer to report. */
export type WriteReport =
  /** `inverse` restores what the write replaced, in the bytes it left (Undo of
   * a Markdown page's whole save, step 9): the replacement's changed region
   * only. Empty for a file the write created. */
  | { readonly tag: 'applied'; readonly checksum: Digest; readonly inverse: readonly SourceEdit[] }
  | {
      readonly tag: 'rejected';
      readonly reason: RejectionReason;
      readonly message: string;
      /** The bytes on disk now, when the rejection is about them. */
      readonly diskChecksum: Digest | undefined;
    }
  | {
      readonly tag: 'uncertain';
      readonly message: string;
      readonly candidateChecksum: Digest | undefined;
      /** Reconciled at once by comparing checksums (plan §3.5); undefined when
       * the file cannot even be read to compare. */
      readonly reconciliation: Reconciliation | undefined;
    }
  | { readonly tag: 'backpressured' };

/** What a visual edit came to (step 6): an applied one hands back the bytes
 * it left and the inverse Undo submits, against the returned checksum. */
export type EditReport =
  | {
      readonly tag: 'applied';
      readonly checksum: Digest;
      readonly bytes: ByteString;
      readonly inverse: readonly SourceEdit[];
    }
  | Exclude<WriteReport, { readonly tag: 'applied' }>;

/** The anchor and operation of an intent, built against the snapshot it names;
 * the host adds the id, the file and the checksum. */
export type IntentDraft = Pick<Intent, 'anchor' | 'operation'>;

/** What an edit is built against (step 6). `history` says what lies between
 * the bytes it was authored against and the bytes on disk now: nothing, only
 * this actor's own commits (which it can rebase through exactly), or a write
 * from outside. */
export interface EditBase {
  readonly authored: Snapshot;
  readonly current: Snapshot;
  readonly history: 'unchanged' | 'own-commits' | 'outside';
}

/** What an edit request states besides its content: the checksum it was
 * authored against, and the reason to refuse it with when the host no longer
 * holds those bytes — a node reference can no longer be found (`anchor-moved`),
 * a code patch can no longer be merged (`merge-conflict`). */
export interface EditStatement {
  readonly authoredChecksum: Digest;
  readonly gone: RejectionReason;
}

/** A built edit, and which of the two snapshots it names. An edit that states
 * a whole region's new content (the frontmatter the model now describes) is
 * built against the current bytes when only the app's own commits came
 * between: the model that stated it already holds what they did. */
export interface BuiltEdit {
  readonly draft: IntentDraft;
  readonly basis: 'authored' | 'current';
}

export type HostDisk = Pick<NodeDocumentDisk, 'read' | 'lock' | 'unlock' | 'replace' | 'create' | 'canonical'>;

export interface DocumentActorsOptions {
  readonly disk: HostDisk;
  readonly projector: Projector;
  readonly planner: Planner;
  readonly telemetry: DocumentTelemetry;
  /** `immediate` in the app: each submission is stepped to its outcome at
   * once. `deferred` leaves it queued until `drain` — tests use it to fill a
   * queue and see backpressure. */
  readonly drain: 'immediate' | 'deferred';
  /** Runs `task` soon, off the current call: the watcher-tick refresh. */
  readonly schedule: (task: () => void) => void;
  /** Observes each lease as it is taken, in order (tests pin the order). */
  readonly onLease?: (file: string) => void;
}

export interface DiskState {
  readonly checksum: Digest;
  readonly bytes: ByteString;
}

export interface CurrentError {
  readonly code: 'missing' | 'failed';
  readonly message: string;
}
