// "Log in with Sanity": the browser sign-in Sanity's own CLI uses, ending in a
// project key rather than a login.
//
//   1. A one-shot server listens on localhost; the browser opens Sanity's
//      sign-in page with that server as the place to come back to.
//   2. Sanity redirects back with a one-time session id, exchanged for the
//      person's login token.
//   3. Their projects and datasets are listed; the one the site's own .env
//      names is suggested.
//   4. On their choice, a project key with the Editor role is created and kept
//      (encrypted, cmsConnectionStore.ts), and the login token is logged out.
//
// The login token can do anything the person can, across every project they
// belong to; the key can read and write documents in one project. Only the key
// is kept. The renderer polls this like the GitHub sign-in (publishAccount.ts):
// one session at a time, each request answered with the current state.

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import {
  SANITY_LOGIN_TIMEOUT_MS,
  type SanityLoginRequest,
  type SanityLoginState,
  type SanityProjectChoice,
} from '../../shared/properties/cmsConnections';
import type { CmsConnectionStore } from './cmsConnectionStore';
import {
  SanityRequestError,
  createSanityEditorKey,
  sanityLoginURL,
  sanityLogout,
  sanityProjects,
  sanityTokenForSession,
} from './sanityApi';

const SUCCESS_PAGE = 'https://www.sanity.io/login/success';
// The .env lines read for a suggestion, and the longest file read for them.
const ENV_FILES = ['.env', '.env.local', '.env.development'] as const;
const ENV_BYTES_MAX = 64 * 1024;

// One sign-in: its state, and what it holds while it runs. Ending it releases
// all of it and logs the login out — the key, when there is one, is what stays.
class Session {
  state: SanityLoginState = { kind: 'starting' };
  projects: readonly SanityProjectChoice[] = [];
  private server: http.Server | undefined;
  private token: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly id: string,
    readonly projectRoot: string,
  ) {}

  listen(server: http.Server, onTimeout: () => void): void {
    assert(this.server === undefined, 'A sign-in listens once');
    this.server = server;
    this.timer = setTimeout(onTimeout, SANITY_LOGIN_TIMEOUT_MS);
    this.timer.unref();
  }

  stopListening(): void {
    this.server?.close();
    this.server = undefined;
  }

  signedIn(token: string, projects: readonly SanityProjectChoice[]): void {
    this.token = token;
    this.projects = projects;
  }

  loginToken(): string | undefined {
    return this.token;
  }

  end(state: SanityLoginState): void {
    assert(state.kind !== 'browser', 'A sign-in ends in a final state');
    clearTimeout(this.timer);
    this.stopListening();
    const token = this.token;
    this.token = undefined;
    if (token) {
      void sanityLogout(token).catch(() => undefined);
    }
    this.state = state;
  }
}

export class SanityLogin {
  private session: Session | undefined;

  constructor(private readonly store: CmsConnectionStore) {}

  request(projectRoot: string, request: SanityLoginRequest): SanityLoginState {
    const current = this.session;
    if (request.action === 'start') {
      current?.end({ kind: 'cancelled' });
      return this.start(projectRoot, request.id);
    }
    if (!current || current.id !== request.id) {
      return { kind: 'failed', message: 'This Sanity sign-in is no longer running.' };
    }
    switch (request.action) {
      case 'status':
        return current.state;
      case 'cancel':
        current.end({ kind: 'cancelled' });
        return current.state;
      case 'choose':
        return this.choose(current, request.projectId, request.dataset);
      default: {
        const exhaustive: never = request;
        return exhaustive;
      }
    }
  }

