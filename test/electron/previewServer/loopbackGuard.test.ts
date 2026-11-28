// Goal: with the preview open on the local network, a device on the Wi-Fi gets the site and nothing of
// Stacki's: every /__avb route, the local /studio and Vite's /__open-in-editor answer 403 unless the
// connection comes from this computer, with a loopback Host and (when sent) a loopback Origin.
// Method: the pure verdict (judgeRequest) is driven through a table of remote addresses (IPv4 and IPv6
// loopback, IPv4-mapped IPv6, LAN, missing), Host headers (spoofed, bracketed IPv6, DNS-rebinding names)
// and Origins, and of paths (encoded, doubled slashes, near-misses that are the site). The middleware runs
// on fake sockets for the 403 itself. Last, a real HTTP server on 0.0.0.0 with the guard in front is asked
// from 127.0.0.1 and, when this machine has a network address, from that address: a request to one's own
// LAN address arrives from that address, which is a real non-loopback source without a second device.
// With a preview key (only the devices that scanned the code), the same table and the same real server hold
// that this computer always passes, the code's address (a GET carrying the key) is answered with the cookie
// and a redirect to the page without the key, the cookie lets a device in, and anything else from the network
// is refused, the live-reload WebSocket upgrade included; a wrong key, a key of the wrong length, the key in
// a POST and a Cookie header past its bound never pass.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import {
  cookieKeys,
  isLoopbackAddress,
  isLoopbackHost,
  isLoopbackOnlyRoute,
  isLoopbackOrigin,
  judgeRequest,
  loopbackGuard,
  loopbackGuardMiddleware,
} from '#dist/electron/previewServer/loopbackGuard.js';
import { selectLanAddresses } from '#dist/electron/preview/lanAddresses.js';
import { PREVIEW_KEY_COOKIE, PREVIEW_KEY_PARAM, toPreviewKey } from '#dist/shared/ipc/devNetwork.js';

const local = { remoteAddress: '127.0.0.1', host: '127.0.0.1:4321', origin: undefined, method: 'GET', cookie: undefined, key: undefined };
const KEY = toPreviewKey('aZ09_-aZ09_-aZ09_-aZ09_-aZ09_-aZ09_-aZ09_-a');
const OTHER_KEY = toPreviewKey('bZ09_-aZ09_-aZ09_-aZ09_-aZ09_-aZ09_-aZ09_-a');
// A device on the Wi-Fi asking the site, with the server's key.
const phone = { remoteAddress: '192.168.1.40', host: '192.168.1.23:4321', origin: undefined, method: 'GET', cookie: undefined, key: KEY };

