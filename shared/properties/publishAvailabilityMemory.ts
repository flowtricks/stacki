import { assert } from '../core/assert';
import { UNKNOWN_PUBLISH_AVAILABILITY, type PublishAvailability, type PublishDestinationState } from './publishState';

// Why this exists: the Publish button used to render whatever the latest check said, and every
// file event first reset that to "unknown", which the button draws as ready (accent, enabled).
// A burst of events therefore flashed blue and settled back to grey when the check came in.
// Here a check only ever *replaces* what is shown once it has answered, so "I am still asking"
// never reaches the screen.

/**
 * What the button remembers between checks. `confirmed` is the last answer a check gave, per
 * destination; `held` is a clean-to-pending answer waiting for a second check to agree.
 */
export interface PublishAvailabilityMemory {
  readonly confirmed: PublishAvailability | undefined;
  readonly held: PublishAvailability | undefined;
}

export type PublishAvailabilityEvent =
  /** A check answered. Destinations it could not judge arrive as `unknown`. */
  | { readonly kind: 'checked'; readonly result: PublishAvailability }
  /** A check failed, which proves nothing about either destination. */
  | { readonly kind: 'failed' };

export const EMPTY_PUBLISH_AVAILABILITY_MEMORY: PublishAvailabilityMemory = { confirmed: undefined, held: undefined };

/**
 * How long a clean-to-pending answer waits for its confirming check. Short enough that a real
 * edit still shows within a moment of the first answer; long enough to outlast a tool that
 * writes a file and rewrites it straight away.
 */
export const PUBLISH_CONFIRM_DELAY_MS = 250;

export function reducePublishAvailability(memory: PublishAvailabilityMemory, event: PublishAvailabilityEvent): PublishAvailabilityMemory {
  switch (event.kind) {
    case 'failed':
      return memory;
    case 'checked':
      return reduceChecked(memory, event.result);
  }
}

/** What to draw: the last confirmed answer, or the neutral unknown before any check has answered. */
export function shownPublishAvailability(memory: PublishAvailabilityMemory): PublishAvailability {
  return memory.confirmed ?? UNKNOWN_PUBLISH_AVAILABILITY;
}

function reduceChecked(memory: PublishAvailabilityMemory, result: PublishAvailability): PublishAvailabilityMemory {
  const merged = mergeConfirmed(memory.confirmed, result);
  const previous = memory.confirmed;
  if (previous === undefined) {
    return { confirmed: merged, held: undefined };
  }
  if (flipsToPending(previous, merged)) {
    if (memory.held === undefined) {
      // The first answer that says "changes" after "nothing": ask once more before showing it.
      return { confirmed: previous, held: merged };
    }
    assert(flipsToPending(previous, memory.held), 'A held answer is always a flip to pending');
  }
  return { confirmed: merged, held: undefined };
}

// A destination the check could not judge keeps its last confirmed state; one it judged replaces it.
function mergeConfirmed(previous: PublishAvailability | undefined, result: PublishAvailability): PublishAvailability {
  const github = result.github === 'unknown' ? (previous?.github ?? 'unknown') : result.github;
  const hosting = keepUnknown(previous?.hosting, result.hosting);
  const githubPush = result.github === 'unknown' ? previous?.githubPush : result.githubPush;
  const staging = mergeStaging(previous?.staging, result.staging);
  const { hostingPublishedAtMs } = result;
  return {
    github,
    hosting,
    ...(githubPush === undefined ? {} : { githubPush }),
    ...(hostingPublishedAtMs === undefined ? {} : { hostingPublishedAtMs }),
    ...(staging === undefined ? {} : { staging }),
  };
}

// Absent means the project has no staging, which replaces what was shown; unjudged keeps what was confirmed.
function mergeStaging(previous: PublishAvailability['staging'], next: PublishAvailability['staging']): PublishAvailability['staging'] {
  if (next?.state !== 'unknown') {
    return next;
  }
  const shown = previous ?? next;
  assert(next.state === 'unknown', 'Only an unjudged check keeps what was shown');
  return shown;
}

function keepUnknown(previous: PublishDestinationState | undefined, next: PublishDestinationState): PublishDestinationState {
  return next === 'unknown' ? (previous ?? 'unknown') : next;
}

function flipsToPending(previous: PublishAvailability, next: PublishAvailability): boolean {
  if (previous.github === 'current') {
    if (next.github === 'pending') {
      return true;
    }
  }
  if (previous.hosting === 'current') {
    if (next.hosting === 'pending') {
      return true;
    }
  }
  if (previous.staging?.state === 'current') {
    if (next.staging?.state === 'pending') {
      return true;
    }
  }
  return false;
}

/** How long a burst of file events must stay quiet before one check is asked for. */
export const PUBLISH_EVENT_QUIET_MS = 200;

const GENERATED_SEGMENTS: readonly (readonly string[])[] = [['node_modules'], ['.astro'], ['.stacki', 'preview']];
const EDITOR_TEMPORARY = /(^\.DS_Store$|~$|^\.#|^#.*#$|\.sw[a-p]$|^4913$|\.tmp$)/;

/**
 * Whether a change can alter what Publish would send. Generated trees and editor scratch files
 * never can, so they must not trigger a check at all. An empty list means the producer did not
 * say which files changed, which has to count as relevant.
 */
export function publishRelevantChange(files: readonly string[]): boolean {
  if (files.length === 0) {
    return true;
  }
  return files.some((file) => !publishIrrelevantFile(file));
}

function publishIrrelevantFile(file: string): boolean {
  const segments = file.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const name = segments[segments.length - 1];
  if (name !== undefined) {
    if (EDITOR_TEMPORARY.test(name)) {
      return true;
    }
  }
  return GENERATED_SEGMENTS.some((generated) => containsRun(segments, generated));
}

function containsRun(segments: readonly string[], run: readonly string[]): boolean {
  for (let start = 0; start + run.length <= segments.length; start += 1) {
    if (run.every((segment, offset) => segments[start + offset] === segment)) {
      return true;
    }
  }
  return false;
}
