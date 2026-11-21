// A stand-in for herdr's socket: it reads one request, answers it and closes
// the connection, as herdr's src/api/server.rs does.
import { createServer, type Server } from "node:net";

export function oneShotHerdr(answer: (req: { id: string; method: string; params: Record<string, unknown> }) => object): Server {
  return createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      const req = JSON.parse(buf.slice(0, i)) as { id: string; method: string; params: Record<string, unknown> };
      c.end(`${JSON.stringify({ id: req.id, result: answer(req) })}\n`);
    });
  });
}
