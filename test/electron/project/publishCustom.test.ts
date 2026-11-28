// Goal: a Custom host deploys exactly as chosen (GitHub auto-deploy, a deploy script, or a deploy link), refuses
// before pushing when it cannot, and never lets the deploy link reach a tracked file, a log, a message or a child
// process. Method: the real publisher on temporary Git projects with a local bare remote, package scripts that
// record their runs, a stand-in for the computer's encryption, and an injected transport instead of the network
// (so the https rule is never weakened). One test serves the transport from a real local server to see the bytes.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { git } from '#dist/electron/lib/nodeTools.js';
import { DesktopPublisher } from '#dist/electron/project/publisher.js';
import { readPublishAvailability } from '#dist/electron/project/publishAvailability.js';
import { repositoryIdentity } from '#dist/electron/project/deployLinkStore.js';
import { deployResponse, sendDeployRequest, type DeployTransport } from '#dist/electron/project/deployRequest.js';
import { DEFAULT_PUBLISH_CONFIG, type CustomHosting } from '#dist/shared/properties/publishConfig.js';
import { record } from '#dist/shared/core/boundary.js';
import { PUBLISH_TEMPORARY_SEAMS } from '#dist/electron/project/publishTemporary.js';
import { deployCalls, fakeLinkStore, filesUnder, finished, publishSite, scriptsRun, write } from '../../helpers/publishSite.ts';

const SECRET = 'k9QzSECRETtoken42';
const LINK = `https://api.host.example/deploy_hooks/${SECRET}?key=${SECRET}`;

function custom(customHosting: CustomHosting, extra: Readonly<Record<string, unknown>> = {}) {
  return { ...DEFAULT_PUBLISH_CONFIG, customHosting, beforePublish: ['before'], afterPublish: ['after'], ...extra };
}

interface Sent {
  readonly address: string;
  readonly method: string;
}

function transport(answers: readonly (number | { readonly status: number; readonly location: string } | Error)[]) {
  const sent: Sent[] = [];
  const send: DeployTransport = async (address, options) => {
    sent.push({ address, method: options.method });
    const answer = answers[Math.min(sent.length - 1, answers.length - 1)];
    if (answer instanceof Error) {
      throw answer;
    }
    const { status, location } = typeof answer === 'object' ? answer : { status: answer ?? 200, location: undefined };
    return { status, location };
  };
  return { sent, send };
}

async function edit(root: string) {
  write(root, 'page.txt', `Edit ${Math.random()}`);
}

test('GitHub auto-deploy only pushes: no build, hooks or deploy, and nothing is claimed beyond the push', async (context) => {
  const site = await publishSite(context, { publish: custom({ deploy: 'github', siteUrl: 'https://example.com' }) });
  await edit(site.root);
  const publisher = new DesktopPublisher();
  publisher.start(site.root, 'all', 'Update');
  assert.deepEqual(await finished(publisher, site.root), { kind: 'done', github: true, hosting: false, handoff: 'github' });
  assert.deepEqual(site.calls(), []);
  assert.equal(await site.revision(site.remote, 'refs/heads/main'), await site.revision(site.root, 'HEAD'));
  assert.equal((await readPublishAvailability(site.root)).hosting, 'unconfigured');
  publisher.start(site.root, 'hosting');
  const state = await finished(publisher, site.root);
  assert.equal(state.kind, 'failed');
  assert.equal(state.kind === 'failed' ? state.messageRef?.key : '', 'publish.custom.autoDeploy');
});

test('a deploy script runs after the build and the push, and only the push is claimed before it runs', async (context) => {
  const site = await publishSite(context, { publish: custom({ deploy: 'script', script: 'ship' }) });
  await edit(site.root);
  const publisher = new DesktopPublisher();
  publisher.start(site.root, 'all', 'Update');
  assert.deepEqual(await finished(publisher, site.root), { kind: 'done', github: true, hosting: true, handoff: 'script' });
  assert.deepEqual(scriptsRun(site.calls()), ['before', 'build', 'ship', 'after']);
  for (const call of site.calls()) {
    assert.equal(call.env['STACKI_PUBLISH_ENV'], 'production', call.argv[0]);
  }
  assert.equal((await readPublishAvailability(site.root)).hosting, 'current');
  await edit(site.root);
  assert.equal((await readPublishAvailability(site.root)).hosting, 'pending');
});

