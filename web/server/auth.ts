// Signing in to the web app (docs/web.md, section 2): passkeys, made
// through one-time pairing links, and the sessions a sign-in starts.
//
// The passkeys and the pairing tokens are in auth.json, which the command
// line writes while the server runs (pair, revoke); the server reads it
// again whenever it changed. Sessions are in memory only: a restart signs
// everyone out, and the next Face ID signs them in again.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

// A sign-in lasts while it is used, and ends this long after the last use.
export const IDLE_MS = 30 * 60_000;
// How long a pairing link works.
export const PAIR_TTL_MS = 10 * 60_000;
// How long a passkey prompt may stay open.
const CHALLENGE_MS = 5 * 60_000;

export interface Passkey {
  // The credential's ID, base64url.
  id: string;
  label: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  createdAt: string;
  lastUsedAt?: string;
}

interface PairToken {
  // SHA-256 of the token, hex; the token itself is only in the link.
  hash: string;
  label: string;
  expiresAt: string;
}

interface AuthFile {
  // The one user's WebAuthn user handle, base64url: one relay is one
  // account (design section 5.6).
  userId: string;
  passkeys: Passkey[];
  pairTokens: PairToken[];
}

export interface Session {
  passkeyId: string;
  lastUsed: number;
}

export class AuthError extends Error {}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

// auth.json, read and written atomically.
export class AuthStore {
  private cache: { mtimeMs: number; size: number; data: AuthFile } | undefined;

  constructor(readonly path: string) {}

  load(): AuthFile {
    let st;
    try {
      st = statSync(this.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return { userId: "", passkeys: [], pairTokens: [] };
    }
    if (this.cache && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) return this.cache.data;
    const data = JSON.parse(readFileSync(this.path, "utf8")) as AuthFile;
    this.cache = { mtimeMs: st.mtimeMs, size: st.size, data };
    return data;
  }

  update(fn: (d: AuthFile) => void): AuthFile {
    const d = structuredClone(this.load());
    if (!d.userId) d.userId = b64url(randomBytes(32));
    fn(d);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(d, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.path);
    this.cache = undefined;
    return d;
  }

  // A one-time pairing token for a new passkey, labelled for the list.
  issuePairToken(label: string, now = Date.now()): string {
    const token = b64url(randomBytes(32));
    this.update((d) => {
      d.pairTokens = d.pairTokens.filter((t) => Date.parse(t.expiresAt) > now);
      d.pairTokens.push({ hash: sha256(token), label, expiresAt: new Date(now + PAIR_TTL_MS).toISOString() });
    });
    return token;
  }

  // The pairing token's entry, if it is live; it is not used up.
  pairToken(token: string, now = Date.now()): PairToken | undefined {
    const h = sha256(token);
    return this.load().pairTokens.find((t) => sameHex(t.hash, h) && Date.parse(t.expiresAt) > now);
  }

  passkeys(): Passkey[] {
    return this.load().passkeys;
  }

  // Removes the passkey whose ID or label is given; returns it.
  revoke(which: string): Passkey | undefined {
    let gone: Passkey | undefined;
    this.update((d) => {
      const matches = d.passkeys.filter((p) => p.id === which || p.label === which);
      if (matches.length > 1) throw new AuthError(`more than one passkey is labelled ${which}; give its ID`);
      gone = matches[0];
      d.passkeys = d.passkeys.filter((p) => p !== gone);
    });
    return gone;
  }
}

export interface Relying {
  // The app's origin, e.g. "https://pirc.example"; its host name is the
  // passkeys' relying party ID.
  origin: string;
  name: string;
}

// Passkey ceremonies and sign-in sessions, for the HTTP server.
export class Auth {
  // Challenges handed out and not yet used: base64url → what for.
  private challenges = new Map<string, { kind: "register" | "login"; tokenHash?: string; expires: number }>();
  // Sessions by the SHA-256 of their cookie's secret.
  private sessions = new Map<string, Session>();
  readonly rpID: string;

  constructor(readonly store: AuthStore, readonly rp: Relying, private readonly now = () => Date.now()) {
    this.rpID = new URL(rp.origin).hostname;
  }

  private remember(challenge: string, v: { kind: "register" | "login"; tokenHash?: string }): void {
    const now = this.now();
    for (const [c, x] of this.challenges) if (x.expires <= now) this.challenges.delete(c);
    this.challenges.set(challenge, { ...v, expires: now + CHALLENGE_MS });
  }

