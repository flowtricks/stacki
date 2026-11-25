// The AI panel's agent choice per surface (shared/properties/ai/agentChoices.ts): which project agent a
// new chat, "Fix with AI" and "Build an app" run with. The choices are this person's, per project, in
// browser storage (read synchronously, so the panel's first frame already shows them); the project's
// agent definitions come from main (src/ipc/agentsBridge.ts) and are read again when the panel opens,
// when the window regains focus, when a definition file changes and after the app's own agent writes.
//
// The state lives outside React, as aiStore.ts does, so a hand-off from another panel can read it
// with the AI panel closed.
import { useSyncExternalStore } from 'react';
import { assert } from '../../../shared/core/assert';
import type { AgentId } from '../../../shared/properties/ai/agentIds';
import {
  EMPTY_STORED_AGENT_CHOICES,
  agentSettingsFor,
  choicesFor,
  parseStoredAgentChoices,
  resolveAgentChoice,
  serializeStoredAgentChoices,
  withAgentChoice,
  type AgentChoice,
  type AgentChoices,
  type AgentSurface,
  type ResolvedAgentChoice,
  type StoredAgentChoices,
} from '../../../shared/properties/ai/agentChoices';
import type { RememberedSetting } from '../../../shared/properties/ai/rememberedSettings';
import type { ProjectAgent } from '../../../shared/properties/projectAgents';
import { listProjectAgents, onProjectAgentsChanged } from '../../ipc/agentsBridge';

const STORAGE_KEY = 'stacki.ai.agentChoices';

/** The project's definitions as last read: unknown until the first read answers, so nothing reads as missing too early. */
export type AgentDefinitions =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'known'; readonly agents: readonly ProjectAgent[] }
  | { readonly kind: 'unavailable'; readonly message: string };

export interface AgentChoiceState {
  readonly projectPath: string | undefined;
  readonly choices: AgentChoices;
  readonly definitions: AgentDefinitions;
}

let stored: StoredAgentChoices = readStored();
let state: AgentChoiceState = { projectPath: undefined, choices: choicesFor(stored, ''), definitions: { kind: 'unknown' } };
const listeners = new Set<() => void>();
/** The panel, its dialog and a hand-off: a handful at most. */
const LISTENERS_MAX = 16;
let unsubscribe: (() => void) | undefined;

function readStored(): StoredAgentChoices {
  try {
    return parseStoredAgentChoices(localStorage.getItem(STORAGE_KEY));
  } catch {
    return EMPTY_STORED_AGENT_CHOICES;
  }
}

function writeStored(next: StoredAgentChoices): void {
  stored = next;
  try {
    localStorage.setItem(STORAGE_KEY, serializeStoredAgentChoices(next));
  } catch {
    // A choice that cannot be stored holds for this window until it closes.
  }
}

function update(next: AgentChoiceState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

export function agentChoiceState(): AgentChoiceState {
  return state;
}

function subscribe(listener: () => void): () => void {
  assert(listeners.size < LISTENERS_MAX, 'Agent choice listeners are bounded');
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAgentChoices(): AgentChoiceState {
  return useSyncExternalStore(subscribe, agentChoiceState, agentChoiceState);
}

/** Switches to `projectPath` (its stored choices at once) and reads its definitions. */
export async function loadAgentChoices(projectPath: string): Promise<void> {
  assert(projectPath.length > 0, 'loadAgentChoices: a project is named');
  if (state.projectPath !== projectPath) {
    stored = readStored();
    update({ projectPath, choices: choicesFor(stored, projectPath), definitions: { kind: 'unknown' } });
  }
  listenForChanges();
  await refreshDefinitions();
}

/** Reads the open project's definitions again; a read for a project no longer open is dropped. */
export async function refreshDefinitions(): Promise<void> {
  const projectPath = state.projectPath;
  if (projectPath === undefined) {
    return;
  }
  let definitions: AgentDefinitions;
  try {
    const listing = await listProjectAgents(projectPath);
    definitions = { kind: 'known', agents: listing.agents };
  } catch (failure: unknown) {
    definitions = { kind: 'unavailable', message: failure instanceof Error ? failure.message : String(failure) };
  }
  if (state.projectPath === projectPath) {
    update({ ...state, definitions });
  }
}

function listenForChanges(): void {
  if (unsubscribe !== undefined) {
    return;
  }
  const refresh = (): void => void refreshDefinitions();
  const offApp = onProjectAgentsChanged(refresh);
  // A definition edited in the Instructions editor or outside the app arrives as an instructions change.
  const offFiles = window.avb.onInstructionsChanged(refresh);
  window.addEventListener('focus', refresh);
  unsubscribe = () => {
    offApp();
    offFiles();
    window.removeEventListener('focus', refresh);
  };
}

/** Chooses (or clears, with undefined) the agent one surface uses in the open project. */
export function chooseAgent(surface: AgentSurface, choice: AgentChoice | undefined): void {
  const projectPath = state.projectPath;
  assert(projectPath !== undefined, 'chooseAgent: a project is open');
  writeStored(withAgentChoice(stored, { projectPath, surface, choice }));
  update({ ...state, choices: choicesFor(stored, projectPath) });
  assert(state.choices[surface] === choice, 'chooseAgent: the choice is held');
}

/** What a surface's choice means now. Before the definitions are known, a choice is trusted as made. */
export function resolvedChoice(surface: AgentSurface, current: AgentChoiceState = state): ResolvedAgentChoice {
  const choice = current.choices[surface];
  if (current.definitions.kind !== 'known') {
    return choice === undefined ? { kind: 'default' } : pendingResolution(choice);
  }
  return resolveAgentChoice(choice, current.definitions.agents);
}

// Unknown definitions: resolve as if the chosen agent were there, so a hand-off in the first second still runs with it;
// main skips an agent the session does not offer, and the notice appears once the definitions arrive.
function pendingResolution(choice: AgentChoice): ResolvedAgentChoice {
  return resolveAgentChoice(choice, [
    {
      provider: choice.provider,
      path: '',
      name: choice.name,
      description: undefined,
      model: undefined,
      tools: undefined,
      problems: [],
      pairedSource: undefined,
    },
  ]);
}

/** The settings a new chat of `provider` for `surface` starts with: the chosen agent's session option, or none. */
export function agentSettingsForSurface(surface: AgentSurface, provider: AgentId): readonly RememberedSetting[] {
  return agentSettingsFor(resolvedChoice(surface), provider);
}

/** Forgets the window's listeners: for tests and project close. */
export function resetAgentChoiceStore(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  stored = readStored();
  update({ projectPath: undefined, choices: choicesFor(stored, ''), definitions: { kind: 'unknown' } });
}
