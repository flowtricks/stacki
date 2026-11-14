// Goal: a failed publish Git command explains itself in the dialog without ever showing a
// credential (issue #80: every failure read only "Git fetch failed").
// Method: feed gitDiagnosticDetail stderr shaped like real Git output with realistic fake
// secrets in every place Git can echo one (URL user information, the extraheader, an
// Authorization line, GitHub token formats, a JWT, the token's Basic encoding), check the
// bound and the tail window, then run a real failing git command through publishGit with a
// fake token in its arguments and read the error the dialog would show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStderrTail, gitDiagnosticDetail, PUBLISH_DIAGNOSTIC_LIMITS } from '../src/features/publishing/publishGitDiagnostic';
import { publishGit } from '../src/features/publishing/publishGit';

// Fake secrets are assembled at run time from short pieces: a complete token-shaped literal in
// the source would make GitHub push protection refuse the push, and the value is unchanged.
function fakeSecret(...pieces: readonly string[]): string {
  return pieces.join('');
}

// Fake values in the real formats; none is a live credential.
const INSTALLATION_TOKEN = fakeSecret('ghs_16C7', 'e42F292c', '6912E771', '0c838347', 'Ae178B4a');
const PERSONAL_TOKEN = fakeSecret('github_p', 'at_11ABC', 'DEFG0123', '456789_a', 'bcdefghi', 'jklmnopq', 'rstuvwxy', 'zABCDEFG', 'HIJ');
const JWT = fakeSecret('eyJhbGci', 'OiJSUzI1', 'NiJ9.eyJ', 'pc3MiOiI', 'xMjM0NTY', 'iLCJleHA', 'iOjE3MDA', 'wMDAwMDB', '9.c2lnbm', 'F0dXJlLX', 'ZhbHVl');
const BASIC = Buffer.from('x-access-token:' + INSTALLATION_TOKEN).toString('base64');

function assertClean(detail: string) {
  for (const secret of [INSTALLATION_TOKEN, PERSONAL_TOKEN, JWT, BASIC, 'hunter2-password-value']) {
    assert.ok(!detail.includes(secret), `"${secret}" leaked into: ${detail}`);
  }
}

test('credentials Git can echo are redacted, wherever they appear', () => {
  const stderr = [
    `fatal: unable to access 'https://x-access-token:${INSTALLATION_TOKEN}@github.com/owner/private.git/': The requested URL returned error: 403`,
    `fatal: could not read from https://someone:hunter2-password-value@example.com/repo.git`,
    `trace: http.https://github.com/.extraheader=Authorization: Basic ${BASIC}`,
    `> Authorization: Bearer ${JWT}`,
    `remote: Invalid username or token ${PERSONAL_TOKEN}.`,
    `error: token ${INSTALLATION_TOKEN} rejected`,
  ].join('\n');
  const detail = gitDiagnosticDetail(stderr, [INSTALLATION_TOKEN]);
  assertClean(detail);
  assert.match(detail, /The requested URL returned error: 403/);
  assert.match(detail, /\[redacted\]/);
  assert.ok(!detail.includes('\n'), 'The detail is one line');
});

test('the exact token is removed even in a shape no pattern knows, URL-encoded or Basic-encoded', () => {
  const token = fakeSecret('v1.01234', '56789abc', 'def01234', '56789abc', 'def01234', '567');
  const stderr = `odd helper said ${token} and ${encodeURIComponent(token)} and ${Buffer.from('x-access-token:' + token).toString('base64')}`;
  const detail = gitDiagnosticDetail(stderr, [token]);
  assert.ok(!detail.includes(token));
  assert.ok(!detail.includes(Buffer.from('x-access-token:' + token).toString('base64')));
  assert.equal(detail, 'odd helper said [redacted] and [redacted] and [redacted]');
});

test('the detail is bounded, keeps the end where the fatal line is, and strips terminal noise', () => {
  const noise = Array.from({ length: 200 }, (_, index) => `remote: counting objects ${index}`).join('\n');
  const detail = gitDiagnosticDetail(noise + '\n\u001b[31mfatal: the real cause\u001b[0m\u0007', []);
  assert.equal(detail.length, PUBLISH_DIAGNOSTIC_LIMITS.detailCharsMax);
  assert.ok(detail.startsWith('…'));
  assert.ok(detail.endsWith('fatal: the real cause'), detail);
  assert.equal(gitDiagnosticDetail('\n  \n', []), '');
});

test('the stderr window drops a cut first line, so half a secret is never kept', () => {
  const tail = createStderrTail();
  const filler = 'x'.repeat(PUBLISH_DIAGNOSTIC_LIMITS.stderrBytesKept - 20);
  tail.append(Buffer.from(`Authorization: Basic ${BASIC}\n`));
  tail.append(Buffer.from(filler + '\nfatal: end\n'));
  const text = tail.text();
  assert.ok(Buffer.byteLength(text) <= PUBLISH_DIAGNOSTIC_LIMITS.stderrBytesKept);
  assert.ok(!text.includes(BASIC.slice(-12)), 'No fragment of the cut line remains');
  assert.ok(text.endsWith('fatal: end\n'));
});

test('a failing publish Git command reports its redacted stderr in the error the dialog shows', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'studio-git-diagnostic-'));
  try {
    const git = { root: parent, directory: path.join(parent, 'objects.git'), authorization: INSTALLATION_TOKEN };
    assert.equal((await publishGit(git, ['init', '--bare', '--quiet', git.directory])).ok, true);
    // A local path that does not exist, carrying the token: Git quotes it back on stderr.
    const missing = path.join(parent, 'missing-' + INSTALLATION_TOKEN + '.git');
    const result = await publishGit(git, ['fetch', '--quiet', missing, 'refs/heads/main']);
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.error.message, /^Git fetch failed\. Check repository access and retry\. Git said: /);
    assert.equal(result.error.messageRef?.key, 'publish.studio.error.gitFailedDetail');
    assertClean(result.error.message);
    assert.match(result.error.message, /\[redacted\]/);
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
