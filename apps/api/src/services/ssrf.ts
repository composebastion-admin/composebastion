import dns, { type LookupAddress } from "node:dns";
import net, { type LookupFunction } from "node:net";
import { promisify } from "node:util";

export type ResolvedAddress = { address: string; family?: number };
export type LookupAll = (hostname: string, options: { all: true; verbatim?: boolean }) => Promise<ResolvedAddress[]>;
export type AgentLookup = LookupFunction;

const lookup = promisify(dns.lookup) as LookupAll;

function dnsHostname(hostname: string) {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function addressFamily(address: string, family?: number) {
  if (family === 4 || family === 6) return family;
  const parsed = net.isIP(address);
  if (parsed === 4 || parsed === 6) return parsed;
  throw Object.assign(new Error(`DNS returned an invalid address for the agent: ${address}`), { code: "ENOTFOUND" });
}

function lookupFamily(options: dns.LookupOptions) {
  if (options.family === 4 || options.family === "IPv4") return 4;
  if (options.family === 6 || options.family === "IPv6") return 6;
  return undefined;
}

function privateAgentAddressError(address: string) {
  return Object.assign(
    new Error(`Agent URL resolved to a private network address (${address}), which is blocked by default to prevent request forgery.`),
    { code: "PRIVATE_AGENT_ADDRESS" }
  );
}

export function isPrivateIp(ip: string): boolean {
  const ipL = ip.toLowerCase().trim();

  if (net.isIP(ipL) === 4) {
    const [a, b, c] = ipL.split(".").map(Number) as [number, number, number, number];
    // Reject every IANA special-purpose, private, shared, documentation,
    // multicast, and reserved IPv4 block. Saved registry origins are the only
    // policy-level exception and are handled by the caller after resolution.
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 192 && b === 31 && c === 196) return true;
    if (a === 192 && b === 52 && c === 193) return true;
    if (a === 192 && b === 88 && c === 99) return true;
    if (a === 192 && b === 175 && c === 48) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    return a >= 224;
  }

  if (net.isIP(ipL) !== 6) return true;
  const words = parseIpv6Words(ipL);
  if (!words) return true;

  const firstFiveZero = words.slice(0, 5).every((word) => word === 0);
  const firstSixZero = firstFiveZero && words[5] === 0;
  const embeddedIpv4 = `${words[6]! >> 8}.${words[6]! & 0xff}.${words[7]! >> 8}.${words[7]! & 0xff}`;

  // IPv4-compatible and standard IPv4-mapped addresses inherit the embedded
  // address policy. IPv4-translated forms are special-purpose and blocked.
  if (firstSixZero || (firstFiveZero && words[5] === 0xffff)) return isPrivateIp(embeddedIpv4);
  if (words.slice(0, 4).every((word) => word === 0) && words[4] === 0xffff && words[5] === 0) return true;

  // Only globally routable unicast is accepted. Explicitly exclude allocated
  // special-purpose ranges that sit inside 2000::/3.
  const globalUnicast = (words[0]! & 0xe000) === 0x2000;
  if (!globalUnicast) return true;
  if (words[0] === 0x2001 && (words[1]! & 0xfe00) === 0) return true; // IETF protocol assignments
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true; // documentation
  if (words[0] === 0x2002) return true; // deprecated 6to4
  if (words[0] === 0x3ffe) return true; // deprecated 6bone
  if (words[0] === 0x3fff && (words[1]! & 0xf000) === 0) return true; // documentation
  return false;
}

function parseIpv6Words(input: string): number[] | null {
  let value = input;
  if (value.includes(".")) {
    const separator = value.lastIndexOf(":");
    if (separator < 0) return null;
    const ipv4 = value.slice(separator + 1);
    if (net.isIP(ipv4) !== 4) return null;
    const octets = ipv4.split(".").map(Number);
    value = `${value.slice(0, separator)}:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array.from({ length: missing }, () => "0"), ...right]
    .map((word) => Number.parseInt(word || "0", 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : null;
}

export function shouldAllowPrivateOutboundUrls(nodeEnv: string, allowPrivateUrls: boolean) {
  return nodeEnv !== "production" || allowPrivateUrls;
}

export function shouldAllowPrivateAgentUrls(nodeEnv: string, allowPrivateAgentUrls: boolean) {
  return shouldAllowPrivateOutboundUrls(nodeEnv, allowPrivateAgentUrls);
}

export async function resolveAgentHostname(hostname: string, resolve: LookupAll = lookup) {
  const host = dnsHostname(hostname);
  const directFamily = net.isIP(host);
  if (directFamily === 4 || directFamily === 6) {
    return [{ address: host, family: directFamily }];
  }
  return resolve(host, { all: true, verbatim: true });
}

export function selectAgentAddress(addresses: ResolvedAddress[], allowPrivateAgentUrls: boolean, family?: number) {
  if (!allowPrivateAgentUrls) {
    for (const entry of addresses) {
      if (isPrivateIp(entry.address)) throw privateAgentAddressError(entry.address);
    }
  }
  const candidates = family === 4 || family === 6
    ? addresses.filter((entry) => addressFamily(entry.address, entry.family) === family)
    : addresses;
  if (candidates.length === 0) {
    throw Object.assign(new Error("Agent hostname did not resolve to a usable address"), { code: "ENOTFOUND" });
  }
  const selected = candidates[0]!;
  return { address: selected.address, family: addressFamily(selected.address, selected.family) };
}

export function createAgentLookup(allowPrivateAgentUrls: boolean, resolve: LookupAll = lookup): AgentLookup {
  return (hostname, options, callback) => {
    const returnAll = options.all === true;
    resolveAgentHostname(hostname, resolve)
      .then((addresses) => selectAgentAddress(addresses, allowPrivateAgentUrls, lookupFamily(options)))
      .then((selected) => {
        if (returnAll) {
          (callback as (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void)(null, [selected]);
          return;
        }
        (callback as (error: NodeJS.ErrnoException | null, address: string, family: number) => void)(
          null,
          selected.address,
          selected.family
        );
      })
      .catch((error: NodeJS.ErrnoException) => {
        if (returnAll) {
          (callback as (lookupError: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void)(error, []);
          return;
        }
        (callback as (lookupError: NodeJS.ErrnoException | null, address: string, family: number) => void)(error, "", 0);
      });
  };
}

export async function validateAgentUrl(urlStr: string, resolve: LookupAll = lookup): Promise<boolean> {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const addresses = await resolveAgentHostname(parsed.hostname, resolve);
    for (const entry of addresses) {
      if (isPrivateIp(entry.address)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
