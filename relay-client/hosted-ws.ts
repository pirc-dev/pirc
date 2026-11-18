// The hosted connection's socket in Node (hosted.ts): ws, which pings, so
// that an idle host notices a dead connection.
import WebSocket from "ws";

import type { OpenSocket } from "./hosted.ts";

export const wsSocket: OpenSocket = (url, on) => {
  const ws = new WebSocket(url, { handshakeTimeout: 10_000, perMessageDeflate: false });
  ws.binaryType = "nodebuffer";
  ws.on("open", () => on.open());
  ws.on("pong", () => on.pong());
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (!isBinary) on.error("relay sent a text frame");
    else on.message(new Uint8Array(data));
  });
  ws.on("close", (code: number, reason: Buffer) => on.close(code, reason.toString()));
  ws.on("error", (err: Error) => on.error(err.message));
  return {
    send: (d) => ws.send(d),
    close: () => {
      ws.removeAllListeners();
      ws.on("error", () => {});
      ws.terminate();
    },
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    ping: () => ws.ping(),
  };
};
