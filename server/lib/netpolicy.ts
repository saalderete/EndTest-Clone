// Where tests and webhooks may connect. Tested sites are treated as untrusted:
// a test must not be able to reach the runner's own network, cloud metadata
// endpoints, or hosts outside its environment's allow-list.
import { lookup } from "node:dns/promises";
import net from "node:net";

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function ipv6Private(ip: string): boolean {
  const x = ip.toLowerCase();
  if (x === "::" || x === "::1") return true;
  if (x.startsWith("::ffff:")) return ipv4Private(x.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x);
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return ipv4Private(ip);
  if (net.isIPv6(ip)) return ipv6Private(ip);
  return false;
}

/** True when the hostname is, or resolves to, a private/loopback/link-local address. */
export async function isBlockedAddress(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return true;
  if (net.isIP(host)) return isPrivateIp(host);
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.some((a) => isPrivateIp(a.address));
  } catch {
    return false; // unresolvable: the browser will fail on its own
  }
}

/** Host allow-list match: exact host, or "*.example.com" for subdomains. */
export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((rule) => {
    const r = rule.trim().toLowerCase();
    if (!r) return false;
    if (r.startsWith("*.")) return h === r.slice(2) || h.endsWith(r.slice(1));
    return h === r;
  });
}

export function normalizeHostList(input: string[] | string): string[] {
  const list = Array.isArray(input) ? input : input.split(/[\s,]+/);
  return [...new Set(list.map((h) => h.trim().toLowerCase()).filter(Boolean))];
}
