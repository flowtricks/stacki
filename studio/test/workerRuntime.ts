// Goal: run the shipped Cloudflare Worker (src/cloudflare/worker.ts) in the real
// Workers runtime, so R2 streams, FixedLengthStream, WebCrypto and routing behave
// as they do in production rather than as a Node imitation of them.
// Method: bundle the Worker with esbuild (as Wrangler does), start it in workerd
// through Miniflare with a local R2 bucket, and replace the preview container's
// Durable Object with a stub that echoes what reached it. A response carrying
// `x-stub-preview: reached` proves a request got past the Worker to the container.
// No network: GitHub is never called, because the allowlist access mode admits the
// signed numeric id without asking GitHub.
import { build, type Plugin } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { Miniflare, Response as MiniflareResponse, convertV4MiniflareOptions } from 'miniflare';
import { signSession } from '../src/features/auth/session';

export const WORKER_TEST = {
  containerToken: 'container-test-token',
  editorId: 123,
  editorLogin: 'editor',
  previewOrigin: 'https://preview.studio.test',
  // A fake secret for tests only; production reads SESSION_SECRET from Wrangler secrets.
  sessionSecret: 'test-session-secret-that-is-long-enough-0123456789',
  studioOrigin: 'https://studio.test',
} as const;

// The container stub: answers every forwarded request with what it received, plus
// the headers the real container sets on an app file (appsServer.ts serveFile).
const STUB_PREVIEW = `
import { DurableObject } from 'cloudflare:workers';
export class StubPreview extends DurableObject {
  async fetch(request) {
    const echo = {
      url: request.url,
      method: request.method,
      token: request.headers.get('x-studio-token'),
      user: request.headers.get('x-studio-user'),
      userId: request.headers.get('x-studio-user-id'),
      session: request.headers.get('x-studio-session'),
      cookie: request.headers.get('cookie'),
      forwardedProto: request.headers.get('x-forwarded-proto'),
      identity: request.headers.get('x-studio-identity'),
      aliases: request.headers.get('x-studio-aliases'),
      name: request.headers.get('x-studio-name'),
    };
    return Response.json(echo, {
      headers: {
        'x-stub-preview': 'reached',
        'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'",
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': 'no-store',
      },
    });
  }
}
export default { fetch() { return new Response('stub'); } };
`;

/** Miniflare's own request and response types (undici's), not the DOM's. */
export type WorkerInit = NonNullable<Parameters<Miniflare['dispatchFetch']>[1]>;
export type WorkerResponse = Awaited<ReturnType<Miniflare['dispatchFetch']>>;

/**
 * The path, in the test bundle only, that hands the Worker a Request built inside workerd from
 * a description. HTTP framing never touches it, so headers no client or parser would send (a
 * malformed Content-Length, a stream without one) reach the Worker's own validation exactly.
 */
export const DIRECT_PATH = '/__worker-test/direct';

export interface DirectRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Base64 body bytes; absent for no body. */
  readonly body?: string;
  /** Send the body as a stream, whose length workerd does not know unless a header states it. */
  readonly streamed?: boolean;
}

const DIRECT_ENTRY = `
import worker from './worker.ts';
export * from './worker.ts';
export default {
  async fetch(request, env, context) {
    if (new URL(request.url).pathname !== ${JSON.stringify(DIRECT_PATH)}) {
      return worker.fetch(request, env, context);
    }
    const spec = await request.json();
    const bytes = spec.body === undefined ? undefined : Uint8Array.from(atob(spec.body), (character) => character.charCodeAt(0));
    const body = bytes === undefined ? undefined : spec.streamed ? new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) : bytes;
    const built = new Request(spec.url, { method: spec.method, headers: spec.headers, body, ...(spec.streamed ? { duplex: 'half' } : {}) });
    return worker.fetch(built, env, context);
  },
};
`;

export const WORKER_RUNTIME_LIMITS = {
  /** workerd startup, including the bundle; a hung start fails with this message, not the step limit. */
  startMs: 120_000,
  /** workerd shutdown. */
  disposeMs: 30_000,
  /** Runtime log entries kept for assertions; older ones are only counted. */
  logEntriesKept: 500,
  /** A test file's whole run; far below the gate's per-step limit. */
  testFileMs: 180_000,
} as const satisfies Record<string, number>;

