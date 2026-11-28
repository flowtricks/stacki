// Goal: a role's editing options (shared/properties/projectRoles.ts) hold on the
// Studio server, not only in the interface: for every option off, the edit it
// covers is refused however it is sent, and the edits still on keep working.
// Method: judge real before and after sources through the same check the room runs
// (assertEditorContentAllowed) over a temporary project whose component prints one
// prop as text, uses another as a class and takes a picture; send actions, raw
// updates and undos through real rooms behind a WebSocket server, as a client that
// skipped its own checks would; and ask the HTTP gate about each write route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { Room, checksum } from '../src/features/collaboration/rooms';
import { assertRouteAllowed, connectionRole, requestRole, routeRule, RoleRefusal } from '../src/features/roles/serverAccess';
import { assertDocumentActionAllowed, assertDocumentChangeAllowed, assertEditorContentAllowed } from '../src/features/roles/documentAccess';
import { assertEditorRequest, routeReadsBody } from '../src/features/roles/editorRoutes';
import { safeInlineHTML } from '../src/features/roles/editorRichText';
import { parseProjectRoles, roleViewOf, can, type RoleView } from '../vendor/stacki/shared/properties/projectRoles';
import type { EditorPart } from '../vendor/stacki/shared/properties/projectRoles';
import { record } from '../src/shared/validation';

const PAGE = 'src/pages/index.astro';
const CARD = `---
interface Props { heading?: string; variant?: string; image?: ImageMetadata; imageAlt?: string }
const { heading = "Card", variant = "plain", image, imageAlt = "" } = Astro.props;
---
<article class={variant}><h2>{heading}</h2><img src={image?.src} alt={imageAlt} /></article>
`;
const PAGE_SOURCE = `---
import Layout from '../layouts/Layout.astro';
import Card from '../components/Card.astro';
import boat from '../assets/boat.jpg';
const title = "Welcome";
const mood = "calm";
---
<Layout>
  <h1 class="big">Hello <strong>there</strong></h1>
  <p>{title}</p>
  <div class={mood}><span class="badge">New</span></div>
  <img src={boat.src} alt="A boat" class="photo" />
  <Card heading="First" variant="plain" image={boat} imageAlt="Boat" />
</Layout>
<style>
  .big { color: red; }
</style>
`;

/** A custom role with the client's page access and the given options off. */
function role(off: readonly EditorPart[], access: readonly string[] = DESIGN_ACCESS): RoleView {
  const roles = parseProjectRoles({
    version: 1,
    roles: [
      { id: 'admin', members: ['owner'] },
      { id: 'writer', name: 'Writer', members: ['writer'], access, editorOff: off },
    ],
  });
  return roleViewOf(roles, 'writer');
}
const DESIGN_ACCESS = [
  'panel:pages',
  'panel:navigator',
  'panel:elements',
  'panel:components',
  'panel:assets',
  'panel:cms',
  'panel:style',
  'panel:settings',
  'panel:history',
  'panel:ai',
  'panel:code',
  'panel:variables',
  'panel:selectors',
  'panel:properties',
  'code:edit',
  'component:edit',
  'component:create',
  'page:create',
  'page:delete',
  'page:rename',
  'page:layout',
  'publish',
];
/** The owner's example: no panels, but dragging, text and pictures on the page. */
const CANVAS_ONLY: readonly EditorPart[] = ['sidePanel', 'navigator', 'canvasBar'];
const READ_ONLY: readonly EditorPart[] = ['sidePanel', 'navigator', 'canvasBar', 'drag', 'text', 'images'];

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-editor-options-'));
  for (const folder of ['src/pages', 'src/components', 'src/layouts', 'src/assets', '.stacki']) {
    await mkdir(path.join(root, folder), { recursive: true });
  }
  await writeFile(path.join(root, PAGE), PAGE_SOURCE);
  await writeFile(path.join(root, 'src/components/Card.astro'), CARD);
  await writeFile(path.join(root, 'src/layouts/Layout.astro'), '<main><slot /></main>\n');
  const read = (file: string) => readFile(path.join(root, file), 'utf8').catch(() => undefined);
  return { root, read, remove: () => rm(root, { recursive: true, force: true }) };
}

function edited(find: string, replace: string, source = PAGE_SOURCE): string {
  assert.ok(source.includes(find), `the fixture holds ${find}`);
  return source.replace(find, replace);
}

