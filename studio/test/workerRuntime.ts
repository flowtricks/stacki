// Goal: run the shipped Cloudflare Worker (src/cloudflare/worker.ts) in the real
// Workers runtime, so R2 streams, FixedLengthStream, WebCrypto and routing behave
// as they do in production rather than as a Node imitation of them.
// Method: bundle the Worker with esbuild (as Wrangler does), start it in workerd
// through Miniflare with a local R2 bucket, and replace the preview container's
// Durable Object with a stub that echoes what reached it. A response carrying
// `x-stub-preview: reached` proves a request got past the Worker to the container.
// No network: GitHub is never called, because the allowlist access mode admits the
// signed numeric id without asking GitHub.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
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

export interface WorkerRuntime {
  readonly fetch: (url: string, init?: WorkerInit) => Promise<WorkerResponse>;
  readonly drafts: () => ReturnType<Miniflare['getR2Bucket']>;
  readonly origin: () => Promise<URL>;
  readonly dispose: () => Promise<void>;
}

export async function startWorkerRuntime(): Promise<WorkerRuntime> {
  const entry = fileURLToPath(new URL('../src/cloudflare/worker.ts', import.meta.url));
  const bundled = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    external: ['cloudflare:*', 'node:*'],
    write: false,
    logLevel: 'silent',
  });
  const script = bundled.outputFiles[0]?.text;
  if (script === undefined) {
    throw new Error('esbuild produced no Worker bundle');
  }
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
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
          },
        },
        { name: 'stub', modules: true, script: STUB_PREVIEW, durableObjects: { SELF: 'StubPreview' } },
      ],
    }),
  );
  return {
    fetch: (url, init) => (init === undefined ? miniflare.dispatchFetch(url) : miniflare.dispatchFetch(url, init)),
    drafts: () => miniflare.getR2Bucket('DRAFTS'),
    origin: () => miniflare.ready,
    dispose: () => miniflare.dispose(),
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
