// Goal: with the preview open on the local network, a device on the Wi-Fi gets the site and nothing of
// Stacki's: every /__avb route, the local /studio and Vite's /__open-in-editor answer 403 unless the
// connection comes from this computer, with a loopback Host and (when sent) a loopback Origin.
// Method: the pure verdict (judgeRequest) is driven through a table of remote addresses (IPv4 and IPv6
// loopback, IPv4-mapped IPv6, LAN, missing), Host headers (spoofed, bracketed IPv6, DNS-rebinding names)
// and Origins, and of paths (encoded, doubled slashes, near-misses that are the site). The middleware runs
// on fake sockets for the 403 itself. Last, a real HTTP server on 0.0.0.0 with the guard in front is asked
// from 127.0.0.1 and, when this machine has a network address, from that address: a request to one's own
// LAN address arrives from that address, which is a real non-loopback source without a second device.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import os from 'node:os';
import {
  isLoopbackAddress,
  isLoopbackHost,
  isLoopbackOnlyRoute,
  isLoopbackOrigin,
  judgeRequest,
  loopbackGuardMiddleware,
} from '#dist/electron/previewServer/loopbackGuard.js';
import { selectLanAddresses } from '#dist/electron/preview/lanAddresses.js';

const local = { remoteAddress: '127.0.0.1', host: '127.0.0.1:4321', origin: undefined };

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
  assert.deepEqual(judgeRequest({ url: '/__avb/reload', remoteAddress: '192.168.1.40', host: '127.0.0.1:4321', origin: undefined }), {
    kind: 'refuse',
    reason: 'remote',
  });
  // A page in this computer's browser reaching the server through a rebinding name.
  assert.deepEqual(judgeRequest({ ...local, url: '/__avb/value', host: 'rebind.example:4321' }), { kind: 'refuse', reason: 'host' });
  assert.deepEqual(judgeRequest({ ...local, url: '/__avb/refresh', origin: 'https://evil.example' }), { kind: 'refuse', reason: 'origin' });
  assert.deepEqual(judgeRequest({ url: '/', remoteAddress: '192.168.1.40', host: '192.168.1.23:4321', origin: 'http://192.168.1.23:4321' }), { kind: 'pass' });
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
