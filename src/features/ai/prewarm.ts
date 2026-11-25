// Starts the panel's agent early so the first message does not wait for it: when the panel
// opens for an agent that is installed and signed in, and when the composer gets focus. It
// changes nothing on screen (no state, no render), sends nothing the person typed, and a
// failure is the main process's log. Leaving (the panel closes, the agent or project
// changes, the chat starts) lets go of what the start parked.
import { useEffect } from 'react';
import type { AgentId } from '../../../shared/properties/ai/agentIds';
import { PrewarmGate, type PrewarmRequest } from '../../../shared/properties/ai/prewarmGate';
import { aiPrewarm } from './aiBridge';

const gate = new PrewarmGate();

function ask(projectPath: string, agent: AgentId, action: PrewarmRequest): void {
  if (!gate.decide(projectPath, agent, action, performance.now())) {
    return;
  }
  // Fire and forget: the reply is `{ ok: true }` or a failure nothing here would show.
  void aiPrewarm({ projectPath, agent, action });
}

/** `eligible`: the project is trusted, the agent is ready and signed in, and the chat has not started. */
export function usePrewarm(options: { readonly projectPath: string; readonly agent: AgentId; readonly eligible: boolean }): void {
  const { projectPath, agent, eligible } = options;
  useEffect(() => {
    if (!eligible) {
      return undefined;
    }
    if (document.visibilityState === 'visible') {
      ask(projectPath, agent, 'warm');
    }
    const onFocus = (event: FocusEvent): void => {
      if (event.target instanceof Element && event.target.closest('.ai-composer') !== null && document.visibilityState === 'visible') {
        ask(projectPath, agent, 'warm');
      }
    };
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('focusin', onFocus);
      ask(projectPath, agent, 'release');
    };
  }, [projectPath, agent, eligible]);
}
