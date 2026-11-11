// A local web app to look at, or for an agent to check a change to the page
// in a browser: the relay, a pi with the extension and the fake model, and
// pirc-web serving the page as built from this tree, until interrupted. Not
// a test; nothing checks anything. docs/testing.md says how to use it.
//
//   node --experimental-transform-types --no-warnings web/test/demo.ts [port]
//
// It signs in with a passkey in software, as the e2e test does, and serves
// a link on the next port that hands that sign-in to a browser: opening it
// sets the cookie and goes to the page, with no passkey in the browser.
// (Cookies ignore the port, so it can; and the page's own script could
// not replace a cookie an earlier run left.) The pairing link is printed
// too, for a browser that should make a real passkey.
import { createServer } from "node:http";
import { join } from "node:path";

import { Harness, repo, startPi, startRelay } from "../../test/harness.ts";
import { SoftAuthenticator } from "./authenticator.ts";
import { startWeb } from "./web-harness.ts";

const port = Number(process.argv[2] ?? 7402);
const origin = `http://localhost:${port}`;

const h = new Harness();
const stop = async () => {
  await h.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const relay = await startRelay(h);
// With a launcher that opens new agents with the demo's own pi arguments.
const pi = await startPi(h, relay, relay.cmd("add-host", "--label", "laptop"), "pi", [join(repo, "extension/test/give-launcher.ts"), join(repo, "extension/test/ask-questions.ts")]);
const { cli } = await startWeb(h, relay, { label: "web", tls: false, port, echo: true });

// Pairs a passkey in software and signs in with it, as a browser would.
let cookie = "";
const post = async <T>(path: string, body: unknown = {}): Promise<T> => {
  const r = await fetch(origin + path, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  const set = /(pirc-session)=([^;]*)/.exec(r.headers.get("set-cookie") ?? "");
  if (set) cookie = `${set[1]}=${set[2]}`;
  return r.json() as Promise<T>;
};
const key = new SoftAuthenticator();
const link = cli("pair", "--label", "demo-software");
const options = await post<{ challenge: string; rp: { id: string }; user: { id: string } }>("/api/pair/options", { token: link.slice(link.indexOf("#") + 1) });
await post("/api/pair/verify", { response: key.register(options, origin) });
cookie = "";
const login = await post<{ challenge: string; rpId: string }>("/api/login/options");
await post("/api/login/verify", { response: key.authenticate(login, origin) });

const handover = createServer((_req, res) => {
  res.writeHead(303, { "set-cookie": `${cookie}; HttpOnly; SameSite=Strict; Path=/`, location: `${origin}/` }).end();
});
await new Promise<void>((r) => handover.listen(port + 1, "127.0.0.1", r));
h.onCleanup(() => handover.close());

console.log(`
PiRC demo ready
  sign in: http://localhost:${port + 1}/  (opens ${origin}, signed in;
           the sign-in lapses after 30 minutes without a request)
  or pair: ${cli("pair", "--label", "demo")}
  pi:      tmux -L ${pi.tmuxSession} capture-pane -p -t '=${pi.tmuxSession}:'
  stop:    interrupt this process; it removes everything it started
`);