const TEXT_EDITS: Readonly<Record<string, string>> = {
  'words in a text': edited('Hello <strong>', 'Goodbye <strong>'),
  'bold added to words': edited('Hello <strong>there</strong>', '<em>Hello</em> <strong>there</strong>'),
  'a link added to words': edited('Hello <strong>', '<a href="/about">Hello</a> <strong>'),
  'a frontmatter string the page prints': edited('const title = "Welcome";', 'const title = "Hi there";'),
  'a component prop shown as text': edited('heading="First"', 'heading="Second"'),
  'a badge inside a block': edited('>New</span>', '>Old</span>'),
};

const IMAGE_EDITS: Readonly<Record<string, string>> = {
  'an img source from the public folder': edited('src={boat.src}', 'src="/images/hill.png"'),
  'a newly imported picture': edited('src={boat.src}', 'src={hill.src}', edited("boat.jpg';\n", "boat.jpg';\nimport hill from '../assets/hill.png';\n")),
  'an img alt text': edited('alt="A boat"', 'alt="A hill"'),
  'a component picture prop': edited('image={boat} ', 'image={hill} ', edited("boat.jpg';\n", "boat.jpg';\nimport hill from '../assets/hill.webp';\n")),
  'a component picture alt prop': edited('imageAlt="Boat"', 'imageAlt="A hill"'),
};

const NEVER_WITHOUT_PANEL: Readonly<Record<string, string>> = {
  'a changed class': edited('class="big"', 'class="huge"'),
  'a changed image class': edited('class="photo"', 'class="photo wide"'),
  'an added style attribute': edited('<h1 class="big">', '<h1 class="big" style="color: blue">'),
  'an added attribute': edited('<p>{title}</p>', '<p id="x">{title}</p>'),
  'a removed attribute': edited('<h1 class="big">', '<h1>'),
  'a style block': edited('color: red', 'color: blue'),
  'a new script': edited('<style>', '<script>alert(1)</script>\n<style>'),
  'a component variant prop': edited('variant="plain"', 'variant="loud"'),
  'a prop that is not text': edited('heading="First" variant="plain"', 'heading="First" variant="plain" id="card"'),
  'a styled span in a text': edited('Hello <strong>', '<span class="huge">Hello</span> <strong>'),
  'a styled tag in a text': edited('<strong>there</strong>', '<strong style="color: blue">there</strong>'),
  'a script link in a text': edited('Hello <strong>', '<a href="javascript:alert(1)">Hello</a> <strong>'),
  'a link spelled with an entity': edited('Hello <strong>', '<a href="javascript&colon;alert(1)">Hello</a> <strong>'),
  'a spread on a tag in a text': edited('<strong>there</strong>', '<strong {...Astro.props}>there</strong>'),
  'a link with a handler': edited('Hello <strong>', '<a href="/a" onclick="x()">Hello</a> <strong>'),
  'code in a text': edited('Hello <strong>', 'Hello {Astro.url} <strong>'),
  'a new element': edited('<p>{title}</p>', '<p>{title}</p>\n  <p>More</p>'),
  'a removed element': edited('<p>{title}</p>\n  ', ''),
  'reordered elements in a raw edit': edited(
    '  <p>{title}</p>\n  <div class={mood}><span class="badge">New</span></div>\n',
    '  <div class={mood}><span class="badge">New</span></div>\n  <p>{title}</p>\n',
  ),
  'a renamed tag': edited('<p>{title}</p>', '<h6>{title}</h6>'),
  'a frontmatter string the page uses as a class': edited('const mood = "calm";', 'const mood = "huge";'),
  'new frontmatter code': edited('const mood = "calm";', 'const mood = "calm";\nawait fetch("/x");'),
  'an import that is not a picture': edited("boat.jpg';\n", "boat.jpg';\nimport './x.css';\n"),
  'a picture value in a class': edited('class="photo"', 'class="photo.png"'),
  'a script address as a picture': edited('src={boat.src}', 'src="javascript:alert(1)"'),
};

