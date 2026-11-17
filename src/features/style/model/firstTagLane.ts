// The one `<style>` tag a page's first styles create, however fast those styles arrive.
//
// A page with no tag of its own gets one on its first style (firstStyleBlock.ts, newStyleTarget.ts).
// Deciding that takes the panel's scan of the page's style sources, and the scan learns about the
// new tag only after the host has added it and the panel has read the page again. Everything that
// arrived in between used to decide from the old scan, find no tag, and create one of its own: a
// Shift-drag of a padding band commits four sides in one event, and made four tags; a second drag
// while the first save was still on its way to disk made another.
//
// The lane is the panel's memory of the tag it is creating, per open file. The first write that
// needs the tag opens it; every write that arrives before the scan shows the tag joins it instead
// of planning again. Writes joined in the same event as the first one go into the new tag with it,
// so the tag and all of them are one host edit and one undo step. Writes joined while the tag is
// saving wait, one per selector and property (the last value wins, as the last frame of a drag
// does), and are written into the tag once the scan shows it, through the panel's ordinary path,
// which merges into the rule by selector rather than adding another. Pure state, no React: the
// hook owns one lane (useEditorResolution.ts useCreateRule) and drives it.

import { assert } from '../../../../shared/core/assert';

/** One property write, as the panel makes it (embed/EditorBasics.tsx PropWrite). */
export type LaneWrite = { readonly prop: string; readonly value: string; readonly important: boolean };

/** Writes for one selector, in the order their properties were first written. */
export type LaneBatch = { readonly selector: string; readonly writes: readonly LaneWrite[] };

/** What a scan means for the lane: still waiting for the tag, or the writes to make now. */
export type LaneScanOutcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'waiting' }
  | {
      readonly kind: 'drain';
      /** The new tag's document key, when the scan showed it; undefined when the lane stopped waiting for it. */
      readonly tagKey: string | undefined;
      readonly batches: readonly LaneBatch[];
    };

/**
 * How many scans may pass after the tag was saved without showing it before the lane lets go.
 * The scan that was already running when the save landed predates the tag, and a rescan the
 * change starts can be overtaken by one more; past a handful the page has moved on (the tag was
 * undone, the file changed under it) and the writes go the ordinary way rather than waiting for a
 * tag that is not coming. A count of scans, not a time: a big project's slow scan is never cut off.
 */
export const LANE_SCANS_WITHOUT_TAG_MAX = 8;

type Phase = 'collecting' | 'writing' | 'landed';

type Lane = {
  readonly filePath: string;
  /** The selector the first write asked for, and the selector its rule was created under (`.class` for a bare tag). */
  readonly requested: string;
  readonly selector: string;
  /** The style documents of this file the scan already showed when the lane opened. */
  readonly knownKeys: ReadonlySet<string>;
  phase: Phase;
  scansWithoutTag: number;
  /** One entry per selector and property: a later value replaces an earlier one. */
  readonly queue: Map<string, { readonly selector: string; readonly write: LaneWrite }>;
};

export class FirstTagLane {
  private lane: Lane | undefined = undefined;

  /** Whether a tag is being created for `filePath`. A lane for another file (the page changed) is dropped. */
  holds(filePath: string | undefined): boolean {
    const lane = this.lane;
    if (lane === undefined) {
      return false;
    }
    if (lane.filePath === filePath) {
      return true;
    }
    this.lane = undefined;
    return false;
  }

  /** The phase of the lane, for tests and assertions; undefined when no tag is being created. */
  phase(): Phase | undefined {
    return this.lane?.phase;
  }

  /** The first write that needs the tag opens the lane, before it joins it. */
  open(input: { readonly filePath: string; readonly requested: string; readonly selector: string; readonly knownKeys: Iterable<string> }): void {
    assert(this.lane === undefined, 'FirstTagLane.open: one tag is created at a time');
    assert(input.selector.length > 0, 'FirstTagLane.open: the new rule has a selector');
    this.lane = {
      filePath: input.filePath,
      requested: input.requested,
      selector: input.selector,
      knownKeys: new Set(input.knownKeys),
      phase: 'collecting',
      scansWithoutTag: 0,
      queue: new Map(),
    };
  }

