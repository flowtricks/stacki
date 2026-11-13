// What the panel says about the agent's progress, as pure functions of a chat's view and a clock
// reading: the context ring's tone, the line under a running turn ("Running a command  1m 17s"),
// the one-line summary of a group of tool calls, and how a duration is written. Pure so the
// panels that draw them (composer, transcript) share one wording and the tests pin it.
//
// `now` is always passed in: nothing here reads the clock, so a test can fix time and a component
// can tick it once per second without recomputing anything else.
import { assert } from '../../../shared/core/assert';
import type { Formatters } from '../../../shared/core/i18n/format';
import type { ToolKindName } from '../../../shared/properties/ai/chatModel';
import type { MessageKey } from '../../../shared/properties/i18n/messageRef';
import type { Translator } from '../../lib/i18n/localeContext';
import { waitingPermissions, type ChatView, type ToolItem, type TranscriptItem } from './chatReducer';

export type ContextTone = 'unknown' | 'neutral' | 'amber' | 'red';

/** The ring's colour: neutral below 70% of the window, amber from 70%, red from 90%; unknown before the agent reports a window. */
export function contextTone(used: number, size: number): ContextTone {
  assert(Number.isFinite(used), 'contextTone: used is finite');
  assert(Number.isFinite(size), 'contextTone: size is finite');
  if (size <= 0 || used < 0) {
    return 'unknown';
  }
  // Integer comparisons: no rounding decides which side of a threshold a chat falls on.
  if (used * 100 >= size * 90) {
    return 'red';
  }
  if (used * 100 >= size * 70) {
    return 'amber';
  }
  return 'neutral';
}

/** The share of the window used, rounded down, or undefined while the window is unknown. */
export function contextPercent(used: number, size: number): number | undefined {
  if (size <= 0 || used < 0) {
    return undefined;
  }
  return Math.floor((used * 100) / size);
}

/** What the pure functions here need to write a sentence: the language's messages and its number format. */
export interface ChatWords {
  readonly translate: Translator;
  readonly formatNumber: Formatters['formatNumber'];
}

/**
 * A duration as people read it: `1.4s`, `12s`, `1m 17s`, `1h 2m` in English; the unit marks follow the language
 * (`1,4 Sek.`). Never negative. Units come from `Intl` (narrow unit style), so no unit word is spelled here.
 */
