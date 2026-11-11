#!/usr/bin/env -S node --experimental-transform-types --no-warnings
// pirc-web: PiRC's web app (docs/web.md).
//
//   pirc-web enrol <relay-url> <token>          register with a PiRC relay
//   pirc-web serve --origin URL --listen host:port (--tls-cert F --tls-key F | --plaintext)
//   pirc-web pair [--label NAME]                print a link that adds a passkey
//   pirc-web list                               passkeys
//   pirc-web revoke <passkey ID or label>       remove a passkey, signing it out
//   pirc-web version
//
// Options go after a command's arguments. Every command takes --data-dir
// (default $PIRC_WEB_DIR, else $XDG_CONFIG_HOME/pirc/web). A command
// refuses a data directory owned by another user: its files are created
// 0600, so one run as root would lock a service's user out.
//
// serve's flags can also be set in the environment, for a service's
// environment file: PIRC_WEB_ORIGIN, PIRC_WEB_LISTEN, PIRC_WEB_TLS_CERT,
// PIRC_WEB_TLS_KEY, PIRC_WEB_PLAINTEXT (true or false) and PIRC_WEB_PAGE.
// A flag wins over its variable; an empty variable counts as unset. The
// origin is the app's address as browsers see it ("https://pirc.example"):
// passkeys are tied to its host name, and requests from any other are
// refused. serve saves it for pair.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createSecureServer } from "node:http2";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { serve } from "@hono/node-server";

import { loadOrCreateKey, RelayConnection, type ConnectionState } from "@pirc/relay-client";
import { Cli, readJson, writeJson } from "@pirc/relay-client/service";

import { Client } from "../core/client.ts";
import type { RelayView } from "../core/view.ts";
import { createApp } from "./app.ts";
import { Auth, AuthError, AuthStore } from "./auth.ts";
import { Notifier } from "./notify.ts";
import { PushStore } from "./push.ts";
import { EventLog, Watchers } from "./stream.ts";

interface Config {
  relay?: string;
  origin?: string;
}

// Set by sh/release.sh when it bundles the web app; "dev" from source.
declare const PIRC_VERSION: string | undefined;
const VERSION = typeof PIRC_VERSION === "string" ? PIRC_VERSION : "dev";

const cli = new Cli("pirc-web");
const die = (msg: string): never => cli.die(msg);

function readConfig(dir: string): Config {
  return readJson<Config>(join(dir, "web.json")) ?? {};
}

function writeConfig(dir: string, c: Config): void {
  writeJson(join(dir, "web.json"), c);
}

function checkOrigin(v: string): string {
  if (!URL.canParse(v)) die(`not an origin: ${v}`);
  const u = new URL(v);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))) {
    die(`the origin must be https:// (passkeys need it), or http://localhost for testing: ${v}`);
  }
  if (u.pathname !== "/" || u.search || u.hash) die(`an origin has no path: ${v}`);
  return u.origin;
}

function relayView(s: ConnectionState): RelayView {
  switch (s.kind) {
    case "connecting":
    case "ready":
    case "stopped":
      return { state: s.kind };
    case "offline":
    case "pending":
      return { state: "offline", reason: s.reason };
    case "refused":
      return { state: "refused", reason: s.reason };
  }
}

async function enrol(dir: string, url: string, token: string): Promise<void> {
  await cli.enrol({ dir, url, token, label: "web", software: `pirc-web/${VERSION}` });
  writeConfig(dir, { ...readConfig(dir), relay: url });
  console.log(`enrolled with ${url}`);
}

