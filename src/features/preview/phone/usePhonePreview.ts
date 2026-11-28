// The state behind the toolbar's phone preview (PhonePreviewMenu.tsx): whether the project's dev server is
// open on the local network, as main holds it (electron/handlers/devServers.ts), and turning it on or off.
//
// Main is the one source of truth. The renderer reads it whenever the preview's address changes (a start,
// a restart, a branch switch) and after every change it asks for, so the toolbar always shows the running
// server's mode, never a guess. Turning it on asks once per window session, in the app's own dialog, because
// it exposes the site to everyone on the Wi-Fi; nothing about it is ever saved, so every launch starts off.
// Turning the preview on lets in only the devices that scan its code (main makes a new key each time); while on, the
// card's settings can open it to anyone on the Wi-Fi (chooseAccess), another restart. Every "on" starts keyed again.
import { useCallback, useEffect, useRef, useState } from 'react';
import { assert } from '../../../../shared/core/assert';
import type { DevNetworkAccess, DevNetworkFailure, DevNetworkMode, DevNetworkRequest, DevNetworkState } from '../../../../shared/ipc/devNetwork';
import type { MessageKey, Translator } from '../../../lib/i18n/localeContext';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import { changeDevNetwork, readDevNetwork } from './phoneBridge';

type PhonePreviewOn = Extract<DevNetworkState, { readonly kind: 'on' }>;

/**
 * What the menu draws: off, on (with the server's port and addresses), or a restart in progress toward one of them.
 * A restart that only changes who may open it keeps the card it had (`keep`, with the access asked for), so the
 * popover does not swap to skeletons and back; a restart that turns it on or off has nothing to keep.
 */
export type PhonePreviewState =
  | { readonly kind: 'off' }
  | {
      readonly kind: 'changing';
      readonly toward: DevNetworkMode;
      readonly keep: { readonly on: PhonePreviewOn; readonly access: DevNetworkAccess } | undefined;
    }
  | PhonePreviewOn;

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
  /** While on: open to anyone on the network, or only to the devices that scan the code. */
  readonly chooseAccess: (access: DevNetworkAccess) => void;
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

  const change = useCallback((request: DevNetworkRequest) => {
    void phonePreviewChange({
      request,
      begin: () => {
        generation.current += 1;
        const current = stateRef.current;
        const keep = request.mode === 'network' && current.kind === 'on' ? { on: current, access: request.access } : undefined;
        setState({ kind: 'changing', toward: request.mode, keep });
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
  }, []);

  const toggle = useCallback(() => {
    const current = stateRef.current;
    if (current.kind === 'changing') {
      return; // One restart at a time; main refuses a second one too.
    }
    // Turned on, only the devices that scan its code get in, with a new key from main; the card's setting can open
    // it to anyone on the network, and that is never remembered. One restart either way.
    change(current.kind === 'on' ? { projectPath, mode: 'local' } : { projectPath, mode: 'network', access: 'key' });
  }, [projectPath, change]);

  const chooseAccess = useCallback(
    (access: DevNetworkAccess) => {
      const current = stateRef.current;
      if (current.kind !== 'on') {
        return; // Only an open preview has an access to choose; the card offers it only then.
      }
      if (current.access.kind === access) {
        return;
      }
      change({ projectPath, mode: 'network', access });
    },
    [projectPath, change],
  );

  return { state, toggle, chooseAccess };
}

// The change itself: the session's one confirmation before the first "on", the restart, and the state it
// leaves. Every failure ends in a toast and the state main reports, so the row never stays half-changed.
async function phonePreviewChange(change: {
  readonly request: DevNetworkRequest;
  readonly begin: () => number;
  readonly finish: (started: number, next: PhonePreviewState) => void;
  readonly fail: (message: string) => void;
  readonly translate: Translator;
}): Promise<void> {
  const { translate, request } = change;
  if (request.mode === 'network' && !confirmedThisSession) {
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
    const reply = await changeDevNetwork(request);
    if (reply.ok) {
      change.finish(started, reply.value);
      return;
    }
    change.fail(translate(FAILURE_MESSAGES[reply.error]));
  } catch (error: unknown) {
    change.fail(translate('preview.phone.error.failed', { message: error instanceof Error ? error.message : String(error) }));
  }
  // Whatever happened, the toolbar shows what main now runs.
  const after = await readDevNetwork(request.projectPath).catch((): PhonePreviewState => ({ kind: 'off' }));
  assert(after.kind !== 'changing', 'phonePreviewChange: main reports a settled mode');
  change.finish(started, after);
}
