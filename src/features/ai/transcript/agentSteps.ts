// A subagent's work as a designer reads it: its calls folded into steps ("Read 5 files", "Edited 3 files
// (Button.astro, Hero.astro, …)", "Ran the tests"), each with a status, a time and the calls behind it.
// Consecutive calls of one kind make one step, so a run of reads is one line and the edit that follows is the
// next; a call's kind comes from the table in toolWords.ts (`classifyStep`). The technical side (the exact
// command, the full path, the error) stays on the calls, for the "Show commands" disclosure to draw.
//
// Pure: no clock, no DOM. Built from the reducer's `ToolItem`s alone, so a chat stored by an older version (no
// tool names, no stamps) still folds, into the generic steps ("Ran a command", "Used a tool") without times.
// Bounded everywhere (`STEP_LIMITS`): a subagent with thousands of calls keeps its newest steps and counts the rest.
import { assert } from '../../../../shared/core/assert';
import type { MessageKey } from '../../../../shared/properties/i18n/messageRef';
import type { Translator } from '../../../lib/i18n/localeContext';
import type { ToolItem } from '../chatReducer';
import { isSubagentCall } from '../subagents';
import { classifyStep, friendlyToolTitle, toolPhrase, type StepFacts, type StepKind } from './toolWords';

export const STEP_LIMITS = {
  /** Steps kept per subagent, newest; older ones are counted. */
  groupsMax: 200,
  /** Calls kept per step for its rows and its commands, newest; the rest are counted. */
  callsPerGroupMax: 50,
  /** File names a step names ("Edited 3 files (A, B, …)"). */
  filesNamedMax: 2,
  /** Distinct files a step tracks; past it the count stops growing. */
  filesCountedMax: 500,
  /** Steps shown under a subagent before the older ones fold into "N earlier steps". */
  latestGroupsShown: 4,
  /** Earlier steps each "Show more" adds. */
  earlierPageSize: 10,
  /** Rows of an opened step, its calls in words, before "N more not shown". */
  callRowsShown: 20,
  /** Characters of a failed call's error shown behind "Show commands", from its end. */
  errorCharsShown: 800,
  /** Characters of a command shown behind "Show commands". */
  commandCharsShown: 2_000,
} as const satisfies Record<string, number>;

/** Where one call, or one step, stands. `stopped`: it was still open when its subagent stopped working. */
export type StepStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface StepCall {
  readonly item: ToolItem;
  readonly facts: StepFacts;
  readonly status: StepStatus;
}

export interface StepGroup {
  /** The first call's id: stable while the step grows, so an opened step stays open. */
  readonly key: string;
  readonly kind: StepKind;
  /** A `tool` step's tool, a `command` step's program; undefined otherwise. */
  readonly name: string | undefined;
  /** Every call of the step, the ones left out of `calls` included. */
  readonly count: number;
  /** The distinct files the step read or edited, in the order first touched, at most `filesNamedMax + 1` (one more says "…"). */
  readonly files: readonly string[];
  /** How many distinct files, up to `filesCountedMax`. */
  readonly fileCount: number;
  /** What every call of the step was about, when they agree (one search, one script); undefined otherwise. */
  readonly subject: string | undefined;
  /** Running while any call runs; otherwise the newest call's outcome (a test run that failed, then passed, is done). */
  readonly status: StepStatus;
  readonly failed: number;
  readonly startedAt: number | undefined;
  /** The last call's end; undefined while it runs or when the calls carry no stamps. */
  readonly endedAt: number | undefined;
  /** The newest `callsPerGroupMax` calls. */
  readonly calls: readonly StepCall[];
  readonly omittedCalls: number;
}

export interface StepTimeline {
  /** The newest `groupsMax` steps, oldest first. */
  readonly groups: readonly StepGroup[];
  readonly omittedGroups: number;
  /** Calls in all, and calls still running: "31 tasks, 1 running". */
  readonly tasks: number;
  readonly running: number;
}

export const EMPTY_TIMELINE: StepTimeline = { groups: [], omittedGroups: 0, tasks: 0, running: 0 };

