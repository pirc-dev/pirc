// The hosted relay's protocol, v1alpha2 (docs/e2e.md), apart from index.ts
// since its frames share v1alpha1's names. SessionRef and Error stay
// v1alpha1's, as does session.proto. account.proto's messages are the
// bodies a hosted account's devices sign or seal; e2e/ checks the list.
export * from "./gen/pirc/v1alpha2/relay_pb.ts";
export * from "./gen/pirc/v1alpha2/account_pb.ts";
export * from "./gen/pirc/v1alpha2/channel_pb.ts";
