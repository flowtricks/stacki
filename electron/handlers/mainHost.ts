// What the IPC handler modules use of main.ts: the registrar, the window's
// channel and dialogs, the open project, and the document actors. main.ts owns
// all of it (it holds the window and the module-level state), builds one host,
// and hands each module the part it declares as a Pick of this interface.
//
// Handler modules never import electron's values: the main harness
// (test/helpers/mainHarness.ts) replaces electron for main.js alone, so a
// module that imported it would reach the real one.
import type { OpenDialogOptions, OpenDialogReturnValue } from 'electron';
import type { DocumentActors } from '../documents/documentActors';
import type { createIpcRegistrar } from '../lib/ipcRegistrar';

export interface MainHost {
  readonly ipcMain: { readonly handle: ReturnType<typeof createIpcRegistrar> };
  /** Resolves a path and throws unless it is inside the open project. */
  readonly assertInProject: (filePath: string) => string;
  readonly clipboard: Pick<Electron.Clipboard, 'writeText'>;
  readonly documents: DocumentActors;
  /** The app changed a project file; the canvas may need to hear of it. */
  readonly noteAppWrite: () => void;
  /** The root of the project the app has open, or undefined when none is. */
  readonly openProject: () => string | undefined;
  /** The project the app has open, which file access is scoped to. */
  readonly noteProjectRoot: (projectPath: string) => void;
  /** The trailing-slash mode the project's dev server serves. */
  readonly readTrailingSlash: (projectPath: string) => string;
  /** Sends to the renderer, when its window is open. */
  readonly send: (channel: string, payload?: unknown) => void;
  /** Moves deleted files to the bin, where they can be got back from, shows a file in the file manager, and opens a web page. */
  readonly shell: Pick<Electron.Shell, 'trashItem' | 'showItemInFolder' | 'openExternal'>;
  readonly showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>;
}
