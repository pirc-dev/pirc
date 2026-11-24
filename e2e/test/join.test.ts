import assert from "node:assert/strict";
import { test } from "node:test";

import { create, toBinary } from "@bufbuild/protobuf";
import { DeviceSchema, JoinOfferSchema } from "@pirc/protocol/v1alpha2";
import sodium from "libsodium-wrappers-sumo";

import { base32, checkOffer, fromBase32, JOIN_TEXT_CHARS, joinPrologue, joinText, makeOffer, readJoinText } from "../join.ts";
import { ROLE_CLIENT, ROLE_COMPUTER } from "../list.ts";
import { device, signingPair } from "./make.ts";

await sodium.ready;

test("base32: Crockford's alphabet, most significant bit first, spare bits zero", () => {
  assert.equal(base32(Uint8Array.of()), "");
  assert.equal(base32(Uint8Array.of(0xff)), "ZW");
  assert.equal(base32(Uint8Array.of(0, 0, 0, 0, 1)), "00000001");
  assert.equal(base32(Uint8Array.of(0xde, 0xad, 0xbe, 0xef, 0x42)), "VTPVXVT2");
  assert.deepEqual(fromBase32("VTPVXVT2", 5), Uint8Array.of(0xde, 0xad, 0xbe, 0xef, 0x42));
  assert.equal(fromBase32("ZX", 1), undefined, "spare bits set");
  assert.equal(fromBase32("ZU", 1), undefined, "U is not in the alphabet");
  assert.equal(fromBase32("ZW0", 1), undefined, "the length");
  for (let n = 0; n < 40; n++) {
    const b = sodium.randombytes_buf(n);
    assert.deepEqual(fromBase32(base32(b), n), b);
  }
});

test("the join's text: PIRC1, the lookup, the secret; 65 characters", () => {
  const secret = Uint8Array.from({ length: 32 }, (_, i) => i);
  const text = joinText("VTPVXVT2", secret);
  assert.equal(text, "PIRC1VTPVXVT2000G40R40M30E209185GR38E1W8124GK2GAHC5RR34D1P70X3RFG");
  assert.equal(text.length, JOIN_TEXT_CHARS);
  const want = { lookup: "VTPVXVT2", secret };
  assert.deepEqual(readJoinText(text), want);
  assert.deepEqual(readJoinText(text.toLowerCase()), want);
  assert.deepEqual(readJoinText(` ${text.slice(0, 20)}-${text.slice(20, 40)} ${text.slice(40)}\n`), want);
  assert.deepEqual(readJoinText(`https://pirc.dev/join#${text}`), want);
  for (const bad of [text.slice(1), `${text}0`, `PIRC2${text.slice(5)}`, `${text.slice(0, 64)}Z`, `${text.slice(0, 10)}U${text.slice(11)}`, ""]) {
    assert.equal(readJoinText(bad), undefined, bad);
  }
  assert.throws(() => joinText("VTPVXVT", secret));
  assert.throws(() => joinText("VTPVXVT2", secret.subarray(1)));
});

test("the prologue: framed(context, version 1, the lookup)", () => {
  const p = joinPrologue("VTPVXVT2");
  const ctx = new TextEncoder().encode("pirc-e2e-v2 join");
  assert.deepEqual(p.subarray(0, ctx.length), ctx);
  assert.deepEqual(p.subarray(ctx.length), Uint8Array.of(0, 8, 0, 0, 0, 0, 0, 0, 0, 1, 8, ...new TextEncoder().encode("VTPVXVT2")));
});

test("an offer: signed over the handshake, its channel key the one proved, of the role expected", () => {
  const hh = sodium.randombytes_buf(64);
  const C = device("joining computer", ROLE_COMPUTER, false);
  const P = device("joining phone", ROLE_CLIENT, true);
  const sign = (name: string) => (m: Uint8Array) => signingPair(name).sign(m);
  const offerC = makeOffer(C, hh, sign("joining computer"));
  const offerP = makeOffer(P, hh, sign("joining phone"));
  const check = (offer: Uint8Array, role: number, remote: Uint8Array, h = hh) => checkOffer(sodium, { offer, role, remoteStatic: remote, handshakeHash: h });
  assert.equal(check(offerC, ROLE_COMPUTER, C.channelKey).result, "accepted");
  assert.deepEqual(check(offerP, ROLE_CLIENT, P.channelKey), { result: "accepted", device: P });
  assert.deepEqual(check(offerC, ROLE_CLIENT, C.channelKey), { result: "refused", reason: "role" });
  assert.deepEqual(check(offerC, ROLE_COMPUTER, P.channelKey), { result: "refused", reason: "channel-key" });
  assert.deepEqual(check(offerC, ROLE_COMPUTER, C.channelKey, sodium.randombytes_buf(64)), { result: "refused", reason: "signature" });
  assert.deepEqual(check(makeOffer(C, hh, sign("someone else")), ROLE_COMPUTER, C.channelKey), { result: "refused", reason: "signature" });
  assert.deepEqual(check(Uint8Array.of(0xff), ROLE_COMPUTER, C.channelKey), { result: "refused", reason: "parse" });
  const forged = (d: typeof C) => toBinary(JoinOfferSchema, create(JoinOfferSchema, { device: create(DeviceSchema, d), signature: signingPair("joining computer").sign(new Uint8Array(0)) }));
  assert.deepEqual(check(forged({ ...C, boxKey: C.boxKey.subarray(1) }), ROLE_COMPUTER, C.channelKey), { result: "refused", reason: "key" });
  assert.deepEqual(check(forged({ ...C, readOnlyKey: P.readOnlyKey }), ROLE_COMPUTER, C.channelKey), { result: "refused", reason: "key" });
  assert.deepEqual(check(makeOffer({ ...P, notificationKey: new Uint8Array(0) }, hh, sign("joining phone")), ROLE_CLIENT, P.channelKey), { result: "refused", reason: "key" });
  // The signature covers every key: one changed after signing fails.
  const signed = makeOffer(P, hh, sign("joining phone"));
  const tampered = toBinary(JoinOfferSchema, create(JoinOfferSchema, { device: create(DeviceSchema, { ...P, boxKey: C.boxKey }), signature: signed.subarray(signed.length - 64) }));
  assert.deepEqual(check(tampered, ROLE_CLIENT, P.channelKey), { result: "refused", reason: "signature" });
});