test('without the panel, only words and pictures may change, each under its own option', async (context) => {
  const site = await project();
  context.after(site.remove);
  const allowed = async (who: RoleView, after: string) => {
    await assertEditorContentAllowed(who, PAGE, { before: PAGE_SOURCE, after }, site.read);
  };
  const refused = async (who: RoleView, after: string, label: string) => {
    await assert.rejects(allowed(who, after), RoleRefusal, label);
  };
  const canvas = role(CANVAS_ONLY);
  for (const [label, after] of Object.entries({ ...TEXT_EDITS, ...IMAGE_EDITS })) {
    await assert.doesNotReject(allowed(canvas, after), label);
  }
  for (const [label, after] of Object.entries(NEVER_WITHOUT_PANEL)) {
    await refused(canvas, after, label);
  }
  const noText = role([...CANVAS_ONLY, 'text']);
  for (const [label, after] of Object.entries(TEXT_EDITS)) {
    await refused(noText, after, `text off refuses ${label}`);
  }
  for (const [label, after] of Object.entries(IMAGE_EDITS)) {
    await assert.doesNotReject(allowed(noText, after), `text off keeps ${label}`);
  }
  const noImages = role([...CANVAS_ONLY, 'images']);
  for (const [label, after] of Object.entries(IMAGE_EDITS)) {
    await refused(noImages, after, `images off refuses ${label}`);
  }
  await assert.doesNotReject(allowed(noImages, TEXT_EDITS['words in a text'] ?? ''));
});

test('HTML a component renders from a prop takes words and formatting only', () => {
  assert.equal(safeInlineHTML('Hi', 'Hi <strong>there</strong>'), true);
  assert.equal(safeInlineHTML('Hi', '<a href=&quot;/about&quot;>Hi</a>'), true);
  assert.equal(safeInlineHTML('Hi', 'a &amp;lt; b'), true, 'a typed angle bracket stays a word');
  for (const html of [
    'Hi <img src=x onerror=alert(1)>',
    '&lt;img src=x onerror=alert(1)&gt;',
    '<span class=&quot;x&quot;>Hi</span>',
    '<a href=&quot;javascript:alert(1)&quot;>Hi</a>',
    'Hi</p><div>more</div><p>',
    '<script>alert(1)</script>',
  ]) {
    assert.equal(safeInlineHTML('Hi', html), false, html);
  }
});

test('with the panel on, settings change but what is switched off does not', async (context) => {
  const site = await project();
  context.after(site.remove);
  const check = (off: readonly EditorPart[], after: string) => assertEditorContentAllowed(role(off), PAGE, { before: PAGE_SOURCE, after }, site.read);
  const setting = NEVER_WITHOUT_PANEL['a changed class'] ?? '';
  for (const off of [['text'], ['images'], ['drag'], ['elements']] as const) {
    await assert.doesNotReject(check(off, setting), `a class change with ${off[0]} off`);
  }
  for (const [label, after] of Object.entries(TEXT_EDITS)) {
    await assert.rejects(check(['text'], after), /cannot change text/, label);
  }
  for (const [label, after] of Object.entries(IMAGE_EDITS)) {
    await assert.rejects(check(['images'], after), /cannot change images/, label);
  }
  for (const off of ['drag', 'elements'] as const) {
    for (const label of ['a new element', 'a removed element', 'reordered elements in a raw edit']) {
      await assert.rejects(check([off], NEVER_WITHOUT_PANEL[label] ?? ''), /reorder/, `${off}: ${label}`);
    }
  }
});

const verbatim = '<p>{title}</p>';
const frontmatter = /^---\n([\s\S]*?)\n---/.exec(PAGE_SOURCE)?.[1] ?? '';
const ACTIONS = {
  move: { kind: 'move', node: 'n0.1', target: 'n0.0', placement: 'before' },
  delete: { kind: 'delete', node: 'n0.1' },
  duplicate: { kind: 'duplicate', node: 'n0.1' },
  insert: { kind: 'insert', target: 'n0.1', placement: 'after', name: 'Card', importPath: '../components/Card.astro', paired: false },
  paste: { kind: 'paste', target: 'n0.1', placement: 'after', clipboard: { file: PAGE, fragment: verbatim, frontmatter } },
  wrap: { kind: 'wrap-text', node: 'n0.0.0', name: 'span' },
} as const;

