// End to end: the relay, pi with the extension, and the web app's server
// run as its command with TLS, used over HTTP/2 and its event stream as a
// browser uses them, signed in with a passkey made in software
// (authenticator.ts). Needs openssl, for a certificate for localhost.
//
//   node --experimental-transform-types web/test/e2e.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:http2";
import { join } from "node:path";

import { Harness, repo, sleep, startPi, startRelay, step } from "../../test/harness.ts";
import type { Outcome } from "../core/results.ts";
import type { ChatItem, ChatView, SessionView, ViewEvent } from "../core/view.ts";
import { SoftAuthenticator } from "./authenticator.ts";
import { startPushService } from "./push-service.ts";
import { startWeb } from "./web-harness.ts";

const h = new Harness();
let failure: unknown;
try {
  const relay = await startRelay(h);
  const pi = await startPi(h, relay, relay.cmd("add-host", "--label", "e2e-host"), "pi", [join(repo, "extension/test/give-place.ts"), join(repo, "extension/test/give-launcher.ts"), join(repo, "extension/test/ask-questions.ts")]);

  // A release's bundle (sh/release.sh), with its page, else the source,
  // with the page built here; as deployed, TLS, which browsers then use
  // HTTP/2 over.
  const web = await startWeb(h, relay, { label: "e2e-web", tls: true, keepPage: true });
  const { origin, cli } = web;
  const cert = web.cert!;

  // One HTTP/2 connection, as a browser keeps; :authority is the origin's.
  // localhost is the server's 127.0.0.1, whatever the resolver prefers.
  const lookup = (_h: string, o: { all?: boolean }, cb: (e: null, a: unknown, f?: number) => void) =>
    o.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4);
  const h2 = connect(origin, { ca: readFileSync(cert), lookup: lookup as never });
  // Cleanup stops the server under this connection: its reset then is
  // expected. Before that, an error fails the step that met it.
  h2.on("error", () => {});
  h.onCleanup(() => h2.destroy());
  const h2fetch = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<Response>((resolve, reject) => {
      const req = h2.request({ ":method": init.method ?? "GET", ":path": path, ...init.headers });
      req.on("response", (hdrs) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(hdrs)) if (!k.startsWith(":") && v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
        let done = false;
        const body = new ReadableStream<Uint8Array>({
          start(ctl) {
            req.on("data", (d: Buffer) => !done && ctl.enqueue(new Uint8Array(d)));
            req.on("end", () => !done && (done = true, ctl.close()));
            req.on("error", (e) => !done && (done = true, ctl.error(e)));
          },
          cancel() {
            done = true;
            req.close();
          },
        });
        resolve(new Response(body, { status: Number(hdrs[":status"]), headers }));
      });
      req.on("error", reject);
      req.end(init.body);
    });
  let cookie = "";
  const http = async (path: string, body?: unknown) => {
    const r = await h2fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const set = /(__Host-pirc-session)=([^;]*)/.exec(r.headers.get("set-cookie") ?? "");
    if (set) cookie = `${set[1]}=${set[2]}`;
    return r;
  };
  const post = async <T>(path: string, body: unknown = {}) => {
    const r = await http(path, body);
    assert.equal(r.status, 200, `${path}: ${r.status} ${await r.clone().text()}`);
    return (await r.json()) as T;
  };

  step("the page is served, with its security headers");
  {
    const r = await http("/");
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<div id="root">/);
    assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.equal((await http("/api/snapshot")).status, 401);
  }

  step("pirc-web pair makes a passkey once; it signs in");
  const phone = new SoftAuthenticator();
  {
    const link = cli("pair", "--label", "e2e-phone");
    assert.ok(link.startsWith(`${origin}/pair#`), link);
    const token = link.slice(link.indexOf("#") + 1);
    const options = await post<{ challenge: string; rp: { id: string }; user: { id: string } }>("/api/pair/options", { token });
    await post("/api/pair/verify", { response: phone.register(options, origin) });
    assert.match(cli("list"), /"e2e-phone"/);
    cookie = "";
    const login = await post<{ challenge: string; rpId: string }>("/api/login/options");
    await post("/api/login/verify", { response: phone.authenticate(login, origin) });
  }

  step("the session list shows pi's session");
  let session: SessionView | undefined;
  for (let i = 0; i < 100 && !session; i++) {
    const snap = await (await http("/api/snapshot")).json() as { sessions: SessionView[] };
    session = snap.sessions[0];
    if (!session) await sleep(100);
  }
  assert.ok(session, "no session");
  assert.equal(session.hostLabel, "e2e-host");
  assert.equal(session.model?.id, "fake-1");
  const id = session.id;

  step("where pi runs: the harness's tmux session, detected");
  for (let i = 0; i < 50 && !session?.place; i++) {
    await sleep(100);
    session = ((await (await http("/api/snapshot")).json()) as { sessions: SessionView[] }).sessions[0];
  }
  assert.equal(session?.place?.kind, "tmux", JSON.stringify(session?.place));
  assert.equal(session?.place?.group, pi.tmuxSession);
  assert.equal(session?.place?.window, pi.tmuxWindow);

  // The chat's snapshot, then its event stream from there.
  const snap = await (await http(`/api/snapshot?chat=${encodeURIComponent(id)}`)).json() as { id: string; chat: ChatView };
  let chat = snap.chat;
  const events: ViewEvent[] = [];
  const stream = await h2fetch(`/api/events?chat=${encodeURIComponent(id)}&after=${snap.id}`, { headers: { cookie } });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  void (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buf += dec.decode(value);
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const data = buf.slice(0, i).split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
        buf = buf.slice(i + 2);
        if (data && data !== "{}") events.push(JSON.parse(data) as ViewEvent);
      }
    }
  })();
  h.onCleanup(() => void reader.cancel());

  // Applies the stream's events, as the page does, until the chat passes.
  const { applyToChat } = await import("../core/view.ts");
  // How many times the chat has started again (the process moved to
  // another session).
  let resets = 0;
  const until = async (what: string, ok: (items: ChatItem[]) => boolean) => {
    for (let i = 0; i < 150; i++) {
      for (const e of events.splice(0)) {
        chat = applyToChat(chat, e);
        if (e.type === "chatReset" && e.id === id) resets++;
        if (e.type === "session" && e.session.id === id) session = e.session;
      }
      if (ok(chat.items)) return;
      await sleep(100);
    }
    assert.fail(`${what}: ${JSON.stringify(chat.items).slice(-800)}`);
  };
  const text = (it: ChatItem) => (it.kind === "assistant" ? it.blocks.filter((b) => b.kind === "text").map((b) => b.text).join("") : "");

  step("a prompt runs: the user's message, the reply streamed then finished");
  {
    const r = await post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/prompt`, { text: "hello" });
    assert.deepEqual(r.ok && r.result, { kind: "accepted" });
    await until("the reply", (items) => items.some((x) => x.kind === "user" && x.text === "hello")
      && items.some((x) => x.kind === "assistant" && !x.streaming && x.stop === "stop" && text(x).length > 0));
  }

  step("its first message names a session with no name, and stays its first");
  await until("the first message", () => session?.first === "hello");

  step("a tool call shows with its result");
  await post(`/api/sessions/${encodeURIComponent(id)}/prompt`, { text: "tool" });
  await until("the tool", (items) => items.some((x) => x.kind === "tool" && x.name === "bash" && x.result !== undefined));
  assert.equal(session?.first, "hello");
  {
    const tool = chat.items.filter((x): x is Extract<ChatItem, { kind: "tool" }> => x.kind === "tool").at(-1)!.result!;
    assert.equal(tool.exitCode, 0);
    assert.equal(typeof tool.durationMs, "number");
  }

  step("the actions: models, model, thinking level, cost and context");
  {
    const r = await post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/models`);
    assert.ok(r.ok && r.result.kind === "models");
    // The test's pi lists any provider its environment has keys for, too.
    assert.deepEqual(r.result.models.filter((m) => m.model.provider === "fake").map((m) => m.model.id).sort(), ["fake-1", "fake-2"]);
    assert.ok((await post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/model`, { provider: "fake", id: "fake-2" })).ok);
    assert.ok((await post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/thinking`, { level: "high" })).ok);
    // The command answers once its effect is in the stream.
    await until("the session's new model", () => session?.model?.id === "fake-2" && session.thinking === "high");
    const st = await post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/stats`);
    assert.ok(st.ok && st.result.kind === "stats" && st.result.output > 0, JSON.stringify(st));
  }

  step("stopping a turn");
  {
    await post(`/api/sessions/${encodeURIComponent(id)}/prompt`, { text: "slow" });
    await until("streaming", (items) => items.some((x) => x.kind === "assistant" && x.streaming));
    assert.ok((await post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/abort`)).ok);
    await until("the stop", (items) => items.some((x) => x.kind === "assistant" && x.stop === "aborted"));
  }

  step("another extension gives the place, then hands back to detection");
  {
    pi.keys("/giveplace my agent", "Enter");
    await until("the given place", () => session?.place?.display === "my agent");
    pi.keys("/giveplace", "Enter");
    await until("detection again", () => session?.place?.kind === "tmux");
  }

  step("clone copies the chat; a fork from a message keeps what came before it");
  {
    const users = (items: ChatItem[]) => items.flatMap((x) => (x.kind === "user" ? [x.text] : []));
    const before = users(chat.items);
    assert.deepEqual(before, ["hello", "tool", "slow"]);
    let r = await post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/clone`);
    assert.deepEqual(r.ok && r.result, { kind: "accepted" }, JSON.stringify(r));
    let seen = resets;
    await until("the clone's chat", (items) => resets > seen && !chat.loading && users(items).length === 3);
    assert.deepEqual(users(chat.items), before);
    const tool = chat.items.find((x) => x.kind === "user" && x.text === "tool")!;
    assert.ok(tool.entryId, "a user message carries its entry");
    seen = resets;
    r = await post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/fork`, { entryId: tool.entryId });
    assert.deepEqual(r.ok && r.result, { kind: "accepted" }, JSON.stringify(r));
    await until("the fork's chat", (items) => resets > seen && !chat.loading && users(items).length > 0);
    assert.deepEqual(users(chat.items), ["hello"]);
    r = await post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/fork`, { entryId: "nope" });
    assert.ok(!r.ok && r.code === "INVALID", JSON.stringify(r));
  }

  step("the past sessions list the ones before; resume goes back to one");
  {
    const users = (items: ChatItem[]) => items.flatMap((x) => (x.kind === "user" ? [x.text] : []));
    const r = await post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/past`, { allFolders: false });
    assert.ok(r.ok && r.result.kind === "pastSessions", JSON.stringify(r));
    const past = r.ok && r.result.kind === "pastSessions" ? r.result.sessions : [];
    const whole = past.find((x) => x.firstPrompt === "hello" && x.messages > 0 && x.modified > 0);
    assert.ok(whole, JSON.stringify(past));
    const seen = resets;
    const u = await post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/resume`, { path: whole.path });
    assert.deepEqual(u.ok && u.result, { kind: "accepted" }, JSON.stringify(u));
    await until("the resumed chat", (items) => resets > seen && !chat.loading && users(items).length > 0);
    assert.equal(users(chat.items)[0], "hello");
    const bad = await post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/resume`, { path: whole.path + ".nope" });
    assert.ok(!bad.ok && bad.code === "INVALID", JSON.stringify(bad));
  }

  step("going back to a message, with a summary, starts the chat again; the branch left is listed, and switching back to it");
  {
    const users = (items: ChatItem[]) => items.flatMap((x) => (x.kind === "user" ? [x.text] : []));
    const before = users(chat.items);
    const last = chat.items.findLast((x) => x.kind === "user")!;
    let seen = resets;
    let r = await post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/tree`, { entryId: last.entryId, summarize: true });
    assert.deepEqual(r.ok && r.result, { kind: "accepted" }, JSON.stringify(r));
    await until("the chat gone back", (items) => resets > seen && !chat.loading && items.at(-1)?.kind === "branchSummary");
    assert.deepEqual(users(chat.items), before.slice(0, -1));
    const b = await post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/branches`);
    assert.ok(b.ok && b.result.kind === "tree", JSON.stringify(b));
    const branches = b.ok && b.result.kind === "tree" ? b.result.branches : [];
    assert.deepEqual(branches.map((x) => [x.current, x.prompt]), [[true, before.at(-2)], [false, before.at(-1)]]);
    assert.ok(branches[1].modified > 0 && branches[1].messages > 0);
    seen = resets;
    r = await post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/tree`, { entryId: branches[1].leafId });
    assert.deepEqual(r.ok && r.result, { kind: "accepted" }, JSON.stringify(r));
    await until("the branch left, again", (items) => resets > seen && !chat.loading && users(items).length === before.length);
    assert.deepEqual(users(chat.items), before);
  }

  step("reload keeps the chat; prompts run again once pi is back");
  {
    const seen = resets;
    const r = await post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/reload`);
    assert.deepEqual(r.ok && r.result, { kind: "accepted" }, JSON.stringify(r));
    // Requests are answered BUSY until pi has reloaded.
    let p = await post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/prompt`, { text: "after reload" });
    for (let i = 0; i < 50 && !p.ok && p.code === "BUSY"; i++) {
      await sleep(200);
      p = await post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/prompt`, { text: "after reload" });
    }
    assert.deepEqual(p.ok && p.result, { kind: "accepted" }, JSON.stringify(p));
    await until("the reply after reload", (items) => items.some((x) => x.kind === "user" && x.text === "after reload")
      && items.at(-1)?.kind === "assistant" && !(items.at(-1) as { streaming?: boolean }).streaming);
    assert.equal(resets, seen, "the chat was not reset");
  }

  step("a command's exit status, and an edit's diff");
  {
    const tools = () => chat.items.filter((x): x is Extract<ChatItem, { kind: "tool" }> => x.kind === "tool");
    await until("the last reply", (items) => items.at(-1)?.kind === "assistant" && !session?.working);
    await post(`/api/sessions/${encodeURIComponent(id)}/prompt`, { text: "run failing" });
    await until("the failed command", () => tools().some((x) => x.result?.exitCode === 3));
    assert.equal(tools().find((x) => x.result?.exitCode === 3)!.result!.isError, true);
    await until("its reply", (items) => items.at(-1)?.kind === "assistant" && !session?.working);
    writeFileSync(join(pi.work, "notes.txt"), "first\nold line\nlast\n");
    await post(`/api/sessions/${encodeURIComponent(id)}/prompt`, { text: "make an edit" });
    await until("the edit", () => tools().some((x) => x.name === "edit" && x.result !== undefined));
    const edited = tools().find((x) => x.name === "edit")!.result!;
    assert.equal(edited.isError, false, edited.text);
    assert.match(edited.diff ?? "", /^-old line$/m);
    assert.match(edited.diff ?? "", /^\+new line$/m);
    assert.equal(edited.exitCode, undefined);
    await until("its reply", (items) => items.at(-1)?.kind === "assistant" && !session?.working);
  }

  step("an image in a prompt reaches pi, and its copy is shown from the server");
  {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const r = await post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/prompt`, { text: "look", images: [{ mimeType: "image/png", data: png }] });
    assert.ok(r.ok, JSON.stringify(r));
    await until("pi's copy with its image", (items) => items.some((x) => x.kind === "user" && x.text.startsWith("look") && x.images.length === 1));
    const it = chat.items.find((x): x is Extract<ChatItem, { kind: "user" }> => x.kind === "user" && x.text.startsWith("look"))!;
    assert.ok(it.images[0].key, JSON.stringify(it));
    const img = await http(`/api/images/${it.images[0].key}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), it.images[0].mimeType);
    assert.ok((await img.arrayBuffer()).byteLength > 0);
    await until("its reply", (items) => items.at(-1)?.kind === "assistant" && !session?.working);
  }

  step("pi's questions: asked in the terminal and of the app; the app's answer closes the terminal's dialog, and the terminal's takes the question back");
  {
    const answers = () => {
      const f = join(pi.work, "answers.log");
      return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n") : [];
    };
    const asked = async (kind: string) => {
      await until(`a ${kind} question`, () => session?.questions?.[0]?.kind === kind);
      return session!.questions![0];
    };
    const answer = (questionId: string, body: object) =>
      post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/answer`, { questionId, ...body });
    // The extension has its answer, the question has gone, and the turn
    // it held up has started and finished.
    const settled = async (n: number) => {
      for (let i = 0; i < 100 && answers().length < n; i++) await sleep(100);
      await prompted;
      await until("the question gone and the turn done", (items) => !session?.questions?.length && !session?.working
        && items.at(-1)?.kind === "assistant" && !(items.at(-1) as { streaming: boolean }).streaming);
    };
    // The prompt is answered once its run starts, after the question.
    let prompted: Promise<void> = Promise.resolve();
    const ask = async (kind: string) => {
      await prompted;
      prompted = post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/prompt`, { text: `ask ${kind}` }).then((r) => assert.ok(r.ok, JSON.stringify(r)));
    };

    await ask("select");
    let q = await asked("select");
    assert.deepEqual([q.title, q.options, q.answerable], ["Which colour?", ["red", "green", "blue"], true]);
    assert.match(pi.screen(), /Which colour\?/);
    const bad = await answer(q.id, { option: 7 });
    assert.equal(!bad.ok && bad.code, "INVALID", JSON.stringify(bad));
    assert.ok((await answer(q.id, { option: 1 })).ok);
    await settled(1);
    assert.deepEqual(answers(), ['select="green"']);
    assert.doesNotMatch(pi.screen(), /Which colour\?/, "the terminal's dialog is still open");

    await ask("confirm");
    q = await asked("confirm");
    assert.equal(q.message, "14 files go.");
    assert.ok((await answer(q.id, { confirmed: false })).ok);
    await settled(2);
    await ask("input");
    q = await asked("input");
    assert.equal(q.placeholder, "e.g. fix/login");
    assert.ok((await answer(q.id, { text: "fix/e2e" })).ok);
    await settled(3);
    await ask("input");
    q = await asked("input");
    assert.ok((await answer(q.id, { dismissed: true })).ok);
    await settled(4);
    assert.deepEqual(answers().slice(1), ["confirm=false", 'input="fix/e2e"', "input=null"]);

    // Answered in the terminal first: the app's answer comes too late.
    await ask("confirm");
    q = await asked("confirm");
    pi.keys("Enter");
    await settled(5);
    assert.equal(answers()[4], "confirm=true");
    const late = await answer(q.id, { confirmed: false });
    assert.equal(!late.ok && late.code, "INVALID");

    // An editor waits in the terminal only.
    await ask("editor");
    q = await asked("editor");
    assert.equal(q.answerable, false);
    const refused = await answer(q.id, { text: "x" });
    assert.equal(!refused.ok && refused.code, "INVALID");
    pi.keys("Escape");
    await settled(6);
    assert.equal(answers()[5], "editor=null");
    await prompted;
  }

  step("a new agent opens beside pi, in a folder of the host's, in a window named as asked, and announces its launch; stopping it ends it");
  {
    type Snap = { sessions: SessionView[] };
    const snapshot = async () => (await (await http("/api/snapshot")).json()) as Snap;
    assert.equal((await snapshot()).sessions.find((x) => x.id === id)?.launcher, "test");
    const bad = await post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/launch`, { cwd: join(pi.work, "missing") });
    assert.equal(!bad.ok && bad.code, "INVALID", JSON.stringify(bad));
    const requestId = "e2e-launch-0000000001";
    const r = await post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/launch`, { cwd: pi.work, name: "e2e #new", requestId });
    assert.deepEqual(r.ok && r.result, { kind: "accepted" }, JSON.stringify(r));
    let launched: SessionView | undefined;
    for (let i = 0; i < 150 && !launched; i++) {
      launched = (await snapshot()).sessions.find((x) => x.launchId === requestId);
      if (!launched) await sleep(100);
    }
    assert.ok(launched, "the new agent did not connect");
    assert.equal(launched.place?.group, session.place?.group);
    assert.equal(launched.place?.window, "e2e #new");
    assert.notEqual(launched.id, id);
    const stop = await post<Outcome>(`/api/sessions/${encodeURIComponent(launched.id)}/stop`);
    assert.ok(stop.ok || stop.code === "SESSION_GONE", JSON.stringify(stop));
    let gone = false;
    for (let i = 0; i < 100 && !gone; i++) {
      gone = !(await snapshot()).sessions.some((x) => x.id === launched!.id);
      if (!gone) await sleep(100);
    }
    assert.ok(gone, "the stopped agent is still listed");
    assert.ok((await snapshot()).sessions.some((x) => x.id === id), "the first pi went too");
  }

  step("a finished turn notifies a subscribed browser, through its push service, unless a page shows the chat");
  {
    const service = await startPushService({ cert: readFileSync(cert), key: readFileSync(web.key!) });
    h.onCleanup(() => service.close());
    const sub = service.subscription("/phone");
    assert.equal((await post<{ ok: boolean }>("/api/push/subscribe", { subscription: sub })).ok, true);
    const tested = await post<{ ok: boolean; message?: string }>("/api/push/test", { endpoint: sub.endpoint });
    assert.ok(tested.ok, tested.message);
    assert.equal(JSON.parse(service.got[0].text).tag, "test");

    // A pi of its own: this test's stream shows the first one's chat.
    type Snap = { id: string; sessions: SessionView[]; chat?: ChatView };
    const snapshot = async (chat?: string) => (await (await http(`/api/snapshot${chat ? `?chat=${encodeURIComponent(chat)}` : ""}`)).json()) as Snap;
    const requestId = "e2e-launch-0000000002";
    assert.ok((await post<Outcome>(`/api/sessions/${encodeURIComponent(id)}/launch`, { cwd: pi.work, requestId })).ok);
    let other: SessionView | undefined;
    for (let i = 0; i < 150 && !other; i++) {
      other = (await snapshot()).sessions.find((x) => x.launchId === requestId);
      if (!other) await sleep(100);
    }
    assert.ok(other, "the new agent did not connect");
    const oid = other.id;
    const prompt = async (t: string) => assert.ok((await post<Outcome>(`/api/sessions/${encodeURIComponent(oid)}/prompt`, { text: t })).ok);

    await prompt("notify me");
    for (let i = 0; i < 150 && service.got.length < 2; i++) await sleep(100);
    assert.equal(service.got.length, 2, "nothing was pushed");
    const n = JSON.parse(service.got[1].text) as { title: string; body: string; url: string; tag: string };
    const reply = [...(await snapshot(oid)).chat!.items].reverse().find((x) => x.kind === "assistant")!;
    const said = text(reply).replace(/\s+/g, " ").trim();
    assert.ok(said.length > 0);
    assert.equal(n.body, said.length > 120 ? `${said.slice(0, 119).trimEnd()}…` : said);
    assert.equal(n.url, `/s/${encodeURIComponent(oid)}`);
    assert.equal(n.title, `notify me · e2e-host`);
    assert.equal(service.got[1].headers["content-encoding"], "aes128gcm");

    // A page showing the chat: nothing.
    const page = await http(`/api/events?chat=${encodeURIComponent(oid)}&after=${(await snapshot()).id}`);
    await prompt("watching");
    let done = false;
    for (let i = 0; i < 150 && !done; i++) {
      const s = await snapshot(oid);
      done = s.chat!.items.filter((x) => x.kind === "assistant" && !x.streaming).length >= 2 && !s.sessions.find((x) => x.id === oid)!.working;
      if (!done) await sleep(100);
    }
    assert.ok(done, "the second turn did not finish");
    await sleep(500);
    assert.equal(service.got.length, 2, "notified while a page showed the chat");
    await page.body!.cancel();
    assert.ok((await post<{ ok: boolean }>("/api/push/unsubscribe", { endpoint: sub.endpoint })).ok);
    assert.ok((await post<Outcome>(`/api/sessions/${encodeURIComponent(oid)}/stop`)).ok);
  }

  step("a machine without a token asks to join; approved in the app, its session appears");
  {
    await startPi(h, relay, "", "newcomer");
    type Snap = { sessions: SessionView[]; pendingHosts: { key: string; label: string }[] };
    let asking: Snap["pendingHosts"][number] | undefined;
    for (let i = 0; i < 100 && !asking; i++) {
      const snap = await (await http("/api/snapshot")).json() as Snap;
      asking = snap.pendingHosts.find((x) => x.label === "e2e-newcomer");
      if (!asking) await sleep(100);
    }
    assert.ok(asking, "no host asking");
    // The key the relay's command shows, which the person compares.
    assert.match(relay.cmd("pending"), new RegExp(asking.key));
    const r = await post<{ ok: boolean }>("/api/hosts/approve", { key: asking.key, label: "e2e-new" });
    assert.deepEqual(r.ok, true, JSON.stringify(r));
    assert.deepEqual((await (await http("/api/snapshot")).json() as Snap).pendingHosts, []);
    assert.match(relay.cmd("list"), /e2e-new/);
    // The host asks again every 10 seconds.
    let joined: SessionView | undefined;
    for (let i = 0; i < 150 && !joined; i++) {
      const snap = await (await http("/api/snapshot")).json() as Snap;
      joined = snap.sessions.find((x) => x.hostLabel === "e2e-new");
      if (!joined) await sleep(100);
    }
    assert.ok(joined, "the approved host's session did not appear");
    const again = await post<{ ok: boolean; code?: string }>("/api/hosts/reject", { key: asking.key });
    assert.equal(again.code, "INVALID", JSON.stringify(again));
  }

  step("the devices are listed, this server's own marked; renamed in the app, a host's live session shows the new name");
  {
    type Device = { key: string; role: string; label: string; online: boolean; self: boolean };
    type Snap = { sessions: SessionView[]; devices: Device[] };
    const snap = await (await http("/api/snapshot")).json() as Snap;
    const host = snap.devices.find((d) => d.label === "e2e-new");
    assert.ok(host && host.role === "host" && host.online && !host.self, JSON.stringify(snap.devices));
    assert.ok(snap.devices.some((d) => d.role === "client" && d.self && d.online), JSON.stringify(snap.devices));
    const r = await post<{ ok: boolean }>("/api/devices/rename", { key: host.key, label: "e2e-renamed" });
    assert.equal(r.ok, true, JSON.stringify(r));
    // The answer comes after the list and the sessions under the new name.
    const after = await (await http("/api/snapshot")).json() as Snap;
    assert.equal(after.devices.find((d) => d.key === host.key)?.label, "e2e-renamed");
    assert.ok(after.sessions.some((x) => x.hostLabel === "e2e-renamed"), "the session kept its old host name");
    assert.ok(!after.sessions.some((x) => x.hostLabel === "e2e-new"));
    assert.match(relay.cmd("list"), /e2e-renamed/);
    // Removing the server's own key would cut every browser off.
    const own = snap.devices.find((d) => d.self)!;
    const refused = await post<{ ok: boolean; code?: string }>("/api/devices/remove", { key: own.key });
    assert.deepEqual([refused.ok, refused.code], [false, "PERMISSION_DENIED"]);
    assert.ok(relay.cmd("list").includes(own.key), "the server's key is still registered");
  }

  step("a token made in the app enrols a machine under the name given");
  {
    const r = await post<{ ok: boolean; token: string; relay: string; expiresAt: number }>("/api/devices/invite", { role: "host", label: "e2e-named" });
    assert.ok(r.ok && r.token && r.relay === relay.url, JSON.stringify(r));
    assert.ok(Math.abs(r.expiresAt - Date.now() - 15 * 60_000) < 60_000, `expires ${r.expiresAt}`);
    await startPi(h, relay, r.token, "invited");
    let joined: SessionView | undefined;
    for (let i = 0; i < 150 && !joined; i++) {
      joined = ((await (await http("/api/snapshot")).json()) as { sessions: SessionView[] }).sessions.find((x) => x.hostLabel === "e2e-named");
      if (!joined) await sleep(100);
    }
    // Under the token's name, not the one the machine gives (e2e-invited).
    assert.ok(joined, "the invited machine's session did not appear");
  }

  step("the server is still up, after streaming over HTTP/2");
  assert.ok(web.running(), web.log());
  assert.match((await http("/third-party-licenses.txt")).status.toString(), /^200$/);

  step("the prompts reached pi's terminal");
  // The last the app sent; earlier ones have scrolled away.
  assert.match(pi.screen(), /ask editor/);

  step("revoking the passkey signs it out");
  cli("revoke", "e2e-phone");
  assert.equal((await http("/api/snapshot")).status, 401);
} catch (e) {
  failure = e;
} finally {
  await h.close();
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
console.log("ok: web app end to end");
