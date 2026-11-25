// Where each agent's command-line tool looks for skills (`<name>/SKILL.md` folders), and which agent a
// skill's display path belongs to. One list for the main process, which reads the folders
// (electron/handlers/ai/mentionIndex.ts), and the renderer, which keeps only the active agent's skills
// in the `/` menu (src/features/ai/composer/slashRows.ts), so the two can never disagree about a folder.
//
// Claude Code reads `.claude/skills` in the project and in the home folder. Codex reads `.agents/skills`
// (the shared convention) and its own `.codex/skills`; the Codex places have not been checked against
// every installed Codex, so a folder that does not exist is simply skipped.
import { assert } from '../../core/assert';
import type { AgentId } from './agentIds';
import type { SkillSource } from './mentions';

export interface SkillPlace {
  /** The folder the place is relative to: the open project, or the person's home folder. */
  readonly base: 'project' | 'home';
  /** The place, relative to its base, with forward slashes. */
  readonly folder: string;
  readonly source: SkillSource;
  readonly agent: AgentId;
}

export const SKILL_PLACES = [
  { base: 'project', folder: '.claude/skills', source: 'project', agent: 'claude' },
  { base: 'project', folder: '.agents/skills', source: 'project', agent: 'codex' },
  { base: 'project', folder: '.codex/skills', source: 'project', agent: 'codex' },
  { base: 'home', folder: '.claude/skills', source: 'user', agent: 'claude' },
  { base: 'home', folder: '.codex/skills', source: 'user', agent: 'codex' },
  { base: 'home', folder: '.agents/skills', source: 'user', agent: 'codex' },
] as const satisfies readonly SkillPlace[];

/** How a place begins a skill's display path: project-relative, or `~/` for the home folder. */
export function skillPlacePrefix(place: SkillPlace): string {
  const prefix = place.base === 'project' ? place.folder : `~/${place.folder}`;
  assert(!prefix.endsWith('/'), 'skillPlacePrefix: no trailing slash');
  return prefix;
}

/** The agent whose place a skill's display path (`.claude/skills/x/SKILL.md`) is in, or undefined for none of them. */
export function skillAgentOf(displayPath: string): AgentId | undefined {
  const place = SKILL_PLACES.find((candidate) => displayPath.startsWith(`${skillPlacePrefix(candidate)}/`));
  assert(place === undefined || place.folder.length > 0, 'skillAgentOf: every place names a folder');
  return place?.agent;
}