export function formatDuration(milliseconds: number, formatNumber: Formatters['formatNumber']): string {
  assert(Number.isFinite(milliseconds), 'formatDuration: a finite number');
  const clamped = Math.max(0, milliseconds);
  const unit = (value: number, name: 'second' | 'minute' | 'hour', fractionDigits: number): string =>
    formatNumber(value, { style: 'unit', unit: name, unitDisplay: 'narrow', minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
  if (clamped < 10_000) {
    return unit(Math.floor(clamped / 100) / 10, 'second', 1);
  }
  const seconds = Math.floor(clamped / 1000);
  if (seconds < 60) {
    return unit(seconds, 'second', 0);
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${unit(minutes, 'minute', 0)} ${unit(seconds % 60, 'second', 0)}`;
  }
  return `${unit(Math.floor(minutes / 60), 'hour', 0)} ${unit(minutes % 60, 'minute', 0)}`;
}

/** Tokens as people write them, in the language's own short form: `850`, `42K`, `1.2M`. */
export function formatTokens(tokens: number, formatNumber: ChatWords['formatNumber']): string {
  assert(Number.isFinite(tokens), 'formatTokens: a finite number');
  const value = Math.max(0, Math.round(tokens));
  return formatNumber(value, { notation: 'compact', compactDisplay: 'short' });
}

export type TurnPhase = 'command' | 'reading' | 'searching' | 'editing' | 'fetching' | 'thinking' | 'waiting' | 'compacting' | 'working';

export type TurnStatus =
  | { readonly kind: 'idle' }
  /** `elapsedMs` is undefined for a turn this view did not see begin. */
  | { readonly kind: 'running'; readonly phase: TurnPhase; readonly label: string; readonly elapsedMs: number | undefined }
  | { readonly kind: 'worked'; readonly elapsedMs: number };

/** Neutral words for the moments between tool calls, rotated slowly so the line shows life without claiming a step. */
const IDLE_VERBS = ['ai.status.idle.working', 'ai.status.idle.thinking', 'ai.status.idle.looking'] as const satisfies readonly MessageKey[];
const IDLE_VERB_MS = 4000;

const PHASE_LABELS = {
  command: 'ai.status.phase.command',
  reading: 'ai.status.phase.reading',
  searching: 'ai.status.phase.searching',
  editing: 'ai.status.phase.editing',
  fetching: 'ai.status.phase.fetching',
  thinking: 'ai.status.phase.thinking',
  waiting: 'ai.status.phase.waiting',
  compacting: 'ai.status.phase.compacting',
} as const satisfies Readonly<Record<Exclude<TurnPhase, 'working'>, MessageKey>>;

function phaseOfTool(kind: ToolKindName): TurnPhase {
  switch (kind) {
    case 'execute':
      return 'command';
    case 'read':
      return 'reading';
    case 'search':
      return 'searching';
    case 'edit':
    case 'delete':
    case 'move':
      return 'editing';
    case 'fetch':
      return 'fetching';
    case 'think':
      return 'thinking';
    case 'switch_mode':
    case 'other':
      return 'working';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function phaseOf(view: ChatView): TurnPhase {
  if (waitingPermissions(view).length > 0) {
    return 'waiting';
  }
  if (view.compaction?.status === 'in_progress') {
    return 'compacting';
  }
  const last = view.items[view.items.length - 1];
  if (last?.kind === 'tool' && (last.status === 'pending' || last.status === 'in_progress')) {
    return phaseOfTool(last.toolKind);
  }
  if (last?.kind === 'text' && last.role === 'thought') {
    return 'thinking';
  }
  return 'working';
}

/** The line under the transcript: what a running turn is doing and for how long, or how long the last turn took. */
export function buildTurnStatus(view: ChatView, now: number, translate: Translator): TurnStatus {
  assert(Number.isFinite(now), 'buildTurnStatus: a finite clock reading');
  if (view.running !== undefined) {
    const phase = phaseOf(view);
    const verb = IDLE_VERBS[Math.floor(Math.max(0, now) / IDLE_VERB_MS) % IDLE_VERBS.length] ?? IDLE_VERBS[0];
    return {
      kind: 'running',
      phase,
      label: translate(phase === 'working' ? verb : PHASE_LABELS[phase]),
      elapsedMs: view.turnStartedAt === undefined ? undefined : Math.max(0, now - view.turnStartedAt),
    };
  }
  for (let index = view.items.length - 1; index >= 0; index -= 1) {
    const item = view.items[index];
    if (item?.kind === 'turn-end') {
      return item.startedAt === undefined ? { kind: 'idle' } : { kind: 'worked', elapsedMs: Math.max(0, item.at - item.startedAt) };
    }
  }
  return { kind: 'idle' };
}

/** Distinct files a call touched, else one per call (a call that names no file still counts once). */
function fileCount(calls: readonly ToolItem[]): number {
  const paths = new Set<string>();
  let unnamed = 0;
  for (const call of calls) {
    const named = [...call.paths, ...call.diffs.map((diff) => diff.path)];
    if (named.length === 0) {
      unnamed += 1;
    }
    for (const path of named) {
      paths.add(path);
    }
  }
  return paths.size + unnamed;
}

/** "Ran 4 commands, edited 2 files, read 6 files": a group of tool calls in one line. Empty when there is nothing to say. */
export function activityHeadline(items: readonly TranscriptItem[], translate: Translator): string {
  const byKind = (...kinds: readonly ToolKindName[]): readonly ToolItem[] =>
    items.filter((item): item is ToolItem => item.kind === 'tool' && kinds.includes(item.toolKind));
  const commands = byKind('execute');
  const edits = byKind('edit', 'delete', 'move');
  const reads = byKind('read');
  const searches = byKind('search');
  const fetches = byKind('fetch');
  const others = byKind('other');
  const phrases = [
    commands.length === 0 ? '' : translate('ai.activity.ran', { count: commands.length }),
    edits.length === 0 ? '' : translate('ai.activity.edited', { count: fileCount(edits) }),
    reads.length === 0 ? '' : translate('ai.activity.read', { count: fileCount(reads) }),
    searches.length === 0 ? '' : translate('ai.activity.searched', { count: searches.length }),
    fetches.length === 0 ? '' : translate('ai.activity.fetched', { count: fetches.length }),
    others.length === 0 ? '' : translate('ai.activity.used', { count: others.length }),
  ].filter((phrase) => phrase !== '');
  const line = phrases.join(', ');
  return line === '' ? '' : `${line.charAt(0).toUpperCase()}${line.slice(1)}`;
}
