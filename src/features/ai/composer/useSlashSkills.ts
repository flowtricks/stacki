// The skills the `/` menu lists, kept so the menu is instant: the list is asked of the main process
// (the `ai:mentions` channel, skills alone, an empty query) when the composer mounts and again each time
// the menu opens, and the last answer for the project is shown meanwhile. The menu filters the list as the
// person types, so a keystroke never waits on the main process. A project change asks for that project's
// list; only when there is no answer yet for it does the menu draw placeholder rows.
import { useEffect, useState } from 'react';
import { assert } from '../../../../shared/core/assert';
import type { MentionCandidate } from '../../../../shared/properties/ai/mentions';
import type { MentionSearch } from '../mentions/useMentionRows';
import type { SlashSkill } from './slashRows';

export type SlashSkillState = { readonly kind: 'loading' } | { readonly kind: 'failed' } | { readonly kind: 'ready'; readonly skills: readonly SlashSkill[] };

/** Projects whose skill lists are kept at once; the oldest is forgotten past it. */
export const SLASH_SKILL_SCOPES_MAX = 4;

// The last list per project, shared by every composer so a new chat opens with it.
const cache = new Map<string, readonly SlashSkill[]>();

/** Forget every kept list (tests). */
export function forgetSlashSkills(): void {
  cache.clear();
}

/**
 * The skills for `scope` (the project path; '' when none is open). `open` is whether the `/` menu shows:
 * each time it turns true the list is asked for again.
 */
export function useSlashSkills(input: { readonly scope: string; readonly open: boolean; readonly search: MentionSearch }): SlashSkillState {
  const { scope, open, search } = input;
  const [answer, setAnswer] = useState<{ readonly scope: string; readonly state: SlashSkillState } | undefined>(undefined);
  useEffect(() => {
    let current = true;
    void askSkills(search).then((skills) => {
      if (!current) {
        return;
      }
      if (skills === undefined) {
        setAnswer({ scope, state: { kind: 'failed' } });
        return;
      }
      remember(scope, skills);
      setAnswer({ scope, state: { kind: 'ready', skills } });
    });
    return () => {
      current = false;
    };
    // `open` is a dependency only so each opening asks again; a closing asks too, which is harmless and cheap.
  }, [scope, open, search]);
  const kept = cache.get(scope);
  if (kept !== undefined) {
    return { kind: 'ready', skills: kept };
  }
  if (answer !== undefined && answer.scope === scope) {
    return answer.state;
  }
  return { kind: 'loading' };
}

function remember(scope: string, skills: readonly SlashSkill[]): void {
  cache.delete(scope);
  if (cache.size >= SLASH_SKILL_SCOPES_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) {
      cache.delete(oldest.value);
    }
  }
  cache.set(scope, skills);
  assert(cache.size <= SLASH_SKILL_SCOPES_MAX, 'useSlashSkills: kept lists are bounded');
}

/** The skills, or undefined when the list could not be read (no project open, the main process refused). */
async function askSkills(search: MentionSearch): Promise<readonly SlashSkill[] | undefined> {
  let reply: Awaited<ReturnType<MentionSearch>>;
  try {
    reply = await search('', ['skill']);
  } catch {
    // The list is optional help: a bridge error must not take the message box down with it.
    return undefined;
  }
  if (!reply.ok) {
    return undefined;
  }
  const skills = reply.value.flatMap(toSlashSkill);
  assert(skills.length <= reply.value.length, 'askSkills: one skill per candidate at most');
  return skills;
}

function toSlashSkill(candidate: MentionCandidate): readonly SlashSkill[] {
  switch (candidate.kind) {
    case 'skill':
      return [{ name: candidate.name, description: candidate.description, source: candidate.source, path: candidate.path }];
    case 'file':
      return []; // Asked for skills alone; a file row would be the main process's mistake, and is not a skill.
    default: {
      const exhaustive: never = candidate;
      return exhaustive;
    }
  }
}
