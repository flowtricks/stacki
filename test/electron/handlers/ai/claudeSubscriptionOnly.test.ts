// Goal: the AI panel runs Claude on a subscription only. No Claude process it starts gets a variable that chooses
// another kind of billing (status, token check, sign-in, sign-out, install, the adapter, hence chats, pin subagents,
// resumed chats and model listing); each is told to switch the settings routes off. "Signed in" takes proof: a
// claude.ai sign-in with a paid plan, or a token the CLI names as the subscription token. Everything else is signed
// out. Every message asks again. A running session that reports an API key is stopped and held as signed out with
// the reason; extra usage past the plan is shown as a warning while it lasts. Codex is left as it was.
// Methodology: AgentSetup and AgentHost from dist/ with real child processes. `claude` is a /bin/sh script that
// records each run's arguments and which blocked variables reached it, and answers `auth status` and the token
// check from marker files with the fields and values Claude Code 2.1.332 was seen to print for made-up credentials
// against a local fake API. The adapter is the stand-in ACP process; what the host writes to it is recorded. Every
// key is made up; nothing real is run, read or signed in to. Skipped on Windows, which has no /bin/sh.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { AgentHost } from '#dist/electron/handlers/ai/agentHost.js';
import { AgentSetup, readClaudeStatus, readClaudeTokenCheck, type SessionPermit, type SessionVerdict } from '#dist/electron/handlers/ai/agentSetup.js';
import { ChatStore } from '#dist/electron/handlers/ai/chatStore.js';
import { PinPictures } from '#dist/electron/handlers/ai/pinPictures.js';
import { CLAUDE_BLOCKED_VARIABLES, CLAUDE_SUBSCRIPTION_SETTINGS, claudeSubscriptionEnvironment } from '#dist/electron/lib/claudeSubscriptionOnly.js';
import { toRecord } from '#dist/shared/core/record.js';
import { parseSetupState, type SetupState } from '#dist/shared/ipc/aiChat.js';
import { parseClaudeSessionSignal, type ClaudeBillingSignal } from '#dist/shared/properties/ai/claudeBilling.js';
import { waitFor } from '../../../helpers/waitFor.js';

const posix = { skip: process.platform === 'win32' ? 'the fake CLI is a /bin/sh script' : false };
const KEY = 'sk-ant-api03-made-up-for-this-test';
const FAKE_ADAPTER = path.resolve('test/fixtures/ai/fakeAdapter.mjs');
/** As an app launched from a terminal that sets up every other route would hand it over. */
const EVERY_ROUTE: Readonly<Record<string, string>> = Object.fromEntries(CLAUDE_BLOCKED_VARIABLES.map((name) => [name, KEY]));
const SIGN_IN_ARGS = ['--settings', JSON.stringify(CLAUDE_SUBSCRIPTION_SETTINGS), 'auth', 'login', '--claudeai'];

type Context = { after: (run: () => void) => void };

const status = (fields: Readonly<Record<string, unknown>>) => JSON.stringify({ loggedIn: true, apiProvider: 'firstParty', ...fields });
const subscription = (plan: string) => status({ authMethod: 'claude.ai', subscriptionType: plan });
const tokenAccount = (account: Readonly<Record<string, unknown>>) =>
  JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'stacki', response: { account } } });

/** What `auth status` prints in each state a marker file stands for. */
const STATUSES = {
  max: subscription('max'),
  pro: subscription('pro'),
  team: subscription('team'),
  enterprise: subscription('enterprise'),
  'max-and-saved-key': status({ authMethod: 'claude.ai', subscriptionType: 'max', apiKeySource: '/login managed key' }),
  // A claude.ai sign-in without a plan, as Claude prints it.
  'no-plan': '{"loggedIn":true,"apiProvider":"firstParty","authMethod":"claude.ai","subscriptionType":null}',
  'new-method': status({ authMethod: 'gateway', subscriptionType: 'max' }),
  'saved-key': status({ authMethod: 'api_key', apiKeySource: '/login managed key' }),
  'managed-helper': status({ authMethod: 'api_key_helper', apiKeySource: 'apiKeyHelper' }),
  cloud: status({ authMethod: 'third_party', apiProvider: 'bedrock' }),
  token: status({ authMethod: 'oauth_token' }),
} as const;

