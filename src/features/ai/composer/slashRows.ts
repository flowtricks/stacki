// The rows of the composer's `/` menu: Stacki's commands, the active agent's skills and the commands the
// agent advertised, narrowed by what follows the `/` and ranked so the closest names come first. Pure: the
// skill list comes from useSlashSkills.ts, the menu is drawn by SlashMenu.tsx.
//
// Ranking: a name equal to the query, then names that start with it, then names that contain it. Within
// one rank Stacki's commands come first (they act here), then skills (the person's own), then the agent's
// commands; skills keep their alphabetical order and commands the order they were given. A skill hides an
// agent command of the same name (an agent advertises its skills as commands, without the source), and a
// Stacki command hides both (it is what the name does here).
import { assert } from '../../../../shared/core/assert';
import type { AgentId } from '../../../../shared/properties/ai/agentIds';
import type { ChatCommand } from '../../../../shared/properties/ai/chatModel';
import type { SkillSource } from '../../../../shared/properties/ai/mentions';
import { skillAgentOf } from '../../../../shared/properties/ai/skillPlaces';
import { builtinCommandNamed } from './builtinCommands';

/** A skill as the `/` menu lists it. */
export interface SlashSkill {
  readonly name: string;
  readonly description: string;
  readonly source: SkillSource;
  /** The display path (`.claude/skills/x/SKILL.md`, `~/.codex/skills/x/SKILL.md`), which says whose skill it is. */
  readonly path: string;
}

export type SlashRow =
  | { readonly kind: 'builtin'; readonly command: ChatCommand }
  | { readonly kind: 'command'; readonly command: ChatCommand }
  | { readonly kind: 'skill'; readonly skill: SlashSkill };

/** The most rows the menu draws; it scrolls past what fits. */
export const SLASH_ROWS_MAX = 100;

/** What follows the `/` of a draft that is a command being typed (`/lum`), or undefined when it is not one. */
export function slashQueryOf(text: string): string | undefined {
  if (!text.startsWith('/')) {
    return undefined;
  }
  if (/\s/.test(text)) {
    return undefined; // A space ends the name: the rest is the message.
  }
  const query = text.slice(1).toLowerCase();
  assert(query.length < text.length, 'slashQueryOf: the slash is not part of the query');
  return query;
}

/** The skills of `agent`'s own places, in name order. */
export function skillsForAgent(skills: readonly SlashSkill[], agent: AgentId): readonly SlashSkill[] {
  const own = skills.filter((skill) => skillAgentOf(skill.path) === agent);
  const sorted = [...own].sort((left, right) => left.name.localeCompare(right.name));
  assert(sorted.length <= skills.length, 'skillsForAgent: a subset');
  return sorted;
}

/** The menu's rows for `query` (already lower case, without the `/`). */
export function slashRows(input: {
  readonly commands: readonly ChatCommand[];
  readonly skills: readonly SlashSkill[];
  readonly query: string;
}): readonly SlashRow[] {
  const rows = candidateRows(input.commands, input.skills);
  const scored: { readonly row: SlashRow; readonly score: number; readonly order: number }[] = [];
  for (const [order, row] of rows.entries()) {
    const score = nameScore(slashRowName(row).toLowerCase(), input.query);
    if (score > 0) {
      scored.push({ row, score, order });
    }
  }
  scored.sort((left, right) => right.score - left.score || kindRank(left.row) - kindRank(right.row) || left.order - right.order);
  const shown = scored.slice(0, SLASH_ROWS_MAX).map((entry) => entry.row);
  assert(shown.length <= SLASH_ROWS_MAX, 'slashRows: bounded');
  return shown;
}

/** The name a row completes to, without the `/`. */
export function slashRowName(row: SlashRow): string {
  switch (row.kind) {
    case 'builtin':
    case 'command':
      return row.command.name;
    case 'skill':
      return row.skill.name;
    default: {
      const exhaustive: never = row;
      return exhaustive;
    }
  }
}

/** Every row before filtering: each name once, a Stacki command over a skill over an agent command. */
function candidateRows(commands: readonly ChatCommand[], skills: readonly SlashSkill[]): readonly SlashRow[] {
  const builtins = commands.filter((command) => builtinCommandNamed(command.name) !== undefined);
  const taken = new Set(builtins.map((command) => command.name));
  const ownSkills = skills.filter((skill) => !taken.has(skill.name));
  for (const skill of ownSkills) {
    taken.add(skill.name);
  }
  const advertised = commands.filter((command) => !taken.has(command.name));
  const rows: readonly SlashRow[] = [
    ...builtins.map((command) => ({ kind: 'builtin' as const, command })),
    ...ownSkills.map((skill) => ({ kind: 'skill' as const, skill })),
    ...advertised.map((command) => ({ kind: 'command' as const, command })),
  ];
  assert(rows.length <= commands.length + skills.length, 'candidateRows: nothing is added twice');
  return rows;
}

function nameScore(name: string, query: string): number {
  if (query === '') {
    return 1;
  }
  if (name === query) {
    return 4;
  }
  if (name.startsWith(query)) {
    return 3;
  }
  if (name.includes(query)) {
    return 2;
  }
  return 0;
}

function kindRank(row: SlashRow): number {
  switch (row.kind) {
    case 'builtin':
      return 0;
    case 'skill':
      return 1;
    case 'command':
      return 2;
    default: {
      const exhaustive: never = row;
      return exhaustive;
    }
  }
}
