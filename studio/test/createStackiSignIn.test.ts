// Goal: the sign-in step of `npm create stacki` chooses, validates and records a sign-in type
// without ever touching a secret.
// Method: flag parsing and the prompt flow run as pure functions; the end-to-end test feeds a
// scripted stdin through the same line prompter the command uses, on a temporary project that
// holds a copy of the shipped wrangler.jsonc (comments and trailing commas included). No network,
// no installation, nothing under the repository is written. The built command is also run as a
// child process for the cases that must stop before any file is changed.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseOptions } from '../scripts/createStacki/options';
import { keyPrompter, linePrompter } from '../scripts/createStacki/prompter';
import { chooseSignIn, configureSignIn } from '../scripts/createStacki/signIn';

const studio = fileURLToPath(new URL('../', import.meta.url));
const NO_FLAGS = parseOptions([]);

async function projectWithConfig(extraVars = ''): Promise<string> {
  const project = await mkdtemp(path.join(os.tmpdir(), 'create-stacki-signin-'));
  await mkdir(path.join(project, 'studio/cloudflare'), { recursive: true });
  const template = await readFile(path.join(studio, 'templates/cloudflare/wrangler.jsonc'), 'utf8');
  const text = extraVars === '' ? template : template.replace('"EDITOR_GITHUB_IDS": "",', `"EDITOR_GITHUB_IDS": "",\n    ${extraVars}`);
  await writeFile(path.join(project, 'studio/cloudflare/wrangler.jsonc'), text);
  return project;
}

function scripted(answers: readonly string[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = '';
  output.on('data', (chunk: Buffer) => {
    transcript += chunk.toString();
  });
  input.end(answers.join('\n') + '\n');
  return { prompter: linePrompter(input, output), transcript: () => transcript };
}

function terminal() {
  const input = Object.assign(new PassThrough(), { setRawMode: () => undefined });
  const output = new PassThrough();
  output.resume();
  return { input, prompter: keyPrompter(input, output) };
}

test('a typed question in a terminal rejects when cancelled, and answers otherwise', async () => {
  for (const key of ['\x03', '\x04']) {
    const { input, prompter } = terminal();
    const asked = assert.rejects(prompter.ask('Client ID: '), /^Error: Cancelled\.$/);
    input.write(key);
    await asked;
  }
  const { input, prompter } = terminal();
  const answer = prompter.ask('Client ID: ');
  input.write(' abc \r');
  assert.equal(await answer, 'abc');
});

test('--auth parses long form, takes values both ways and rejects unknown kinds', () => {
  assert.equal(parseOptions(['--auth', 'google']).auth, 'google');
  assert.equal(parseOptions(['--auth=oidc', '--auth-issuer=https://id.example.com']).issuer, 'https://id.example.com');
  assert.equal(parseOptions(['--yes', '--auth', 'passkey', '--auth-admin', 'sam']).admin, 'sam');
  assert.equal(parseOptions(['--yes']).auth, undefined);
  assert.throws(() => parseOptions(['--auth', 'saml']), /--auth must be one of: github, access, google, oidc, passkey/);
  assert.throws(() => parseOptions(['--auth']), /Missing value for --auth/);
  assert.throws(() => parseOptions(['--auth', '--yes']), /Missing value/);
  assert.throws(() => parseOptions(['-a', 'google']), /Unknown option/);
});

test('--yes keeps GitHub and asks nothing; other kinds need their values as flags', async () => {
  assert.deepEqual(await chooseSignIn({ ...NO_FLAGS }, undefined), { ok: true, value: { kind: 'github' } });
  const missing = await chooseSignIn({ ...NO_FLAGS, auth: 'google' }, undefined);
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? '' : missing.error, /--auth-client-id, --auth-admin/);
  const bad = await chooseSignIn({ ...NO_FLAGS, auth: 'oidc', issuer: 'http://insecure.test', clientId: 'x', admin: 'a@b.co' }, undefined);
  assert.equal(bad.ok, false);
  const good = await chooseSignIn({ ...NO_FLAGS, auth: 'passkey' }, undefined);
  assert.deepEqual(good, { ok: true, value: { kind: 'passkey', admin: 'passkey:owner' } });
});

