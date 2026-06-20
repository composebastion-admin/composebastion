import dns from "node:dns";
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

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) — classify by the embedded IPv4 address.
  const mapped = ipL.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIp(mapped[1]!);
  const mappedHex = ipL.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1]!, 16);
    const low = Number.parseInt(mappedHex[2]!, 16);
    if (high <= 0xffff && low <= 0xffff) {
      return isPrivateIp(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
    }
  }

  // IPv4 Loopback and Link-local
  if (ip.startsWith("127.") || ip.startsWith("169.254.")) return true;

  const parts = ip.split(".").map(Number);
  if (parts.length === 4 && !parts.some(isNaN)) {
    const a = parts[0]!;
    const b = parts[1]!;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 100.64.0.0/10 — carrier-grade NAT / shared address space
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 0.0.0.0/8
    if (a === 0) return true;
  }

  // IPv6 Loopback and unspecified
  if (ipL === "::1" || ipL === "::") return true;
  // Link-local fe80::/10 (fe80–febf)
  if (/^fe[89ab][0-9a-f]:/.test(ipL)) return true;
  // Unique Local Addresses fc00::/7 (fc00–fdff)
  if (/^f[cd][0-9a-f][0-9a-f]:/.test(ipL)) return true;

  return false;
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
    resolveAgentHostname(hostname, resolve)
      .then((addresses) => selectAgentAddress(addresses, allowPrivateAgentUrls, lookupFamily(options)))
      .then((selected) => callback(null, selected.address, selected.family))
      .catch((error: NodeJS.ErrnoException) => callback(error, "", 0));
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