test('a script package.json no longer has stops before building or pushing', async (context) => {
  const site = await publishSite(context, { publish: custom({ deploy: 'script', script: 'gone' }) });
  await edit(site.root);
  const before = await site.refs();
  const publisher = new DesktopPublisher();
  publisher.start(site.root, 'all', 'Update');
  const state = await finished(publisher, site.root);
  assert.equal(state.kind === 'failed' ? state.messageRef?.key : '', 'publish.custom.script.missing');
  assert.deepEqual(site.calls(), []);
  assert.equal(await site.refs(), before);
});

test('a failing deploy script keeps the push, reports the failure and records no deployment', async (context) => {
  const site = await publishSite(context, { publish: custom({ deploy: 'script', script: 'broken' }) });
  await edit(site.root);
  const publisher = new DesktopPublisher();
  publisher.start(site.root, 'all', 'Update');
  const state = await finished(publisher, site.root);
  assert.equal(state.kind, 'failed');
  assert.ok(state.kind === 'failed' && state.github && !state.hosting);
  assert.equal(state.kind === 'failed' ? state.handoff : undefined, 'github');
  assert.equal((await readPublishAvailability(site.root)).hosting, 'pending');
});

test('a settings file alone runs and sends nothing: only choosing to publish to the host does', async (context) => {
  const site = await publishSite(context, { publish: custom({ deploy: 'script', script: 'ship' }) });
  const store = fakeLinkStore(site.userData);
  await readPublishAvailability(site.root);
  assert.deepEqual(site.calls(), []);
  await edit(site.root);
  const publisher = new DesktopPublisher(PUBLISH_TEMPORARY_SEAMS, { deployLinks: store });
  publisher.start(site.root, 'github', 'Push only');
  await finished(publisher, site.root);
  assert.deepEqual(site.calls(), []);
});

test('a deploy link pushes, then sends one POST, with no local build', async (context) => {
  const site = await publishSite(context, { publish: custom({ deploy: 'link' }, { beforePublish: [], afterPublish: [] }) });
  // No checkout is needed, so a site without installed dependencies still publishes.
  fs.rmSync(path.join(site.root, 'node_modules'), { recursive: true });
  const store = fakeLinkStore(site.userData);
  assert.equal((await store.save(site.root, LINK)).ok, true);
  await edit(site.root);
  const network = transport([201]);
  const publisher = new DesktopPublisher(PUBLISH_TEMPORARY_SEAMS, { deployLinks: store, transport: network.send });
  publisher.start(site.root, 'all', 'Update');
  assert.deepEqual(await finished(publisher, site.root), { kind: 'done', github: true, hosting: true, handoff: 'link' });
  assert.deepEqual(network.sent, [{ address: LINK, method: 'POST' }]);
  assert.deepEqual(site.calls(), []);
  assert.equal((await readPublishAvailability(site.root)).hosting, 'current');
});

test('a request without a push is not recorded as deploying work GitHub does not have', async (context) => {
  const site = await publishSite(context, { publish: custom({ deploy: 'link' }, { beforePublish: [], afterPublish: [] }) });
  const store = fakeLinkStore(site.userData);
  await store.save(site.root, LINK);
  await git(site.root, ['fetch', '--quiet', 'origin']);
  await edit(site.root);
  const network = transport([200]);
  const publisher = new DesktopPublisher(PUBLISH_TEMPORARY_SEAMS, { deployLinks: store, transport: network.send });
  publisher.start(site.root, 'hosting');
  assert.equal((await finished(publisher, site.root)).kind, 'done');
  assert.equal(network.sent.length, 1);
  assert.equal((await readPublishAvailability(site.root)).hosting, 'pending');
  // Once GitHub holds the same files, a request on its own is recorded, with no upstream setting needed.
  await git(site.root, ['add', '--all']);
  await git(site.root, ['commit', '--quiet', '--message', 'Pushed elsewhere']);
  await git(site.root, ['push', '--quiet', 'origin', 'main']);
  await git(site.root, ['fetch', '--quiet', 'origin']);
  publisher.start(site.root, 'hosting');
  assert.equal((await finished(publisher, site.root)).kind, 'done');
  assert.equal((await readPublishAvailability(site.root)).hosting, 'current');
});

