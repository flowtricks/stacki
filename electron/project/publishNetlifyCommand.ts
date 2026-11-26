// One bounded run of the Netlify CLI that returns data: `netlify api <method>` for every read and for Add site.
// What the CLI prints is classified here and goes no further: its errors can quote requests, so only a reason
// crosses back to the caller.
import { execFile } from 'node:child_process';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { DISCOVERY_LIMITS, type ConnectionFailure } from '../../shared/properties/publishDiscovery';
import { netlifyEnvironment } from './publishEnvironment';
import { resolvePublishExecutable } from './publishExecutable';

/**
 * Why a run failed: a connection problem, or Netlify answering no. `refused` is HTTP 422 (a site name that is taken
 * or not allowed), `not-found` HTTP 404, and `timeout` a run Stacki stopped, whose request may still have landed.
 */
export type NetlifyFailure = ConnectionFailure | 'refused' | 'not-found' | 'timeout';

// A page of fifty sites is a few hundred KiB; four MiB leaves room for sites with long settings.
const OUTPUT_BYTES_MAX = 4_194_304;
// Only this much of a failed command's output is classified; the rest is discarded unread.
const FAILURE_CHARS_MAX = 8192;
const DATA_CHARS_MAX = 4096;

interface Run {
  readonly stdout: string;
  readonly stderr: string;
  readonly failure: { readonly code?: unknown; readonly killed?: boolean } | undefined;
}

export function classifyNetlifyFailure(error: { readonly code?: unknown; readonly killed?: boolean }, output: string): NetlifyFailure {
  assert(output.length <= 2 * FAILURE_CHARS_MAX + 1, 'Classified output stays bounded');
  if (error.code === 'ENOENT') {
    return 'missing-cli';
  }
  if (error.killed === true) {
    return 'timeout';
  }
  if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|getaddrinfo|fetch failed/i.test(output)) {
    return 'network';
  }
  if (/session has expired|\bUnauthorized\b|\bAccess Denied\b|\b401\b/i.test(output)) {
    return 'expired';
  }
  if (/authentication required|NOT_LOGGED_IN|not logged in/i.test(output)) {
    return 'signed-out';
  }
  if (/\bUnprocessable\b|\b422\b|must be unique|already (?:been )?(?:taken|exists)/i.test(output)) {
    return 'refused';
  }
  if (/\bNot Found\b|\b404\b/i.test(output)) {
    return 'not-found';
  }
  return 'unknown';
}

/** Calls one Netlify API method through the CLI, which holds the sign-in. Data travels as one JSON argument, never a shell string. */
export async function netlifyAPI(
  root: string,
  method: 'listAccountsForUser' | 'listSitesForAccount' | 'getSite' | 'createSiteInTeam',
  data: Readonly<Record<string, unknown>>,
): Promise<Result<unknown, NetlifyFailure>> {
  const payload = JSON.stringify(data);
  assert(payload.length <= DATA_CHARS_MAX, 'A Netlify API request stays small');
  const run = await runNetlify(root, ['api', method, '--data', payload]);
  if (run.failure !== undefined) {
    const reason = classifyNetlifyFailure(run.failure, failureText(run));
    // The API answers 401 both when nobody is signed in and when a sign-in has expired; `status` tells them apart.
    return err(reason === 'expired' ? await signInProblem(root) : reason);
  }
  try {
    const value: unknown = JSON.parse(run.stdout);
    return ok(value);
  } catch {
    return err('unknown');
  }
}

// `netlify status --json` prints NOT_LOGGED_IN when there is no sign-in, and for a dead one also says the session expired.
async function signInProblem(root: string): Promise<'signed-out' | 'expired'> {
  const run = await runNetlify(root, ['status', '--json']);
  const output = failureText(run);
  if (/session has expired/i.test(output)) {
    return 'expired';
  }
  return output.includes('NOT_LOGGED_IN') ? 'signed-out' : 'expired';
}

function failureText(run: Run): string {
  return `${run.stderr.slice(0, FAILURE_CHARS_MAX)}\n${run.stdout.slice(0, FAILURE_CHARS_MAX)}`;
}

function runNetlify(root: string, argumentsList: readonly string[]): Promise<Run> {
  let resolved: { readonly executable: string; readonly arguments: readonly string[] };
  try {
    resolved = resolvePublishExecutable(root, { executable: 'netlify', arguments: argumentsList, environment: {} });
  } catch {
    // Windows resolves the CLI's entry before starting it, so a missing tool is found here.
    return Promise.resolve({ stdout: '', stderr: '', failure: { code: 'ENOENT' } });
  }
  return new Promise((resolve) => {
    const child = execFile(
      resolved.executable,
      [...resolved.arguments],
      {
        cwd: root,
        env: netlifyEnvironment(),
        shell: false,
        encoding: 'utf8',
        timeout: DISCOVERY_LIMITS.timeoutMs,
        maxBuffer: OUTPUT_BYTES_MAX,
        killSignal: 'SIGKILL',
        windowsHide: true,
      },
      (error, stdout, stderr) => resolve({ stdout, stderr, failure: error ?? undefined }),
    );
    child.stdin?.end();
  });
}