/** One entry the runtime logged (workerd's own errors and the Worker's console). */
export interface RuntimeLogEntry {
  readonly level: string;
  readonly message: string;
}

export interface WorkerRuntime {
  /**
   * The warnings and errors the runtime logged that match none of `expected`. workerd logs
   * a write to a connection the client already closed ("Broken pipe") as an error; the
   * tests read every response body so that never happens, and this proves it.
   */
  readonly unexpectedLogs: (expected: readonly RegExp[]) => readonly RuntimeLogEntry[];
  /** Calls the Worker's fetch handler with a Request built in workerd (DIRECT_PATH). */
  readonly direct: (request: DirectRequest) => Promise<WorkerResponse>;
  readonly fetch: (url: string, init?: WorkerInit) => Promise<WorkerResponse>;
  readonly drafts: () => ReturnType<Miniflare['getR2Bucket']>;
  readonly origin: () => Promise<URL>;
  readonly dispose: () => Promise<void>;
}

/** The Worker bundled with a custom provider in the auth slot, as `npm run build` wires studio/cloudflare/auth-provider.ts. */
export interface WorkerRuntimeOptions {
  /** Absolute path of a module whose default export is an AuthProviderFactory. */
  readonly authProviderModule?: string;
  /** Bundle a built-in provider into the Worker, as `npm run build` does for `AUTH_PROVIDER` (builtInSlotSource). */
  readonly builtInProvider?: 'access' | 'google' | 'oidc' | 'passkey';
  /** Extra Worker vars, such as EDITOR_ACCESS or a provider's own settings. */
  readonly vars?: Readonly<Record<string, string>>;
}

// Replaces src/cloudflare/authProviderSlot.ts with a re-export of the given provider module, the way the build does.
function authSlot(module: string): Plugin {
  return {
    name: 'auth-provider-slot',
    setup(context) {
      context.onResolve({ filter: /\/authProviderSlot$/ }, () => ({ path: 'authProviderSlot', namespace: 'auth-slot' }));
      context.onLoad({ filter: /.*/, namespace: 'auth-slot' }, () => ({
        contents: `export { default as customAuthProvider } from ${JSON.stringify(module)};`,
        loader: 'ts',
        resolveDir: fileURLToPath(new URL('../src/cloudflare/', import.meta.url)),
      }));
    },
  };
}

const BUILT_IN_FACTORY = {
  access: 'createAccessProvider',
  google: 'createGoogleProvider',
  oidc: 'createOidcProvider',
  passkey: 'createPasskeyProvider',
} as const;

// Replaces src/cloudflare/builtInProviderSlot.ts with the chosen built-in provider, the way the build does.
function builtInSlot(id: keyof typeof BUILT_IN_FACTORY): Plugin {
  return {
    name: 'built-in-provider-slot',
    setup(context) {
      context.onResolve({ filter: /\/builtInProviderSlot$/ }, () => ({ path: 'builtInProviderSlot', namespace: 'built-in-slot' }));
      context.onLoad({ filter: /.*/, namespace: 'built-in-slot' }, () => ({
        contents: `import { ${BUILT_IN_FACTORY[id]} } from '../features/auth/providers/${id}';\nexport const builtInProviderSlot = { id: ${JSON.stringify(id)}, create: ${BUILT_IN_FACTORY[id]} };`,
        loader: 'ts',
        resolveDir: fileURLToPath(new URL('../src/cloudflare/', import.meta.url)),
      }));
    },
  };
}

