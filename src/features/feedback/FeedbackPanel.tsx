import React, { useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { TrailedFeedbackItem } from '../../../shared/ipc/feedback';
import { CheckIcon, CloseIcon } from '../../ui/Icons';
import { renderHandoff } from './feedbackBridge';
import type { FeedbackPin, useFeedback } from './feedbackState';
import './feedback.css';

interface FeedbackPanelProps {
  readonly feedback: ReturnType<typeof useFeedback>['feedback'];
  /** What a new note attaches to: the selected node's name, or the page. */
  readonly target: string | undefined;
  /** The current selection's leaf key; its rows are highlighted. */
  readonly selectedKey: string | undefined;
  readonly onSelectPin: (pin: FeedbackPin) => void;
  readonly showToast: (message: string, kind: 'success' | 'error') => void;
}

// Notes pinned to canvas selections, kept in .stacki/feedback.json for a coding
// agent: select an element, type, press Enter; Copy for agent hands them over.
export default function FeedbackPanel(props: FeedbackPanelProps) {
  const { feedback } = props;
  const [draft, setDraft] = useState('');
  const { reload } = feedback;
  // Opening the tab catches up with what an agent changed in the file.
  useEffect(() => void reload(), [reload]);
  const open = feedback.items.filter((item) => !item.done);
  const done = feedback.items.filter((item) => item.done);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) {
      return;
    }
    event.preventDefault();
    const note = draft.trim();
    if (note) {
      setDraft('');
      void feedback.add(note);
    }
  };
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(renderHandoff(feedback.items));
      props.showToast('Copied. Paste it into Claude Code in the project.', 'success');
    } catch {
      props.showToast('Could not copy the feedback.', 'error');
    }
  };
  return (
    <div className="panel-section grow">
      <div className="panel-header">
        <h2>Feedback</h2>
        <button className="feedback-copy" disabled={open.length === 0} onClick={() => void copy()}>
          Copy for agent
        </button>
      </div>
      <div className="panel-body feedback-body">
        <textarea
          className="feedback-input"
          value={draft}
          placeholder={props.target ? `Note on ${props.target}` : 'Note on this page'}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {open.map((item, index) => (
          <FeedbackRow key={item.id} item={item} number={index + 1} {...props} />
        ))}
        {done.length > 0 && (
          <div className="feedback-done-head">
            <span>Done</span>
            <button onClick={() => void feedback.clearDone()}>Clear done</button>
          </div>
        )}
        {done.map((item) => (
          <FeedbackRow key={item.id} item={item} number={undefined} {...props} />
        ))}
        <p className="feedback-path">.stacki/feedback.json</p>
      </div>
    </div>
  );
}

function FeedbackRow(
  props: FeedbackPanelProps & {
    readonly item: TrailedFeedbackItem;
    readonly number: number | undefined;
  },
) {
  const { item, feedback } = props;
  const pin = feedback.pins.find((candidate) => candidate.id === item.id);
  const selected = item.keys.at(-1) === props.selectedKey ? ' is-selected' : '';
  return (
    <div
      className={`feedback-row${item.done ? ' is-done' : ''}${selected}`}
      onClick={() => pin && props.onSelectPin(pin)}
    >
      <span className="feedback-number">{props.number ?? ''}</span>
      <div className="feedback-main">
        <div className="feedback-label">
          {item.label}
          <span className="feedback-where">{item.trail.at(-1) ?? ''}</span>
        </div>
        <div className="feedback-note">{item.note}</div>
      </div>
      <button
        aria-label={item.done ? 'Reopen' : 'Done'}
        onClick={(event) => {
          event.stopPropagation();
          void feedback.toggleDone(item.id);
        }}
      >
        <CheckIcon size={12} />
      </button>
      <button
        aria-label="Remove"
        onClick={(event) => {
          event.stopPropagation();
          void feedback.remove(item.id);
        }}
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );
}
