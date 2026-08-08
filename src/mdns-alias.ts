/**
 * Advertise a `.local` name for this machine's loopback address over mDNS.
 *
 * The point is a memorable URL with no privilege at all. The usual ways to get
 * one both cost something: `/etc/hosts` is root-owned, so it means a sudo
 * password prompt during install, and a public `A` record pointing at 127.0.0.1
 * means owning a domain and adding DNS. An mDNS proxy registration costs
 * neither — advertising a record is an unprivileged operation, and the address
 * you advertise is whatever you say it is, loopback included. This is what
 * tools like LocalCan do, and it is why a `<host>.local` name does not have to
 * mean "the LAN address" the way a machine's own hostname record does.
 *
 * macOS only, deliberately. Bonjour is built into the OS there, so this is free
 * and works offline. Linux would need avahi-daemon and avahi-utils installed
 * and mDNS enabled in the resolver — a system daemon, which is exactly what a
 * first install should not be dragging in for the sake of a nicer URL. Linux
 * keeps the existing options: a loopback DNS name when one resolves, or the
 * opt-in hosts entry.
 *
 * Two things worth knowing about the trade:
 *   - The registration lives only as long as the process holding it, which is
 *     why this is owned by `serve` rather than by setup. Stop the server and
 *     the name stops resolving, which is also the cleanest possible uninstall.
 *   - `.local` is a namespace shared with every device on the network. While
 *     this is running, other machines resolve the same name to *their own*
 *     loopback. That is harmless — they get a refused connection unless they
 *     happen to run something on the port — but it is a shared namespace, so
 *     two people running omg.dev on one network will claim the same name.
 */
import { ENV_PREFIX, ENV_PREFIX_LEGACY } from "./env-compat.ts";

let registration: ReturnType<typeof Bun.spawn> | null = null;

/**
 * Read OMG_MDNS_HOSTNAME, falling back to the legacy LFG_ spelling.
 *
 * Returns undefined only when neither name is set at all. An explicitly empty
 * value is a real answer — "advertise nothing" — and must not be mistaken for
 * "unset" and overridden by the default.
 */
function configuredHostname(env: Record<string, string | undefined> = process.env): string | undefined {
  return env[`${ENV_PREFIX}MDNS_HOSTNAME`] ?? env[`${ENV_PREFIX_LEGACY}MDNS_HOSTNAME`];
}

/**
 * The name to advertise, or "" to advertise nothing.
 *
 * Defaults to `omg.local` on macOS and to nothing everywhere else. An explicit
 * empty value turns it off; any other value is used verbatim, so a machine
 * running two instances can give them different names.
 */
export function mdnsHostname(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = configuredHostname(env);
  if (configured !== undefined) return configured.trim();
  return platform === "darwin" ? "omg.local" : "";
}

/** `omg.local` -> `omg`: dns-sd wants the instance name without the domain. */
export function serviceInstanceName(hostname: string): string {
  return hostname.replace(/\.local\.?$/i, "") || hostname;
}

export type MdnsDeps = {
  platform: NodeJS.Platform;
  which: (name: string) => string | null;
  spawn: (command: string[]) => { kill: () => void } | null;
  log: (message: string) => void;
};

function defaultDeps(): MdnsDeps {
  return {
    platform: process.platform,
    which: name => Bun.which(name),
    spawn: command => {
      const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      return { kill: () => child.kill() };
    },
    log: message => console.log(message),
  };
}

/**
 * Start advertising, returning the name being advertised (or null).
 *
 * Every failure here is non-fatal by design: a missing `dns-sd`, a name already
 * claimed on the network, a machine with mDNS switched off. None of that should
 * stop the server from serving — the loopback URL always works regardless.
 */
export function startMdnsAlias(port: number, overrides: Partial<MdnsDeps> = {}): string | null {
  const deps = { ...defaultDeps(), ...overrides };
  const hostname = mdnsHostname(deps.platform);
  if (!hostname) return null;
  if (deps.platform !== "darwin") return null;

  const dnssd = deps.which("dns-sd");
  if (!dnssd) return null;

  // -P registers a *proxy* record: a name pointing at an address that is not
  // the advertising host's own. That is the whole trick — it is what lets a
  // .local name resolve to 127.0.0.1 instead of this machine's LAN address.
  const child = deps.spawn([
    dnssd,
    "-P",
    serviceInstanceName(hostname),
    "_http._tcp",
    "local",
    String(port),
    hostname,
    "127.0.0.1",
  ]);
  if (!child) return null;
  registration = child as ReturnType<typeof Bun.spawn>;
  deps.log(`  named local url: http://${hostname}:${port} (mDNS, this machine only)`);
  return hostname;
}

/** Drop the advertisement. Safe to call when nothing is registered. */
export function stopMdnsAlias(): void {
  if (!registration) return;
  try {
    registration.kill();
  } catch {
    /* already gone */
  }
  registration = null;
}