  /** A write that needs the tag: it goes in with the tag, or waits for it. The first write's selector maps to its rule's. */
  join(requested: string, write: LaneWrite): void {
    const lane = this.lane;
    assert(lane !== undefined, 'FirstTagLane.join: a lane is open');
    assert(write.prop.length > 0, 'FirstTagLane.join: a write names a property');
    const selector = requested === lane.requested ? lane.selector : requested;
    const key = `${selector}\u0000${write.prop}`;
    // Deleted first, so a property written again moves to the end and the order stays the order of the last writes.
    lane.queue.delete(key);
    lane.queue.set(key, { selector, write });
  }

  /** The writes that go into the new tag itself: the first selector's, joined in the event that opened the lane. */
  takeFirstWrites(): readonly LaneWrite[] {
    const lane = this.lane;
    assert(lane !== undefined, 'FirstTagLane.takeFirstWrites: a lane is open');
    assert(lane.phase === 'collecting', 'FirstTagLane.takeFirstWrites: taken once, before the tag is written');
    const writes: LaneWrite[] = [];
    for (const [key, entry] of lane.queue) {
      if (entry.selector === lane.selector) {
        writes.push(entry.write);
        lane.queue.delete(key);
      }
    }
    assert(writes.length > 0, 'FirstTagLane.takeFirstWrites: the opening write is among them');
    lane.phase = 'writing';
    return writes;
  }

  /** The tag's write finished. A failure lets go of the lane: what waited was for a tag that does not exist. */
  settle(outcome: 'written' | 'failed'): void {
    const lane = this.lane;
    if (lane === undefined) {
      return;
    }
    assert(lane.phase === 'writing', 'FirstTagLane.settle: only a tag being written settles');
    if (outcome === 'failed') {
      this.lane = undefined;
      return;
    }
    lane.phase = 'landed';
  }

  /**
   * A scan finished. `nodeKeys` are the keys of the `<style>` documents of `filePath` it shows.
   * Once one is new (the tag), or the scans have stopped looking for it, the lane lets go and hands
   * back the waiting writes, one batch per selector, for the panel's ordinary path.
   */
  afterScan(filePath: string | undefined, nodeKeys: readonly string[]): LaneScanOutcome {
    const lane = this.lane;
    if (lane === undefined || !this.holds(filePath)) {
      return { kind: 'idle' };
    }
    if (lane.phase !== 'landed') {
      return { kind: 'waiting' };
    }
    const tagKey = nodeKeys.find((key) => !lane.knownKeys.has(key));
    if (tagKey !== undefined) {
      return this.release(tagKey);
    }
    lane.scansWithoutTag += 1;
    if (lane.scansWithoutTag < LANE_SCANS_WITHOUT_TAG_MAX) {
      return { kind: 'waiting' };
    }
    return this.release(undefined);
  }

  private release(tagKey: string | undefined): LaneScanOutcome {
    const lane = this.lane;
    assert(lane !== undefined, 'FirstTagLane.release: a lane is open');
    this.lane = undefined;
    const bySelector = new Map<string, LaneWrite[]>();
    for (const entry of lane.queue.values()) {
      const writes = bySelector.get(entry.selector) ?? [];
      writes.push(entry.write);
      bySelector.set(entry.selector, writes);
    }
    const batches = [...bySelector].map(([selector, writes]) => ({ selector, writes }));
    assert(
      batches.reduce((total, batch) => total + batch.writes.length, 0) === lane.queue.size,
      'FirstTagLane.release: every waiting write is handed back once',
    );
    return { kind: 'drain', tagKey, batches };
  }
}