test('no saved link stops before pushing; a link saved for another repository is never sent', async (context) => {
  const site = await publishSite(context, { publish: custom({ deploy: 'link' }) });
  const store = fakeLinkStore(site.userData);
  const network = transport([200]);
  const publisher = new DesktopPublisher(PUBLISH_TEMPORARY_SEAMS, { deployLinks: store, transport: network.send });
  const before = await site.refs();
  const refused = async (key: string) => {
    await edit(site.root);
    publisher.start(site.root, 'all', 'Update');
    const state = await finished(publisher, site.root);
    assert.equal(state.kind === 'failed' ? state.messageRef?.key : state.kind, key);
    assert.equal(await site.refs(), before);
    assert.deepEqual(network.sent, []);
    assert.deepEqual(site.calls(), []);
  };
  await refused('publish.custom.link.missing');
  await store.save(site.root, LINK);
  // The same folder now holds a different repository, as after a fresh clone into it.
  await git(site.root, ['config', 'remote.origin.url', 'https://github.com/someone/else.git']);
  await git(site.root, ['config', `url.${site.remote}.insteadOf`, 'https://github.com/someone/else.git']);
  await refused('publish.custom.link.otherRepository');
  assert.deepEqual(await store.state(site.root), { kind: 'other-repository' });
});

test('one repository has one identity however its address is spelled', () => {
  const expected = 'github.com/owner/site';
  for (const origin of ['https://github.com/Owner/Site.git', 'git@github.com:owner/site.git', 'https://token@github.com/owner/site']) {
    assert.equal(repositoryIdentity(origin), expected, origin);
  }
  assert.notEqual(repositoryIdentity('https://github.com.evil.example/owner/site.git'), expected);
});

// The publisher resolves a project with the operating system's own resolver. On Windows, Node's JavaScript
// `fs.realpathSync` can answer differently for the same folder: it keeps a short (8.3) name such as RUNNER~1 and a
// mapped or substituted drive letter. A link junction stands for the other spelling, and the JavaScript resolver is
// replaced with one that keeps it, so every platform takes the Windows path.
test('a link saved under another spelling of the project folder is still the one publishing sends', async (context) => {
  const site = await publishSite(context, { publish: custom({ deploy: 'link' }, { beforePublish: [], afterPublish: [] }) });
  const spelled = path.join(site.directory, 'SITE~1');
  fs.symlinkSync(site.root, spelled, 'junction');
  const keepsSpelling = Object.assign((target: fs.PathLike) => String(target), { native: fs.realpathSync.native });
  context.mock.method(fs, 'realpathSync', keepsSpelling);
  const store = fakeLinkStore(site.userData);
  assert.equal((await store.save(spelled, LINK)).ok, true);
  assert.equal((await store.state(site.root)).kind, 'saved', 'Both spellings are one project');
  await edit(site.root);
  const network = transport([200]);
  const publisher = new DesktopPublisher(PUBLISH_TEMPORARY_SEAMS, { deployLinks: store, transport: network.send });
  publisher.start(spelled, 'all', 'Update');
  assert.deepEqual(await finished(publisher, spelled), { kind: 'done', github: true, hosting: true, handoff: 'link' });
  assert.deepEqual(network.sent, [{ address: LINK, method: 'POST' }]);
  // Removing under either spelling removes the one saved link.
  assert.equal(store.remove(spelled).ok, true);
  assert.deepEqual(await store.state(site.root), { kind: 'none' });
});

