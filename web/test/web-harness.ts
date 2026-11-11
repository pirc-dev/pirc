// The web app's server for the e2e test and the demo: enrolled with the
// harness's relay, then serving, as its command runs it.
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { freePort, repo, sleep, type Harness, type Relay } from "../../test/harness.ts";

export interface Web {
  origin: string;
  // Runs a pirc-web command on the server's data directory; its output.
  cli(...args: string[]): string;
  // What the server has printed so far.
  log(): string;
  // Whether the server is still running.
  running(): boolean;
  // With tls, the certificate it serves, for a client to trust.
  cert?: string;
  key?: string;
}

// tls serves as deployed, with a certificate for localhost made here
// (needs openssl); else plaintext. The page is built first unless a
// release's bundle (PIRC_E2E_WEB) brings its own, or keepPage says a build
// already there will do. echo shows the server's output as it comes.
export async function startWeb(h: Harness, relay: Relay, o: { label: string; tls: boolean; port?: number; keepPage?: boolean; echo?: boolean }): Promise<Web> {
  const bundle = process.env.PIRC_E2E_WEB;
  const node = bundle ? [bundle] : ["--experimental-transform-types", "--no-warnings", join(repo, "web/server/main.ts")];
  if (!bundle && !(o.keepPage && existsSync(join(repo, "web/page/dist/index.html")))) {
    execFileSync(join(repo, "web/node_modules/.bin/vite"), ["build", "--logLevel", "warn"], { cwd: join(repo, "web/page"), stdio: "inherit" });
  }
  const data = join(h.dir, "web");
  const cli = (...args: string[]) => execFileSync("node", [...node, ...args, "--data-dir", data], { encoding: "utf8" }).trim();
  cli("enrol", relay.url, relay.cmd("add-client", "--label", o.label));
  const port = o.port ?? await freePort();
  let tlsArgs = ["--plaintext"];
  let cert: string | undefined;
  let key: string | undefined;
  if (o.tls) {
    cert = join(h.dir, "web-cert.pem");
    key = join(h.dir, "web-key.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert], { stdio: "ignore" });
    tlsArgs = ["--tls-cert", cert, "--tls-key", key];
  }
  const origin = `${o.tls ? "https" : "http"}://localhost:${port}`;
  let out = "";
  // The certificate is trusted for what the server reaches too: a
  // stand-in push service serves it (push-service.ts).
  const server = spawn("node", [...node, "serve", ...tlsArgs, "--listen", `127.0.0.1:${port}`, "--origin", origin, "--data-dir", data], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(cert ? { NODE_EXTRA_CA_CERTS: cert } : {}) },
  });
  const take = (b: Buffer) => {
    out += b;
    if (o.echo) process.stdout.write(b);
  };
  server.stdout!.on("data", take);
  server.stderr!.on("data", take);
  h.onCleanup(() => server.kill());
  for (let i = 0; i < 100 && !out.includes("listening"); i++) await sleep(100);
  if (!out.includes("listening")) throw new Error(`pirc-web did not start on ${origin}:\n${out}`);
  return { origin, cli, log: () => out, running: () => server.exitCode === null && server.signalCode === null, ...(cert ? { cert, key } : {}) };
}
