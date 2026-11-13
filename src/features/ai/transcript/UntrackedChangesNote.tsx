// The one quiet line where a Changes card would have been, for a turn whose file edits the ledger did
// not track: the person turned "Snapshot before & after each AI change" off, or the snapshot failed or timed out.
// The line only appears when the agent announced an edit, so a chat that only reads stays silent.
// "Turn on" flips the setting at once (the line reads "on" without waiting for the save) and applies
// to the next turn; it never reaches back into the turn the note belongs to.
import { useState } from 'react';
import type { UntrackedReason } from '../../../../shared/properties/ai/chatModel';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { turnOnChangeTracking } from './trackChangesBridge';

type NoteState = 'idle' | 'on' | 'failed';

export function UntrackedChangesNote({ reason }: { readonly reason: UntrackedReason }) {
  const translate = useTranslate();
  const [state, setState] = useState<NoteState>('idle');
  const turnOn = () => {
    setState('on');
    void turnOnChangeTracking().then((saved) => {
      if (!saved) {
        setState('failed');
      }
    });
  };
  if (reason === 'unavailable') {
    return <div className="ai-notice ai-notice-info">{translate('ai.changes.untracked.unavailable')}</div>;
  }
  return (
    <div className="ai-notice ai-notice-info ai-untracked">
      <span>{translate(state === 'on' ? 'ai.changes.untracked.nowOn' : 'ai.changes.untracked.off')}</span>
      {state !== 'on' && (
        <button type="button" className="ai-untracked-turn-on" onClick={turnOn}>
          {translate('ai.changes.untracked.turnOn')}
        </button>
      )}
      {state === 'failed' && <span className="ai-untracked-failed">{translate('ai.changes.untracked.failed')}</span>}
    </div>
  );
}
