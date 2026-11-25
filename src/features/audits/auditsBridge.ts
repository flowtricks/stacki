// The Audits panel's transport: `.stacki/audits.json` through the project
// metadata read and write every settings file uses (writes are checked against
// the bytes read), and a rendered page fetched by main from the dev server.
// Both answers are parsed here before the panel sees them.
import { boolean, count, record, text } from '../../../shared/core/boundary';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { err, ok, type Result } from '../../../shared/core/result';
import { parseAuditIgnoresSource, serializeAuditIgnores, type AuditIgnores } from '../../../shared/properties/auditIgnores';
import { readMetadata, writeMetadata } from '../../ipc/projectMetadataBridge';
import { parseMeasurement, type Measurement } from '../../../shared/page/auditPerformance';

export interface StoredIgnores {
  /** The bytes read: the base the next write is checked against; undefined when the file does not exist. */
  readonly source: string | undefined;
  readonly value: AuditIgnores;
}

export async function readAuditIgnores(projectPath: string): Promise<Result<StoredIgnores, string>> {
  try {
    const file = await readMetadata(projectPath, 'audits');
    return ok({ source: file.source, value: parseAuditIgnoresSource(file.source) });
  } catch (error: unknown) {
    return err(error instanceof Error ? error.message : String(error));
  }
}

/** Writes `next` over the bytes `base` read; a newer edit elsewhere makes this fail rather than be overwritten. */
export async function saveAuditIgnores(projectPath: string, base: StoredIgnores, next: AuditIgnores): Promise<Result<StoredIgnores, string>> {
  const source = serializeAuditIgnores(next);
  try {
    const saved = await writeMetadata(projectPath, base.source === undefined ? { kind: 'audits', source } : { kind: 'audits', source, base: base.source });
    return ok({ source: saved.source, value: parseAuditIgnoresSource(saved.source) });
  } catch (error: unknown) {
    return err(error instanceof Error ? error.message : String(error));
  }
}

export type RenderedHtml = { readonly ok: true; readonly status: number; readonly html: string } | { readonly ok: false; readonly message: string };

export function parseRenderedHtml(input: unknown): RenderedHtml {
  const value = record(input);
  if (boolean(value['ok'])) {
    return { ok: true, status: count(value['status']), html: text(value['html']) };
  }
  return { ok: false, message: text(value['message']) };
}

/** The route as the dev server at `devUrl` renders it. */
export async function fetchRenderedPage(projectPath: string, devUrl: string, route: string): Promise<RenderedHtml> {
  const payload = parseIpcPayload('audit:render', { projectPath, devUrl, route });
  return parseRenderedHtml(await window.avb.renderAuditPage(payload));
}

/** One route's performance, measured by main in a hidden window and parsed here. */
export async function measureRoute(projectPath: string, devUrl: string, route: string): Promise<Result<Measurement, string>> {
  const payload = parseIpcPayload('audit:measure', { projectPath, devUrl, route });
  const answer = record(await window.avb.measureAuditPage(payload));
  if (answer['ok'] !== true) {
    return err(text(answer['message']));
  }
  try {
    return ok(parseMeasurement(answer['measurement']));
  } catch (error: unknown) {
    return err(error instanceof Error ? error.message : String(error));
  }
}
