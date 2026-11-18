// Signed objects (docs/e2e.md, section 2): a body as its signer encoded
// it, the signer's key, and an Ed25519 signature over framed("pirc-e2e-v1
// <kind>", account ID, body). Verified on those bytes before the body is
// parsed; never encoded again.

import { fromBinary, toBinary, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import {
  AnnouncementBodySchema,
  BundleBodySchema,
  EnvelopeBodySchema,
  JoinDeviceBodySchema,
  LabelKeyWrapBodySchema,
  LabelsBodySchema,
  ListVersionBodySchema,
  PreKeyBodySchema,
  SignedObjectSchema,
  WithdrawalBodySchema,
  type SignedObject,
} from "@pirc/protocol/v1alpha2";
import { create } from "@bufbuild/protobuf";
import { equal, framed } from "./bytes.ts";
import { verify, type Signer } from "./ed25519.ts";
import { sha256 } from "./hpke.ts";

/** Each kind of signed object: its context, its body, and which field names its signer. */
export const KINDS = {
  list: { schema: ListVersionBodySchema, signer: (b: MessageShape<typeof ListVersionBodySchema>) => b.signer },
  withdrawal: { schema: WithdrawalBodySchema, signer: (b: MessageShape<typeof WithdrawalBodySchema>) => b.signer },
  "pre-key": { schema: PreKeyBodySchema, signer: (b: MessageShape<typeof PreKeyBodySchema>) => b.signer },
  "label-key": { schema: LabelKeyWrapBodySchema, signer: (b: MessageShape<typeof LabelKeyWrapBodySchema>) => b.signer },
  labels: { schema: LabelsBodySchema, signer: (b: MessageShape<typeof LabelsBodySchema>) => b.signer },
  bundle: { schema: BundleBodySchema, signer: (b: MessageShape<typeof BundleBodySchema>) => b.hostKey },
  announcement: {
    schema: AnnouncementBodySchema,
    signer: (b: MessageShape<typeof AnnouncementBodySchema>) => b.session?.hostKey ?? new Uint8Array(0),
  },
  request: { schema: EnvelopeBodySchema, signer: (b: MessageShape<typeof EnvelopeBodySchema>) => b.signer },
  join: { schema: JoinDeviceBodySchema, signer: (b: MessageShape<typeof JoinDeviceBodySchema>) => b.publicKey },
} as const;

export type Kind = keyof typeof KINDS;
type Body<K extends Kind> = MessageShape<(typeof KINDS)[K]["schema"]>;

export const context = (kind: Kind): string => `pirc-e2e-v1 ${kind}`;

export function signedBytes(kind: Kind, accountId: Uint8Array, body: Uint8Array): Uint8Array {
  return framed(context(kind), accountId, body);
}

/** Encodes the body once, and signs those bytes. */
export async function sign<K extends Kind>(kind: K, accountId: Uint8Array, signer: Signer, body: Body<K>): Promise<SignedObject> {
  const schema = KINDS[kind].schema as DescMessage;
  const bytes = toBinary(schema, body as never);
  if (!equal(KINDS[kind].signer(body as never), signer.publicKey)) throw new Error(`the ${kind}'s signer field is not the signing key`);
  return create(SignedObjectSchema, {
    body: bytes,
    signature: await signer.sign(signedBytes(kind, accountId, bytes)),
    signer: signer.publicKey,
  });
}

/** The body, if the signature checks and the body names the same signer; otherwise null. */
export async function open<K extends Kind>(kind: K, accountId: Uint8Array, obj: SignedObject): Promise<Body<K> | null> {
  if (!(await verify(obj.signer, signedBytes(kind, accountId, obj.body), obj.signature))) return null;
  let body: Body<K>;
  try {
    body = fromBinary(KINDS[kind].schema as DescMessage, obj.body) as Body<K>;
  } catch {
    return null;
  }
  return equal(KINDS[kind].signer(body as never), obj.signer) ? body : null;
}

/** SHA-256 of the body: a version's hash, and version 1's is the account ID. */
export const hash = (obj: SignedObject): Promise<Uint8Array> => sha256(obj.body);

export const encode = (obj: SignedObject): Uint8Array => toBinary(SignedObjectSchema, obj);
export const decode = (b: Uint8Array): SignedObject => fromBinary(SignedObjectSchema, b);
