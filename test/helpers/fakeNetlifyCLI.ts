// A stand-in for the Netlify CLI, installed as a temporary site's own `netlify-cli`. It prints what netlify-cli 27.20.1
// prints (read from its source: login --request/--check, status --json, api, deploy --json) and records every call.
// It holds no account and opens no connection; a scenario file beside it decides what each command meets.
import fs from 'node:fs';
import path from 'node:path';
import { list, record, text } from '#dist/shared/core/boundary.js';

export type FakeNetlifyScenario = Required<FakeNetlifyChanges>;

/** What a test changes about the account and the next commands; the rest stays as FAKE_SCENARIO. */
export interface FakeNetlifyChanges {
  readonly auth?: 'ok' | 'signed-out' | 'expired';
  readonly network?: 'ok' | 'offline';
  /** What each `login --check` answers, in order; the last one repeats. */
  readonly checks?: readonly ('pending' | 'authorized' | 'denied' | 'offline' | 'hang')[];
  readonly request?: 'ok' | 'offline' | 'foreign-url';
  readonly deploy?: 'ok' | 'build-failure' | 'other-site' | 'no-result';
  readonly create?: 'ok' | 'hang' | 'garbled';
  readonly teams?: readonly { readonly slug: string; readonly name: string }[];
  readonly sites?: readonly FakeNetlifySite[];
}

export interface FakeNetlifySite {
  readonly id: string;
  readonly name: string;
  readonly account_slug: string;
  /** Absent here is the API's JSON null, which the fake prints. */
  readonly custom_domain?: string;
  readonly ssl_url: string;
}

export const FAKE_SITE: FakeNetlifySite = {
  id: '3b9f2c10-1111-4222-8333-944455556666',
  name: 'my-astro-site',
  account_slug: 'acme',
  ssl_url: 'https://my-astro-site.netlify.app',
};

export const FAKE_SCENARIO: FakeNetlifyScenario = {
  auth: 'ok',
  network: 'ok',
  checks: ['authorized'],
  request: 'ok',
  deploy: 'ok',
  create: 'ok',
  teams: [{ slug: 'acme', name: 'Acme team' }],
  sites: [FAKE_SITE],
};

/** Text no part of Stacki may ever show: the fake prints it in every failure, where a real CLI could quote a request. */
export const FAKE_SECRET = 'fake-netlify-secret-value';

