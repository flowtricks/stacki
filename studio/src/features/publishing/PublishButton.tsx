import { showPublishingFavicon } from './publishFavicon';
import { usePublishAvailability } from './usePublishAvailability';
import { PublishControl } from '../../../vendor/stacki/src/features/publishing/PublishControl';
import type { PublishTarget } from '../../../vendor/stacki/shared/properties/publishConfig';
import { useEffect, useRef, useState } from 'react';
import { publishProject } from './publishClient';
import type { PublishState } from './publish';
import { PublishStatus } from '../../../vendor/stacki/src/features/publishing/PublishStatus';
import { publishStatusView, STUDIO_PUBLISH_RUNNING_NOTE_KEY } from './publishStatusView';
import { useTranslate, useTranslateDescribed } from '../../../vendor/stacki/src/lib/i18n/useTranslate';
import type { Described, Translator } from '../../../vendor/stacki/shared/properties/i18n/messageRef';
import { useSharedPublish } from './sharedPublish';
import './publish.css';

export function PublishButton({ report }: { report: (error: unknown) => void }) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
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
      report(publishMessage(state, translate, translateDescribed));
    } catch (error) {
      if (!controller.signal.aborted) {
        setFailed(true);
        report(error);
      }
    } finally {
      active.current = undefined;
      if (!controller.signal.aborted) {
        setBusy(false);
        // Recheck at once: the shared broadcast may never change (the demo has none), and the
        // button must grey out as soon as nothing is left to push or deploy.
        availability.refresh();
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
      {visible && <PublishStatusPopup state={state} failed={failed} close={() => setVisible(false)} />}
    </div>
  );
}

// The same popup Desktop shows; only the job status is translated.
function PublishStatusPopup({ state, failed, close }: { readonly state: PublishState | undefined; readonly failed: boolean; readonly close: () => void }) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const view = publishStatusView(state, failed ? 'interrupted' : 'running');
  const note = view.noteParts === undefined ? view.note : view.noteParts.map((part) => translateDescribed(part)).join(' ');
  return <PublishStatus state={view.state} close={close} runningNote={translate(STUDIO_PUBLISH_RUNNING_NOTE_KEY)} {...(note === undefined ? {} : { note })} />;
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

function publishMessage(state: PublishState, translate: Translator, translateDescribed: (problem: Described) => string): string | Error {
  if (state.kind === 'failed') {
    return new Error(translateDescribed(state));
  }
  if (state.kind === 'review-open') {
    return translate('publish.studio.toast.reviewReady');
  }
  if (state.kind !== 'committed') {
    return translate('publish.studio.toast.started');
  }
  const message =
    state.deployment === 'live'
      ? translate('publish.studio.toast.live')
      : state.deployment === 'pending'
        ? translate('publish.studio.toast.unconfirmed')
        : translate('publish.studio.toast.notConnected');
  return message + (state.cleanupWarning ? ' ' + translateDescribed({ message: state.cleanupWarning, messageRef: state.cleanupWarningRef }) : '');
}