test('the list defaults to GitHub on Enter and re-asks an invalid value', async () => {
  const github = scripted(['']);
  assert.deepEqual(await chooseSignIn(NO_FLAGS, github.prompter), { ok: true, value: { kind: 'github' } });
  assert.match(github.transcript(), /How should people sign in to Studio\?[\s\S]*1\) GitHub \(default\)[\s\S]*5\) Passkeys/);
  github.prompter.close();
  const oidc = scripted(['4', 'http://nope', 'https://login.corp.com', 'client-1', 'Corp', '', '', 'Ann@Corp.com']);
  const result = await chooseSignIn(NO_FLAGS, oidc.prompter);
  oidc.prompter.close();
  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: 'oidc',
      issuer: 'https://login.corp.com',
      clientId: 'client-1',
      name: 'Corp',
      allowedDomains: [],
      allowedEmails: [],
      admin: 'oidc:ann@corp.com',
    },
  });
  assert.match(oidc.transcript(), /issuer is not valid/);
});

test('end to end: scripted answers write only non-secret variables and print the secret command', async () => {
  const project = await projectWithConfig();
  const file = path.join(project, 'studio/cloudflare/wrangler.jsonc');
  const before = await readFile(file, 'utf8');
  const session = scripted(['3', 'abc.apps.googleusercontent.com', 'corp.com, Example.org', '', 'owner@corp.com']);
  try {
    const chosen = await chooseSignIn(NO_FLAGS, session.prompter);
    assert.ok(chosen.ok);
    const configured = await configureSignIn(project, chosen.value, session.prompter);
    assert.equal(configured.written.kind, 'written');
    const after = await readFile(file, 'utf8');
    assert.ok(after.startsWith(before.slice(0, before.indexOf('"EDITOR_GITHUB_IDS"'))), 'everything before the new lines is untouched');
    assert.match(after, /"AUTH_PROVIDER": "google"/);
    assert.match(after, /"GOOGLE_CLIENT_ID": "abc\.apps\.googleusercontent\.com"/);
    assert.match(after, /"AUTH_ALLOWED_DOMAINS": "corp\.com,example\.org"/);
    assert.match(after, /"AUTH_BOOTSTRAP_ADMIN": "google:owner@corp\.com"/);
    assert.doesNotMatch(after, /SECRET/);
    assert.match(before, /\/\/ Keep diagnostic logging opt-in/);
    assert.match(after, /\/\/ Keep diagnostic logging opt-in/);
    const text = configured.lines.join('\n');
    assert.match(text, /npx wrangler secret put GOOGLE_CLIENT_SECRET --config cloudflare\/wrangler\.jsonc/);
    assert.match(text, /https:\/\/<your-site>\/studio\/auth\/google\/callback/);
    assert.doesNotMatch(session.transcript(), /client secret|secret:/i, 'no question asks for a secret');
  } finally {
    session.prompter.close();
    await rm(project, { recursive: true, force: true });
  }
});

test('an AUTH_PROVIDER already in the file is kept unless the owner says yes', async () => {
  const project = await projectWithConfig('"AUTH_PROVIDER": "custom",');
  const file = path.join(project, 'studio/cloudflare/wrangler.jsonc');
  const before = await readFile(file, 'utf8');
  const config = { kind: 'passkey', admin: 'passkey:owner' } as const;
  try {
    const refused = scripted(['n', 'n']);
    const kept = await configureSignIn(project, config, refused.prompter);
    refused.prompter.close();
    assert.deepEqual(kept.written, { kind: 'kept', provider: 'custom' });
    assert.equal(await readFile(file, 'utf8'), before);
    assert.match(kept.lines.join('\n'), /left as it is/);
    const unattended = await configureSignIn(project, config, undefined);
    assert.equal(unattended.written.kind, 'kept');
    assert.equal(await readFile(file, 'utf8'), before);
    const accepted = scripted(['y', 'n']);
    const replaced = await configureSignIn(project, config, accepted.prompter);
    accepted.prompter.close();
    assert.equal(replaced.written.kind, 'written');
    const after = await readFile(file, 'utf8');
    assert.match(after, /"AUTH_PROVIDER": "passkey"/);
    assert.doesNotMatch(after, /custom/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('GitHub writes nothing, and a missing config is reported instead of invented', async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'create-stacki-signin-empty-'));
  try {
    const github = await configureSignIn(project, { kind: 'github' }, undefined);
    assert.equal(github.written.kind, 'unchanged');
    const missing = await configureSignIn(project, { kind: 'passkey', admin: 'passkey:owner' }, undefined);
    assert.equal(missing.written.kind, 'failed');
    assert.match(missing.lines.join('\n'), /by hand/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

function runCli(args: readonly string[]): Promise<{ readonly code: number; readonly out: string; readonly errors: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'scripts/createStacki/cli.ts', ...args], { cwd: studio, timeout: 60_000 }, (error, out, errors) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ code, out, errors });
    });
  });
}