test('loopback remote addresses, in every spelling a socket reports', () => {
  for (const address of ['127.0.0.1', '127.1.2.3', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1']) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of ['192.168.1.20', '10.0.0.5', '::ffff:192.168.1.20', 'fe80::1', '2001:db8::1', '128.0.0.1', '', undefined, '::ffff:127.0.0.1.evil']) {
    assert.equal(isLoopbackAddress(address), false, String(address));
  }
});

test('loopback Host headers, and the names a rebinding attack or a LAN client sends', () => {
  for (const host of ['127.0.0.1:4321', '127.0.0.1', 'localhost:4321', 'LOCALHOST', 'app.localhost:1', '[::1]:4321', '[::1]']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['192.168.1.23:4321', 'evil.example:4321', 'localhost.evil.example', '127.0.0.1.nip.io', '[::2]:1', '', undefined, 'x'.repeat(600)]) {
    assert.equal(isLoopbackHost(host), false, String(host));
  }
});

test('an Origin is absent or loopback; null and other sites are not', () => {
  assert.equal(isLoopbackOrigin(undefined), true);
  assert.equal(isLoopbackOrigin('http://127.0.0.1:5173'), true, 'the Studio origin beside the site');
  assert.equal(isLoopbackOrigin('http://localhost:4321'), true);
  assert.equal(isLoopbackOrigin('null'), false);
  assert.equal(isLoopbackOrigin('http://192.168.1.23:4321'), false);
  assert.equal(isLoopbackOrigin('https://evil.example'), false);
  assert.equal(isLoopbackOrigin('file://'), false);
});

test('the guarded routes, however the path is spelled; the site is not guarded', () => {
  for (const url of [
    '/__avb/touch?f=x',
    '/__avb',
    '/__AVB/reload',
    '//__avb//refresh',
    '/%5F%5Favb/value?m=x',
    '/studio',
    '/studio/',
    '/__open-in-editor?file=x',
    '/%E0%A4%A',
  ]) {
    assert.equal(isLoopbackOnlyRoute(url), true, url);
  }
  for (const url of ['/', '/about', '/blog/__avb-notes', '/studios', '/_astro/page.js', '/@vite/client', undefined]) {
    assert.equal(isLoopbackOnlyRoute(url), false, String(url));
  }
});

test('the verdict: the site passes from anywhere, Stacki routes only from this computer', () => {
  assert.deepEqual(judgeRequest({ ...local, url: '/__avb/touch' }), { kind: 'pass' });
  assert.deepEqual(judgeRequest({ ...local, url: '/__avb/touch', remoteAddress: '::ffff:127.0.0.1' }), { kind: 'pass' });
  assert.deepEqual(judgeRequest({ ...local, url: '/__avb/touch', remoteAddress: '192.168.1.40' }), { kind: 'refuse', reason: 'remote' });
  assert.deepEqual(judgeRequest({ ...local, url: '/__avb/touch', remoteAddress: '::ffff:192.168.1.40' }), { kind: 'refuse', reason: 'remote' });
  assert.deepEqual(judgeRequest({ ...local, url: '/__avb/touch', remoteAddress: undefined }), { kind: 'refuse', reason: 'remote' });
  // A LAN device that spoofs a loopback Host is still refused by its socket.
  assert.deepEqual(judgeRequest({ ...local, url: '/__avb/reload', remoteAddress: '192.168.1.40', host: '127.0.0.1:4321' }), {
    kind: 'refuse',
    reason: 'remote',
  });
  // A page in this computer's browser reaching the server through a rebinding name.
  assert.deepEqual(judgeRequest({ ...local, url: '/__avb/value', host: 'rebind.example:4321' }), { kind: 'refuse', reason: 'host' });
  assert.deepEqual(judgeRequest({ ...local, url: '/__avb/refresh', origin: 'https://evil.example' }), { kind: 'refuse', reason: 'origin' });
  assert.deepEqual(judgeRequest({ ...phone, key: undefined, url: '/', origin: 'http://192.168.1.23:4321' }), { kind: 'pass' });
});

test('with a key, the network reaches the site only through the code or its cookie; this computer always passes', () => {
  // This computer: the canvas never carries the key.
  assert.deepEqual(judgeRequest({ ...local, key: KEY, url: '/' }), { kind: 'pass' });
  assert.deepEqual(judgeRequest({ ...local, key: KEY, url: '/@vite/client', remoteAddress: '::1' }), { kind: 'pass' });
  // The code's address: let in with the cookie and sent to the same page, its own query kept, the key dropped.
  assert.deepEqual(judgeRequest({ ...phone, url: `/?${PREVIEW_KEY_PARAM}=${KEY}` }), { kind: 'admit', location: '/' });
  assert.deepEqual(judgeRequest({ ...phone, url: `/blog/post?draft=1&${PREVIEW_KEY_PARAM}=${KEY}` }), { kind: 'admit', location: '/blog/post?draft=1' });
  assert.deepEqual(judgeRequest({ ...phone, method: 'HEAD', url: `/?${PREVIEW_KEY_PARAM}=${KEY}` }), { kind: 'admit', location: '/' });
  // The cookie, alone or among the page's own cookies.
  assert.deepEqual(judgeRequest({ ...phone, url: '/blog', cookie: `${PREVIEW_KEY_COOKIE}=${KEY}` }), { kind: 'pass' });
  assert.deepEqual(judgeRequest({ ...phone, url: '/_astro/page.js', cookie: `theme=dark; ${PREVIEW_KEY_COOKIE}=${KEY}; lang=fr` }), { kind: 'pass' });
  // Everything else from the network.
  assert.deepEqual(judgeRequest({ ...phone, url: '/' }), { kind: 'refuse', reason: 'key' });
  assert.deepEqual(judgeRequest({ ...phone, url: `/?${PREVIEW_KEY_PARAM}=${OTHER_KEY}` }), { kind: 'refuse', reason: 'key' }, 'another key');
  assert.deepEqual(judgeRequest({ ...phone, url: `/?${PREVIEW_KEY_PARAM}=${KEY.slice(1)}` }), { kind: 'refuse', reason: 'key' }, 'a shorter guess');
  assert.deepEqual(judgeRequest({ ...phone, url: `/?${PREVIEW_KEY_PARAM}=` }), { kind: 'refuse', reason: 'key' });
  assert.deepEqual(
    judgeRequest({ ...phone, method: 'POST', url: `/?${PREVIEW_KEY_PARAM}=${KEY}` }),
    { kind: 'refuse', reason: 'key' },
    'only a page is let in',
  );
  assert.deepEqual(judgeRequest({ ...phone, url: '/', cookie: `${PREVIEW_KEY_COOKIE}=${OTHER_KEY}` }), { kind: 'refuse', reason: 'key' });
  assert.deepEqual(judgeRequest({ ...phone, url: '/', cookie: `other-${PREVIEW_KEY_COOKIE}=${KEY}` }), { kind: 'refuse', reason: 'key' });
  assert.deepEqual(judgeRequest({ ...phone, url: '/', remoteAddress: undefined }), { kind: 'refuse', reason: 'key' });
  // Stacki's routes stay this computer's only: the key never opens them.
  assert.deepEqual(judgeRequest({ ...phone, url: `/__avb/touch?${PREVIEW_KEY_PARAM}=${KEY}`, cookie: `${PREVIEW_KEY_COOKIE}=${KEY}` }), {
    kind: 'refuse',
    reason: 'remote',
  });
});

test('with a key, text that is no address is refused, and the redirect never names another host', () => {
  for (const url of ['//[', 'http://[']) {
    assert.deepEqual(judgeRequest({ ...phone, url }), { kind: 'refuse', reason: 'key' }, url);
    assert.deepEqual(judgeRequest({ ...phone, url, cookie: `${PREVIEW_KEY_COOKIE}=${KEY}` }), { kind: 'refuse', reason: 'key' }, url);
  }
  for (const path of ['/.//example.org/x', '/..//example.org/x', '/.///example.org/x', '/.\\\\example.org/x']) {
    assert.deepEqual(judgeRequest({ ...phone, url: `${path}?${PREVIEW_KEY_PARAM}=${KEY}` }), { kind: 'admit', location: '/example.org/x' }, path);
  }
});

test('the cookie header is read within its bounds', () => {
  assert.deepEqual(cookieKeys(undefined), []);
  assert.deepEqual(cookieKeys(`${PREVIEW_KEY_COOKIE}=a; ${PREVIEW_KEY_COOKIE}=b`), ['a', 'b']);
  assert.deepEqual(cookieKeys(` ${PREVIEW_KEY_COOKIE} = ${KEY} `), [KEY]);
  assert.deepEqual(cookieKeys(`${PREVIEW_KEY_COOKIE}=${KEY}${'x'.repeat(9000)}`), [], 'a header past its bound holds no key');
  const late = `${Array.from({ length: 70 }, (_, index) => `c${index}=1`).join('; ')}; ${PREVIEW_KEY_COOKIE}=${KEY}`;
  assert.deepEqual(cookieKeys(late), [], 'nor does a cookie past the 64th');
});

// A fake request and response, as the dev server hands them to a middleware.
function run(request: { readonly url: string; readonly remoteAddress: string | undefined; readonly headers: Readonly<Record<string, string>> }) {
  const outcome = { next: false, status: 0, body: '' };
  const fakeRequest = { url: request.url, socket: { remoteAddress: request.remoteAddress }, headers: request.headers };
  const fakeResponse = {
    writeHead(status: number) {
      outcome.status = status;
    },
    end(body: string) {
      outcome.body = body;
    },
  };
  // @ts-expect-error The middleware reads only url, socket.remoteAddress and headers, and calls only writeHead and end.
  loopbackGuardMiddleware(fakeRequest, fakeResponse, () => {
    outcome.next = true;
  });
  return outcome;
}

test('the middleware answers 403 and never calls the next handler for a refused request', () => {
  assert.deepEqual(run({ url: '/__avb/touch?f=a', remoteAddress: '192.168.1.40', headers: { host: '192.168.1.23:4321' } }), {
    next: false,
    status: 403,
    body: 'Forbidden',
  });
  assert.deepEqual(run({ url: '/__avb/touch?f=a', remoteAddress: '::ffff:10.0.0.9', headers: { host: '127.0.0.1:4321' } }), {
    next: false,
    status: 403,
    body: 'Forbidden',
  });
  assert.deepEqual(run({ url: '/__avb/touch?f=a', remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:4321' } }), { next: true, status: 0, body: '' });
  assert.deepEqual(run({ url: '/blog', remoteAddress: '192.168.1.40', headers: { host: '192.168.1.23:4321' } }), { next: true, status: 0, body: '' });
});

test('a real server on every interface: loopback reaches Stacki routes, the network reaches only the site', async (context) => {
  const server = http.createServer((request, response) => {
    loopbackGuardMiddleware(request, response, () => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`site ${request.url ?? ''}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  context.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP server');
  }
  const { port } = address;
  const ask = (host: string, path: string, headers: Readonly<Record<string, string>> = {}) =>
    new Promise<number>((resolve, reject) => {
      const request = http.request({ host, port, path, headers, agent: false }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on('error', reject);
      request.end();
    });
  assert.equal(await ask('127.0.0.1', '/__avb/paths?p=x'), 200);
  assert.equal(await ask('127.0.0.1', '/'), 200);
  assert.equal(await ask('127.0.0.1', '/__avb/paths', { host: 'rebind.example' }), 403, 'a rebinding Host from loopback');
  const lan = selectLanAddresses(os.networkInterfaces())[0];
  if (lan === undefined) {
    context.diagnostic('This machine has no network address: the non-loopback half ran on fake sockets only.');
    return;
  }
  assert.equal(await ask(lan.address, '/'), 200, 'the site, from the network');
  assert.equal(await ask(lan.address, '/__avb/paths?p=x'), 403, 'a Stacki route, from the network');
  assert.equal(await ask(lan.address, '/__avb/touch', { host: `127.0.0.1:${port}` }), 403, 'a spoofed loopback Host, from the network');
  assert.equal(await ask(lan.address, '/studio'), 403);
  assert.equal(await ask(lan.address, '/__open-in-editor?file=/etc/hosts'), 403);
});

test('a real server with a key: the code lets a device in with a cookie, every other device gets 403, the socket included', async (context) => {
  const guard = loopbackGuard(KEY);
  const server = http.createServer((request, response) => {
    guard.middleware(request, response, () => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`site ${request.url ?? ''}`);
    });
  });
  // What Vite's live-reload socket would answer, once the guard's listener before it lets the upgrade through.
  server.prependListener('upgrade', guard.upgrade);
  server.on('upgrade', (_request, socket) => {
    if (!socket.destroyed) {
      socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  context.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP server');
  }
  const { port } = address;
  const ask = (host: string, path: string, headers: Readonly<Record<string, string>> = {}) =>
    new Promise<{ readonly status: number; readonly location: string | undefined; readonly cookie: string | undefined }>((resolve, reject) => {
      const request = http.request({ host, port, path, headers, agent: false }, (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0, location: response.headers.location, cookie: response.headers['set-cookie']?.[0] });
      });
      request.on('error', reject);
      request.end();
    });
  // The first line of the answer to an upgrade request, as a WebSocket client sends it.
  const upgrade = (host: string, cookie: string | undefined) =>
    new Promise<string>((resolve, reject) => {
      const socket = net.connect({ host, port }, () => {
        socket.write(
          `GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${cookie === undefined ? '' : `Cookie: ${cookie}\r\n`}\r\n`,
        );
      });
      let answer = '';
      socket.on('data', (chunk: Buffer) => {
        answer += chunk.toString();
      });
      socket.on('close', () => resolve(answer.split('\r\n')[0] ?? ''));
      socket.on('error', reject);
    });
  assert.equal((await ask('127.0.0.1', '/')).status, 200, 'this computer needs no key');
  assert.match(await upgrade('127.0.0.1', undefined), /101/, 'nor does the canvas’s live reload');
  const lan = selectLanAddresses(os.networkInterfaces())[0];
  if (lan === undefined) {
    context.diagnostic('This machine has no network address: the key was checked on the pure verdict only.');
    return;
  }
  const typed = await ask(lan.address, '/blog');
  assert.equal(typed.status, 403, 'a device that did not scan the code');
  assert.equal(typed.cookie, undefined, 'and is given nothing');
  assert.match(await upgrade(lan.address, undefined), /403/, 'nor its live-reload socket');
  const admitted = await ask(lan.address, `/blog?${PREVIEW_KEY_PARAM}=${KEY}`);
  assert.equal(admitted.status, 303);
  assert.equal(admitted.location, '/blog', 'the key leaves the address');
  assert.equal(admitted.cookie, `${PREVIEW_KEY_COOKIE}=${KEY}; Path=/; HttpOnly; SameSite=Lax`);
  const cookie = `${PREVIEW_KEY_COOKIE}=${KEY}`;
  assert.equal((await ask(lan.address, '/blog', { cookie })).status, 200, 'the scanned device, with its cookie');
  assert.match(await upgrade(lan.address, cookie), /101/, 'and its live reload');
  assert.equal((await ask(lan.address, '/blog', { cookie: `${PREVIEW_KEY_COOKIE}=${OTHER_KEY}` })).status, 403, 'an older code’s cookie');
  assert.equal((await ask(lan.address, '/__avb/paths', { cookie })).status, 403, 'Stacki’s routes stay closed to it');
});

test('a device without the key reads how to get in, on a page sized for a phone, with nothing of its request in it', () => {
  let status = 0;
  let type = '';
  let body = '';
  const request = { url: '/<script>', method: 'GET', socket: { remoteAddress: '192.168.1.40' }, headers: { host: '192.168.1.23:4321' } };
  const response = {
    writeHead(code: number, headers: Readonly<Record<string, string>>) {
      status = code;
      type = headers['content-type'] ?? '';
    },
    end(text: string) {
      body = text;
    },
  };
  // @ts-expect-error The middleware reads only url, method, socket.remoteAddress and headers, and calls only writeHead and end.
  loopbackGuard(KEY).middleware(request, response, () => assert.fail('refused'));
  assert.equal(status, 403);
  assert.match(type, /^text\/html/);
  assert.match(body, /name="viewport"/);
  assert.match(body, /scan its QR code/);
  assert.doesNotMatch(body, /<script|192\.168/);
});
