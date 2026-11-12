// The line under a running turn: the four-dot loader, what the agent is doing right now ("Running
// a command", "Reading 3 files", "Waiting for you") and how long the turn has run, counted live.
// The words come from the newest event (runningLabel), never from a script of fake steps.
//
// The ticking part is its own component, mounted only while a turn runs, so a finished chat holds
// no timer, and the rest of the transcript does not re-render each second.
import type { ChatView } from '../chatReducer';
import { formatDuration } from '../chatStatus';
import { LoaderDots } from '../../../ui/LoaderDots';
import { useNow } from './ticker';
import { runningLabel } from './transcriptModel';

export function TurnStatus({ view }: { readonly view: ChatView }) {
  return view.running === undefined ? undefined : <RunningLine view={view} />;
}

function RunningLine({ view }: { readonly view: ChatView }) {
  const now = useNow();
  const status = runningLabel(view, now);
  if (status === undefined) {
    return undefined;
  }
  return (
    <div className="ai-turn-status">
      <LoaderDots dotPx={4} />
      <span className="ai-turn-label" role="status">
        {status.label}
      </span>
      {status.elapsedMs !== undefined && (
        <span className="ai-turn-time" aria-hidden="true">
          {formatDuration(status.elapsedMs)}
        </span>
      )}
    </div>
  );
}