function pageDir(v: string | undefined): string {
  const dir = v
    ?? [join(import.meta.dirname, "page"), join(import.meta.dirname, "..", "page", "dist")].find((d) => existsSync(join(d, "index.html")));
  if (!dir || !existsSync(join(dir, "index.html"))) die(`no built page${v ? ` in ${v}` : ""}; build it, or give --page`);
  return dir!;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  // enrol's URL and token, and revoke's passkey, come first, taken as they
  // are: a token or a passkey ID may begin with "-", which the option
  // parser would take for an option. Options follow them.
  const taken = cmd === "enrol" ? 2 : cmd === "revoke" ? 1 : 0;
  const fixed = args.slice(0, taken);
  const rest = args.slice(taken);
  const { values: v, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      origin: { type: "string" },
      listen: { type: "string" },
      "tls-cert": { type: "string" },
      "tls-key": { type: "string" },
      plaintext: { type: "boolean" },
      page: { type: "string" },
      label: { type: "string" },
    },
  });
  if (cmd === "version") return console.log(VERSION);
  const dir = cli.dataDir(v["data-dir"], "PIRC_WEB_DIR", "web");
  cli.checkOwner(dir);
  const store = new AuthStore(join(dir, "auth.json"));

  switch (cmd) {
    case "enrol": {
      const [url, token] = fixed;
      if (!url || !token || positionals.length > 0) die("usage: pirc-web enrol <relay-url> <token>");
      return enrol(dir, url, token);
    }
    case "pair": {
      const origin = v.origin ? checkOrigin(v.origin) : readConfig(dir).origin;
      if (!origin) die("no origin known yet: start serve once, or give --origin");
      const label = v.label ?? "passkey";
      const token = store.issuePairToken(label);
      console.log(`${origin}/pair#${token}`);
      console.error("Open it on the device within 10 minutes, and make a passkey there. It works once.");
      return;
    }
    case "list": {
      const keys = store.passkeys();
      if (keys.length === 0) console.error("no passkeys; add one with pirc-web pair");
      for (const p of keys) console.log(`${p.id}  ${JSON.stringify(p.label)}  added ${p.createdAt}${p.lastUsedAt ? `  last used ${p.lastUsedAt}` : ""}`);
      return;
    }
    case "revoke": {
      const [which] = fixed;
      if (!which || positionals.length > 0) die("usage: pirc-web revoke <passkey ID or label>");
      try {
        const gone = store.revoke(which);
        if (!gone) die("no such passkey");
        console.log(`revoked ${JSON.stringify(gone!.label)}; its sign-ins end with their next request`);
      } catch (e) {
        if (e instanceof AuthError) die(e.message);
        throw e;
      }
      return;
    }
    case "serve":
      return serveCmd(dir, store, v);
    default:
      die("usage: pirc-web enrol|serve|pair|list|revoke|version (see https://github.com/pirc-dev/pirc/blob/master/docs/self-hosting.md)");
  }
}

function serveCmd(dir: string, store: AuthStore, v: Record<string, string | boolean | undefined>): void {
  const config = readConfig(dir);
  if (!config.relay) die("not enrolled with a relay: run pirc-web enrol <relay-url> <token>");
  const originArg = (v.origin as string | undefined) ?? cli.env("PIRC_WEB_ORIGIN");
  if (!originArg) die("no origin: give --origin (or PIRC_WEB_ORIGIN), the app's address as browsers see it");
  const origin = checkOrigin(originArg!);
  const listen = cli.listen((v.listen as string | undefined) ?? cli.env("PIRC_WEB_LISTEN"), "PIRC_WEB_LISTEN");
  const tls = cli.tls(
    (v["tls-cert"] as string | undefined) ?? cli.env("PIRC_WEB_TLS_CERT"),
    (v["tls-key"] as string | undefined) ?? cli.env("PIRC_WEB_TLS_KEY"),
    (v.plaintext as boolean | undefined) ?? cli.envBool("PIRC_WEB_PLAINTEXT"),
  );
  const page = pageDir((v.page as string | undefined) ?? cli.env("PIRC_WEB_PAGE"));
  if (config.origin !== origin) writeConfig(dir, { ...config, origin });

  const logLine = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
  const log = new EventLog(randomUUID().slice(0, 8));
  let conn: RelayConnection | undefined;
  const key = loadOrCreateKey(join(dir, "client.key"));
  const client = new Client({ send: (f) => conn?.send(f) ?? false, onEvent: (e) => log.push(e), publicKey: key.publicKey });
  conn = new RelayConnection({
    url: config.relay!,
    role: "client",
    key,
    label: "web",
    software: `pirc-web/${VERSION}`,
    onFrame: (f) => client.onFrame(f),
    onState: (s) => {
      logLine(`relay ${s.kind}${"reason" in s ? `: ${s.reason}` : ""}`);
      client.onState(relayView(s));
    },
    onError: (where, e) => logLine(`${where}: ${(e as Error)?.message ?? e}`),
  });

  const auth = new Auth(store, { origin, name: "PiRC" });
  const watchers = new Watchers();
  const pushStore = new PushStore(join(dir, "push.json"));
  const notifier = new Notifier({
    log,
    client,
    store: pushStore,
    passkeys: () => store.passkeys().map((p) => p.id),
    watching: (chat) => watchers.has(chat),
    subject: origin,
    logLine,
  });
  notifier.start();
  const app = createApp({ auth, client, log, pageDir: page, logLine, watchers, push: { store: pushStore, notifier }, relay: config.relay });
  const options = { fetch: app.fetch, hostname: listen.host, port: listen.port };
  const server = tls
    ? serve({ ...options, createServer: createSecureServer, serverOptions: { ...tls, allowHTTP1: true } })
    : serve(options);
  server.on("listening", () => {
    logLine(`pirc-web ${VERSION} listening on ${listen.shown} for ${origin}${tls ? "" : " (plaintext)"}`);
    conn!.start();
  });
  server.on("error", (e) => die(`cannot listen on ${listen.shown}: ${(e as Error).message}`));
  const stop = () => {
    conn?.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

await main();
