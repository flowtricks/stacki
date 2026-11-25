// The renderer's side of the update channels. Every value from main is parsed before it reaches a component
// (docs/contracts.md, "Update popup"): a payload that breaks the contract throws here, not in the popup.
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { parseUpdateEvent, parseUpdateState, type UpdateAction, type UpdateEvent, type UpdateState } from '../../../shared/ipc/updateState';

/** What the popup needs from main; tests and the harness hand in their own. */
export interface UpdateBridge {
  readonly read: () => Promise<UpdateState>;
  readonly subscribe: (callback: (event: UpdateEvent) => void) => () => void;
  readonly act: (action: UpdateAction) => Promise<void>;
}

export const mainUpdateBridge: UpdateBridge = {
  read: async () => parseUpdateState(await window.avb.readUpdateState()),
  subscribe: (callback) => window.avb.onUpdateState((input) => callback(parseUpdateEvent(input))),
  act: async (action) => {
    await window.avb.actOnUpdate(parseIpcPayload('update:act', { action }));
  },
};
