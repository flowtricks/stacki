// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the bar over the canvas while the mode is on.
//
// It names the mode (and says nothing is saved), lists the frames (click to show one, double-click to rename),
// and holds the session's actions: duplicate the shown frame, compare every frame side by side, send them to the
// AI, leave, and start over. Placed over the canvas column's foot, so the editor's own canvas controls stay free.
import { useEffect, useState, type KeyboardEvent } from 'react';
import { centralIcon } from '../../ui/central/CentralIcon';
import { add, arrowRotateCounterClockwise, close, columns, sparkle } from '../../ui/central/centralGeometry';
import TipAnchor from '../../ui/TipAnchor';
import { DESIGN_SESSION_LIMITS, type DesignFrameView, type DesignSessionState } from '../../../shared/ipc/designSession';
import { exitDesignMode, frameAction, pictureActive, type DesignHostSource } from './designActions';
import { updateDesignView, type DesignPhase } from './designStore';
import { useDesignWords } from './i18n/designWords';
import { useCanvasColumn } from './useCanvasColumn';

const AddIcon = centralIcon(add);
const CloseIcon = centralIcon(close);
const CompareIcon = centralIcon(columns);
const SendIcon = centralIcon(sparkle);
const StartOverIcon = centralIcon(arrowRotateCounterClockwise);

type OnSession = Extract<DesignSessionState, { kind: 'on' }>;

export function DesignBar({ app, session, phase }: { readonly app: DesignHostSource; readonly session: OnSession; readonly phase: DesignPhase }) {
  const words = useDesignWords();
  const column = useCanvasColumn();
  const [confirming, setConfirming] = useState<'no' | 'yes'>('no');
  const busy = phase === 'leaving';
  const full = session.frames.length >= DESIGN_SESSION_LIMITS.framesMax;
  useEffect(() => {
    if (confirming === 'no') {
      return undefined;
    }
    const timer = window.setTimeout(() => setConfirming('no'), 4_000);
    return () => window.clearTimeout(timer);
  }, [confirming]);
  const compare = async (): Promise<void> => {
    await pictureActive(app, session);
    updateDesignView((view) => ({ ...view, board: view.board === 'open' ? 'closed' : 'open' }));
  };
  return (
    <div className="dm-bar" data-design-mode="" style={column} role="toolbar" aria-label={words('bar.label')}>
      <TipAnchor text={words('bar.tip')}>
        <span className="dm-badge">{words('bar.label')}</span>
      </TipAnchor>
      <div className="dm-frames" role="tablist" aria-label={words('bar.frames')}>
        {session.frames.map((frame) => (
          <FrameTab key={frame.id} app={app} frame={frame} active={frame.id === session.active} removable={session.frames.length > 1} />
        ))}
      </div>
      <TipAnchor text={full ? words('toast.frameLimit', { count: DESIGN_SESSION_LIMITS.framesMax }) : words('bar.duplicateTip')}>
        <button
          type="button"
          className="dm-icon"
          aria-label={words('bar.duplicate')}
          disabled={busy || full}
          onClick={() => void frameAction(app, words, { op: 'duplicate' })}
        >
          <AddIcon size={16} />
        </button>
      </TipAnchor>
      <TipAnchor text={words('bar.compareTip')}>
        <button type="button" className="dm-button" disabled={busy} onClick={() => void compare()}>
          <CompareIcon size={16} />
          <span>{words('bar.compare')}</span>
        </button>
      </TipAnchor>
      <TipAnchor text={confirming === 'yes' ? undefined : words('bar.startOverTip')}>
        <button
          type="button"
          className={confirming === 'yes' ? 'dm-button is-confirming' : 'dm-icon'}
          aria-label={words('bar.startOver')}
          disabled={busy}
          onClick={() => {
            if (confirming === 'yes') {
              setConfirming('no');
              void frameAction(app, words, { op: 'start-over' });
            } else {
              setConfirming('yes');
            }
          }}
        >
          <StartOverIcon size={16} />
          {confirming === 'yes' && <span>{words('bar.startOverConfirm')}</span>}
        </button>
      </TipAnchor>
      <TipAnchor text={words('bar.sendTip')}>
        <button type="button" className="dm-button is-primary" disabled={busy} onClick={() => void exitDesignMode(app, words, 'send')}>
          <SendIcon size={16} />
          <span>{words('bar.send')}</span>
        </button>
      </TipAnchor>
      <TipAnchor text={words('bar.exitTip')}>
        <button type="button" className="dm-button" disabled={busy} onClick={() => void exitDesignMode(app, words, 'keep')}>
          <span>{words('bar.exit')}</span>
        </button>
      </TipAnchor>
    </div>
  );
}

function FrameTab({
  app,
  frame,
  active,
  removable,
}: {
  readonly app: DesignHostSource;
  readonly frame: DesignFrameView;
  readonly active: boolean;
  readonly removable: boolean;
}) {
  const words = useDesignWords();
  const [editing, setEditing] = useState<'no' | 'yes'>('no');
  const [draft, setDraft] = useState(frame.name);
  const finish = (save: 'save' | 'cancel'): void => {
    setEditing('no');
    const name = draft.trim();
    if (save === 'save' && name.length > 0 && name !== frame.name) {
      void frameAction(app, words, { op: 'rename', frame: frame.id, name: name.slice(0, DESIGN_SESSION_LIMITS.frameNameCharsMax) });
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish('save');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish('cancel');
    }
  };
  const tip = frame.changedFiles === 0 ? words('frame.unchanged') : words('frame.changes', { count: frame.changedFiles });
  if (editing === 'yes') {
    return (
      <input
        className="dm-tab-input"
        aria-label={words('frame.renameLabel')}
        value={draft}
        maxLength={DESIGN_SESSION_LIMITS.frameNameCharsMax}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => finish('save')}
        onKeyDown={onKeyDown}
      />
    );
  }
  return (
    <span className={active ? 'dm-tab is-active' : 'dm-tab'}>
      <TipAnchor text={tip}>
        <button
          type="button"
          role="tab"
          aria-selected={active}
          className="dm-tab-name"
          onClick={() => {
            if (!active) {
              void frameAction(app, words, { op: 'switch', frame: frame.id });
            }
          }}
          onDoubleClick={() => {
            setDraft(frame.name);
            setEditing('yes');
          }}
        >
          {frame.name}
        </button>
      </TipAnchor>
      {removable && (
        <TipAnchor text={words('frame.delete')}>
          <button
            type="button"
            className="dm-tab-close"
            aria-label={words('frame.delete')}
            onClick={() => void frameAction(app, words, { op: 'delete', frame: frame.id })}
          >
            <CloseIcon size={12} />
          </button>
        </TipAnchor>
      )}
    </span>
  );
}
