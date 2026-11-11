// A scripted OpenAI-compatible chat model for the end-to-end test: pi talks
// to it through a models.json entry, so the test needs no real provider.
//
// The reply depends on the last user message:
//   "hello"  some streamed text
//   "tool"   a bash tool call, then text once the result comes back
//   "run failing"   a bash tool call that exits with 3
//   "make an edit"  an edit tool call, changing "old line" in notes.txt
//   "slow"   text streamed slowly, for aborting
//   "medium" text streamed over about a second, for prompts sent mid-run
//   "wait"   two seconds before the text, as a slow model takes
//   "table"  a five-column markdown table, for narrow screens
//   "markdown"  a reply with headings, emphasis, code, a list and a link
// and a summary for pi's compaction request, whatever it quotes; after
// three seconds when the conversation says "takes time".
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

type Msg = { role: string; content?: unknown };

function lastUser(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    if (m.role === "tool") return "<tool result>";
  }
  return "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startFakeModel(): Promise<{ url: string; server: Server }> {
  let calls = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body || "{}") as { messages?: Msg[] };
    const said = lastUser(request.messages ?? []);
    // pi's compaction requests have its summariser's system prompt.
    const system = request.messages?.find((m) => m.role === "system")?.content;
    const summarising = JSON.stringify(system ?? "").includes("summarization assistant");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta: object, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "fake-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const end = () => {
      res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "fake-1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    };
    let aborted = false;
    req.on("close", () => (aborted = true));
    if (summarising) {
      if (said.includes("takes time")) for (let i = 0; i < 30 && !aborted; i++) await sleep(100);
      send({ content: "Summary of the session so far." });
      send({}, "stop");
      return end();
    }
    if (said === "<tool result>") {
      for (const t of ["done", " with the tool"]) {
        send({ content: t });
        await sleep(20);
      }
      send({}, "stop");
      return end();
    }
    if (said.includes("markdown")) {
      const md = [
        "## The relay's two keys",
        "",
        "Each phone has a **main key** and a *read-only* key, kept in `KeyStore.kt`:",
        "",
        "1. the main key signs every request;",
        "2. the read-only key fetches the session list when a push wakes the phone.",
        "",
        "- Removing the phone removes both.",
        "- See [the design](https://example.com/design) for why.",
        "",
        "```sh",
        "pirc-relay list",
        "```",
      ].join("\n");
      for (const t of md.match(/[\s\S]{1,40}/g)!) {
        send({ content: t });
        await sleep(20);
      }
      send({}, "stop");
      return end();
    }
    if (said.includes("table")) {
      const md = [
        "Here is how the three options compare:",
        "",
        "| Option | Approach | Latency (p95) | Monthly cost | Notes |",
        "|---|---|---|---:|---|",
        "| A | Keep the relay where it is and add a second region | 120 ms | £14 | Simplest; no code change, but a second VM to look after |",
        "| B | `web/core/client.ts` reconnects through a WebSocket proxy | 85 ms | £0 | Needs the proxy to keep idle connections open for at least 10 minutes |",
        "| C | Move everything to Cloudflare Workers with Durable Objects | 40 ms | £5 | Largest rewrite; ties the product to one vendor |",
        "",
        "I would start with **B**.",
      ].join("\n");
      for (const t of md.match(/[\s\S]{1,40}/g)!) {
        send({ content: t });
        await sleep(20);
      }
      send({}, "stop");
      return end();
    }
    // Each call its own ID, as a real model gives them: a client keys
    // tool cards by it.
    const call = (name: string, args: object) => {
      send({ role: "assistant", tool_calls: [{ index: 0, id: `call_${++calls}`, type: "function", function: { name, arguments: "" } }] });
      send({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] });
      send({}, "tool_calls");
      return end();
    };
    if (said.includes("run failing")) return call("bash", { command: "echo about to fail; exit 3" });
    if (said.includes("make an edit")) return call("edit", { path: "notes.txt", edits: [{ oldText: "old line", newText: "new line" }] });
    if (said.includes("tool")) {
      send({ role: "assistant", tool_calls: [{ index: 0, id: `call_${++calls}`, type: "function", function: { name: "bash", arguments: "" } }] });
      send({ tool_calls: [{ index: 0, function: { arguments: '{"command":"echo pirc-tool-output"}' } }] });
      send({}, "tool_calls");
      return end();
    }
    if (said.includes("medium")) {
      for (let i = 0; i < 10 && !aborted; i++) {
        send({ content: `step${i} ` });
        await sleep(100);
      }
      send({}, "stop");
      return end();
    }
    if (said.includes("slow")) {
      for (let i = 0; i < 200 && !aborted; i++) {
        send({ content: `word${i} ` });
        await sleep(100);
      }
      send({}, "stop");
      return end();
    }
    if (said.includes("wait")) for (let i = 0; i < 20 && !aborted; i++) await sleep(100);
    for (const t of ["Hi", " there,", " from", " the fake", " model."]) {
      send({ content: t });
      await sleep(20);
    }
    send({}, "stop");
    end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, server };
}