test('without the computer’s encryption nothing is kept', async (context) => {
  const site = await publishSite(context, { publish: custom({ deploy: 'link' }) });
  const store = fakeLinkStore(site.userData, { available: false });
  const saved = await store.save(site.root, LINK);
  assert.equal(saved.ok ? '' : saved.error.messageRef?.key, 'publish.custom.link.unavailable');
  assert.deepEqual(fs.readdirSync(site.userData), []);
  assert.deepEqual(await store.state(site.root), { kind: 'unavailable' });
});

test('two destinations can never hold or send the same link, and one removed destination’s link is gone', async (context) => {
  const site = await publishSite(context, { publish: custom({ deploy: 'link' }) });
  const store = fakeLinkStore(site.userData);
  const ids = ['staging', 'd-review01'];
  assert.equal((await store.save(site.root, 'https://host.example/staging', 'staging', ids)).ok, true);
  const taken = await store.save(site.root, 'https://host.example/staging', 'd-review01', ids);
  assert.equal(taken.ok ? '' : taken.error.messageRef?.key, 'publish.destination.error.sharedLink');
  assert.deepEqual(await store.state(site.root, 'd-review01'), { kind: 'none' });
  // Saved before the other destination was known of, the copy is still never sent.
  assert.equal((await store.save(site.root, 'https://host.example/staging', 'd-review01')).ok, true);
  const sent = await store.linkToSend(site.root, 'd-review01', ids);
  assert.equal(sent.ok ? '' : sent.error.messageRef?.key, 'publish.destination.error.sharedLink');
  assert.equal(store.remove(site.root, 'staging').ok, true);
  assert.deepEqual(await store.state(site.root, 'staging'), { kind: 'none' });
  assert.deepEqual(await store.linkToSend(site.root, 'd-review01', ['d-review01']), { ok: true, value: 'https://host.example/staging' });
});

test('each destination has its own link, and staging can never hold or send production’s', async (context) => {
  const site = await publishSite(context, { publish: custom({ deploy: 'link' }) });
  const store = fakeLinkStore(site.userData);
  assert.equal((await store.save(site.root, LINK, 'production')).ok, true);
  const same = await store.save(site.root, LINK, 'staging');
  assert.equal(same.ok ? '' : same.error.messageRef?.key, 'publish.destination.error.productionLink');
  assert.deepEqual(await store.state(site.root, 'staging'), { kind: 'none' });
  assert.equal((await store.linkToSend(site.root, 'staging')).ok, false);
  const file = path.join(site.userData, 'deploy-links.json');
  const links = () => {
    const stored: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return record(record(stored)['links']);
  };
  const [productionKey, productionValue] = Object.entries(links())[0] ?? [];
  await store.save(site.root, 'https://api.host.example/staging', 'staging');
  // Production's sealed value moved under staging's key by hand answers as unset.
  const stagingKey = Object.keys(links()).find((key) => key !== productionKey);
  assert.ok(stagingKey !== undefined);
  fs.writeFileSync(file, JSON.stringify({ version: 1, links: { [stagingKey]: productionValue } }));
  assert.deepEqual(await store.state(site.root, 'staging'), { kind: 'none' });
  if (process.platform !== 'win32') {
    store.remove(site.root, 'staging');
    assert.equal(fs.statSync(file).mode & 0o077, 0, 'The store is readable by its owner only');
  }
});

for (const [name, answers, key] of [
  ['a refusal', [500], 'publish.custom.request.refused'],
  ['a redirect that would change the method', [{ status: 302, location: 'https://api.host.example/next' }], 'publish.custom.request.redirected'],
  ['a redirect to another host', [{ status: 307, location: 'https://evil.example/next' }], 'publish.custom.request.redirected'],
  ['a redirect to http', [{ status: 308, location: 'http://api.host.example/next' }], 'publish.custom.request.redirected'],
  ['a network failure that quotes the link', [new Error(`getaddrinfo ENOTFOUND ${LINK}`)], 'publish.custom.request.unreachable'],
] as const) {
  test(`${name} fails once, without retrying or repeating the link`, async () => {
    const network = transport(answers);
    const sent = await sendDeployRequest(LINK, network.send);
    assert.equal(sent.ok ? '' : sent.error.messageRef?.key, key);
    assert.equal(network.sent.length, 1);
    assert.ok(!JSON.stringify(sent).includes(SECRET));
  });
}

