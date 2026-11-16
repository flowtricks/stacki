// Chromium can finish a failed iframe navigation with an empty error document.
// Report that failure even when the dev server has recovered before the next probe.
import { parsePreviewFailure } from '../../shared/ipc/previewFailure';

// The two events of Electron's WebContents this reads, as the one interface a fake can stand in for.
interface PreviewContents {
  on(event: 'did-fail-load', listener: (event: unknown, code: number, description: string, address: string, mainFrame: boolean) => void): void;
  on(
    event: 'did-frame-navigate',
    listener: (event: unknown, address: string, httpResponseCode: number, httpStatusText: string, mainFrame: boolean) => void,
  ): void;
  send(channel: string, payload: string): void;
}

// A page that throws while the server renders it answers with an error status and loads as a document, so the
// navigation does not fail: the status is the only sign, and it is the one a person's last edit usually caused.
const SERVER_ERROR_STATUS_MIN = 500;

export function listenForPreviewFailures(contents: PreviewContents, previewURL: () => string | undefined): void {
  const report = (address: string): void => {
    const current = previewURL();
    if (!current) {
      return;
    }
    let failed: string;
    try {
      failed = parsePreviewFailure(address);
    } catch {
      return;
    }
    if (new URL(failed).origin === new URL(current).origin) {
      contents.send('dev:preview-failed', failed);
    }
  };
  contents.on('did-fail-load', (_event, code, _description, address, mainFrame) => {
    // Aborted navigations are deliberate page switches, not failed previews.
    if (mainFrame || code === -3) {
      return;
    }
    report(address);
  });
  contents.on('did-frame-navigate', (_event, address, httpResponseCode, _statusText, mainFrame) => {
    if (!mainFrame && httpResponseCode >= SERVER_ERROR_STATUS_MIN) {
      report(address);
    }
  });
}