/** What the token check answers; `silent` never answers. */
const TOKENS = {
  'subscription-token': tokenAccount({ tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: 'firstParty' }),
  'bearer-token': tokenAccount({ tokenSource: 'ANTHROPIC_AUTH_TOKEN', apiProvider: 'firstParty' }),
  'profile-token': tokenAccount({ apiProvider: 'firstParty' }),
  silent: '',
} as const;

function world(context: Context) {
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-subscription-only-')));
  context.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const calls = path.join(bin, 'calls');
  const file = (name: string) => path.join(bin, name);
  // Which blocked variables reached a run, by name: none may.
  const reached = CLAUDE_BLOCKED_VARIABLES.map((name) => `\${${name}+${name} }`).join('');
  const script = [
    '#!/bin/sh',
    `printf '%s|%s|%s\\n' "${reached}" "$ANTHROPIC_CONFIG_DIR" "$*" >> '${calls}'`,
    `case "$*" in`,
    `*'auth logout') /bin/rm -f '${file('status')}'; exit 0 ;;`,
    `*'auth status')`,
    `  [ -f '${file('broken')}' ] && exit 3`,
    `  if [ -f '${file('status')}' ]; then /bin/cat '${file('status')}'; exit 0; fi`,
    `  printf '%s\\n' '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'; exit 1 ;;`,
    // The token check: answers the one request, then waits for a message that never comes, as claude does.
    `*' -p '*)`,
    `  read -r request; printf '%s\\n' "$request" >> '${file('asked')}'`,
    `  printf '%s\\n' '{"type":"system","subtype":"hook_started"}'`,
    `  [ -s '${file('token-answer')}' ] && /bin/cat '${file('token-answer')}'`,
    '  exec /bin/sleep 30 ;;',
    'esac',
    'exit 0',
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'claude'), `${script}\n`, { mode: 0o755 });
  const environment = () => ({ PATH: bin, HOME: bin, ...EVERY_ROUTE });
  const set = (signIn: keyof typeof STATUSES | 'broken' | 'signed-out', token?: keyof typeof TOKENS) => {
    for (const name of ['status', 'broken', 'token-answer']) {
      fs.rmSync(file(name), { force: true });
    }
    if (signIn === 'broken') {
      fs.writeFileSync(file('broken'), '');
    } else if (signIn !== 'signed-out') {
      fs.writeFileSync(file('status'), `${STATUSES[signIn]}\n`);
    }
    if (token !== undefined && TOKENS[token] !== '') {
      fs.writeFileSync(file('token-answer'), `${TOKENS[token]}\n`);
    }
  };
  const lines = (name: string) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8').trim().split('\n') : []);
  const states: SetupState[] = [];
  const clock = { nowMs: 1_000_000 };
  const terminals: Record<string, string | undefined>[] = [];
  const signInExit = { code: 1 };
  const setup = new AgentSetup({
    environment,
    agentEnvironment: async () => environment(),
    openExternal: () => undefined,
    publish: (state: SetupState) => states.push(state),
    log: () => undefined,
    home: bin,
    now: () => clock.nowMs,
    statusRetryDelaysMs: [],
    // Long enough for a script to start under load; only the silent token check waits it out.
    statusTimeoutMs: 5_000,
    spawnTerminal: async (command, given) => {
      assert.deepEqual(command.args, SIGN_IN_ARGS, 'the subscription sign-in');
      terminals.push({ ...given });
      return {
        onData: () => undefined,
        onExit: (listener: (code: number) => void) => setImmediate(() => listener(signInExit.code)),
        write: () => undefined,
        kill: () => undefined,
      };
    },
  });
  context.after(() => setup.stopAll());
  return { bin, set, runs: () => lines('calls'), asked: () => lines('asked'), states, setup, clock, terminals, signInExit, environment };
}

