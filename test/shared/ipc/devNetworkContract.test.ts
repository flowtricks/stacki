// Goal: the phone preview's contract (shared/ipc/devNetwork.ts) lets through only what main means to say:
// a mode of two words, on the network an access of two words (open, or only scanned devices with a key of
// 43 base64url characters), IPv4 addresses with named interfaces, a real TCP port, a bounded list, and one
// of the known failures. Absence is `undefined`, never `null`.
// Method: one known-good value per parser, then each known-bad shape (a third mode or access, a network
// request with no access, a key of the wrong length or alphabet, an IPv6 or padded address, a port out of
// range, a list past its bound, an unknown failure code, null where a value belongs), and the phone URL
// builder with its routes and the key, including the routes that must not move the host.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEV_NETWORK_LIMITS,
  isIPv4Address,
  NETWORK_ACCESS_OPEN,
  networkPageURL,
  parseDevNetworkReply,
  parseDevNetworkRequest,
  parseDevNetworkState,
  PREVIEW_KEY_PARAM,
  toPreviewKey,
} from '#dist/shared/ipc/devNetwork.js';

const wifi = { address: '192.168.1.23', interfaceName: 'en0' };
const KEY = 'aZ09_-aZ09_-aZ09_-aZ09_-aZ09_-aZ09_-aZ09_-a';
const open = { kind: 'open' } as const;
// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull: unknown = JSON.parse('null');

test('a request names the project and one of two modes, and on the network one of two accesses', () => {
  assert.deepEqual(parseDevNetworkRequest({ projectPath: '/site', mode: 'network', access: 'open' }), {
    projectPath: '/site',
    mode: 'network',
    access: 'open',
  });
  assert.deepEqual(parseDevNetworkRequest({ projectPath: '/site', mode: 'network', access: 'key' }), { projectPath: '/site', mode: 'network', access: 'key' });
  assert.deepEqual(parseDevNetworkRequest({ projectPath: '/site', mode: 'local' }), { projectPath: '/site', mode: 'local' });
  // Back to this computer carries no access: one given anyway is not part of the answer.
  assert.deepEqual(parseDevNetworkRequest({ projectPath: '/site', mode: 'local', access: 'key' }), { projectPath: '/site', mode: 'local' });
  assert.throws(() => parseDevNetworkRequest({ projectPath: '/site', mode: 'network' }), /expected open or key/);
  assert.throws(() => parseDevNetworkRequest({ projectPath: '/site', mode: 'network', access: 'cookie' }), /expected open or key/);
  assert.throws(() => parseDevNetworkRequest({ projectPath: '/site', mode: 'network', access: jsonNull }), /expected open or key/);
  assert.throws(() => parseDevNetworkRequest({ projectPath: '/site', mode: 'public' }), /expected local or network/);
  assert.throws(() => parseDevNetworkRequest({ projectPath: '/site', mode: true }), /expected local or network/);
  assert.throws(() => parseDevNetworkRequest({ mode: 'network', access: 'open' }));
  assert.throws(() => parseDevNetworkRequest(jsonNull));
});

test('a preview key is 43 base64url characters, nothing else', () => {
  assert.equal(toPreviewKey(KEY), KEY);
  for (const bad of ['', KEY.slice(1), `${KEY}a`, `${KEY.slice(1)}+`, `${KEY.slice(1)}/`, `${KEY.slice(1)}=`, ` ${KEY.slice(1)}`, `${KEY.slice(1)}é`]) {
    assert.throws(() => toPreviewKey(bad), /expected 43 base64url characters/, JSON.stringify(bad));
  }
});

test('IPv4 addresses only, written the way the system reports them', () => {
  for (const good of ['192.168.1.23', '10.0.0.1', '0.0.0.0', '255.255.255.255']) {
    assert.equal(isIPv4Address(good), true, good);
  }
  for (const bad of ['192.168.1.256', '192.168.01.2', '192.168.1', '::1', 'fe80::1', ' 10.0.0.1', '10.0.0.1 ', 'localhost', '']) {
    assert.equal(isIPv4Address(bad), false, bad);
  }
});

