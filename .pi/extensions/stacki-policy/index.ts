// Pi coding-agent extension: the repository policy for Pi, the same rules the
// Claude Code and Codex hooks enforce (scripts/agent/hook.mts), from the same
// functions. Pi loads project extensions after the project is trusted.
//
// tool_call            refuses gate-skipping commands; asks before gate-file edits
// tool_result          formats and checks each file a write or edit touched
// agent_before_settle  checks every changed file; a failure continues the run
//                      with the findings, at most stopContinuationsMax times
//
// Pi's event payloads come from outside this repository, so they are read as
// unknown and parsed field by field (AGENTS.md §2). The Pi package is not a
// dependency: the few API members used are declared structurally below.

import path from 'node:path';
import { commandVerdict, pathVerdict, repositoryPath, type Verdict } from '../../../scripts/agent/core.mts';
import { field } from '../../../scripts/agent/payload.mts';
import { checkChanged, checkFiles, repositoryRoot } from '../../../scripts/policy/checks.mts';
import { POLICY_LIMITS } from '../../../scripts/policy/limits.mts';

interface PiContext {
  readonly cwd: string;
  readonly hasUI: boolean;
  readonly ui: {
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, type?: 'info' | 'warning' | 'error'): void;
  };
}

interface PiApi {
  on(event: string, handler: (event: unknown, context: PiContext) => unknown): unknown;
}

const COMMAND_TOOLS = new Set(['bash', 'powershell']);
const EDIT_TOOLS = new Set(['edit', 'write']);
// A human who starts Pi with this set has approved edits to the gate files.
const POLICY_EDIT_APPROVAL = 'STACKI_ALLOW_POLICY_EDITS';

export default function stackiPolicy(pi: PiApi): void {
  const root = repositoryRoot();
  let refusals = 0;

  pi.on('tool_call', async (event, context) => {
    const verdict = toolVerdict(root, event, context.cwd);
    if (verdict.kind === 'allow') {
      return undefined;
    }
    if (verdict.kind === 'ask') {
      if (process.env[POLICY_EDIT_APPROVAL] === '1') {
        return undefined;
      }
      if (context.hasUI) {
        const approved = await context.ui.confirm('Edit a repository gate file?', verdict.reason);
        return approved ? undefined : { block: true, reason: verdict.reason };
      }
      return { block: true, reason: `${verdict.reason} Ask your human to approve it.` };
    }
    return { block: true, reason: verdict.reason };
  });

  pi.on('tool_result', (event, context) => {
    const file = editedFile(root, event, context.cwd);
    if (file === undefined) {
      return undefined;
    }
    const outcome = checkFiles(root, [file], { format: 'write' });
    if (outcome.kind === 'pass') {
      return undefined;
    }
    const existing: unknown = Reflect.get(asObject(event), 'content');
    const content: readonly unknown[] = Array.isArray(existing) ? existing : [];
    const text = truncate(`The edit left findings:\n\n${outcome.report}`);
    return { content: [...content, { type: 'text', text }], isError: true };
  });

  pi.on('agent_before_settle', (event, context) => {
    const outcome = checkChanged(root);
    if (outcome.kind === 'pass') {
      refusals = 0;
      return undefined;
    }
    refusals += 1;
    if (refusals > POLICY_LIMITS.stopContinuationsMax) {
      refusals = 0;
      context.ui.notify('stacki: stopped with failing checks; run `npm run check:changed`.', 'warning');
      return undefined;
    }
    const existing: unknown = Reflect.get(asObject(event), 'entries');
    const entries: readonly unknown[] = Array.isArray(existing) ? existing : [];
    const heading =
      `The changes do not pass the repository checks yet (attempt ${refusals} of ` + `${POLICY_LIMITS.stopContinuationsMax}). Fix these, then finish:`;
    const message = {
      type: 'custom_message',
      customType: 'stacki-policy',
      content: truncate(`${heading}\n\n${outcome.report}`),
      display: true,
    };
    return { entries: [...entries, message], continue: true };
  });
}

function toolVerdict(root: string, event: unknown, cwd: string): Verdict {
  const toolName = field(event, 'toolName') ?? '';
  const input: unknown = Reflect.get(asObject(event), 'input');
  if (COMMAND_TOOLS.has(toolName)) {
    const command = field(input, 'command');
    return command === undefined ? { kind: 'allow' } : commandVerdict(command, root);
  }
  const file = editedFile(root, event, cwd);
  return file === undefined ? { kind: 'allow' } : pathVerdict(file);
}

function editedFile(root: string, event: unknown, cwd: string): string | undefined {
  const toolName = field(event, 'toolName') ?? '';
  if (!EDIT_TOOLS.has(toolName)) {
    return undefined;
  }
  const target = field(Reflect.get(asObject(event), 'input'), 'path');
  if (target === undefined) {
    return undefined;
  }
  return repositoryPath(root, path.resolve(cwd), target);
}

function asObject(value: unknown): object {
  return typeof value === 'object' && value !== null ? value : {};
}

function truncate(text: string): string {
  const limit = POLICY_LIMITS.feedbackCharsMax;
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncated)`;
}