  private start(projectRoot: string, id: string): SanityLoginState {
    const session = new Session(id, projectRoot);
    this.session = session;
    const server = http.createServer((request, response) =>
      this.callback(session, request, response),
    );
    session.listen(server, () =>
      session.end({ kind: 'failed', message: 'Sanity sign-in timed out.' }),
    );
    server.on('error', (error) => this.fail(session, error));
    // Bound to localhost, not 127.0.0.1: Sanity accepts any http://localhost:<port> origin.
    server.listen(0, 'localhost', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        this.fail(session, new Error('Could not start the sign-in listener.'));
        return;
      }
      const origin = `http://localhost:${address.port}/callback`;
      this.set(session, { kind: 'browser', url: sanityLoginURL(origin) });
    });
    return session.state;
  }

  // The browser's way back. Sanity may put the session id in the query, in a
  // `url` parameter (its CLI's form), or in the fragment — which a browser
  // never sends — so a request without one gets a page that reads the fragment
  // and comes back once with it in the query.
  private callback(session: Session, request: http.IncomingMessage, response: http.ServerResponse) {
    const back = callbackOf(request.url);
    if (request.method !== 'GET' || back.kind === 'other') {
      response.writeHead(404).end();
      return;
    }
    if (back.kind === 'without-sid') {
      response
        .writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'",
        })
        .end(FRAGMENT_PAGE);
      return;
    }
    response.writeHead(303, { Location: SUCCESS_PAGE }).end();
    session.stopListening();
    if (session.state.kind !== 'browser') {
      return;
    }
    this.set(session, { kind: 'starting' });
    void this.signedIn(session, back.sid).catch((error: unknown) => this.fail(session, error));
  }

  private async signedIn(session: Session, sid: string): Promise<void> {
    const token = await sanityTokenForSession(sid);
    const projects = await sanityProjects(token);
    session.signedIn(token, projects);
    if (projects.length === 0) {
      throw new Error('This Sanity account is not a member of any project.');
    }
    this.set(session, {
      kind: 'choosing',
      projects,
      suggestion: siteSuggestion(session.projectRoot, projects),
    });
  }

  private choose(session: Session, projectId: string, dataset: string): SanityLoginState {
    const project = session.projects.find((entry) => entry.id === projectId);
    const token = session.loginToken();
    if (session.state.kind !== 'choosing' || !project || !token) {
      return session.state;
    }
    if (!project.datasets.includes(dataset)) {
      return session.state;
    }
    this.set(session, { kind: 'creating' });
    // Sanity refuses two keys with one label, and a key outlives a sign-in that
    // was abandoned after creating it; the time keeps every label new.
    const created = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const label = `Stacki (${os.hostname().slice(0, 40)}) ${created} UTC`;
    void createSanityEditorKey(token, projectId, label)
      .then((key) => {
        const connection = this.store.save(session.projectRoot, {
          kind: 'sanity',
          label: `${project.name} · ${dataset}`,
          projectId,
          dataset,
          secret: key,
        });
        session.end({ kind: 'complete', connection });
      })
      .catch((error: unknown) => this.fail(session, error));
    return session.state;
  }

  private fail(session: Session, error: unknown): void {
    session.end({ kind: 'failed', message: failureMessage(error) });
  }

  // Only the running sign-in moves on; a replaced one keeps its last state.
  private set(session: Session, state: SanityLoginState): void {
    const current = this.session;
    if (current === session) {
      current.state = state;
    }
  }
}

// Reads `#sid=` (or `_context`'s sid) and returns once with it in the query; a
// page with no session id says so rather than looping.
const FRAGMENT_PAGE = `<!doctype html><meta charset="utf-8"><title>Stacki</title>
<p id="m">Finishing Sanity sign-in…</p>
<script>
const h = new URLSearchParams(location.hash.slice(1));
let sid = h.get('sid');
try { sid = sid || JSON.parse(new URLSearchParams(location.search).get('_context') || '{}').sid; }
catch (e) {}
if (sid && /^[\\w-]{1,512}$/.test(sid)) location.replace('/callback?sid=' + sid);
else document.getElementById('m').textContent =
  'Sanity did not return a sign-in. Close this tab and try again in Stacki.';
</script>`;

type Callback =
  | { readonly kind: 'sid'; readonly sid: string }
  | { readonly kind: 'without-sid' }
  | { readonly kind: 'other' };

function callbackOf(requestURL: string | undefined): Callback {
  if (!requestURL || requestURL.length > 8192) {
    return { kind: 'other' };
  }
  const own = new URL(requestURL, 'http://localhost');
  if (own.pathname !== '/callback') {
    return { kind: 'other' };
  }
  const sid = own.searchParams.get('sid') ?? sidOfURL(own.searchParams.get('url') ?? undefined);
  if (sid && /^[\w-]{1,512}$/.test(sid)) {
    return { kind: 'sid', sid };
  }
  return { kind: 'without-sid' };
}

function sidOfURL(back: string | undefined): string | undefined {
  if (back === undefined) {
    return undefined;
  }
  try {
    return new URL(back).searchParams.get('sid') ?? undefined;
  } catch {
    return undefined;
  }
}

function failureMessage(error: unknown): string {
  if (error instanceof SanityRequestError && (error.status === 401 || error.status === 403)) {
    return (
      'Your role in this Sanity project cannot create API keys (Administrator or ' +
      'Developer can). Ask an admin for one, then choose “Paste a Sanity key” ' +
      'from the arrow beside “Log in with Sanity”.'
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return (message || 'Sanity sign-in failed.').slice(0, 900);
}

// The project and dataset the site itself reads, from its .env files, when one
// of the person's projects has them.
function siteSuggestion(projectRoot: string, projects: readonly SanityProjectChoice[]) {
  const values = new Map<string, string>();
  for (const name of ENV_FILES) {
    for (const [key, value] of envEntries(path.join(projectRoot, name))) {
      values.set(key, value);
    }
  }
  const pick = (suffix: string) =>
    [...values].find(
      ([key]) => /^(PUBLIC_|SANITY_STUDIO_|NEXT_PUBLIC_)?SANITY_/.test(key) && key.endsWith(suffix),
    )?.[1];
  const projectId = pick('PROJECT_ID');
  const dataset = pick('DATASET') ?? 'production';
  const project = projects.find((entry) => entry.id === projectId);
  return project && project.datasets.includes(dataset)
    ? { projectId: project.id, dataset }
    : undefined;
}

function envEntries(file: string): [string, string][] {
  let text: string;
  try {
    if (fs.statSync(file).size > ENV_BYTES_MAX) {
      return [];
    }
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: [string, string][] = [];
  for (const line of text.split(/\r?\n/).slice(0, 2000)) {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*["']?([^"'#\s]*)["']?/.exec(line);
    if (match?.[1] && match[2]) {
      out.push([match[1], match[2]]);
    }
  }
  return out;
}
