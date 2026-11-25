// Reads git once when the last running AI turn stops, so the branch chip beside Publish shows a branch the AI made or switched to
// without waiting for the next timer tick. Only the running-to-idle edge reads, so streaming text never does.
// A component of its own (it draws nothing) so the AI store's many updates re-render this one empty node, not the Publish button.
import { useEffect, useRef } from 'react';
import { useAiState } from '../../features/ai/aiStore';

export function RefreshGitWhenAiTurnEnds({ refresh }: { readonly refresh: () => Promise<unknown> }) {
  const ai = useAiState();
  const running = [...ai.views.values()].some((view) => view.running !== undefined);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) {
      void refresh().catch(() => undefined);
    }
    wasRunning.current = running;
  }, [running, refresh]);
  return undefined;
}
