// The address a request came from when it may have passed through trusted
// proxies, found as the relay finds it (relay/internal/proxy): on a
// connection from a trusted proxy, the rightmost X-Forwarded-For entry
// that is not itself a trusted proxy, since each proxy appends the address
// it saw and anything left of that was written by the client and may be
// forged; from anyone else the header is ignored. The sign-in limit counts
// by it, so that clients behind one proxy do not share theirs.
import { BlockList, isIP } from "node:net";

export interface Proxies {
  list: BlockList;
  // The prefixes covering more than one address: any peer inside one can
  // pass for any address, by sending the header itself.
  wide: string[];
}

// An IPv4-mapped IPv6 address as plain IPv4, as Node gives a dual-stack
// socket's peers; anything else as it is.
function bare(a: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  return m ? m[1] : a;
}

// A comma-separated list of addresses and CIDR prefixes, such as
// "172.30.88.2, 10.0.0.0/8". Empty is none.
export function parseProxies(s: string | undefined): Proxies {
  const list = new BlockList();
  const wide: string[] = [];
  for (const f of (s ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [net, bits, extra] = f.split("/");
    const a = bare(net);
    const v = isIP(a);
    if (!v || extra !== undefined || (bits !== undefined && !/^\d+$/.test(bits))) throw new Error(`trusted proxy "${f}": not an address or CIDR prefix`);
    const type = v === 6 ? "ipv6" : "ipv4";
    const max = v === 6 ? 128 : 32;
    if (bits === undefined) {
      list.addAddress(a, type);
      continue;
    }
    // Peers are compared unmapped, so an IPv4-mapped prefix is too, as the
    // relay takes it: ::ffff:10.1.0.0/112 is 10.1.0.0/16.
    const mapped = a !== net;
    let n = Number(bits);
    if (mapped && n < 96) throw new Error(`trusted proxy "${f}": wider than the IPv4-mapped range`);
    if (mapped) n -= 96;
    if (n > max) throw new Error(`trusted proxy "${f}": a prefix of at most ${mapped ? 128 : max} bits`);
    list.addSubnet(a, n, type);
    if (n < max) wide.push(f);
  }
  return { list, wide };
}

function trusted(a: string, p: Proxies): boolean {
  const v = isIP(a);
  return v !== 0 && p.list.check(a, v === 6 ? "ipv6" : "ipv4");
}

// remote is the connection's peer, forwarded the X-Forwarded-For header
// (Node joins repeated ones with commas); "?" when the peer is not known.
export function clientAddr(remote: string | undefined, forwarded: string | undefined, p: Proxies | undefined): string {
  const from = remote ? bare(remote) : "?";
  if (!p || !trusted(from, p)) return from;
  const hops = (forwarded ?? "").split(",").map((x) => bare(x.trim()));
  let client = "";
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!isIP(hops[i])) break;
    client = hops[i];
    if (!trusted(client, p)) break;
  }
  return client || from;
}
