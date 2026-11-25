// Goal: the phone preview offers the address a phone on the same Wi-Fi can open, and never one it cannot:
// not loopback, not link-local, not IPv6, and a VPN, container or VM interface only when nothing else exists.
// Method: selectLanAddresses (electron/preview/lanAddresses.ts) is pure, so it is driven with tables shaped
// like os.networkInterfaces() on macOS, Linux and Windows: a laptop on Wi-Fi, Wi-Fi beside Docker and a VPN,
// Ethernet beside Wi-Fi, no network at all, IPv6 only, link-local only, a VPN alone, Node 18.0's numeric
// family, and tables past the bounds. The results are compared whole, best first.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LAN_ADDRESS_LIMITS, selectLanAddresses } from '#dist/electron/preview/lanAddresses.js';

const ipv4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal });
const ipv6 = (address: string, internal = false) => ({ address, family: 'IPv6', internal });
const loopback = { lo0: [ipv4('127.0.0.1', true), ipv6('::1', true)] };

test('a laptop on Wi-Fi offers its Wi-Fi address', () => {
  assert.deepEqual(selectLanAddresses({ ...loopback, en0: [ipv6('fe80::1c2b:3a4d'), ipv4('192.168.1.23')] }), [
    { address: '192.168.1.23', interfaceName: 'en0' },
  ]);
});

test('Docker, a VPN, Tailscale and AirDrop are passed over while Wi-Fi is there', () => {
  const table = {
    ...loopback,
    utun3: [ipv4('10.8.0.6')],
    docker0: [ipv4('172.17.0.1')],
    'br-4f2a': [ipv4('172.18.0.1')],
    tailscale0: [ipv4('100.101.102.103')],
    awdl0: [ipv6('fe80::aa')],
    vEthernet: [ipv4('172.24.112.1')],
    'vEthernet (WSL)': [ipv4('172.25.0.1')],
    bridge100: [ipv4('192.168.64.1')],
    vmnet8: [ipv4('192.168.200.1')],
    en0: [ipv4('192.168.0.42')],
  };
  assert.deepEqual(selectLanAddresses(table), [{ address: '192.168.0.42', interfaceName: 'en0' }]);
});

test('Wi-Fi and Ethernet are both offered, physical names and private ranges first', () => {
  const table = {
    'Wi-Fi': [ipv4('10.0.0.7')],
    Ethernet: [ipv4('192.168.10.5')],
    eth1: [ipv4('203.0.113.9')],
    custom: [ipv4('192.168.50.2')],
  };
  assert.deepEqual(selectLanAddresses(table), [
    { address: '192.168.10.5', interfaceName: 'Ethernet' },
    { address: '10.0.0.7', interfaceName: 'Wi-Fi' },
    { address: '203.0.113.9', interfaceName: 'eth1' },
    { address: '192.168.50.2', interfaceName: 'custom' },
  ]);
});

test('the 172.16/12 range ranks after 10/8, and 172.32 is not private', () => {
  assert.deepEqual(
    selectLanAddresses({ en1: [ipv4('172.32.0.1')], en0: [ipv4('172.16.4.4')], en2: [ipv4('10.1.1.1')] }).map((lan) => lan.address),
    ['10.1.1.1', '172.16.4.4', '172.32.0.1'],
  );
});

test('no network at all: nothing to offer', () => {
  assert.deepEqual(selectLanAddresses({}), []);
  assert.deepEqual(selectLanAddresses(loopback), []);
  assert.deepEqual(selectLanAddresses({ en0: undefined }), []);
});

test('IPv6 only: nothing to offer, since the phone URL is IPv4', () => {
  assert.deepEqual(selectLanAddresses({ ...loopback, en0: [ipv6('2001:db8::5'), ipv6('fe80::5')] }), []);
});

test('link-local only (no DHCP answered): nothing to offer', () => {
  assert.deepEqual(selectLanAddresses({ en0: [ipv4('169.254.12.34')], en1: [ipv4('169.254.1.1')] }), []);
});

test('a VPN alone is offered, since nothing else is there', () => {
  assert.deepEqual(selectLanAddresses({ ...loopback, utun2: [ipv4('10.8.0.6')] }), [{ address: '10.8.0.6', interfaceName: 'utun2' }]);
});

test('loopback an interface forgot to mark internal, malformed addresses and duplicates are dropped', () => {
  const table = {
    en5: [ipv4('127.0.0.2'), ipv4('192.168.1.300'), ipv4('192.168.01.2'), ipv4('not an address')],
    en0: [ipv4('192.168.1.9')],
    en1: [ipv4('192.168.1.9')],
  };
  assert.deepEqual(selectLanAddresses(table), [{ address: '192.168.1.9', interfaceName: 'en0' }]);
});

test('Node 18.0 reported the family as a number', () => {
  assert.deepEqual(selectLanAddresses({ en0: [{ address: '192.168.4.4', family: 4, internal: false }] }), [{ address: '192.168.4.4', interfaceName: 'en0' }]);
});

test('a table past the bounds is read up to them, and the answer holds at most eight', () => {
  const table: Record<string, ReturnType<typeof ipv4>[]> = {};
  for (let i = 0; i < LAN_ADDRESS_LIMITS.interfacesMax + 20; i++) {
    table[`en${i}`] = Array.from({ length: LAN_ADDRESS_LIMITS.addressesPerInterfaceMax + 5 }, (_, j) => ipv4(`10.${i % 250}.${j}.1`));
  }
  const offered = selectLanAddresses(table);
  assert.equal(offered.length, 8);
  assert.equal(new Set(offered.map((lan) => lan.address)).size, 8, 'no address twice');
});
