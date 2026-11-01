// Chromium can finish a failed iframe navigation with an empty error document.
// Report that failure even when the dev server has recovered before the next probe.
import { parsePreviewFailure } from '../../shared/ipc/previewFailure';

interface PreviewContents {
  on(event: 'did-fail-load', listener: (event: unknown, code: number, description: string, address: string, mainFrame: boolean) => void): void;
  send(channel: string, payload: string): void;
}

export function listenForPreviewFailures(contents: PreviewContents, previewURL: () => string | undefined): void {
  contents.on('did-fail-load', (_event, code, _description, address, mainFrame) => {
    // Aborted navigations are deliberate page switches, not failed previews.
    if (mainFrame || code === -3) {
      return;
    }
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
  });
}