test('each named action needs its option, and a paste may only copy what the page holds', () => {
  const run = (who: RoleView, action: Parameters<typeof assertDocumentActionAllowed>[3]) => () => assertDocumentActionAllowed(who, PAGE, PAGE_SOURCE, action);
  const canvas = role(CANVAS_ONLY);
  for (const action of [ACTIONS.move, ACTIONS.delete, ACTIONS.duplicate, ACTIONS.insert, ACTIONS.paste]) {
    assert.doesNotThrow(run(canvas, action), action.kind);
  }
  assert.throws(run(canvas, ACTIONS.wrap), /styles or settings/);
  for (const clipboard of [
    { file: PAGE, fragment: '<p style="color: blue">x</p>', frontmatter },
    { file: PAGE, fragment: verbatim, frontmatter: `${frontmatter}\nawait fetch("/x");` },
    { file: 'src/pages/other.astro', fragment: verbatim, frontmatter },
  ]) {
    assert.throws(run(canvas, { ...ACTIONS.paste, clipboard }), /new markup/);
  }
  const content = { kind: 'insert-content', target: 'n0.1', placement: 'after', content: { kind: 'text', text: 'x' } };
  assert.throws(run(canvas, content as unknown as Parameters<typeof run>[1]), /new markup/);
  assert.throws(run(role([...CANVAS_ONLY, 'drag']), ACTIONS.move), /reorder/);
  assert.doesNotThrow(run(role([...CANVAS_ONLY, 'drag']), ACTIONS.delete));
  const fixed = role([...CANVAS_ONLY, 'elements']);
  for (const action of [ACTIONS.delete, ACTIONS.duplicate, ACTIONS.insert, ACTIONS.paste]) {
    assert.throws(run(fixed, action), /add, duplicate or delete/, action.kind);
  }
  assert.doesNotThrow(run(fixed, ACTIONS.move));
  for (const action of Object.values(ACTIONS)) {
    assert.throws(run(role(READ_ONLY), action), RoleRefusal, `read only: ${action.kind}`);
  }
});

test('a read only role changes no document, and a limited one no component, stylesheet or other page file', () => {
  const change = (who: RoleView, file: string) => () => assertDocumentChangeAllowed(who, file, 'a', 'b');
  const reader = role(READ_ONLY);
  for (const file of [PAGE, '.stacki/guide.json', 'src/content/post.md', 'src/styles/a.css', 'src/components/Card.astro']) {
    assert.throws(change(reader, file), RoleRefusal, file);
  }
  const canvas = role(CANVAS_ONLY);
  for (const file of ['src/components/Card.astro', 'src/styles/a.css', 'src/pages/api.ts', 'src/pages/post.md', '.stacki/variables.json']) {
    assert.throws(change(canvas, file), RoleRefusal, file);
  }
  assert.doesNotThrow(change(canvas, 'src/content/post.md'), 'the CMS stays while text and images are on');
  assert.throws(change(role([...CANVAS_ONLY, 'images']), 'src/content/post.md'), RoleRefusal);
});

/** Whether the HTTP gate lets `who` send a write to `pathname`. */
function routeAllowed(who: RoleView, pathname: string, body: Record<string, unknown> = {}): boolean {
  const text = JSON.stringify(body);
  try {
    const rule = routeRule('POST', pathname);
    if (rule !== undefined) {
      assertRouteAllowed(who, rule, text);
    }
    assertEditorRequest(who, pathname, routeReadsBody(who, pathname) ? text : '');
    return true;
  } catch (error: unknown) {
    if (error instanceof RoleRefusal) {
      return false;
    }
    throw error;
  }
}

