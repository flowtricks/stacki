// The pure part of Settings > Agents (AgentsSettings.tsx): the New agent form's fields and template, the
// words for each definition problem and field problem, and which paired files a re-sync would overwrite.
// Kept apart from the component so the rules can be tested without a browser.
import { assert } from '../../../shared/core/assert';
import { AGENT_IDS, type AgentId } from '../../../shared/properties/ai/agentIds';
import {
  PROJECT_AGENT_LIMITS,
  agentFieldProblems,
  normalizeAgentFields,
  type AgentFieldProblem,
  type AgentFields,
  type AgentListing,
  type AgentProblem,
  type PairedAgent,
} from '../../../shared/properties/projectAgents';
import type { MessageKey } from '../../lib/i18n/localeContext';

/** What the form holds while it is typed: text as typed, the tools as one comma-separated line. */
export interface AgentDraft {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly tools: string;
  readonly claudeModel: string;
  readonly codexModel: string;
}

/** Claude Code's model aliases for an agent; empty is Claude's own default. */
export const CLAUDE_MODEL_CHOICES = ['', 'inherit', 'sonnet', 'opus', 'haiku'] as const;

/** The template a new agent starts from: the parts every agent's instructions need, ready to fill in. */
export function newAgentDraft(template: { readonly role: string; readonly steps: string; readonly output: string }): AgentDraft {
  return {
    name: '',
    description: '',
    instructions: `${template.role}\n\n${template.steps}\n\n${template.output}\n`,
    tools: '',
    claudeModel: '',
    codexModel: '',
  };
}

/** A pair's fields as the form edits them. */
export function draftOfFields(fields: AgentFields): AgentDraft {
  return {
    name: fields.name,
    description: fields.description,
    instructions: fields.instructions,
    tools: fields.tools.join(', '),
    claudeModel: fields.claudeModel ?? '',
    codexModel: fields.codexModel ?? '',
  };
}

/** The draft as fields, tidied as main will tidy them, so the form checks what will be written. */
export function fieldsOfDraft(draft: AgentDraft): AgentFields {
  const tools = draft.tools
    .split(',')
    .map((tool) => tool.trim())
    .filter((tool) => tool !== '');
  return normalizeAgentFields({
    name: draft.name.trim(),
    description: draft.description,
    instructions: draft.instructions,
    tools,
    claudeModel: draft.claudeModel === '' ? undefined : draft.claudeModel,
    codexModel: draft.codexModel === '' ? undefined : draft.codexModel,
  });
}

/**
 * The names a new pair may not take: every agent of either CLI and every pair, so a new pair never shadows a
 * definition written by hand. An edit leaves out its own pair and the files generated from it.
 */
export function takenNames(listing: AgentListing, editing: string | undefined): readonly string[] {
  const ownSource = editing === undefined ? undefined : `.stacki/agents/${editing}.json`;
  const names = [
    ...listing.agents.filter((agent) => ownSource === undefined || agent.pairedSource !== ownSource).map((agent) => agent.name),
    ...listing.paired.filter((pair) => pair.source !== ownSource).flatMap((pair) => (pair.fields.ok ? [pair.fields.value.name] : [])),
  ];
  assert(names.length <= PROJECT_AGENT_LIMITS.agentsMax * AGENT_IDS.length + PROJECT_AGENT_LIMITS.pairedMax, 'takenNames: bounded by the listing');
  return names;
}

/** The form's problems, for the draft as it stands. */
export function draftProblems(draft: AgentDraft, taken: readonly string[]): readonly AgentFieldProblem[] {
  return agentFieldProblems(fieldsOfDraft(draft), taken);
}

/** The providers whose generated file a re-sync or a field edit would overwrite: the files someone edited. */
export function editedProviders(pair: PairedAgent): readonly AgentId[] {
  return AGENT_IDS.filter((provider) => pair.files[provider] === 'edited');
}

/** Whether a pair needs a re-sync: a file someone edited, or one that is gone. */
export function pairNeedsSync(pair: PairedAgent): boolean {
  return AGENT_IDS.some((provider) => pair.files[provider] !== 'in-sync');
}

/** The key and parameters that word one definition problem. */
export function problemMessage(problem: AgentProblem): { readonly key: MessageKey; readonly params?: Readonly<Record<string, string | number>> } {
  switch (problem.kind) {
    case 'too-large':
      return { key: 'settings.agents.problem.tooLarge', params: { size: Math.floor(PROJECT_AGENT_LIMITS.fileBytesMax / 1024) } };
    case 'no-frontmatter':
      return { key: 'settings.agents.problem.noFrontmatter' };
    case 'unclosed-frontmatter':
      return { key: 'settings.agents.problem.unclosedFrontmatter' };
    case 'syntax':
      return problem.line === undefined
        ? { key: 'settings.agents.problem.syntax', params: { detail: problem.detail } }
        : { key: 'settings.agents.problem.syntaxLine', params: { detail: problem.detail, line: problem.line } };
    case 'duplicate-key':
      return { key: 'settings.agents.problem.duplicateKey', params: { key: problem.key } };
    case 'not-a-map':
      return { key: 'settings.agents.problem.notAMap' };
    case 'missing-field':
      return { key: 'settings.agents.problem.missingField', params: { field: problem.field } };
    case 'wrong-type':
      return { key: 'settings.agents.problem.wrongType', params: { field: problem.field } };
    case 'too-long':
      return { key: 'settings.agents.problem.tooLong', params: { field: problem.field } };
    default: {
      const exhaustive: never = problem;
      return exhaustive;
    }
  }
}

/** The key that words one field problem of the form. */
export function fieldProblemKey(problem: AgentFieldProblem): MessageKey {
  switch (problem.code) {
    case 'empty':
      return 'settings.agents.field.empty';
    case 'format':
      return problem.field === 'name' ? 'settings.agents.field.nameFormat' : 'settings.agents.field.format';
    case 'too-long':
      return 'settings.agents.field.tooLong';
    case 'taken':
      return 'settings.agents.field.taken';
    case 'too-many':
      return 'settings.agents.field.tooMany';
    default: {
      const exhaustive: never = problem.code;
      return exhaustive;
    }
  }
}
