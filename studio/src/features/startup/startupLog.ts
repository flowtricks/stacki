// The Durable Object's memory of one cold start: the first time each stage began. Pure and
// bounded (one entry per stage), so the Worker route stays trivial and a test can drive it.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { STARTUP_STAGES, stageIndex, type StartupEntry, type StartupStage, type StartupView } from './startupStages';

/**
 * A report from the same process can arrive late, but never later than its own five-second time
 * limit (startupReporter.ts). A clock that is further behind than this is a new process.
 */
export const NEW_PROCESS_MARGIN_MS = 10_000;

/**
 * What the Durable Object knows about the container's process: not running, running but its
 * port does not answer yet, or answering. A Durable Object that was evicted while the container
 * kept running has an empty log; an answering port then means the preview server is up.
 */
export type ContainerPhase = 'stopped' | 'starting' | 'serving';

export class StartupLog {
  private entries: StartupEntry[] = [];

  /** A new container process begins its own history. */
  reset(): void {
    this.entries = [];
  }

  /**
   * Keeps the first report of a stage and ignores a stage that is not later than the last one:
   * reports travel as separate requests, so one can arrive after a later one. A report whose
   * clock is far earlier than the last one's comes from a new container process: its history starts over.
   */
  record(entry: StartupEntry): void {
    const previous = this.entries[this.entries.length - 1];
    if (previous !== undefined && previous.sinceStartMs - entry.sinceStartMs > NEW_PROCESS_MARGIN_MS) {
      this.reset();
    }
    const last = this.entries[this.entries.length - 1];
    if (last !== undefined && stageIndex(entry.stage) <= stageIndex(last.stage)) {
      return;
    }
    this.entries.push(entry);
    assert(this.entries.length <= STARTUP_STAGES.length, 'A start has at most one entry per stage');
  }

  /** `container` until the process is up and has said something; then the latest stage it reported. */
  view(phase: ContainerPhase): StartupView {
    const last = this.entries[this.entries.length - 1];
    let stage: StartupStage = 'container';
    if (phase === 'serving') {
      stage = last === undefined ? 'ready' : last.stage;
    } else if (phase === 'starting' && last !== undefined) {
      stage = last.stage;
    }
    assert(STARTUP_STAGES.includes(stage), 'The view names a known stage');
    return { stage, history: phase === 'stopped' ? [] : [...this.entries] };
  }
}
