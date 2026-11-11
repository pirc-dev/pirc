// Proves the generated TypeScript and Go agree on the wire format.
//   node sh/roundtrip.ts encode    writes one binary Frame to stdout
//   node sh/roundtrip.ts compare   reads Go's JSON of it from stdin
import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { isDeepStrictEqual } from "node:util";
import { FrameSchema, SessionMessageSchema, Delivery } from "../protocol/index.ts";

const session = {
  hostKey: new Uint8Array(32).fill(7),
  sessionId: "01a15805-28bb-722e-84d0-9b79c9594d1a",
  instanceId: "i-4f1c",
};
const payload = create(SessionMessageSchema, {
  body: {
    case: "prompt",
    value: { requestId: "r-1", text: "héllo ✓", delivery: Delivery.FOLLOW_UP, images: [{ mimeType: "image/png", data: new Uint8Array([1, 2, 3]) }] },
  },
});
const frame = create(FrameSchema, {
  body: { case: "routed", value: { session, payload: toBinary(SessionMessageSchema, payload) } },
});
const event = create(SessionMessageSchema, {
  body: { case: "event", value: { seq: 18446744073709551615n, at: timestampFromDate(new Date(0)), body: { case: "workingChanged", value: { working: true } } } },
});

const expected = {
  frame: toJson(FrameSchema, frame),
  payload: toJson(SessionMessageSchema, payload),
  event: toJson(SessionMessageSchema, fromBinary(SessionMessageSchema, toBinary(SessionMessageSchema, event))),
};

if (process.argv[2] === "encode") {
  // Length-prefixed: frame, then event.
  for (const bytes of [toBinary(FrameSchema, frame), toBinary(SessionMessageSchema, event)]) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length);
    process.stdout.write(len);
    process.stdout.write(bytes);
  }
} else {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const got = JSON.parse(Buffer.concat(chunks).toString());
  if (!isDeepStrictEqual(got, expected)) {
    console.error("MISMATCH\nexpected:", JSON.stringify(expected, null, 2), "\ngot:", JSON.stringify(got, null, 2));
    process.exit(1);
  }
  console.log("ok: frame, payload and event identical in TypeScript and Go");
}