test('only a proven subscription is signed in: each kind of sign-in, as Claude reports it', posix, async (context) => {
  const it = world(context);
  const refused = { agent: 'claude', step: 'signed-out', reason: 'not-subscription' };
  const account = (plan: string | undefined, source: 'account' | 'token') => ({
    agent: 'claude',
    step: 'ready',
    account: { name: undefined, plan, email: undefined, source },
  });
  for (const [signIn, token, permit, state] of [
    ['max', undefined, 'allowed', account('Max', 'account')],
    ['pro', undefined, 'allowed', account('Pro', 'account')],
    ['team', undefined, 'allowed', account('Team', 'account')],
    ['enterprise', undefined, 'allowed', account('Enterprise', 'account')],
    ['max-and-saved-key', undefined, 'allowed', account('Max', 'account')],
    ['token', 'subscription-token', 'allowed', account(undefined, 'token')],
    ['token', 'bearer-token', 'sign-in', refused],
    ['token', 'profile-token', 'sign-in', refused],
    ['token', 'silent', 'unchecked', { agent: 'claude', step: 'unchecked' }],
    ['no-plan', undefined, 'sign-in', refused],
    ['new-method', undefined, 'sign-in', refused],
    ['saved-key', undefined, 'sign-in', refused],
    ['managed-helper', undefined, 'sign-in', refused],
    ['cloud', undefined, 'sign-in', refused],
    ['signed-out', undefined, 'sign-in', { agent: 'claude', step: 'signed-out' }],
    ['broken', undefined, 'unchecked', { agent: 'claude', step: 'unchecked' }],
  ] as const) {
    const label = `${signIn} ${token ?? ''}`;
    it.set(signIn, token);
    assert.equal(await it.setup.permit('claude'), permit satisfies SessionPermit, label);
    assert.deepEqual(it.states.at(-1), state, label);
    assert.deepEqual(parseSetupState(JSON.parse(JSON.stringify(state))), state, `${label}: crosses to the window`);
  }
  // The token check wrote one request and never a message.
  assert.equal(it.asked().length, 4);
  for (const line of it.asked()) {
    assert.deepEqual(JSON.parse(line), { type: 'control_request', request_id: 'stacki', request: { subtype: 'initialize' } });
  }
});

test('every message asks again, messages asking together share one check, and a sign-out ends it', posix, async (context) => {
  const it = world(context);
  it.set('max');
  const together = await Promise.all([it.setup.permit('claude'), it.setup.permit('claude'), it.setup.permit('claude')]);
  assert.deepEqual(together, ['allowed', 'allowed', 'allowed']);
  assert.equal(it.runs().length, 1, 'one status for all');
  // Changed in a terminal a moment later: the very next message sees it.
  it.set('saved-key');
  assert.equal(await it.setup.permit('claude'), 'sign-in');
  it.set('max');
  assert.equal(await it.setup.permit('claude'), 'allowed', 'signed in again');
  await it.setup.act('claude', { kind: 'signOut' });
  assert.equal(await it.setup.permit('claude'), 'sign-in');
  assert.equal(await it.setup.permit('codex'), 'allowed', 'Codex is not asked');
});

test('every setup command of Claude runs without the other routes and with the settings that switch them off', posix, async (context) => {
  const it = world(context);
  it.set('token', 'subscription-token');
  await it.setup.act('claude', { kind: 'detect' });
  await it.setup.act('claude', { kind: 'signOut' });
  await it.setup.act('claude', { kind: 'signIn' });
  await waitFor({ what: 'the sign-in to end', read: () => it.states.at(-1)?.step, until: (step) => step === 'failed' });
  assert.equal(it.terminals.length, 1);
  assert.equal(Object.values(it.terminals[0] ?? {}).includes(KEY), false, 'the sign-in terminal has none');
  assert.ok(it.runs().length >= 4);
  for (const run of it.runs()) {
    assert.ok(run.startsWith(`|${os.devNull}|--settings {`), `no blocked variable, no profile folder: ${run}`);
    assert.ok(run.includes('"apiKeyHelper":""'), run);
    assert.ok(run.includes(`"env":${JSON.stringify(CLAUDE_SUBSCRIPTION_SETTINGS.env)}`), run);
  }
  assert.ok(it.runs().some((run) => run.includes('"disableAllHooks":true') && run.endsWith('--strict-mcp-config --no-session-persistence')));
  assert.deepEqual(
    claudeSubscriptionEnvironment('claude', { Anthropic_Api_Key: KEY, claude_code_use_vertex: '1', CLAUDE_CODE_OAUTH_TOKEN: 'kept' }),
    { CLAUDE_CODE_OAUTH_TOKEN: 'kept', ANTHROPIC_CONFIG_DIR: os.devNull },
    'Windows names have any case, and the subscription token stays',
  );
  assert.deepEqual(claudeSubscriptionEnvironment('codex', EVERY_ROUTE), EVERY_ROUTE, 'Codex is unchanged');
});

