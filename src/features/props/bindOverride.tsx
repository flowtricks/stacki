// The data picker's override point, `cms.bind` (docs/apps.md, "Overrides"): while
// a running app answers it, opening a field's picker, pressing a data chip to
// re-edit it (BindFieldMenu in propBindings.tsx) or a loop's Source asks the app
// first. A path it answers is applied through the picker's own `onPick`, the
// same call a click on a row makes; `default` shows Stacki's picker; `cancel`
// closes it. Alt held at the press, or "Use Stacki's picker" while waiting, skips
// the app.
import { useTranslate } from '../../lib/i18n/useTranslate';
import { useEffect, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { APP_RPC_LIMITS, type AppOverrideContexts } from '../../../shared/properties/appsRpc';
import { altHeldAtLastPress, askAppOverride, useAppOverrideOwner, type AppOverrideCall } from '../../ui/appOverrideSlot';
import type { PickerNode } from './DataPicker';
import '../../ui/overrideNote.css';

type BindContext = Omit<AppOverrideContexts['cms.bind'], 'selection'>;

/** Whether the picker waits on an app, and how the person stops waiting. */
export type BindOverrideState = { readonly kind: 'stacki' } | { readonly kind: 'waiting'; readonly owner: string; readonly useStacki: () => void };

/** For a picker that is mounted when it opens: asks the owning app once, on open. */
export function useBindOverride(handlers: {
  /** The context, read when the request is sent. */
  readonly ask: () => BindContext;
  readonly onPicked: (path: string) => void;
  readonly onCancel: () => void;
}): BindOverrideState {
  const owner = useAppOverrideOwner('cms.bind');
  const [phase, setPhase] = useState<'ask' | 'stacki'>(() => (owner === undefined || altHeldAtLastPress() ? 'stacki' : 'ask'));
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    if (phase !== 'ask') {
      return undefined;
    }
    let live = true;
    const call = askAppOverride({ point: 'cms.bind', context: latest.current.ask() }, { bypass: false });
    void call.answer.then((answer) => {
      if (!live) {
        return;
      }
      assert(answer.point === 'cms.bind', 'A binding is answered at its own point');
      const { result } = answer;
      switch (result.kind) {
        case 'picked':
          latest.current.onPicked(result.path);
          return;
        case 'cancel':
          latest.current.onCancel();
          return;
        case 'default':
          setPhase('stacki');
          return;
        default: {
          const exhaustive: never = result;
          return exhaustive;
        }
      }
    });
    // Closing the picker, or choosing Stacki's, tells the app to close its own.
    return () => {
      live = false;
      call.cancel();
    };
  }, [phase]);
  if (phase === 'ask' && owner !== undefined) {
    return { kind: 'waiting', owner, useStacki: () => setPhase('stacki') };
  }
  return { kind: 'stacki' };
}

/** For a picker opened by a button the caller owns (a loop's Source): asks on press, keeps the call to cancel. */
export function useBindOverrideOnPress(): {
  readonly owner: string | undefined;
  readonly ask: (context: BindContext, handlers: { readonly onPicked: (path: string) => void; readonly onStacki: () => void }) => void;
} {
  const owner = useAppOverrideOwner('cms.bind');
  const pending = useRef<AppOverrideCall | undefined>(undefined);
  useEffect(() => () => pending.current?.cancel(), []);
  const ask = (context: BindContext, handlers: { readonly onPicked: (path: string) => void; readonly onStacki: () => void }): void => {
    pending.current?.cancel();
    const call = askAppOverride({ point: 'cms.bind', context }, { bypass: false });
    pending.current = call;
    void call.answer.then((answer) => {
      if (pending.current !== call) {
        return; // A later press replaced this one.
      }
      pending.current = undefined;
      assert(answer.point === 'cms.bind', 'A binding is answered at its own point');
      const { result } = answer;
      switch (result.kind) {
        case 'picked':
          handlers.onPicked(result.path);
          return;
        case 'cancel':
          return;
        case 'default':
          handlers.onStacki();
          return;
        default: {
          const exhaustive: never = result;
          return exhaustive;
        }
      }
    });
  };
  return { owner, ask };
}

/** What the picker shows while an app answers it. */
export function BindOverrideWaiting({ owner, onStacki }: { readonly owner: string; readonly onStacki: () => void }) {
  const translate = useTranslate();
  return (
    <div className="dp-override" role="status">
      <span>{translate('props.override.choosing', { owner })}</span>
      <button type="button" className="dp-new-prop" onClick={onStacki}>
        {translate('props.override.useStacki')}
      </button>
    </div>
  );
}

/** The paths a picker offers, breadth first and bounded, for the app's context. */
export function pickerPaths(tree: readonly PickerNode[]): readonly string[] {
  const paths: string[] = [];
  const queue: PickerNode[] = [...tree];
  for (let index = 0; index < queue.length; index += 1) {
    if (paths.length >= APP_RPC_LIMITS.overridePathsMax) {
      break;
    }
    const node = queue[index];
    assert(node !== undefined, 'The queue has no holes');
    if (node.path.length > 0 && node.path.length <= APP_RPC_LIMITS.bindingPathCharsMax) {
      paths.push(node.path);
    }
    // Children past the bound are never read, so the queue stays within a few times the bound.
    if (queue.length < APP_RPC_LIMITS.overridePathsMax * 4) {
      queue.push(...(node.children ?? []));
    }
  }
  assert(paths.length <= APP_RPC_LIMITS.overridePathsMax, 'Override paths are bounded');
  return paths;
}