test('the state: off, or on with a port, bounded addresses and who may open it', () => {
  assert.deepEqual(parseDevNetworkState({ kind: 'off' }), { kind: 'off' });
  assert.deepEqual(parseDevNetworkState({ kind: 'on', port: 4321, addresses: [wifi], access: open }), {
    kind: 'on',
    port: 4321,
    addresses: [wifi],
    access: open,
  });
  assert.deepEqual(parseDevNetworkState({ kind: 'on', port: 4321, addresses: [], access: open }), { kind: 'on', port: 4321, addresses: [], access: open });
  assert.deepEqual(parseDevNetworkState({ kind: 'on', port: 4321, addresses: [wifi], access: { kind: 'key', key: KEY } }), {
    kind: 'on',
    port: 4321,
    addresses: [wifi],
    access: { kind: 'key', key: KEY },
  });
  assert.throws(() => parseDevNetworkState({ kind: 'on', port: 4321, addresses: [wifi] }));
  assert.throws(() => parseDevNetworkState({ kind: 'on', port: 4321, addresses: [wifi], access: { kind: 'key' } }));
  assert.throws(() => parseDevNetworkState({ kind: 'on', port: 4321, addresses: [wifi], access: { kind: 'key', key: 'short' } }), /expected 43 base64url/);
  assert.throws(() => parseDevNetworkState({ kind: 'on', port: 4321, addresses: [wifi], access: { kind: 'anyone' } }), /expected open or key/);
  assert.throws(() => parseDevNetworkState({ kind: 'maybe' }), /expected off or on/);
  for (const port of [0, -1, 65_536, 4321.5, '4321', undefined]) {
    assert.throws(() => parseDevNetworkState({ kind: 'on', port, addresses: [wifi], access: open }), /expected a TCP port/, String(port));
  }
  assert.throws(() => parseDevNetworkState({ kind: 'on', port: 4321, addresses: jsonNull, access: open }), /expected a list/);
  const many = Array.from({ length: DEV_NETWORK_LIMITS.addressesMax + 1 }, (_, index) => ({ address: `10.0.0.${index + 1}`, interfaceName: 'en0' }));
  assert.throws(() => parseDevNetworkState({ kind: 'on', port: 4321, addresses: many, access: open }), /exceeds limit/);
  assert.throws(
    () => parseDevNetworkState({ kind: 'on', port: 4321, addresses: [{ address: '::1', interfaceName: 'lo0' }], access: open }),
    /expected an IPv4 address/,
  );
  assert.throws(
    () => parseDevNetworkState({ kind: 'on', port: 4321, addresses: [{ address: '10.0.0.1', interfaceName: '' }], access: open }),
    /expected a name/,
  );
  assert.throws(
    () =>
      parseDevNetworkState({
        kind: 'on',
        port: 4321,
        addresses: [{ address: '10.0.0.1', interfaceName: 'x'.repeat(DEV_NETWORK_LIMITS.interfaceNameCharsMax + 1) }],
        access: open,
      }),
    /exceeds limit/,
  );
});

test('a reply is the new state or one known failure', () => {
  assert.deepEqual(parseDevNetworkReply({ ok: true, value: { kind: 'off' } }), { ok: true, value: { kind: 'off' } });
  for (const code of ['no-address', 'no-server', 'external', 'busy', 'restart-failed']) {
    assert.deepEqual(parseDevNetworkReply({ ok: false, error: code }), { ok: false, error: code });
  }
  assert.throws(() => parseDevNetworkReply({ ok: false, error: 'firewall' }), /unknown failure/);
  assert.throws(() => parseDevNetworkReply({ ok: 'yes', value: { kind: 'off' } }), /expected a boolean/);
  assert.throws(() => parseDevNetworkReply({ ok: true, value: jsonNull }));
});

test('the phone URL is the network address, the port and the canvas page, and the route never moves the host', () => {
  assert.equal(networkPageURL(wifi, 4321, '/', NETWORK_ACCESS_OPEN), 'http://192.168.1.23:4321/');
  assert.equal(networkPageURL(wifi, 4321, '/blog/post?draft=1', NETWORK_ACCESS_OPEN), 'http://192.168.1.23:4321/blog/post?draft=1');
  assert.equal(networkPageURL(wifi, 4321, '/ünï', NETWORK_ACCESS_OPEN), 'http://192.168.1.23:4321/%C3%BCn%C3%AF');
  assert.throws(() => networkPageURL(wifi, 4321, 'blog', NETWORK_ACCESS_OPEN), /the route is a path/);
  assert.throws(() => networkPageURL(wifi, 4321, '//evil.example/x', NETWORK_ACCESS_OPEN), /the route keeps the host/);
  assert.throws(() => networkPageURL({ address: 'evil.example', interfaceName: 'en0' }, 4321, '/', NETWORK_ACCESS_OPEN), /the address is IPv4/);
});

test('with only scanned devices let in, the phone URL carries the key beside the page’s own query', () => {
  const access = { kind: 'key', key: toPreviewKey(KEY) } as const;
  assert.equal(networkPageURL(wifi, 4321, '/', access), `http://192.168.1.23:4321/?${PREVIEW_KEY_PARAM}=${KEY}`);
  const withQuery = new URL(networkPageURL(wifi, 4321, '/blog/post?draft=1', access));
  assert.equal(withQuery.pathname, '/blog/post');
  assert.equal(withQuery.searchParams.get('draft'), '1');
  assert.equal(withQuery.searchParams.get(PREVIEW_KEY_PARAM), KEY);
  assert.equal(withQuery.host, '192.168.1.23:4321');
});
