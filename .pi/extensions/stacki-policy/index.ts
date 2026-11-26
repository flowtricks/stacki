// Pi coding-agent extension: the repository policy for Pi, the same rules the
// Claude Code and Codex hooks enforce (scripts/agent/hook.mts), from the same
// functions. Pi loads project extensions after the project is trusted.
//
// The tool-call guard asks before gate-file edits. GitHub runs the code checks.
//
// Pi's event payloads come from outside this repository, so they are read as
// unknown and parsed field by field (AGENTS.md §2). The Pi package is not a
// dependency: the few API members used are declared structurally below.

import path from 'node:path';
import { commandVerdict, pathVerdict, repositoryPath, type Verdict } from '../../../scripts/agent/core.mts';
import { field } from '../../../scripts/agent/payload.mts';
import { repositoryRoot } from '../../../scripts/policy/checks.mts';

interface PiContext {
  readonly cwd: string;
  readonly hasUI: boolean;
  readonly ui: {
    confirm(title: string, message: string): Promise<boolean>;
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