/**
 * The steps of a subagent's calls. `working`: the subagent is still at work; a call left open by one that is not
 * (stopped, failed, or finished without closing it) is `stopped`, never running forever. The same calls array with
 * the same `working` gives the same timeline object, so a row that did not change is not drawn again.
 */
export function groupSteps(calls: readonly ToolItem[], options: { readonly working: boolean }): StepTimeline {
  const cached = TIMELINES.get(calls);
  if (cached !== undefined && cached.working === options.working) {
    return cached.timeline;
  }
  const timeline = buildTimeline(calls, options);
  TIMELINES.set(calls, { working: options.working, timeline });
  return timeline;
}

const TIMELINES = new WeakMap<readonly ToolItem[], { readonly working: boolean; readonly timeline: StepTimeline }>();

/** The facts of one call: a subagent's own subagent (Codex's "Start subagent …" too) is a helper, whatever its kind. */
export function stepOf(item: ToolItem): StepFacts {
  return isSubagentCall(item) ? { kind: 'helper', subject: undefined, name: undefined } : classifyStep(item);
}

/** Where a call stands; a finished command with a non-zero exit failed, though the agent reported it completed. */
export function callStatus(item: Pick<ToolItem, 'status' | 'exitCode' | 'toolKind'>, options: { readonly working: boolean }): StepStatus {
  switch (item.status) {
    case 'pending':
    case 'in_progress':
      return options.working ? 'running' : 'stopped';
    case 'failed':
      return 'failed';
    case 'completed':
      return item.toolKind === 'execute' && item.exitCode !== undefined && item.exitCode !== 0 ? 'failed' : 'done';
    default: {
      const exhaustive: never = item.status;
      return exhaustive;
    }
  }
}

/** A step's words: "Read Hero.astro", "Read 5 files", "Edited 3 files (A, B, …)", "Ran the tests (2 times)", "Used Get Page Layout". */
export function stepLabel(group: Pick<StepGroup, 'kind' | 'count' | 'files' | 'fileCount' | 'subject' | 'name'>, translate: Translator): string {
  const label = labelOf(group, translate);
  assert(label !== '', 'stepLabel: a label');
  return label;
}

/** The words of one call on its own, as a row inside its opened step. */
export function callLabel(call: StepCall, translate: Translator): string {
  const file = call.facts.kind === 'read' || call.facts.kind === 'edit' ? call.facts.subject : undefined;
  return stepLabel(
    {
      kind: call.facts.kind,
      count: 1,
      files: file === undefined ? [] : [file],
      fileCount: file === undefined ? 0 : 1,
      subject: call.facts.subject,
      name: call.facts.name,
    },
    translate,
  );
}

/**
 * One line for a run of calls, in the same words its steps use, so the line above a list of steps never disagrees
 * with the steps under it: "Looked through the project 2 times, edited 1 file". Files are counted once each; every
 * kind that is neither a file read or edit, a look through the project nor a look on the web is "other steps". Empty
 * when there were no calls.
 */
