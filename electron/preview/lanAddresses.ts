// Which of this machine's addresses a phone on the same Wi-Fi can open the preview at.
//
// `os.networkInterfaces()` lists every interface the system has: loopback, Wi-Fi, Ethernet, and a
// crowd of virtual ones (Docker bridges, VPN tunnels, Hyper-V switches, Tailscale, Apple's AirDrop
// link). A phone reaches only the first two, so this keeps IPv4 addresses that are not internal and
// not link-local (169.254/16, which the system assigns when no network answered), and ranks them:
// interfaces named like Wi-Fi or Ethernet first, then the private ranges home and office routers hand
// out (192.168/16, then 10/8, then 172.16/12). Virtual interfaces are offered only when nothing else
// is there, since a VPN's address is still the right one on some setups and none would be worse.
//
// Pure: the caller passes what the system reported, so the table of cases is a unit test.
import { assert } from '../../shared/core/assert';
import { DEV_NETWORK_LIMITS, isIPv4Address, type LanAddress } from '../../shared/ipc/devNetwork';

/** One address as `os.networkInterfaces()` reports it; Node 18.0 briefly reported `family` as a number. */
export interface InterfaceAddress {
  readonly address: string;
  readonly family: string | number;
  readonly internal: boolean;
}

export type InterfaceTable = Readonly<Record<string, readonly InterfaceAddress[] | undefined>>;

// Bounds on what is read from the system: a machine with more interfaces or addresses than this is
// read up to the bound, never further.
export const LAN_ADDRESS_LIMITS = {
  interfacesMax: 128,
  addressesPerInterfaceMax: 32,
} as const satisfies Record<string, number>;

// Interfaces a phone on the same Wi-Fi does not reach: container and VM bridges, VPN tunnels and
// Apple's peer-to-peer links. Matched against the interface's name, case-insensitively.
const VIRTUAL_NAME_PREFIX =
  /^(docker|br-|veth|virbr|vboxnet|vmnet|vethernet|utun|tun|tap|tailscale|zt|wg|ppp|ipsec|llw|awdl|bridge|anpi|gif|stf|lxc|lxd|cni|flannel|cali|kube)/i;
const VIRTUAL_NAME_PART = /(virtual|vpn|hyper-v|vmware|virtualbox|wsl|zerotier|wireguard|tailscale|docker|loopback)/i;
// Names the major systems give Wi-Fi and Ethernet: macOS en0, Linux eth0/wlan0/wlp2s0/enp3s0, Windows "Wi-Fi"/"Ethernet".
const PHYSICAL_NAME = /^(en\d|eth|wl|wlan|wifi|wi-fi|ethernet|enp|eno|ens|enx)/i;

interface Candidate {
  readonly lan: LanAddress;
  readonly virtual: boolean;
  readonly physical: boolean;
  readonly rangeRank: number;
}

/** The addresses to offer, best first; empty when the machine is on no network a phone could share. */
export function selectLanAddresses(table: InterfaceTable): readonly LanAddress[] {
  const candidates = readCandidates(table);
  const real = candidates.filter((candidate) => !candidate.virtual);
  const chosen = real.length > 0 ? real : candidates;
  const sorted = [...chosen].sort(compareCandidates);
  const unique: LanAddress[] = [];
  for (const candidate of sorted) {
    if (unique.length < DEV_NETWORK_LIMITS.addressesMax && !unique.some((seen) => seen.address === candidate.lan.address)) {
      unique.push(candidate.lan);
    }
  }
  assert(unique.length <= DEV_NETWORK_LIMITS.addressesMax, 'selectLanAddresses: the list is bounded');
  assert(
    unique.every((lan) => isIPv4Address(lan.address)),
    'selectLanAddresses: only IPv4 addresses are offered',
  );
  return unique;
}

function readCandidates(table: InterfaceTable): readonly Candidate[] {
  const candidates: Candidate[] = [];
  const names = Object.keys(table).slice(0, LAN_ADDRESS_LIMITS.interfacesMax);
  for (const name of names) {
    const addresses = (table[name] ?? []).slice(0, LAN_ADDRESS_LIMITS.addressesPerInterfaceMax);
    for (const entry of addresses) {
      const candidate = candidateOf(name, entry);
      if (candidate !== undefined) {
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function candidateOf(name: string, entry: InterfaceAddress): Candidate | undefined {
  if (entry.internal) {
    return undefined;
  }
  if (entry.family !== 'IPv4' && entry.family !== 4) {
    return undefined;
  }
  if (!isIPv4Address(entry.address)) {
    return undefined;
  }
  const octets = entry.address.split('.').map(Number);
  const first = octets[0] ?? 0;
  const second = octets[1] ?? 0;
  // Link-local: the system's own pick when nothing on the network answered; no phone shares it.
  // Loopback that an interface did not mark internal is still loopback.
  if (first === 169 && second === 254) {
    return undefined;
  }
  if (first === 127) {
    return undefined;
  }
  const interfaceName = name.slice(0, DEV_NETWORK_LIMITS.interfaceNameCharsMax);
  if (interfaceName.length === 0) {
    return undefined;
  }
  // 100.64/10 is carrier-grade NAT, which is also where Tailscale puts its addresses: not a Wi-Fi a phone joins.
  const carrierNAT = first === 100 && second >= 64 && second <= 127;
  return {
    lan: { address: entry.address, interfaceName },
    virtual: VIRTUAL_NAME_PREFIX.test(name) || VIRTUAL_NAME_PART.test(name) || carrierNAT,
    physical: PHYSICAL_NAME.test(name),
    rangeRank: privateRangeRank(first, second),
  };
}

// Lower is better: the ranges routers hand out, in the order they are common.
function privateRangeRank(first: number, second: number): number {
  if (first === 192 && second === 168) {
    return 0;
  }
  if (first === 10) {
    return 1;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return 2;
  }
  return 3;
}

function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.physical !== right.physical) {
    return left.physical ? -1 : 1;
  }
  if (left.rangeRank !== right.rangeRank) {
    return left.rangeRank - right.rangeRank;
  }
  if (left.lan.interfaceName !== right.lan.interfaceName) {
    return left.lan.interfaceName < right.lan.interfaceName ? -1 : 1;
  }
  return left.lan.address < right.lan.address ? -1 : left.lan.address > right.lan.address ? 1 : 0;
}
