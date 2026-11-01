import { showPublishingFavicon } from './publishFavicon';
import { usePublishAvailability } from './usePublishAvailability';
import { PublishControl } from '../../../vendor/stacki/src/features/publishing/PublishControl';
import type { PublishTarget } from '../../../vendor/stacki/shared/properties/publishConfig';
import { useEffect, useRef, useState } from 'react';
import { publishProject } from './publishClient';
import type { PublishState } from './publish';
import { PublishProgress } from './PublishProgress';
import { useSharedPublish } from './sharedPublish';
import './publish.css';

export function PublishButton({ report }: { report: (error: unknown) => void }) {
  const [ownBusy, setBusy] = useState(false);
  const shared = useSharedPublish();
  const availability = usePublishAvailability(shared);
  const busy = ownBusy || shared.kind === 'building';
  useEffect(() => {
    if (busy) {
      return showPublishingFavicon(document);
    }
    return undefined;
  }, [busy]);
  const [state, setState] = useState<PublishState>();
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(false);
  const active = useRef<AbortController>();
  usePublishBroadcast(shared, setState, setVisible, setFailed);
  useEffect(() => () => active.current?.abort(), []);
  async function publish(target: PublishTarget) {
    if (active.current && !active.current.signal.aborted) {
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setState(undefined);
    setFailed(false);
    setVisible(true);
    try {
      const state = await publishProject(controller.signal, target, setState);
      report(publishMessage(state));
    } catch (error) {
      if (!controller.signal.aborted) {
        setFailed(true);
        report(error);
      }
    } finally {
      active.current = undefined;
      if (!controller.signal.aborted) {
        setBusy(false);
      }
    }
  }
  return (
    <div className="publish-control">
      <PublishControl
        projectPath=""
        busy={busy}
        publish={(target) => void publish(target)}
        availability={availability.availability}
        refreshAvailability={availability.refresh}
        settingsClosed={availability.refresh}
      />
      {visible && <PublishProgress state={state} busy={busy} failed={failed} dismiss={() => setVisible(false)} />}
    </div>
  );
}

function usePublishBroadcast(
  shared: PublishState,
  setState: (state: PublishState | undefined) => void,
  setVisible: (visible: boolean) => void,
  setFailed: (failed: boolean) => void,
) {
  const observed = useRef('');
  useEffect(() => {
    if (shared.kind === 'building') {
      observed.current = shared.id;
      setState(shared);
      setVisible(true);
      setFailed(false);
    } else if (observed.current && shared.kind === 'idle') {
      setState(undefined);
      setFailed(true);
      observed.current = '';
    } else if ('id' in shared && shared.id === observed.current) {
      setState(shared);
      setFailed(shared.kind === 'failed');
    }
  }, [shared, setState, setVisible, setFailed]);
}

function publishMessage(state: PublishState): string | Error {
  if (state.kind === 'failed') {
    return new Error(state.message);
  }
  if (state.kind === 'review-open') {
    return 'Pull request ready for review.';
  }
  if (state.kind !== 'committed') {
    return 'Publish started';
  }
  const message =
    state.deployment === 'live'
      ? 'Published. Your changes are live.'
      : state.deployment === 'pending'
        ? 'Saved to GitHub. Live deployment is still unconfirmed; check your hosting provider.'
        : 'Saved to GitHub. Automatic live deployment is not connected.';
  return message + (state.cleanupWarning ? ' ' + state.cleanupWarning : '');
}