test('a same-origin redirect that keeps the method is followed, and a loop of them is capped', async () => {
  const followed = transport([{ status: 307, location: '/moved' }, 200]);
  assert.equal((await sendDeployRequest(LINK, followed.send)).ok, true);
  assert.deepEqual(
    followed.sent.map((call) => call.address),
    [LINK, 'https://api.host.example/moved'],
  );
  const loop = transport([{ status: 307, location: '/again' }]);
  assert.equal((await sendDeployRequest(LINK, loop.send)).ok, false);
  assert.equal(loop.sent.length, 4);
});

test('a host that never answers times out, and says the deploy may have started', async (context) => {
  // The deadline's timer does not keep a bare test process alive on its own, as the app's own loop does.
  const alive = setInterval(() => undefined, 1_000);
  context.after(() => clearInterval(alive));
  const silent: DeployTransport = (_address, options) =>
    new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error(LINK)), { once: true }));
  const sent = await sendDeployRequest(LINK, silent, 50);
  assert.equal(sent.ok ? '' : sent.error.messageRef?.key, 'publish.custom.request.timedOut');
});

test('what reaches the host is an empty POST, and a large answer is not read', async (context: TestContext) => {
  const received: { method: string | undefined; bytes: number }[] = [];
  const server = http.createServer((request, response) => {
    let bytes = 0;
    request.on('data', (chunk: Buffer) => (bytes += chunk.length));
    request.on('end', () => {
      received.push({ method: request.method, bytes });
      response.writeHead(200);
      response.write('x'.repeat(65_536));
      // Left open: a client that read the whole answer would never finish.
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(typeof address === 'object' && address !== null);
  const sent = await sendDeployRequest(LINK, (_https, options) => fetch(`http://127.0.0.1:${address.port}/hook`, options).then(deployResponse), 5_000);
  assert.equal(sent.ok, true);
  assert.deepEqual(received, [{ method: 'POST', bytes: 0 }]);
});

test('the link never reaches a tracked file, Git history, the settings, a log, a message or a script', async (context) => {
  const logged: string[] = [];
  for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    context.mock.method(console, method, (...values: readonly unknown[]) => logged.push(values.map(String).join(' ')));
  }
  const site = await publishSite(context, { publish: custom({ deploy: 'link' }) });
  const store = fakeLinkStore(site.userData);
  assert.equal((await store.save(site.root, LINK)).ok, true);
  const seen: unknown[] = [await store.state(site.root)];
  for (const answers of [[200], [500], [new Error(`connect failed ${LINK}`)], [{ status: 307, location: `https://evil.example/${SECRET}` }]] as const) {
    await edit(site.root);
    const publisher = new DesktopPublisher(PUBLISH_TEMPORARY_SEAMS, { deployLinks: store, transport: transport(answers).send });
    publisher.start(site.root, 'all', 'Update');
    seen.push(await finished(publisher, site.root), await readPublishAvailability(site.root));
  }
  // The build, hooks and Git ran with the link saved, and none of them was told it.
  assert.deepEqual([...new Set(scriptsRun(site.calls()))], ['before', 'after']);
  assert.deepEqual(deployCalls(site.calls()), []);
  seen.push(site.calls());
  const history = (await git(site.remote, ['log', '--all', '--patch', '--format=%B'])).stdout;
  const files = filesUnder(site.directory, ['objects']).map((file) => fs.readFileSync(file, 'utf8'));
  for (const [where, content] of [
    ['messages and states', JSON.stringify(seen)],
    ['console', logged.join('\n')],
    ['Git history', history],
    ['files', files.join('\n')],
  ] as const) {
    assert.ok(!content.includes(SECRET), `The deploy link reached: ${where}`);
  }
  // A control: the search above does find the link where it was deliberately written.
  write(site.root, 'control.txt', LINK);
  assert.ok(filesUnder(site.directory, ['objects']).some((file) => fs.readFileSync(file, 'utf8').includes(SECRET)));
});