test('the HTTP routes that reach styles, settings or unchecked files are refused under the options', () => {
  const canvas = role(CANVAS_ONLY);
  const everything = role([]);
  const closed = [
    '/studio/api/variables',
    '/studio/api/component-properties',
    '/studio/api/defaults-canvas',
    '/studio/api/ai/propose',
    '/studio/api/ai/apply',
    '/studio/api/git/checkout',
    '/studio/api/history/restore',
    '/studio/api/apps/files',
  ];
  for (const pathname of closed) {
    assert.equal(routeAllowed(canvas, pathname), false, pathname);
    assert.equal(routeAllowed(everything, pathname), true, `without options ${pathname} is as before`);
  }
  assert.equal(routeAllowed(canvas, '/studio/api/metadata', { kind: 'breakpoints' }), false);
  assert.equal(routeAllowed(canvas, '/studio/api/metadata', { kind: 'styles' }), false);
  assert.equal(routeAllowed(canvas, '/studio/api/metadata', { kind: 'roles' }), false);
  assert.equal(routeAllowed(canvas, '/studio/api/create', { file: 'src/pages/new.astro' }), false);
  assert.equal(routeAllowed(canvas, '/studio/api/create', { file: 'src/content/blog/new.md' }), true, 'a CMS entry');
  assert.equal(routeAllowed(canvas, '/studio/api/source', { file: 'src/styles/a.css', base: 'a', source: 'b' }), false);
  assert.equal(routeAllowed(canvas, '/studio/api/upload'), true, 'pictures may be uploaded while images are on');
  const noImages = role([...CANVAS_ONLY, 'images']);
  for (const pathname of ['/studio/api/upload', '/studio/api/assets', '/studio/api/cms', '/studio/api/media-hosting/upload']) {
    assert.equal(routeAllowed(noImages, pathname), false, pathname);
  }
  // With the panel on, the Style save keeps stylesheets and style blocks, never a page's markup.
  const noText = role(['text']);
  const page = { file: PAGE, base: PAGE_SOURCE };
  assert.equal(routeAllowed(noText, '/studio/api/source', { ...page, source: edited('Hello', 'Bye') }), false);
  assert.equal(routeAllowed(noText, '/studio/api/source', { ...page, source: edited('color: red', 'color: blue') }), true);
  assert.equal(routeAllowed(noText, '/studio/api/source', { file: 'src/styles/a.css', base: 'a', source: 'b' }), true);
});

test('a read only role may send no write at all, publishing and unlisted routes included', () => {
  const reader = role(READ_ONLY);
  for (const pathname of [
    '/studio/api/create',
    '/studio/api/pages/rename',
    '/studio/api/upload',
    '/studio/api/assets',
    '/studio/api/cms',
    '/studio/api/source',
    '/studio/api/publish',
    '/studio/api/sync',
    '/studio/api/metadata',
    '/studio/api/apps/storage/set',
    '/studio/api/storage/cleanup',
    '/studio/api/a-route-nobody-listed',
  ]) {
    assert.equal(routeAllowed(reader, pathname, { kind: 'guide', file: PAGE }), false, pathname);
  }
  assert.equal(routeAllowed(reader, '/studio/api/file-stamps'), true);
  assert.equal(can(reader, 'publish'), false);
  assert.equal(can(reader, 'panel:pages'), true, 'a reader still moves between pages');
});

test('a roles file that cannot be read stays as before, and one using options fails closed to read only', async (context) => {
  const site = await project();
  process.env['STUDIO_CONTAINER_TOKEN'] = 'test-token';
  context.after(async () => {
    delete process.env['STUDIO_CONTAINER_TOKEN'];
    await site.remove();
  });
  const request = { headers: { 'x-studio-user': 'acme' } };
  const roles = path.join(site.root, '.stacki/roles.json');
  await writeFile(roles, '{ "version": 2 }');
  const client = await requestRole(site.root, request);
  assert.equal(client.editorOff.size, 0, 'a broken file without options is the plain client, as before');
  await writeFile(roles, '{ "version": 2, "roles": [{ "id": "client", "editorOff": ["text"] }] }');
  const locked = await requestRole(site.root, request);
  assert.equal(locked.id, 'client');
  assert.deepEqual([...locked.editorOff].sort(), ['canvasBar', 'drag', 'elements', 'images', 'navigator', 'sidePanel', 'text']);
  assert.equal(routeAllowed(locked, '/studio/api/publish'), false);
});

