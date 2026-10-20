import React from 'react';
import type { TrailedFeedbackItem } from '../../../shared/ipc/feedback';
import { CheckIcon, CloseIcon } from '../../ui/Icons';
import { renderHandoff } from './feedbackBridge';
import type { useFeedback } from './feedbackState';
import './feedback.css';

interface FeedbackPanelProps {
  readonly feedback: ReturnType<typeof useFeedback>['feedback'];
  readonly projectPath: string;
  readonly showToast: (message: string, kind: 'success' | 'error') => void;
}

// The notes left on the canvas, kept in .stacki/feedback.json for a coding
// agent: click an element and type; Copy for agent hands them over.
export default function FeedbackPanel(props: FeedbackPanelProps) {
  const { feedback } = props;
  const open = feedback.items.filter((item) => !item.done);
  const done = feedback.items.filter((item) => item.done);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(renderHandoff(feedback.items, props.projectPath));
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
        <p className="feedback-hint">Click an element on the canvas to leave a note on it.</p>
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
  // A row with a pin on this page opens it, so the note shows where it was left.
  const pinned = feedback.pins.some((pin) => pin.id === item.id);
  const open = feedback.openPinId === item.id ? ' is-selected' : '';
  return (
    <div
      className={`feedback-row${item.done ? ' is-done' : ''}${open}`}
      onClick={() => pinned && feedback.setOpenPinId(open ? undefined : item.id)}
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
