// What the editor reports when its design canvas has waited too long, and where it is kept.
// A browser's console is out of reach, so the editor posts a small, bounded report that the
// Worker logs (`wrangler tail` shows it) and keeps the last few of in R2, readable by a signed-in
// editor at GET /studio/api/client-diagnostics. Nothing here holds a secret: the report carries
// stage names, counts, an error text the frame produced, the page path and a short user agent.

export const CLIENT_DIAGNOSTIC_LIMITS = {
  bodyBytesMax: 4096,
  entriesMax: 20,
  textCharsMax: 300,
  framesMax: 16,
} as const satisfies Record<string, number>;

export const CLIENT_DIAGNOSTIC_STAGES = ['address', 'frame', 'script'] as const;
export type ClientDiagnosticStage = (typeof CLIENT_DIAGNOSTIC_STAGES)[number];

export interface ClientDiagnostic {
  /** The handshake step the loader was waiting on (previewHandshake.ts). */
  readonly stage: ClientDiagnosticStage;
  /** How many canvas frames exist and how many have fired a load event. */
  readonly frames: number;
  readonly framesLoaded: number;
  /** The frame's own error report (the beacon), if it sent one. */
  readonly frameError: string;
  /** The page path the canvas was showing. */
  readonly page: string;
  /** The container start stage the boot readout last gave, if any. */
  readonly startupStage: string;
  readonly userAgent: string;
}

export interface StoredClientDiagnostic extends ClientDiagnostic {
  readonly at: string;
}

export type ClientDiagnosticResult = { readonly ok: true; readonly value: ClientDiagnostic } | { readonly ok: false; readonly error: string };

function text(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.length <= CLIENT_DIAGNOSTIC_LIMITS.textCharsMax ? value : value.slice(0, CLIENT_DIAGNOSTIC_LIMITS.textCharsMax);
}

function count(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > CLIENT_DIAGNOSTIC_LIMITS.framesMax) {
    return undefined;
  }
  return value;
}

export function parseClientDiagnostic(input: unknown): ClientDiagnosticResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'Expected an object' };
  }
  const fields = new Map(Object.entries(input));
  const record = Object.fromEntries(fields);
  const stage = CLIENT_DIAGNOSTIC_STAGES.find((candidate) => candidate === record['stage']);
  if (stage === undefined) {
    return { ok: false, error: 'Unknown stage' };
  }
  const frames = count(record, 'frames');
  const framesLoaded = count(record, 'framesLoaded');
  if (frames === undefined || framesLoaded === undefined) {
    return { ok: false, error: 'Frame counts must be small whole numbers' };
  }
  if (framesLoaded > frames) {
    return { ok: false, error: 'More frames loaded than exist' };
  }
  return {
    ok: true,
    value: {
      stage,
      frames,
      framesLoaded,
      frameError: text(record, 'frameError') ?? '',
      page: text(record, 'page') ?? '',
      startupStage: text(record, 'startupStage') ?? '',
      userAgent: text(record, 'userAgent') ?? '',
    },
  };
}

/** The newest entry goes first; the list never grows past the limit. */
export function appendClientDiagnostic(list: readonly StoredClientDiagnostic[], entry: StoredClientDiagnostic): readonly StoredClientDiagnostic[] {
  return [entry, ...list].slice(0, CLIENT_DIAGNOSTIC_LIMITS.entriesMax);
}

export function parseStoredDiagnostics(input: unknown): readonly StoredClientDiagnostic[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const kept: StoredClientDiagnostic[] = [];
  const items: readonly unknown[] = input;
  for (const item of items.slice(0, CLIENT_DIAGNOSTIC_LIMITS.entriesMax)) {
    const parsed = parseClientDiagnostic(item);
    const at: unknown = typeof item === 'object' && item !== null && 'at' in item ? item.at : undefined;
    if (parsed.ok && typeof at === 'string' && at.length <= 40) {
      kept.push({ ...parsed.value, at });
    }
  }
  return kept;
}

const DIAGNOSTICS_KEY = 'diagnostics/client.json';

// The two R2 calls the route uses, so the module does not need the Worker's type definitions.
export interface DiagnosticsStore {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
  put(key: string, value: string): Promise<unknown>;
}

export async function clientDiagnosticsRoute(request: Request, drafts: DiagnosticsStore, now: () => string): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  if (request.method === 'GET') {
    const object = await drafts.get(DIAGNOSTICS_KEY);
    const list = object ? parseStoredDiagnostics(await object.json()) : [];
    return Response.json(list, { headers });
  }
  if (request.method === 'POST') {
    const body = await request.text();
    if (body.length > CLIENT_DIAGNOSTIC_LIMITS.bodyBytesMax) {
      return new Response('Report too large', { status: 413, headers });
    }
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      return new Response('Invalid report', { status: 400, headers });
    }
    const parsed = parseClientDiagnostic(input);
    if (!parsed.ok) {
      return new Response(parsed.error, { status: 400, headers });
    }
    const entry: StoredClientDiagnostic = { ...parsed.value, at: now() };
    // One line, so `wrangler tail` shows it whole.
    console.log('client-diagnostic', JSON.stringify(entry));
    const object = await drafts.get(DIAGNOSTICS_KEY);
    const list = object ? parseStoredDiagnostics(await object.json()) : [];
    await drafts.put(DIAGNOSTICS_KEY, JSON.stringify(appendClientDiagnostic(list, entry)));
    return new Response(null, { status: 204, headers });
  }
  return new Response('Method not allowed', { status: 405, headers });
}
