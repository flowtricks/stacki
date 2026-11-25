// Hooks for Claude Code and Codex, which share one protocol shape: a JSON
// payload on stdin, a decision on stdout or exit code 2 with feedback on
// stderr. Configured in .claude/settings.json and .codex/hooks.json:
//
//   node scripts/agent/claude.mts pre-tool|post-tool|stop
//   node scripts/agent/codex.mts pre-tool|post-tool|stop
//
// pre-tool   refuses commands that skip the gates and asks before edits to the
//            files that define them (core.mts).
// post-tool  formats and checks the files the edit touched (checks.mts).
// stop       checks everything changed since HEAD; a failure sends the agent
//            back to work, at most POLICY_LIMITS.stopContinuationsMax times.
//
// A payload this script cannot parse fails loudly (exit 2): a silent pass
// would turn a harness upgrade into a gate that quietly checks nothing.

import fs from 'node:fs';
import { assert } from '../policy/assert.mts';
import { checkChanged, checkFiles, repositoryRoot, type CheckOutcome } from '../policy/checks.mts';
import { POLICY_LIMITS } from '../policy/limits.mts';
import { parseHookPayload, type HookPayload } from './payload.mts';
import { commandVerdict, pathVerdict, patchPaths, repositoryPath, type Verdict } from './core.mts';
import { clearStopState, decideStop, readStopState, reportDigest, writeStopState } from './stopState.mts';

export type Harness = 'claude' | 'codex';
const EVENTS = ['pre-tool', 'post-tool', 'stop'] as const;

// The exit code both harnesses read as "blocked; show stderr to the model".
const EXIT_FEEDBACK = 2;
// A human who starts the agent with this set has approved edits to the gate
// files for that session. The agent cannot set it: hooks run in the harness's
// environment, not in the agent's shell.
const POLICY_EDIT_APPROVAL = 'STACKI_ALLOW_POLICY_EDITS';

// Runs one hook event for one harness; the entry points claude.mts and
// codex.mts name the harness, so the configured commands stay short.
export function runHook(harness: Harness, argumentsList: readonly string[]): number {
  const event = EVENTS.find((candidate) => candidate === argumentsList[0]);
  assert(event !== undefined, 'hook: event must be pre-tool, post-tool, or stop');
  const raw = fs.readFileSync(0, 'utf8');
  const parsed = parseHookPayload(raw, event);
  if (!parsed.ok) {
    process.stderr.write(`stacki hook: ${parsed.error}\n`);
    return EXIT_FEEDBACK;
  }
  const root = repositoryRoot();
  switch (event) {
    case 'pre-tool':
      return preTool(root, harness, parsed.value);
    case 'post-tool':
      return postTool(root, parsed.value);
    case 'stop':
      return stop(root, parsed.value);
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

function preTool(root: string, harness: Harness, payload: HookPayload): number {
  const verdict = toolVerdict(root, payload);
  if (verdict.kind === 'allow') {
    return 0;
  }
  const decision = verdict.kind === 'ask' && harness === 'claude' ? 'ask' : 'deny';
  const reason = verdict.kind === 'ask' && decision === 'deny' ? `${verdict.reason} Ask your human to make or approve this change.` : verdict.reason;
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}

// The strictest verdict across what the call runs and what it edits.
function toolVerdict(root: string, payload: HookPayload): Verdict {
  const verdicts: Verdict[] = [];
  if (payload.command !== undefined) {
    verdicts.push(commandVerdict(payload.command, root));
  }
  for (const file of editedFiles(root, payload)) {
    verdicts.push(pathVerdict(file));
  }
  const denied = verdicts.find((verdict) => verdict.kind === 'deny');
  if (denied !== undefined) {
    return denied;
  }
  const asked = verdicts.find((verdict) => verdict.kind === 'ask');
  if (asked !== undefined) {
    return process.env[POLICY_EDIT_APPROVAL] === '1' ? { kind: 'allow' } : asked;
  }
  return { kind: 'allow' };
}

function postTool(root: string, payload: HookPayload): number {
  const files = editedFiles(root, payload);
  if (files.length === 0) {
    return 0;
  }
  return report(checkFiles(root, files, { format: 'write' }), 'The edit left findings:');
}

function stop(root: string, payload: HookPayload): number {
  const outcome = checkChanged(root);
  if (outcome.kind === 'pass') {
    clearStopState(root, payload.sessionId);
    return 0;
  }
  const limit = POLICY_LIMITS.stopContinuationsMax;
  const state = readStopState(root, payload.sessionId);
  const decision = decideStop(state, reportDigest(outcome.report), limit);
  writeStopState(root, payload.sessionId, decision.next);
  switch (decision.kind) {
    case 'refuse': {
      const heading = 'The changes do not pass the repository checks yet ' + `(attempt ${decision.attempt} of ${limit}). Fix these, then finish:`;
      return report(outcome, heading);
    }
    case 'release': {
      // Out of attempts for these findings: let the session end, and say so.
      const message =
        `stacki: stopped with failing checks after ${limit} attempts. Run ` + '`npm run check:changed` to see them; CI will fail until they are fixed.';
      process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
      return 0;
    }
    case 'already-released':
      return 0;
    default: {
      const unreachable: never = decision;
      return unreachable;
    }
  }
}

function report(outcome: CheckOutcome, heading: string): number {
  if (outcome.kind === 'pass') {
    return 0;
  }
  const text = `${heading}\n\n${outcome.report}`;
  const limit = POLICY_LIMITS.feedbackCharsMax;
  const shown = text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncated)`;
  process.stderr.write(`${shown}\n`);
  return EXIT_FEEDBACK;
}

// Repository-relative paths of the files a tool call writes.
function editedFiles(root: string, payload: HookPayload): readonly string[] {
  const candidates = [...payload.paths, ...patchPaths(payload.toolInput)];
  const files = candidates.map((file) => repositoryPath(root, payload.cwd ?? root, file)).filter((file) => file !== undefined);
  return [...new Set(files)];
}
