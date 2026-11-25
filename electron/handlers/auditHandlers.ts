// The Audits panel's rendered pass reads a page as the project's dev server
// renders it. The renderer's own origin cannot fetch the dev server (it is
// another origin, with no CORS for us), so main fetches it: only a loopback
// origin (the payload parser refuses any other), with a timeout and a size
// bound, and the HTML goes back as text the renderer parses itself.
import { AUDIT_LIMITS } from '../../shared/page/auditFindings';
import type { MainHost } from './mainHost';
import { measurePage, type OpenMeasureWindow } from './auditMeasure';
import { translateMain } from '../lib/mainLocale';

const RENDER_TIMEOUT_MS = 15_000;

export interface AuditHandlerOptions {
  /** Makes the hidden measurement window; main.ts owns electron's values. */
  readonly openMeasureWindow: OpenMeasureWindow;
}

export function registerAuditHandlers(host: Pick<MainHost, 'ipcMain'>, options: AuditHandlerOptions): void {
  // Performance: the route in a hidden window of its own (auditMeasure.ts).
  host.ipcMain.handle('audit:measure', async (_event, input) => measurePage(new URL(input.route, input.devUrl).href, options.openMeasureWindow));
  host.ipcMain.handle('audit:render', async (_event, input) => {
    const url = new URL(input.route, input.devUrl);
    try {
      const response = await fetch(url, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(RENDER_TIMEOUT_MS) });
      const html = await response.text();
      if (html.length > AUDIT_LIMITS.renderedHtmlCharsMax) {
        return { ok: false as const, message: translateMain('error.audit.renderTooLarge', { route: input.route, limit: AUDIT_LIMITS.renderedHtmlCharsMax }) };
      }
      return { ok: true as const, status: response.status, html };
    } catch (error: unknown) {
      return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
    }
  });
}