export function callsHeadline(calls: readonly ToolItem[], translate: Translator): string {
  const edited = new Set<string>();
  const read = new Set<string>();
  let edits = 0;
  let reads = 0;
  let searches = 0;
  let web = 0;
  let other = 0;
  for (const call of calls) {
    if (call.toolKind === 'think' && !isSubagentCall(call)) {
      continue; // A thought is not work done to the site.
    }
    const facts = stepOf(call);
    switch (facts.kind) {
      case 'edit':
        // A file counts once; a call that names none counts as one file of its own.
        edits += countFiles(call, edited);
        break;
      case 'read':
        reads += countFiles(call, read);
        break;
      case 'search':
      case 'files':
        searches += 1;
        break;
      case 'web':
        web += 1;
        break;
      case 'command':
      case 'tool':
      case 'script':
      case 'test':
      case 'check':
      case 'build':
      case 'install':
      case 'devServer':
      case 'commit':
      case 'push':
      case 'history':
      case 'git':
      case 'ask':
      case 'plan':
      case 'todo':
      case 'helper':
      case 'message':
        other += 1;
        break;
      default: {
        const exhaustive: never = facts.kind;
        return exhaustive;
      }
    }
  }
  const editedFiles = edited.size + edits;
  const readFiles = read.size + reads;
  assert(searches + web + other <= calls.length, 'callsHeadline: no call is counted twice');
  const phrases = [
    searches === 0 ? '' : translate('ai.activity.searched', { count: searches }),
    readFiles === 0 ? '' : translate('ai.activity.read', { count: readFiles }),
    editedFiles === 0 ? '' : translate('ai.activity.edited', { count: editedFiles }),
    web === 0 ? '' : translate('ai.activity.web', { count: web }),
    other === 0 ? '' : translate('ai.activity.other', { count: other }),
  ].filter((phrase) => phrase !== '');
  if (phrases.length === 1 && other > 0) {
    return translate('ai.activity.usedTools', { count: other }); // Nothing else to be "other" than: "Took 2 steps".
  }
  const line = phrases.join(', ');
  return line === '' ? '' : `${line.charAt(0).toUpperCase()}${line.slice(1)}`;
}

// Adds the files a call names to `seen` (bounded); 1 when it names none, so it still counts as a file, else 0.
function countFiles(call: ToolItem, seen: Set<string>): number {
  const named = [...call.diffs.map((diff) => diff.path), ...call.paths];
  for (const path of named) {
    if (seen.size < STEP_LIMITS.filesCountedMax) {
      seen.add(path);
    }
  }
  return named.length === 0 ? 1 : 0;
}

/** The headline of a subagent's steps (`callsHeadline` of every call they hold). */
export function stepsHeadline(timeline: StepTimeline, translate: Translator): string {
  return callsHeadline(
    timeline.groups.flatMap((group) => group.calls.map((call) => call.item)),
    translate,
  );
}

/**
 * A file as a designer knows it: a page by its name ("Home page", "About page"), a component or layout by its name
 * ("Card component"), anything else by its file name. The path stays in the step's technical rows.
 */
export function friendlyFile(file: string, translate: Translator): string {
  const page = /(?:^|\/)pages\/(.+)\.(?:astro|md|mdx|html)$/u.exec(file)?.[1];
  if (page !== undefined) {
    const route = page.replace(/(?:^|\/)index$/u, '');
    const last = route.split('/').at(-1) ?? '';
    return last === '' ? translate('ai.files.homePage') : translate('ai.files.page', { name: wordsOf(last) });
  }
  const part = /(?:^|\/)(components|layouts)\/(?:.*\/)?([^/]+)\.(?:astro|tsx|jsx|svelte|vue)$/u.exec(file);
  if (part?.[2] !== undefined) {
    return translate(part[1] === 'layouts' ? 'ai.files.layout' : 'ai.files.component', { name: part[2] });
  }
  return file.split('/').at(-1) ?? file;
}

