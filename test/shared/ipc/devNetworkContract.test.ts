// Goal: the phone preview's contract (shared/ipc/devNetwork.ts) lets through only what main means to say:
// a mode of two words, IPv4 addresses with named interfaces, a real TCP port, a bounded list, and one of
// the known failures. Absence is `undefined`, never `null`.
// Method: one known-good value per parser, then each known-bad shape (a third mode, an IPv6 or padded
// address, a port out of range, a list past its bound, an unknown failure code, null where a value
// belongs), and the phone URL builder with its routes, including the ones that must not move the host.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEV_NETWORK_LIMITS,
  isIPv4Address,
  networkPageURL,
  parseDevNetworkReply,
  parseDevNetworkRequest,
  parseDevNetworkState,
} from '#dist/shared/ipc/devNetwork.js';

const wifi = { address: '192.168.1.23', interfaceName: 'en0' };
// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull: unknown = JSON.parse('null');

test('a request names the project and one of two modes', () => {
  assert.deepEqual(parseDevNetworkRequest({ projectPath: '/site', mode: 'network' }), { projectPath: '/site', mode: 'network' });
  assert.deepEqual(parseDevNetworkRequest({ projectPath: '/site', mode: 'local' }), { projectPath: '/site', mode: 'local' });
  assert.throws(() => parseDevNetworkRequest({ projectPath: '/site', mode: 'public' }), /expected local or network/);
  assert.throws(() => parseDevNetworkRequest({ projectPath: '/site', mode: true }), /expected local or network/);
  assert.throws(() => parseDevNetworkRequest({ mode: 'network' }));
  assert.throws(() => parseDevNetworkRequest(jsonNull));
});

test('IPv4 addresses only, written the way the system reports them', () => {
  for (const good of ['192.168.1.23', '10.0.0.1', '0.0.0.0', '255.255.255.255']) {
    assert.equal(isIPv4Address(good), true, good);
  }
  for (const bad of ['192.168.1.256', '192.168.01.2', '192.168.1', '::1', 'fe80::1', ' 10.0.0.1', '10.0.0.1 ', 'localhost', '']) {
    assert.equal(isIPv4Address(bad), false, bad);
  }
});

test('the state: off, or on with a port and bounded addresses', () => {
  assert.deepEqual(parseDevNetworkState({ kind: 'off' }), { kind: 'off' });
  assert.deepEqual(parseDevNetworkState({ kind: 'on', port: 4321, addresses: [wifi] }), { kind: 'on', port: 4321, addresses: [wifi] });
  assert.deepEqual(parseDevNetworkState({ kind: 'on', port: 4321, addresses: [] }), { kind: 'on', port: 4321, addresses: [] });
  assert.throws(() => parseDevNetworkState({ kind: 'maybe' }), /expected off or on/);
  for (const port of [0, -1, 65_536, 4321.5, '4321', undefined]) {
    assert.throws(() => parseDevNetworkState({ kind: 'on', port, addresses: [wifi] }), /expected a TCP port/, String(port));
  }
  assert.throws(() => parseDevNetworkState({ kind: 'on', port: 4321, addresses: jsonNull }), /expected a list/);
  const many = Array.from({ length: DEV_NETWORK_LIMITS.addressesMax + 1 }, (_, index) => ({ address: `10.0.0.${index + 1}`, interfaceName: 'en0' }));
  assert.throws(() => parseDevNetworkState({ kind: 'on', port: 4321, addresses: many }), /exceeds limit/);
  assert.throws(() => parseDevNetworkState({ kind: 'on', port: 4321, addresses: [{ address: '::1', interfaceName: 'lo0' }] }), /expected an IPv4 address/);
  assert.throws(() => parseDevNetworkState({ kind: 'on', port: 4321, addresses: [{ address: '10.0.0.1', interfaceName: '' }] }), /expected a name/);
  assert.throws(
    () =>
      parseDevNetworkState({
        kind: 'on',
        port: 4321,
        addresses: [{ address: '10.0.0.1', interfaceName: 'x'.repeat(DEV_NETWORK_LIMITS.interfaceNameCharsMax + 1) }],
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
  assert.equal(networkPageURL(wifi, 4321, '/'), 'http://192.168.1.23:4321/');
  assert.equal(networkPageURL(wifi, 4321, '/blog/post?draft=1'), 'http://192.168.1.23:4321/blog/post?draft=1');
  assert.equal(networkPageURL(wifi, 4321, '/ünï'), 'http://192.168.1.23:4321/%C3%BCn%C3%AF');
  assert.throws(() => networkPageURL(wifi, 4321, 'blog'), /the route is a path/);
  assert.throws(() => networkPageURL(wifi, 4321, '//evil.example/x'), /the route keeps the host/);
  assert.throws(() => networkPageURL({ address: 'evil.example', interfaceName: 'en0' }, 4321, '/'), /the address is IPv4/);
});