test('a running session that reports an API key is stopped and held as signed out until a sign-in here', posix, async (context) => {
  const it = world(context);
  it.set('max');
  await it.setup.permit('claude');
  const keySource = (source: string): ClaudeBillingSignal => ({ kind: 'key-source', source });
  assert.equal(await it.setup.sessionSignal('claude', keySource('none')), 'continue');
  assert.equal(it.runs().length, 1, 'no key, nothing to ask');
  // A saved Console key beside the subscription: settled by asking again, both ways.
  it.set('max-and-saved-key');
  assert.equal(await it.setup.sessionSignal('claude', keySource('/login managed key')), 'continue');
  it.set('saved-key');
  assert.equal(await it.setup.sessionSignal('claude', keySource('/login managed key')), 'stop');
  it.set('broken');
  assert.equal(await it.setup.sessionSignal('claude', keySource('/login managed key')), 'stop', 'what cannot be checked is not proven');
  // Any other source is a key in use, whatever the status goes on to say.
  it.set('max');
  assert.equal(await it.setup.sessionSignal('claude', keySource('apiKeyHelper')), 'stop');
  const billed = { agent: 'claude', step: 'signed-out', reason: 'billed' };
  assert.deepEqual(it.states.at(-1), billed);
  assert.deepEqual(parseSetupState(JSON.parse(JSON.stringify(billed))), billed);
  assert.equal(await it.setup.permit('claude'), 'sign-in', 'a status that looks fine does not undo what was seen');
  assert.deepEqual(it.states.at(-1), billed);
  it.signInExit.code = 0;
  await it.setup.act('claude', { kind: 'signIn' });
  await waitFor({ what: 'the new sign-in', read: () => it.states.at(-1)?.step, until: (step) => step === 'ready' });
  assert.equal(await it.setup.permit('claude'), 'allowed');
});

test('a sign-in that works but is no subscription shows the card that says so, not a failure', posix, async (context) => {
  const it = world(context);
  it.set('no-plan');
  it.signInExit.code = 0;
  await it.setup.act('claude', { kind: 'signIn' });
  await waitFor({ what: 'the check after signing in', read: () => it.states.at(-1)?.step, until: (step) => step === 'signed-out' });
  assert.ok(!it.states.some((state) => state.step === 'failed'));
});

test('extra usage is a warning on the signed-in state while it lasts: until the session says so or the usage returns', posix, async (context) => {
  const it = world(context);
  it.set('max');
  await it.setup.permit('claude');
  const billing = () => {
    const state = it.states.at(-1);
    return state?.step === 'ready' ? (state.billing ?? 'none') : state?.step;
  };
  const resetsAtSeconds = it.clock.nowMs / 1000 + 3_600;
  const pastThePlan: ClaudeBillingSignal = { kind: 'usage', extra: true, resetsAtSeconds };
  const withinThePlan: ClaudeBillingSignal = { kind: 'usage', extra: false, resetsAtSeconds: undefined };
  assert.equal(await it.setup.sessionSignal('claude', withinThePlan), 'continue');
  assert.equal(billing(), 'none', 'within the plan: no warning');
  const published = it.states.length;
  assert.equal(await it.setup.sessionSignal('claude', pastThePlan), 'continue');
  assert.equal(billing(), 'extra-usage');
  await it.setup.sessionSignal('claude', pastThePlan);
  assert.equal(it.states.length, published + 1, 'said once');
  assert.deepEqual(parseSetupState(JSON.parse(JSON.stringify(it.states.at(-1)))), it.states.at(-1));
  await it.setup.permit('claude');
  assert.equal(billing(), 'extra-usage', 'a status check keeps it');
  await it.setup.sessionSignal('claude', withinThePlan);
  assert.equal(billing(), 'none');
  await it.setup.sessionSignal('claude', pastThePlan);
  it.clock.nowMs = resetsAtSeconds * 1000;
  await it.setup.permit('claude');
  assert.equal(billing(), 'none', 'the included usage is back');
});

