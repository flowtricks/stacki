// The state behind the toolbar's phone preview (PhonePreviewMenu.tsx): whether the project's dev server is
// open on the local network, as main holds it (electron/handlers/devServers.ts), and turning it on or off.
//
// Main is the one source of truth. The renderer reads it whenever the preview's address changes (a start,
// a restart, a branch switch) and after every change it asks for, so the toolbar always shows the running
// server's mode, never a guess. Turning it on asks once per window session, in the app's own dialog, because
// it exposes the site to everyone on the Wi-Fi; nothing about it is ever saved, so every launch starts off.
import { useCallback, useEffect, useRef, useState } from 'react';
import { assert } from '../../../../shared/core/assert';
import type { DevNetworkFailure, DevNetworkMode, DevNetworkState } from '../../../../shared/ipc/devNetwork';
import type { MessageKey, Translator } from '../../../lib/i18n/localeContext';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import { changeDevNetwork, readDevNetwork } from './phoneBridge';

/** What the menu draws: off, on (with the server's port and addresses), or a restart in progress toward one of them. */
export type PhonePreviewState =
  { readonly kind: 'off' } | { readonly kind: 'changing'; readonly toward: DevNetworkMode } | Extract<DevNetworkState, { readonly kind: 'on' }>;

export interface PhonePreviewInput {
  readonly projectPath: string;
  /** The canvas's own (loopback) address; undefined while no dev server runs. */
  readonly devUrl: string | undefined;
  readonly showToast: (message: string, kind: 'error') => void;
  readonly translate: Translator;
}

export interface PhonePreview {
  readonly state: PhonePreviewState;
  readonly toggle: () => void;
}

const FAILURE_MESSAGES: Readonly<Record<DevNetworkFailure, MessageKey>> = {
  'no-address': 'preview.phone.error.noAddress',
  'no-server': 'preview.phone.error.noServer',
  external: 'preview.phone.error.external',
  busy: 'preview.phone.error.busy',
  'restart-failed': 'preview.phone.error.restart',
};

// Whether this window has asked already. A module value, not a preference: a reload (the project closing)
// asks again, and nothing is written anywhere.
let confirmedThisSession = false;

export function usePhonePreview({ projectPath, devUrl, showToast, translate }: PhonePreviewInput): PhonePreview {
  const [state, setState] = useState<PhonePreviewState>({ kind: 'off' });
  // A reply for an older project or address is dropped: each read and change carries the generation it began in.
  const generation = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const toastRef = useRef({ showToast, translate });
  toastRef.current = { showToast, translate };

  useEffect(() => {
    generation.current += 1;
    const started = generation.current;
    if (devUrl === undefined) {
      setState({ kind: 'off' });
      return;
    }
    readDevNetwork(projectPath).then(
      (read) => {
        if (generation.current === started) {
          setState(read);
        }
      },
      () => undefined, // The toolbar keeps what it shows; the next address change reads again.
    );
  }, [projectPath, devUrl]);

  const toggle = useCallback(() => {
    const current = stateRef.current;
    if (current.kind === 'changing') {
      return; // One restart at a time; main refuses a second one too.
    }
    const toward: DevNetworkMode = current.kind === 'on' ? 'local' : 'network';
    void phonePreviewChange({
      projectPath,
      toward,
      begin: () => {
        generation.current += 1;
        setState({ kind: 'changing', toward });
        return generation.current;
      },
      finish: (started, next) => {
        if (generation.current === started) {
          setState(next);
        }
      },
      fail: (message) => toastRef.current.showToast(message, 'error'),
      translate: toastRef.current.translate,
    });
  }, [projectPath]);

  return { state, toggle };
}

// The change itself: the session's one confirmation before the first "on", the restart, and the state it
// leaves. Every failure ends in a toast and the state main reports, so the row never stays half-changed.
async function phonePreviewChange(change: {
  readonly projectPath: string;
  readonly toward: DevNetworkMode;
  readonly begin: () => number;
  readonly finish: (started: number, next: PhonePreviewState) => void;
  readonly fail: (message: string) => void;
  readonly translate: Translator;
}): Promise<void> {
  const { translate } = change;
  if (change.toward === 'network' && !confirmedThisSession) {
    const answer = await confirmDialog({
      title: translate('preview.phone.confirm.title'),
      body: translate('preview.phone.confirm.body'),
      confirmLabel: translate('preview.phone.confirm.turnOn'),
    });
    if (answer === false) {
      return;
    }
    confirmedThisSession = true;
  }
  const started = change.begin();
  try {
    const reply = await changeDevNetwork(change.projectPath, change.toward);
    if (reply.ok) {
      change.finish(started, reply.value);
      return;
    }
    change.fail(translate(FAILURE_MESSAGES[reply.error]));
  } catch (error: unknown) {
    change.fail(translate('preview.phone.error.failed', { message: error instanceof Error ? error.message : String(error) }));
  }
  // Whatever happened, the toolbar shows what main now runs.
  const after = await readDevNetwork(change.projectPath).catch((): PhonePreviewState => ({ kind: 'off' }));
  assert(after.kind !== 'changing', 'phonePreviewChange: main reports a settled mode');
  change.finish(started, after);
}