test('the command documents --auth and prints the sign-in options for an agent', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /--auth <github\|access\|google\|oidc\|passkey>/);
  assert.match(help.out, /never asked for or stored/);
  const agent = await runCli(['--agent']);
  assert.match(agent.out, /--auth/);
  assert.match(agent.out, /wrangler secret put GOOGLE_CLIENT_SECRET/);
  assert.match(agent.out, /Never ask me to paste a client secret/);
  assert.match(agent.out, /AUTH_SETUP_CODE[\s\S]*passkey\/bootstrap/);
  const invalid = await runCli(['--yes', '--auth', 'saml']);
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.errors, /--auth must be one of/);
});

const AUD = 'a'.repeat(64);

test('Cloudflare Access is the second choice and needs no secret', async () => {
  const session = scripted(['2', 'MyTeam.cloudflareaccess.com', AUD, 'Boss@Corp.com']);
  const project = await projectWithConfig();
  try {
    const chosen = await chooseSignIn(NO_FLAGS, session.prompter);
    assert.deepEqual(chosen, {
      ok: true,
      value: { kind: 'access', teamDomain: 'myteam.cloudflareaccess.com', aud: AUD, admin: 'access:boss@corp.com', teamDomainCustom: 'standard' },
    });
    assert.ok(chosen.ok);
    const configured = await configureSignIn(project, chosen.value, session.prompter);
    const after = await readFile(path.join(project, 'studio/cloudflare/wrangler.jsonc'), 'utf8');
    assert.match(after, /"AUTH_PROVIDER": "access"/);
    assert.match(after, /"ACCESS_TEAM_DOMAIN": "myteam\.cloudflareaccess\.com"/);
    assert.match(after, /"AUTH_BOOTSTRAP_ADMIN": "access:boss@corp\.com"/);
    const text = configured.lines.join('\n');
    assert.match(text, /\/studio\*/);
    assert.match(text, /Roles panel/);
    assert.doesNotMatch(text, /secret put/);
  } finally {
    session.prompter.close();
    await rm(project, { recursive: true, force: true });
  }
});

test('an Access team domain outside cloudflareaccess.com needs confirmation', async () => {
  const flags = { ...NO_FLAGS, auth: 'access' as const, teamDomain: 'access.corp.com', aud: AUD, admin: 'a@corp.com' };
  const refused = await chooseSignIn(flags, undefined);
  assert.ok(!refused.ok && /not a cloudflareaccess\.com domain/.test(refused.error));
  const confirmed = await chooseSignIn({ ...flags, teamDomainCheck: 'custom' }, undefined);
  assert.ok(confirmed.ok && confirmed.value.kind === 'access' && confirmed.value.teamDomainCustom === 'confirmed');
  const asked = scripted(['access.corp.com', 'y']);
  const interactive = await chooseSignIn(flags, asked.prompter);
  asked.prompter.close();
  assert.ok(interactive.ok);
  assert.equal(parseOptions(['--auth', 'access', '--auth-custom-domain']).teamDomainCheck, 'custom');
});

test('Passkeys print the setup code steps and only suggest a code when asked, never writing it', async () => {
  const project = await projectWithConfig();
  const file = path.join(project, 'studio/cloudflare/wrangler.jsonc');
  try {
    const declined = scripted(['n']);
    const first = await configureSignIn(project, { kind: 'passkey', admin: 'passkey:owner' }, declined.prompter);
    declined.prompter.close();
    const text = first.lines.join('\n');
    assert.match(text, /AUTH_BOOTSTRAP_ADMIN|passkey:owner/);
    assert.match(text, /wrangler secret put AUTH_SETUP_CODE --config cloudflare\/wrangler\.jsonc/);
    assert.match(text, /long random code \(16 to 200 characters/);
    assert.match(text, /\/studio\/auth\/passkey\/bootstrap/);
    assert.doesNotMatch(text, /Suggested AUTH_SETUP_CODE/);
    const before = await readFile(file, 'utf8');
    const accepted = scripted(['y', 'y']);
    const second = await configureSignIn(project, { kind: 'passkey', admin: 'passkey:owner' }, accepted.prompter);
    accepted.prompter.close();
    const line = second.lines.find((candidate) => candidate.startsWith('Suggested AUTH_SETUP_CODE'));
    assert.match(line ?? '', /: [A-Za-z0-9_-]{43}$/);
    const code = (line ?? '').split(': ').pop() ?? '';
    assert.ok(!(await readFile(file, 'utf8')).includes(code), 'the suggestion is never written to the config');
    assert.equal(before.includes('AUTH_SETUP_CODE'), false);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
