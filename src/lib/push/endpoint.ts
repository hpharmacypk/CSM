import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Push endpoints are capability URLs chosen by the browser. We only ever send
 * to the browser push services below, over HTTPS on the default port, to
 * hosts that resolve to public addresses (never private/internal ones).
 * The database applies the same host list when a browser subscribes.
 */
const PUSH_HOSTS: RegExp[] = [
  /^fcm\.googleapis\.com$/, // Chrome, Edge, Android, Samsung Internet, Opera
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/, // Safari, iPhone/iPad Home Screen apps
  /^[a-z0-9-]{1,63}\.push\.apple\.com$/,
  /^[a-z0-9-]{1,63}\.notify\.windows\.com$/, // Edge (WNS)
];

export function parsePushEndpoint(raw: string, allowLoopbackForTests = false): URL | null {
  if (typeof raw !== "string" || raw.length > 1024 || /\s/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  if (
    allowLoopbackForTests &&
    url.hostname === "127.0.0.1" &&
    (url.protocol === "http:" || url.protocol === "https:")
  ) {
    return url;
  }
  if (url.protocol !== "https:" || url.port !== "") return null;
  if (!PUSH_HOSTS.some((re) => re.test(url.hostname))) return null;
  return url;
}

function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return privateV4(ip);
  if (kind !== 6) return true;
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return privateV4(mapped[1]);
  return (
    v6 === "::" ||
    v6 === "::1" ||
    /^f[cd]/.test(v6) || // unique local fc00::/7
    /^fe[89ab]/.test(v6) || // link local fe80::/10
    /^ff/.test(v6) || // multicast
    v6.startsWith("64:ff9b:") ||
    v6.startsWith("2001:db8:") ||
    v6.startsWith("::ffff:")
  );
}

/** Resolves the host and refuses it if any address is private/internal. */
export async function resolvesToPublic(url: URL, allowLoopbackForTests = false): Promise<boolean> {
  if (allowLoopbackForTests && url.hostname === "127.0.0.1") return true;
  try {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}