const PROGRAM = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const home = path.dirname(fs.realpathSync(__filename));
const scenarioFile = path.join(home, 'scenario.json');
const read = () => JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
const scenario = read();
const argv = process.argv.slice(2);
const env = {};
for (const name of ['CI', 'BROWSER', 'NETLIFY_TELEMETRY_DISABLED', 'NETLIFY_SITE_ID', 'NETLIFY_AUTH_TOKEN', 'NETLIFY_WEB_UI']) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}
fs.appendFileSync(path.join(home, 'calls.jsonl'), JSON.stringify({ argv, env, cwd: process.cwd() }) + '\n');
const json = (value) => process.stdout.write(JSON.stringify(value, null, 2));
const fail = (line) => { process.stderr.write(' > Error: ' + line + ' (' + ${JSON.stringify(FAKE_SECRET)} + ')\n'); process.exit(1); };
const offline = () => fail('FetchError: request to https://api.netlify.com/api/v1/accounts failed, reason: getaddrinfo ENOTFOUND api.netlify.com');
const hang = () => setInterval(() => {}, 1000);
const [command, ...rest] = argv;
if (command === 'login' && rest[0] === '--request') {
  if (scenario.request === 'offline') offline();
  const host = scenario.request === 'foreign-url' ? 'https://evil.example' : 'https://app.netlify.com';
  json({ ticket_id: 'ticket123', url: host + '/authorize?response_type=ticket&ticket=ticket123&utm_source=cli&utm_campaign=integrations',
    check_command: 'netlify login --check ticket123', agent_next_steps: 'Give the URL to the user.' });
} else if (command === 'login' && rest[0] === '--check') {
  const [next, ...later] = scenario.checks;
  if (later.length > 0) fs.writeFileSync(scenarioFile, JSON.stringify({ ...scenario, checks: later }));
  if (next === 'offline') offline();
  else if (next === 'hang') hang();
  else if (next === 'authorized') {
    // As the real CLI does, an approved check stores the sign-in that later commands read.
    fs.writeFileSync(scenarioFile, JSON.stringify({ ...read(), auth: 'ok' }));
    json({ status: next, user: { id: 'u1', email: 'person@example.com', name: 'Person' } });
  }
  else json({ status: next });
} else if (command === 'status') {
  if (scenario.network === 'offline') offline();
  if (scenario.auth === 'ok') json({ loggedIn: true, linked: false, account: {}, siteData: null, error: { code: 'NOT_LINKED' } });
  else {
    json({ loggedIn: false, linked: false, account: null, siteData: null, error: { code: 'NOT_LOGGED_IN', fix: 'netlify login or NETLIFY_AUTH_TOKEN' } });
    if (scenario.auth === 'expired') fail('Your session has expired. Please try to re-authenticate by running "netlify logout" and "netlify login".');
    process.exit(1);
  }
} else if (command === 'api') {
  const method = rest[0];
  const data = JSON.parse(rest[rest.indexOf('--data') + 1]);
  if (scenario.network === 'offline') offline();
  if (scenario.auth !== 'ok') fail('JSONHTTPError: Unauthorized');
  if (method === 'listAccountsForUser') json(scenario.teams.map((team) => ({ id: 'id-' + team.slug, ...team })));
  else if (method === 'listSitesForAccount') {
    const sites = scenario.sites.filter((site) => site.account_slug === data.account_slug);
    json(sites.slice((data.page - 1) * data.per_page, data.page * data.per_page).map((site) => ({ custom_domain: null, ...site })));
  } else if (method === 'getSite') {
    const site = scenario.sites.find((entry) => entry.id === data.site_id);
    if (!site) fail('JSONHTTPError: Not Found');
    json({ custom_domain: null, ...site });
  } else if (method === 'createSiteInTeam') {
    if (scenario.create === 'hang') hang();
    else if (scenario.create === 'garbled') process.stdout.write('<html>');
    else {
      if (data.body.name === 'taken' || scenario.sites.some((site) => site.name === data.body.name)) fail('JSONHTTPError: Unprocessable Entity');
      const site = { id: 'new-' + data.body.name, name: data.body.name, account_slug: data.account_slug, custom_domain: null, ssl_url: 'https://' + data.body.name + '.netlify.app' };
      fs.writeFileSync(scenarioFile, JSON.stringify({ ...scenario, sites: [...scenario.sites, site] }));
      json(site);
    }
  } else fail('"' + method + '" is not a valid api method');
} else if (command === 'deploy') {
  if (scenario.deploy === 'build-failure') {
    process.stdout.write('Netlify Build\n{ not json\n');
    fail('Error while running build');
  }
  if (!argv.includes('--no-build')) process.stdout.write('Netlify Build\n  build.command completed\n');
  if (scenario.deploy !== 'no-result') {
    const siteId = scenario.deploy === 'other-site' ? 'some-other-site' : argv[argv.indexOf('--site') + 1];
    json({ site_id: siteId, site_name: 'my-astro-site', deploy_id: 'deploy1', deploy_url: 'https://deploy1--my-astro-site.netlify.app',
      logs: 'https://app.netlify.com/sites/my-astro-site/deploys/deploy1', function_logs: '', edge_function_logs: '', url: 'https://my-astro-site.netlify.app' });
  }
} else fail('Unknown command');
`;

export interface FakeNetlifyCall {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

function parseCall(line: string): FakeNetlifyCall {
  const value: unknown = JSON.parse(line);
  const call = record(value);
  return {
    argv: list(text)(call['argv']),
    env: Object.fromEntries(Object.entries(record(call['env'])).map(([name, entry]) => [name, text(entry)])),
    cwd: text(call['cwd']),
  };
}

/** Installs the fake as `root`'s own netlify-cli, the copy every Stacki lookup prefers. */
export function installFakeNetlify(root: string, changes: FakeNetlifyChanges = {}) {
  const home = path.join(root, 'node_modules', 'netlify-cli');
  const bin = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const manifest = { name: 'netlify-cli', version: '27.20.1', bin: { netlify: 'run.cjs', ntl: 'run.cjs' } };
  fs.writeFileSync(path.join(home, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(home, 'run.cjs'), PROGRAM, { mode: 0o755 });
  if (process.platform !== 'win32' && !fs.existsSync(path.join(bin, 'netlify'))) {
    fs.symlinkSync(path.join('..', 'netlify-cli', 'run.cjs'), path.join(bin, 'netlify'));
  }
  const set = (next: FakeNetlifyChanges) => {
    fs.writeFileSync(path.join(home, 'scenario.json'), JSON.stringify({ ...FAKE_SCENARIO, ...next }));
  };
  set(changes);
  const calls = (): readonly FakeNetlifyCall[] => {
    const file = path.join(home, 'calls.jsonl');
    if (!fs.existsSync(file)) {
      return [];
    }
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map(parseCall);
  };
  const forget = () => fs.rmSync(path.join(home, 'calls.jsonl'), { force: true });
  return { set, calls, forget };
}