// "blog-post" and "[slug]" as words: "Blog post", "Slug".
function wordsOf(segment: string): string {
  const words = segment
    .replace(/[[\]().]/gu, '')
    .replace(/[-_]+/gu, ' ')
    .trim();
  return words === '' ? segment : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** "31 tasks, 1 running", or "31 tasks" once nothing runs. */
export function timelineSummary(timeline: Pick<StepTimeline, 'tasks' | 'running'>, translate: Translator): string {
  const tasks = translate('ai.steps.tasks', { count: timeline.tasks });
  return timeline.running === 0 ? tasks : translate('ai.steps.summary', { tasks, running: translate('ai.steps.running', { count: timeline.running }) });
}

/** A step's time: from its first call's start to its last call's end; undefined without stamps or while it runs. */
export function stepDurationMs(group: Pick<StepGroup, 'startedAt' | 'endedAt'>): number | undefined {
  if (group.startedAt === undefined || group.endedAt === undefined || group.endedAt < group.startedAt) {
    return undefined;
  }
  return group.endedAt - group.startedAt;
}

/** A call's own time, the same way. */
export function callDurationMs(item: Pick<ToolItem, 'at' | 'endedAt'>): number | undefined {
  return stepDurationMs({ startedAt: item.at, endedAt: item.endedAt });
}

/**
 * Which steps show at once and which fold into "N earlier steps": the newest `latestGroupsShown`, and every step from
 * the first one still running, are shown; the steps before them fold.
 */
export function splitEarlier(groups: readonly StepGroup[]): { readonly earlier: readonly StepGroup[]; readonly latest: readonly StepGroup[] } {
  const firstRunning = groups.findIndex((group) => group.status === 'running');
  const byCount = Math.max(0, groups.length - STEP_LIMITS.latestGroupsShown);
  const cut = firstRunning === -1 ? byCount : Math.min(byCount, firstRunning);
  const split = { earlier: groups.slice(0, cut), latest: groups.slice(cut) };
  assert(split.earlier.length + split.latest.length === groups.length, 'splitEarlier: every step is in one part');
  return split;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildTimeline(calls: readonly ToolItem[], options: { readonly working: boolean }): StepTimeline {
  // Runs of consecutive calls that share a merge key: one run is one step.
  const runs: StepCall[][] = [];
  let lastKey: string | undefined;
  let running = 0;
  for (const item of calls) {
    const facts = stepOf(item);
    const call: StepCall = { item, facts, status: callStatus(item, options) };
    if (call.status === 'running') {
      running += 1;
    }
    const mergeKey = facts.kind === 'tool' ? `tool:${facts.name ?? ''}` : facts.kind;
    const last = runs[runs.length - 1];
    if (last !== undefined && mergeKey === lastKey) {
      last.push(call);
    } else {
      runs.push([call]);
    }
    lastKey = mergeKey;
  }
  const dropped = Math.max(0, runs.length - STEP_LIMITS.groupsMax);
  const groups = runs.slice(dropped).map(summariseRun);
  assert(groups.length <= STEP_LIMITS.groupsMax, 'buildTimeline: the steps are bounded');
  assert(running <= calls.length, 'buildTimeline: running calls are calls');
  return { groups, omittedGroups: dropped, tasks: calls.length, running };
}

/** One run of calls as its step. */
function summariseRun(run: readonly StepCall[]): StepGroup {
  const first = run[0];
  assert(first !== undefined, 'summariseRun: a run has a call');
  const files: string[] = [];
  const fileSet = new Set<string>();
  let subject = first.facts.subject;
  let runningCalls = 0;
  let failed = 0;
  let endedAt: number | undefined;
  for (const call of run) {
    // A subject the calls share (one search, the same script twice) is kept; calls that differ name none.
    if (call.facts.subject !== subject) {
      subject = undefined;
    }
    const file = call.facts.kind === 'read' || call.facts.kind === 'edit' ? call.facts.subject : undefined;
    if (file !== undefined && !fileSet.has(file) && fileSet.size < STEP_LIMITS.filesCountedMax) {
      fileSet.add(file);
      if (files.length <= STEP_LIMITS.filesNamedMax) {
        files.push(file);
      }
    }
    if (call.status === 'running') {
      runningCalls += 1;
    } else if (call.status === 'failed') {
      failed += 1;
    }
    const end = call.item.endedAt;
    if (end !== undefined) {
      endedAt = endedAt === undefined ? end : Math.max(endedAt, end);
    }
  }
  const newest = run[run.length - 1] ?? first;
  const status: StepStatus = runningCalls > 0 ? 'running' : newest.status;
  const kept = run.length <= STEP_LIMITS.callsPerGroupMax ? run : run.slice(run.length - STEP_LIMITS.callsPerGroupMax);
  const group: StepGroup = {
    key: String(first.item.id),
    kind: first.facts.kind,
    name: first.facts.name,
    count: run.length,
    files,
    fileCount: fileSet.size,
    subject,
    status,
    failed,
    startedAt: first.item.at,
    endedAt: status === 'running' ? undefined : endedAt,
    calls: kept,
    omittedCalls: run.length - kept.length,
  };
  assert(group.calls.length <= STEP_LIMITS.callsPerGroupMax, 'summariseRun: a step’s calls are bounded');
  assert(group.files.length <= STEP_LIMITS.filesNamedMax + 1, 'summariseRun: the named files are bounded');
  return group;
}

/** Kinds worded by one fixed phrase, and the phrase. A run of more than one says how many times ("Ran the tests (3 times)"). */
const PLAIN_LABELS = {
  files: 'ai.step.files',
  test: 'ai.step.test',
  check: 'ai.step.check',
  build: 'ai.step.build',
  install: 'ai.step.install',
  devServer: 'ai.step.devServer',
  push: 'ai.step.push',
  history: 'ai.step.history',
  git: 'ai.step.git',
  ask: 'ai.toolName.ask',
  plan: 'ai.toolName.plan',
  todo: 'ai.toolName.todo',
  helper: 'ai.toolName.helper',
  message: 'ai.toolName.followUp',
} as const satisfies Readonly<Partial<Record<StepKind, MessageKey>>>;

function labelOf(group: Pick<StepGroup, 'kind' | 'count' | 'files' | 'fileCount' | 'subject' | 'name'>, translate: Translator): string {
  const { count } = group;
  switch (group.kind) {
    case 'read': {
      if (group.fileCount === 1 && group.files[0] !== undefined) {
        return translate('ai.step.readFile', { file: friendlyFile(group.files[0], translate) });
      }
      const files = group.fileCount > 0 ? group.fileCount : count;
      return files === 1 ? translate('ai.toolName.read') : translate('ai.step.readMany', { count: files });
    }
    case 'edit': {
      if (group.fileCount === 1 && group.files[0] !== undefined) {
        return translate('ai.step.editFile', { file: friendlyFile(group.files[0], translate) });
      }
      if (group.fileCount > 1) {
        return translate('ai.step.editMany', { count: group.fileCount, files: fileList(group, translate) });
      }
      return count === 1 ? translate('ai.toolName.edit') : translate('ai.step.editCount', { count });
    }
    case 'search':
      if (group.subject !== undefined) {
        return repeated(translate('ai.step.searchFor', { query: group.subject }), count, translate);
      }
      return count === 1 ? translate('ai.toolName.searchCode') : translate('ai.step.searchMany', { count });
    case 'web':
      return count === 1 ? translate('ai.step.web') : translate('ai.step.webMany', { count });
    case 'script':
      if (group.subject !== undefined) {
        return repeated(translate('ai.step.scriptNamed', { name: group.subject }), count, translate);
      }
      return count === 1 ? translate('ai.step.script') : translate('ai.step.scriptMany', { count });
    case 'commit':
      return count === 1 ? translate('ai.step.commit') : translate('ai.step.commitMany', { count });
    case 'command':
      return count === 1 ? translate('ai.toolName.run') : translate('ai.step.commandMany', { count });
    case 'tool': {
      const name = group.name ?? '';
      const phrase = friendlyToolTitle(name, name, translate) ?? (name === '' ? toolPhrase('', translate) : name);
      return repeated(phrase, count, translate);
    }
    case 'files':
    case 'test':
    case 'check':
    case 'build':
    case 'install':
    case 'devServer':
    case 'push':
    case 'history':
    case 'git':
    case 'ask':
    case 'plan':
    case 'todo':
    case 'helper':
    case 'message':
      return repeated(translate(PLAIN_LABELS[group.kind]), count, translate);
    default: {
      const exhaustive: never = group.kind;
      return exhaustive;
    }
  }
}

function repeated(phrase: string, count: number, translate: Translator): string {
  return count === 1 ? phrase : translate('ai.step.repeated', { step: phrase, count });
}

/** "Card component, Home page, …": the first names, and an ellipsis when there are more. */
function fileList(group: Pick<StepGroup, 'files' | 'fileCount'>, translate: Translator): string {
  const named = group.files.slice(0, STEP_LIMITS.filesNamedMax).map((file) => friendlyFile(file, translate));
  return group.fileCount > named.length ? `${named.join(', ')}, …` : named.join(', ');
}