export async function startWorkerRuntime(options: WorkerRuntimeOptions = {}): Promise<WorkerRuntime> {
  const bundled = await build({
    // The shipped Worker behind a test-only wrapper (DIRECT_ENTRY); production bundles worker.ts itself.
    stdin: {
      contents: DIRECT_ENTRY,
      resolveDir: fileURLToPath(new URL('../src/cloudflare/', import.meta.url)),
      sourcefile: 'workerTestEntry.js',
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    external: ['cloudflare:*', 'node:*'],
    plugins: [
      ...(options.authProviderModule === undefined ? [] : [authSlot(options.authProviderModule)]),
      ...(options.builtInProvider === undefined ? [] : [builtInSlot(options.builtInProvider)]),
    ],
    write: false,
    logLevel: 'silent',
  });
  const script = bundled.outputFiles[0]?.text;
  if (script === undefined) {
    throw new Error('esbuild produced no Worker bundle');
  }
  // Kept, not printed: a flood of runtime lines on a slow runner once filled the gate's
  // output buffer. Tests assert on them instead (unexpectedLogs).
  const logs: RuntimeLogEntry[] = [];
  let logCount = 0;
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      logRequests: false,
      handleStructuredLogs: (entry: { readonly level: string; readonly message: string }) => {
        logCount++;
        logs.push({ level: entry.level, message: entry.message });
        if (logs.length > WORKER_RUNTIME_LIMITS.logEntriesKept) {
          logs.shift();
        }
      },
      workers: [
        {
          name: 'studio',
          modules: [{ type: 'ESModule', path: 'worker.mjs', contents: script }],
          compatibilityDate: '2026-10-16',
          compatibilityFlags: ['nodejs_compat'],
          r2Buckets: ['DRAFTS'],
          durableObjects: { PREVIEW: { className: 'StubPreview', scriptName: 'stub' } },
          serviceBindings: { ASSETS: () => new Response('studio asset') },
          bindings: {
            CONTAINER_TOKEN: WORKER_TEST.containerToken,
            STUDIO_ORIGIN: WORKER_TEST.studioOrigin,
            PREVIEW_ORIGIN: WORKER_TEST.previewOrigin,
            SESSION_SECRET: WORKER_TEST.sessionSecret,
            GITHUB_REPOSITORY: 'owner/site',
            GITHUB_BRANCH: 'main',
            GITHUB_APP_ID: '',
            GITHUB_INSTALLATION_ID: '',
            GITHUB_PRIVATE_KEY: '',
            GITHUB_CLIENT_ID: '',
            GITHUB_CLIENT_SECRET: '',
            EDITOR_ACCESS: 'allowlist',
            EDITOR_GITHUB_IDS: String(WORKER_TEST.editorId),
            ...options.vars,
          },
        },
        { name: 'stub', modules: true, script: STUB_PREVIEW, durableObjects: { SELF: 'StubPreview' } },
      ],
    }),
  );
  await bounded(miniflare.ready, WORKER_RUNTIME_LIMITS.startMs, 'workerd did not start');
  return {
    unexpectedLogs: (expected) => {
      const quiet = new Set(['debug', 'info', 'log']);
      const problems = logs.filter((entry) => !quiet.has(entry.level) && !expected.some((pattern) => pattern.test(entry.message)));
      // Entries older than the kept window cannot be checked; say so rather than pass silently.
      const dropped = logCount - logs.length;
      return dropped > 0 ? [...problems, { level: 'error', message: `${dropped} runtime log entries exceeded the kept window` }] : problems;
    },
    direct: (request) => drained(miniflare.dispatchFetch('http://localhost' + DIRECT_PATH, { method: 'POST', body: JSON.stringify(request) })),
    fetch: (url, init) => drained(init === undefined ? miniflare.dispatchFetch(url) : miniflare.dispatchFetch(url, init)),
    drafts: () => miniflare.getR2Bucket('DRAFTS'),
    origin: () => miniflare.ready,
    dispose: () => bounded(miniflare.dispose(), WORKER_RUNTIME_LIMITS.disposeMs, 'workerd did not shut down'),
  };
}

/** A `__Host-studio` cookie for the allowlisted editor, valid for `lifetimeMs`. */
export async function studioCookie(lifetimeMs: number): Promise<string> {
  const token = await signSession(
    { id: WORKER_TEST.editorId, login: WORKER_TEST.editorLogin, expires: Date.now() + lifetimeMs, audience: 'studio' },
    WORKER_TEST.sessionSecret,
  );
  return '__Host-studio=' + token;
}

/** `promise`, or a clear failure after `limitMs`; the timer never holds the process open. */
async function bounded<T>(promise: Promise<T>, limitMs: number, failure: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${failure} within ${limitMs} ms`)), limitMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

/**
 * The response with its body already read to the end. A body left unread or cancelled
 * closes the connection while workerd is still writing, which it logs as a Broken pipe
 * error; on a slow runner hundreds of those flooded the gate's output (CI run 43660235328).
 */
async function drained(pending: Promise<WorkerResponse>): Promise<WorkerResponse> {
  const response = await pending;
  const bytes = await response.arrayBuffer();
  return new MiniflareResponse(NULL_BODY_STATUSES.has(response.status) ? null : bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