async function studio(off: readonly EditorPart[]) {
  const site = await project();
  await writeFile(
    path.join(site.root, '.stacki/roles.json'),
    JSON.stringify({
      version: 1,
      defaultRole: 'writer',
      roles: [
        { id: 'admin', members: ['owner'] },
        { id: 'writer', name: 'Writer', members: ['writer'], access: DESIGN_ACCESS, editorOff: off },
      ],
    }),
  );
  const room = new Room(site.root, PAGE);
  await room.initialize();
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', (socket, request: IncomingMessage) => {
    const login = String(request.headers['x-studio-user']);
    room.attach(socket, { key: `github:${login}`, login }, async () => true, undefined, connectionRole(site.root, request));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const sockets: WebSocket[] = [];
  const connect = async (login: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/`, { headers: { 'x-studio-user': login } });
    sockets.push(socket);
    const synced = response(socket, ['sync']);
    await once(socket, 'open');
    await synced;
    return socket;
  };
  const close = async () => {
    for (const socket of sockets) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await room.durable.flush();
    room.document.destroy();
    await site.remove();
  };
  return { room, connect, close };
}

function response(socket: WebSocket, types: readonly string[]) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', receive);
      reject(new Error(`Missing ${types.join(' or ')} response`));
    }, 10_000);
    function receive(bytes: Buffer) {
      const message = record(JSON.parse(bytes.toString()));
      if (types.includes(String(message['type']))) {
        clearTimeout(timer);
        socket.off('message', receive);
        resolve(message);
      }
    }
    socket.on('message', receive);
  });
}

/** Sends the raw update that turns the room's text into `next`, and returns the room's answer. */
async function send(socket: WebSocket, room: Room, next: string) {
  const local = new Y.Doc();
  Y.applyUpdate(local, Y.encodeStateAsUpdate(room.document));
  const text = local.getText('source');
  const before = text.toString();
  let start = 0;
  while (before[start] === next[start] && start < before.length) {
    start += 1;
  }
  let end = 0;
  while (end < before.length - start && end < next.length - start && before[before.length - 1 - end] === next[next.length - 1 - end]) {
    end += 1;
  }
  local.transact(() => {
    text.delete(start, before.length - start - end);
    text.insert(start, next.slice(start, next.length - end));
  });
  const answer = response(socket, ['saved', 'error']);
  const epoch = room.document.getMap('metadata').get('epoch');
  socket.send(JSON.stringify({ type: 'update', epoch, update: Buffer.from(Y.encodeStateAsUpdate(local)).toString('base64') }));
  local.destroy();
  return answer;
}

async function act(socket: WebSocket, room: Room, action: unknown) {
  const answer = response(socket, ['saved', 'error']);
  const epoch = room.document.getMap('metadata').get('epoch');
  socket.send(JSON.stringify({ type: 'action', epoch, checksum: checksum(room.text.toString()), action }));
  return answer;
}

test('over the socket a limited role is held to its options, and may undo only its own changes', async (context) => {
  process.env['STUDIO_CONTAINER_TOKEN'] = 'test-token';
  const state = await studio(CANVAS_ONLY);
  context.after(async () => {
    delete process.env['STUDIO_CONTAINER_TOKEN'];
    await state.close();
  });
  const writer = await state.connect('writer');
  const styled = await send(writer, state.room, edited('class="big"', 'class="huge"'));
  assert.match(String(styled['message']), /cannot change styles or settings/);
  assert.equal(state.room.text.toString(), PAGE_SOURCE, 'the refused edit never reached the room');

  assert.equal((await send(writer, state.room, TEXT_EDITS['words in a text'] ?? ''))['type'], 'saved');
  const typed = state.room.text.toString();
  assert.equal((await act(writer, state.room, ACTIONS.delete))['type'], 'saved');
  const deleted = state.room.text.toString();
  assert.doesNotMatch(deleted, /<p>\{title\}<\/p>/);
  // Undo brings the element back, which no new edit of this role could add.
  assert.equal((await send(writer, state.room, typed))['type'], 'saved', 'undo of its own delete');
  assert.equal((await send(writer, state.room, deleted))['type'], 'saved', 'redo');
  assert.equal((await send(writer, state.room, typed))['type'], 'saved');

  // Once someone else has changed the page, the role cannot step over their change.
  const owner = await state.connect('owner');
  const restyled = edited('class="big"', 'class="admin"', state.room.text.toString());
  assert.equal((await send(owner, state.room, restyled))['type'], 'saved');
  const reverted = await send(writer, state.room, typed);
  assert.match(String(reverted['message']), /cannot change styles or settings/, 'an admin’s restyle cannot be undone by the writer');
  assert.equal(state.room.text.toString(), restyled);
});

test('over the socket a read only role changes nothing', async (context) => {
  process.env['STUDIO_CONTAINER_TOKEN'] = 'test-token';
  const state = await studio(READ_ONLY);
  context.after(async () => {
    delete process.env['STUDIO_CONTAINER_TOKEN'];
    await state.close();
  });
  const reader = await state.connect('writer');
  for (const [label, after] of Object.entries({ ...TEXT_EDITS, ...IMAGE_EDITS })) {
    assert.equal((await send(reader, state.room, after))['type'], 'error', label);
  }
  for (const action of Object.values(ACTIONS)) {
    assert.equal((await act(reader, state.room, action))['type'], 'error', action.kind);
  }
  assert.equal(state.room.text.toString(), PAGE_SOURCE);
});
