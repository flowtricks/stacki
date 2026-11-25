// The override dispatcher (docs/apps.md, "Overrides"): which running app answers
// an override point, and the requests Stacki has sent it. Every override point
// (src/ui/appOverrideSlot.ts) asks through `dispatch`, so a new point is one
// entry in APP_OVERRIDE_POINTS and its feature below.
//
// Rules, each enforced here:
// - One owner per point: the latest registration of a running app the role may
//   use. Earlier registrations queue behind it and own the point again when it
//   unregisters, closes or reloads.
// - A role that lacks the point's feature (the Assets panel, the CMS) gets
//   Stacki's own picker: an app cannot reach past the role.
// - A request is answered within APP_RPC_LIMITS.overrideTimeoutMs, or it is
//   `default`; so is a request whose app closes, crashes or reloads first.
// - At most APP_RPC_LIMITS.overrideCallsMax requests wait on one app.
import { assert } from '../../../shared/core/assert';
import { can, type RoleView } from '../../../shared/properties/projectRoles';
import {
  APP_OVERRIDE_POINTS,
  APP_RPC_LIMITS,
  appAccessFeature,
  defaultAnswer,
  eventMessage,
  fallbackAnswer,
  type AppEditOutcome,
  type AppHostMessage,
  type AppOverrideAnswer,
  type AppOverridePoint,
  type AppOverrideRequest,
} from '../../../shared/properties/appsRpc';
import { canPanel } from '../../lib/roleAccess';
import type { AppOverrideAsk, AppOverrideCall, AppOverrideSlot } from '../../ui/appOverrideSlot';
import type { AppOverrideRegistry, AppSession } from './appRpcHost';

/** The panel a role must see for an app to answer each point in its place. */
const POINT_PANELS = { 'assets.pick': 'assets', 'cms.bind': 'cms' } as const satisfies Record<AppOverridePoint, string>;

export interface AppOverrideDependencies {
  /** Sends a message to the session's frame. */
  readonly post: (session: AppSession, message: AppHostMessage) => void;
  /** The current role; undefined before the host configures one. */
  readonly role: () => RoleView | undefined;
  readonly running: (appId: string) => boolean;
  /** The selected element, which `cms.bind` reports. */
  readonly selection: () => string | undefined;
  readonly timeoutMs: number;
}

export interface AppOverrides extends AppOverrideRegistry {
  /** The session that answers `point` now, if any. */
  readonly ownerOf: (point: AppOverridePoint) => AppSession | undefined;
  readonly dispatch: (ask: AppOverrideAsk) => AppOverrideCall;
  /** A frame went away or reloaded: its registrations end and its requests answer `default`. */
  readonly drop: (session: AppSession) => void;
  /** Running apps or the role changed: requests to apps that stopped answer `default`, and owners are told. */
  readonly changed: () => void;
  readonly subscribe: (listener: () => void) => () => void;
  /** Requests waiting, for tests and bounds. */
  readonly waiting: () => number;
}

interface Registration {
  readonly session: AppSession;
  readonly point: AppOverridePoint;
}

interface Waiting {
  readonly point: AppOverridePoint;
  readonly session: AppSession;
  readonly settle: (answer: AppOverrideAnswer) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** How a request ends: the app is told to close its picker unless it answered or went away. */
type Ending = 'answered' | 'tell-app';

export function createAppOverrides(dependencies: AppOverrideDependencies): AppOverrides {
  assert(dependencies.timeoutMs > 0, 'An override waits a positive time');
  assert(dependencies.timeoutMs <= APP_RPC_LIMITS.overrideTimeoutMs, 'An override never waits past the limit');
  const queue: Registration[] = [];
  const waiting = new Map<number, Waiting>();
  const listeners = new Set<() => void>();
  let nextCall = 1;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const ownerOf = (point: AppOverridePoint): AppSession | undefined => {
    const role = dependencies.role();
    if (role === undefined) {
      return undefined;
    }
    if (!canPanel(role, POINT_PANELS[point])) {
      return undefined; // The role lacks the feature: Stacki's own UI decides what it may do.
    }
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const entry = queue[index];
      assert(entry !== undefined, 'The queue has no holes');
      if (entry.point === point) {
        const appId = entry.session.app.manifest.id;
        if (dependencies.running(appId)) {
          if (can(role, appAccessFeature(appId))) {
            return entry.session;
          }
        }
      }
    }
    return undefined;
  };

