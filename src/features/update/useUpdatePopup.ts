// The popup's state: what main last said, and whether the person hid it. A hidden download stays hidden while it only
// advances (shared/ipc/updateState.ts nextUpdateHidden); news shows it again.
import { useCallback, useEffect, useRef, useState } from 'react';
import { nextUpdateHidden, type UpdateAction, type UpdateState } from '../../../shared/ipc/updateState';
import type { UpdateBridge } from './updateBridge';

export interface UpdatePopupModel {
  readonly state: UpdateState;
  readonly hidden: boolean;
  readonly hide: () => void;
  readonly act: (action: UpdateAction) => void;
}

interface View {
  readonly state: UpdateState;
  readonly hidden: boolean;
}

const IDLE: View = { state: { kind: 'idle' }, hidden: false };

export function useUpdatePopup(bridge: UpdateBridge): UpdatePopupModel {
  const [view, setView] = useState<View>(IDLE);
  // An event that arrives while the first read is in flight is newer than the read's answer.
  const heardEvent = useRef(false);

  useEffect(() => {
    heardEvent.current = false;
    const unsubscribe = bridge.subscribe((event) => {
      heardEvent.current = true;
      setView((previous) => ({ state: event.state, hidden: nextUpdateHidden(event, previous) }));
    });
    let current = true;
    bridge.read().then(
      (state) => {
        if (current && !heardEvent.current) {
          setView({ state, hidden: false });
        }
      },
      (failure: unknown) => {
        console.error('[update] the update state could not be read:', failure);
      },
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, [bridge]);

  const hide = useCallback(() => setView((previous) => ({ ...previous, hidden: true })), []);
  const act = useCallback(
    (action: UpdateAction) => {
      bridge.act(action).catch((failure: unknown) => {
        console.error('[update] the update action failed:', failure);
      });
    },
    [bridge],
  );
  return { state: view.state, hidden: view.hidden, hide, act };
}