test('the two readers take only the shapes Claude prints', () => {
  const read = (message: unknown) => parseClaudeSessionSignal({ sessionId: 's1', message })?.signal;
  assert.deepEqual(read({ type: 'system', subtype: 'init', apiKeySource: 'none' }), { kind: 'key-source', source: 'none' });
  assert.deepEqual(read({ type: 'rate_limit_event', rate_limit_info: { isUsingOverage: true, resetsAt: 12 } }), {
    kind: 'usage',
    extra: true,
    resetsAtSeconds: 12,
  });
  assert.deepEqual(read({ type: 'rate_limit_event', rate_limit_info: { isUsingOverage: false, resetsAt: 'soon' } }), {
    kind: 'usage',
    extra: false,
    resetsAtSeconds: undefined,
  });
  for (const message of [
    { type: 'system', subtype: 'status', apiKeySource: 'x' },
    { type: 'system', subtype: 'init' },
    { type: 'system', subtype: 'init', apiKeySource: 'x'.repeat(600) },
    { type: 'rate_limit_event', rate_limit_info: { isUsingOverage: 'yes' } },
    { type: 'rate_limit_event' },
    'init',
    undefined,
  ]) {
    assert.equal(read(message), undefined, JSON.stringify(message));
  }
  assert.equal(parseClaudeSessionSignal({ message: { type: 'system', subtype: 'init', apiKeySource: 'none' } }), undefined, 'no session');
  const answer = TOKENS['subscription-token'];
  assert.equal(readClaudeTokenCheck(answer), undefined, 'half a line is not an answer yet');
  assert.equal(readClaudeTokenCheck(`${answer}\n`)?.kind, 'signed-in');
  assert.equal(readClaudeTokenCheck('not json\n{"type":"system"}\n'), undefined);
  const keyed = tokenAccount({ tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' });
  assert.equal(readClaudeTokenCheck(`${keyed}\n`)?.kind, 'signed-out');
  const elsewhere = tokenAccount({ tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: 'bedrock' });
  assert.equal(readClaudeTokenCheck(`${elsewhere}\n`)?.kind, 'signed-out');
  const withoutProvider = { stdout: '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}', stderr: '', exitCode: 0 };
  assert.deepEqual(readClaudeStatus(withoutProvider), { kind: 'signed-out', reason: 'not-subscription' }, 'unproven is refused');
});

function hostWorld(context: Context, permit: () => Promise<SessionPermit>, sessionSignal?: (signal: ClaudeBillingSignal) => Promise<SessionVerdict>) {
  const it = world(context);
  const root = fs.mkdtempSync(path.join(it.bin, 'project-'));
  const store = new ChatStore(path.join(it.bin, 'user', 'ai'));
  store.trust(root);
  const environments: Record<string, string | undefined>[] = [];
  const requests: { readonly method: string; readonly params: Record<string, unknown> }[] = [];
  const make = () => {
    const host = new AgentHost({
      userData: path.join(it.bin, 'user'),
      store,
      send: () => undefined,
      files: { read: () => undefined, write: () => undefined, create: () => undefined, trash: async () => undefined },
      snapshots: { snapshot: async () => undefined, changes: async () => [], blob: async () => undefined },
      environment: () => ({ PATH: `${it.bin}${path.delimiter}${process.env['PATH'] ?? ''}`, HOME: it.bin, ...EVERY_ROUTE }),
      // Even an environment that still held another route would lose it at the spawn.
      agentEnvironment: async () => ({ PATH: process.env['PATH'], HOME: it.bin, ...EVERY_ROUTE }),
      permit,
      ...(sessionSignal === undefined ? {} : { sessionSignal: (_agent, signal) => sessionSignal(signal) }),
      now: () => 1_000,
      version: 'test',
      askBeforeTrust: () => true,
      entryOf: () => FAKE_ADAPTER,
      spawnAdapter: (entry: string, cwd: string, environment: Record<string, string | undefined>) => {
        environments.push({ ...environment });
        const child = spawn(process.execPath, [entry], { cwd, env: { ...environment }, stdio: ['pipe', 'pipe', 'pipe'] });
        // What the host writes passes through a tap on its way to the adapter.
        const adapterInput = child.stdin;
        const tap = new PassThrough();
        tap.on('data', (chunk: Buffer) => {
          for (const line of chunk
            .toString('utf8')
            .split('\n')
            .filter((text) => text.trim() !== '')) {
            const message = toRecord(JSON.parse(line));
            const method = message?.['method'];
            if (typeof method === 'string') {
              requests.push({ method, params: toRecord(message?.['params']) ?? {} });
            }
          }
        });
        tap.pipe(adapterInput);
        Object.defineProperty(child, 'stdin', { value: tap });
        return child;
      },
    });
    context.after(() => host.stopAll());
    return host;
  };
  const chat = () => {
    const record = store.create(root, 'claude', 'New chat', 1);
    assert.ok(record !== undefined);
    return record.id;
  };
  const sessions = () => requests.filter((request) => /^session\/(new|resume|load|fork)$/.test(request.method));
  return { ...it, root, store, make, chat, environments, requests, sessions };
}

test('no permit, no Claude process: an unproven or unchecked sign-in starts nothing', posix, async (context) => {
  for (const [permit, code] of [
    ['sign-in', 'sign-in'],
    ['unchecked', 'agent-failed'],
  ] as const) {
    const it = hostWorld(context, async () => permit);
    const refused = await it.make().prompt(it.root, it.chat(), 'hello', []);
    assert.ok(!refused.ok, permit);
    assert.equal(refused.error.code, code, permit);
    assert.deepEqual(it.environments, [], 'no adapter started');
  }
});

test('the adapter has no other route, and every session it opens or reopens carries the settings and asks what it signs in with', posix, async (context) => {
  const it = hostWorld(context, async () => 'allowed');
  const first = it.make();
  const chat = it.chat();
  const started = await first.prompt(it.root, chat, 'hello', []);
  assert.ok(started.ok, JSON.stringify(started));
  await waitFor({ what: 'the session', read: () => it.store.find(it.root, chat)?.sessionId, until: (id) => id !== undefined });
  first.stopAll();
  // A new run of the app: a fork continues the first chat's session (`session/fork`, built as resume and load are),
  // and the early session that lists the models.
  const again = it.make();
  const forked = it.store.fork(it.root, chat, 2);
  assert.ok(forked.ok, JSON.stringify(forked));
  const prompted = await again.prompt(it.root, forked.value.id, 'hello again', []);
  assert.ok(prompted.ok, JSON.stringify(prompted));
  await waitFor({ what: 'the forked session', read: () => it.sessions().some((request) => request.method === 'session/fork'), until: Boolean });
  const before = it.sessions().length;
  again.prewarm(it.root, 'claude', 'warm');
  await waitFor({ what: 'the early session', read: () => it.sessions().length, until: (count) => count > before });
  assert.ok(it.environments.length >= 2);
  for (const environment of it.environments) {
    assert.deepEqual(
      CLAUDE_BLOCKED_VARIABLES.filter((name) => name in environment),
      [],
    );
    assert.equal(Object.values(environment).includes(KEY), false);
    assert.equal(environment['ANTHROPIC_CONFIG_DIR'], os.devNull);
  }
  const methods = new Set(it.sessions().map((request) => request.method));
  assert.deepEqual([...methods].sort(), ['session/fork', 'session/new']);
  const rule = new PinPictures(path.join(it.bin, 'user')).readRule(it.root);
  const settings = { ...CLAUDE_SUBSCRIPTION_SETTINGS, permissions: { allow: [rule] } };
  const emitRawSDKMessages = [{ type: 'system', subtype: 'init' }, { type: 'rate_limit_event' }];
  for (const request of it.sessions()) {
    assert.deepEqual(request.params['_meta'], { claudeCode: { options: { settings }, emitRawSDKMessages } }, request.method);
  }
});

test('what a running session says reaches the setup, and a turn it refuses is cancelled', posix, async (context) => {
  for (const verdict of ['stop', 'continue'] as const) {
    const seen: ClaudeBillingSignal[] = [];
    const it = hostWorld(
      context,
      async () => 'allowed',
      async (signal) => {
        seen.push(signal);
        return verdict;
      },
    );
    const host = it.make();
    const chat = it.chat();
    const started = await host.prompt(it.root, chat, 'report billing', []);
    assert.ok(started.ok, JSON.stringify(started));
    await waitFor({ what: 'the signal', read: () => seen.length, until: (count) => count === 1 });
    assert.deepEqual(seen, [{ kind: 'key-source', source: 'ANTHROPIC_API_KEY' }]);
    const cancels = () => it.requests.filter((request) => request.method === 'session/cancel').length;
    if (verdict === 'stop') {
      await waitFor({ what: 'the cancel', read: cancels, until: (count) => count === 1 });
    } else {
      host.cancel(it.root, chat);
      assert.equal(cancels(), 1, 'only the person’s own stop');
    }
  }
});