  private take(challenge: string, kind: "register" | "login"): { tokenHash?: string } | undefined {
    const c = this.challenges.get(challenge);
    if (!c || c.kind !== kind || c.expires <= this.now()) return undefined;
    this.challenges.delete(challenge);
    return c;
  }

  // --- Pairing: a new passkey -------------------------------------------------

  async registrationOptions(token: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const t = this.store.pairToken(token, this.now());
    if (!t) throw new AuthError("this pairing link is used up or has expired; make another with pirc-web pair");
    const d = this.store.load().userId ? this.store.load() : this.store.update(() => {});
    const options = await generateRegistrationOptions({
      rpName: this.rp.name,
      rpID: this.rpID,
      userName: "PiRC",
      userID: Buffer.from(d.userId, "base64url"),
      attestationType: "none",
      excludeCredentials: d.passkeys.map((p) => ({ id: p.id, transports: p.transports })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    this.remember(options.challenge, { kind: "register", tokenHash: t.hash });
    return options;
  }

  // Verifies a new passkey, uses up its pairing token and signs it in;
  // returns the session cookie's secret.
  async register(response: RegistrationResponseJSON): Promise<string> {
    let pending: { tokenHash?: string } | undefined;
    const v = await verifyRegistrationResponse({
      response,
      expectedChallenge: (c) => (pending = this.take(c, "register")) !== undefined,
      expectedOrigin: this.rp.origin,
      expectedRPID: this.rpID,
      requireUserVerification: true,
    });
    if (!v.verified || !pending?.tokenHash) throw new AuthError("the passkey could not be verified");
    const cred = v.registrationInfo.credential;
    const tokenHash = pending.tokenHash;
    const now = this.now();
    this.store.update((d) => {
      const t = d.pairTokens.find((x) => sameHex(x.hash, tokenHash) && Date.parse(x.expiresAt) > now);
      if (!t) throw new AuthError("this pairing link was used up meanwhile");
      d.pairTokens = d.pairTokens.filter((x) => x !== t);
      d.passkeys.push({
        id: cred.id,
        label: t.label,
        publicKey: b64url(cred.publicKey),
        counter: cred.counter,
        ...(cred.transports ? { transports: cred.transports } : {}),
        createdAt: new Date(now).toISOString(),
      });
    });
    return this.startSession(cred.id);
  }

  // --- Signing in with a passkey -----------------------------------------------

  async authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    // No allow list: the passkey is discoverable, and the browser offers it.
    const options = await generateAuthenticationOptions({ rpID: this.rpID, userVerification: "required" });
    this.remember(options.challenge, { kind: "login" });
    return options;
  }

  async authenticate(response: AuthenticationResponseJSON): Promise<string> {
    const p = this.store.passkeys().find((x) => x.id === response.id);
    if (!p) throw new AuthError("this passkey is not known here: it may have been revoked");
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: (c) => this.take(c, "login") !== undefined,
      expectedOrigin: this.rp.origin,
      expectedRPID: this.rpID,
      credential: { id: p.id, publicKey: Buffer.from(p.publicKey, "base64url"), counter: p.counter, transports: p.transports },
      requireUserVerification: true,
    });
    if (!v.verified) throw new AuthError("the passkey could not be verified");
    const now = new Date(this.now()).toISOString();
    this.store.update((d) => {
      const x = d.passkeys.find((y) => y.id === p.id);
      if (!x) throw new AuthError("this passkey was revoked meanwhile");
      x.counter = v.authenticationInfo.newCounter;
      x.lastUsedAt = now;
    });
    return this.startSession(p.id);
  }

  // --- Sessions --------------------------------------------------------------

  private startSession(passkeyId: string): string {
    const secret = b64url(randomBytes(32));
    this.sessions.set(sha256(secret), { passkeyId, lastUsed: this.now() });
    return secret;
  }

  // The session a cookie's secret holds, if it is live and its passkey is
  // still there. touch: this request counts as use.
  session(secret: string | undefined, touch: boolean): Session | undefined {
    if (!secret) return undefined;
    const key = sha256(secret);
    const s = this.sessions.get(key);
    if (!s) return undefined;
    const now = this.now();
    if (now - s.lastUsed >= IDLE_MS || !this.store.passkeys().some((p) => p.id === s.passkeyId)) {
      this.sessions.delete(key);
      return undefined;
    }
    if (touch) s.lastUsed = now;
    return s;
  }

  endSession(secret: string | undefined): void {
    if (secret) this.sessions.delete(sha256(secret));
  }
}