  const finish = (call: number, answer: AppOverrideAnswer, ending: Ending): void => {
    const entry = waiting.get(call);
    if (entry === undefined) {
      return; // Already answered: the first answer wins.
    }
    assert(entry.point === answer.point, 'A request is answered at its own point');
    waiting.delete(call);
    clearTimeout(entry.timer);
    if (ending === 'tell-app') {
      dependencies.post(entry.session, eventMessage('override.cancel', { call }));
    }
    entry.settle(answer);
  };

  const dispatch = (ask: AppOverrideAsk): AppOverrideCall => {
    const owner = ownerOf(ask.point);
    if (owner === undefined) {
      return settled(defaultAnswer(ask.point));
    }
    const appId = owner.app.manifest.id;
    if ([...waiting.values()].filter((entry) => entry.session.app.manifest.id === appId).length >= APP_RPC_LIMITS.overrideCallsMax) {
      return settled(defaultAnswer(ask.point));
    }
    const call = nextCall;
    nextCall += 1;
    assert(Number.isSafeInteger(call), 'Call ids stay safe integers');
    const request = requestOf(ask, dependencies.selection());
    const answer = new Promise<AppOverrideAnswer>((resolve) => {
      const timer = setTimeout(() => finish(call, defaultAnswer(ask.point), 'tell-app'), dependencies.timeoutMs);
      waiting.set(call, { point: ask.point, session: owner, settle: resolve, timer });
    });
    assert(waiting.size <= APP_RPC_LIMITS.overrideCallsMax * APP_RPC_LIMITS.overrideQueueMax, 'Waiting requests are bounded');
    dependencies.post(owner, eventMessage('override.request', { call, ...request }));
    return { answer, cancel: () => finish(call, fallbackAnswer(ask.point, { kind: 'cancel' }), 'tell-app') };
  };

  return {
    ownerOf,
    dispatch,
    register: (session, point) => {
      removeRegistration(queue, session, point);
      queue.push({ session, point });
      assert(queue.filter((entry) => entry.point === point).length <= APP_RPC_LIMITS.overrideQueueMax, 'An override queue is bounded by the frames');
      notify();
      return { owner: ownerOf(point) === session };
    },
    unregister: (session, point) => {
      removeRegistration(queue, session, point);
      notify();
    },
    resolve: (session, call, answer): AppEditOutcome => {
      const entry = waiting.get(call);
      if (entry === undefined) {
        return { applied: false, reason: 'Stacki is no longer waiting for that answer' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
      }
      // Any frame of the app may answer: the picker can be a custom frame of its own.
      if (entry.session.app.manifest.id !== session.app.manifest.id) {
        return { applied: false, reason: 'That request was sent to another app' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
      }
      if (entry.point !== answer.point) {
        return { applied: false, reason: `That request is for ${entry.point}` }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
      }
      finish(call, answer, 'answered');
      return { applied: true };
    },
    drop: (session) => {
      for (const point of APP_OVERRIDE_POINTS) {
        removeRegistration(queue, session, point);
      }
      for (const [call, entry] of [...waiting]) {
        if (entry.session === session) {
          finish(call, defaultAnswer(entry.point), 'answered');
        }
      }
      notify();
    },
    changed: () => {
      for (const [call, entry] of [...waiting]) {
        if (!dependencies.running(entry.session.app.manifest.id)) {
          finish(call, defaultAnswer(entry.point), 'answered');
        }
      }
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    waiting: () => waiting.size,
  };
}

/** The slot the pickers ask through: owners by app name. */
export function overrideSlotOf(overrides: AppOverrides): AppOverrideSlot {
  return {
    owner: (point) => overrides.ownerOf(point)?.app.manifest.name,
    dispatch: overrides.dispatch,
    subscribe: overrides.subscribe,
  };
}

function settled(answer: AppOverrideAnswer): AppOverrideCall {
  return { answer: Promise.resolve(answer), cancel: () => undefined };
}

// The request as the app hears it: `cms.bind` also says what is selected.
function requestOf(ask: AppOverrideAsk, selection: string | undefined): AppOverrideRequest {
  switch (ask.point) {
    case 'assets.pick':
      return ask;
    case 'cms.bind':
      return { point: ask.point, context: { ...ask.context, selection } };
    default: {
      const exhaustive: never = ask;
      return exhaustive;
    }
  }
}

function removeRegistration(queue: Registration[], session: AppSession, point: AppOverridePoint): void {
  const index = queue.findIndex((entry) => entry.session === session && entry.point === point);
  if (index >= 0) {
    queue.splice(index, 1);
  }
  assert(!queue.some((entry) => entry.session === session && entry.point === point), 'A session registers a point at most once');
}
