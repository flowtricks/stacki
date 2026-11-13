// Gives a handler registrar the one thing Electron's `invoke` loses: the reference to a sentence we wrote. A rejected `invoke` reaches the
// renderer as `Error invoking remote method ...: Error: <message>`; every other property of the thrown error is dropped, so a refusal
// that carries a `messageRef` (a `ReferencedError`, or an error given that property) would arrive as English only. The wrapper appends
// the reference to the message (shared/core/i18n/referencedMessage.ts) and the renderer's `translateErrorText` reads it back. Errors
// without a reference pass through untouched, so git's own words and every other handler behave exactly as before.
import { referenceOfError, withReferencedMessage } from '../../shared/core/i18n/referencedMessage';
import type { createIpcRegistrar } from './ipcRegistrar';

type Registrar = ReturnType<typeof createIpcRegistrar>;

/** The error to reject with: the same error, or a copy whose message ends with its reference. */
export function referencedFailure(error: unknown): unknown {
  const reference = referenceOfError(error);
  if (reference === undefined || !(error instanceof Error)) {
    return error;
  }
  return new Error(withReferencedMessage(error.message, reference), { cause: error });
}

export function referencingIpc(ipcMain: { readonly handle: Registrar }): { readonly handle: Registrar } {
  const handle: Registrar = (channel, listener) => {
    ipcMain.handle(channel, async (event, payload) => {
      try {
        return await listener(event, payload);
      } catch (error: unknown) {
        throw referencedFailure(error);
      }
    });
  };
  return { handle };
}
