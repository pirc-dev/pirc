// One pi session as it is live on the relay: its announcement, its event
// stream and the requests clients send it (session.proto).
import { create, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  MessageUpdateEvent,
  SessionEntry,
  SessionInfo,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolExecutionUpdateEvent,
} from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { hostname } from "node:os";

import {
  accepted,
  CommandSource,
  Delivery,
  ErrorCode,
  HistorySchema,
  SessionAnnouncementSchema,
  SessionMessageSchema,
  SessionOrigin,
  thinkingLevel,
  ThinkingLevel,
  thinkingName,
  errorReply,
  requestName,
  type SessionEventSchema,
  type ConversationItem,
  type SessionAnnouncement,
  type SessionMessage,
  type Place,
  type Answer,
  type Question,
  type Notice,
} from "@pirc/protocol";

import {
  atIso,
  atMs,
  clip,
  compactionItem,
  count,
  firstLine,
  firstPrompt,
  fitItem,
  branches,
  historyItems,
  lastTurnId,
  messageItems,
  modelInfo,
  modelRef,
  promptText,
  sessionTotals,
  textOf,
  type AgentMessage,
} from "./convert.ts";
import { nextNumber, questionNotice, turnNotice } from "./notice.ts";
import { PHOTO_ENTRY, photosOf, preparePhotos, type PhotoData } from "./photos.ts";
import { launchEnv, launchFolder, launchName, piCommand, type Launcher } from "./launch.ts";

export interface Sink {
  // To every client attached to the session.
  broadcast(live: Live, m: SessionMessage): void;
  // To one client.
  reply(live: Live, clientKey: Uint8Array, m: SessionMessage): void;
  // The session's announcement changed.
  announce(live: Live): void;
  // Where the process runs, if known (place.ts).
  place(): Place | undefined;
  // What opens a new pi beside this one, if anything (launch.ts).
  launcher(): Launcher | undefined;
  // The dialogs pi is showing for extensions (questions.ts), and a
  // client's answer to one: why it cannot be taken, if so.
  questions(): Question[];
  answer(a: Answer): string | undefined;
  // The Launch that started this process, if one did.
  readonly launchId: string;
  // The largest payload a frame can carry now.
  maxPayloadBytes(): number;
  // An error of ours, caught so that it never reaches pi.
  fail(where: string, e: unknown): void;
}

// Answers one request; called once, possibly later than the request.
export type Respond = (reply: SessionMessage) => void;

const ORIGIN: Record<SessionStartEvent["reason"], SessionOrigin> = {
  startup: SessionOrigin.STARTUP,
  reload: SessionOrigin.RELOAD,
  new: SessionOrigin.NEW,
  resume: SessionOrigin.RESUME,
  fork: SessionOrigin.FORK,
};

// How long deltas are gathered before they are sent, and tool progress
// at most how often.
const DELTA_MS = 50;
const PROGRESS_MS = 250;
// A prompt not seen echoed as a user message within this time is
// forgotten (a command, or a prompt template that expanded).
const PROMPT_ECHO_MS = 10 * 60_000;
// How long a prompt sent to an idle pi may take to start a run before the
// client is told it timed out. pi refuses a prompt (no credentials, an
// input handler that consumed it) only on its own screen.
export const CONFIRM_MS = 30_000;
// How long a stopping pi waits for its answer to be sent before it exits.
const STOP_DELAY_MS = 300;
// How long a finished message may wait for pi to persist it before it is
// sent without an entry ID.
const PERSIST_MS = 2000;

// The roles pi persists as message entries, and PiRC shows as items. Any
// other (custom, bash, summaries) is stored differently or not at all, and
// waiting for its entry would hold up everything after it.
const SHOWN = new Set(["user", "assistant", "toolResult"]);

// The commands the extension registers to change the session: session
// control is open only to command handlers (docs/design.md, section 8). A
// client's request sends one as prompt text, and is answered when pi shuts
// the session down for the command's reason (Live.onShutdown), or for one
// that keeps the session (tree), when it has run (Live.onCommandRan). run
// gives why it failed, if it did; fork and resume check first what pi
// would refuse, since pi exits on most errors those meet (forkProblem,
// resumeProblem). Nothing may run after reload: pi has replaced the
// extension's runtime by then.
interface SessionCommand {
  name: string;
  description: string;
  reason?: SessionShutdownEvent["reason"];
  // The answer when pi neither shuts the session down nor fails; for a
  // command without a reason, when pi does not run it.
  timeout: string;
  run(args: string, ctx: ExtensionCommandContext): Promise<string | undefined>;
}

const cancelled = (what: string) => (r: { cancelled: boolean }) => (r.cancelled ? `another extension cancelled the ${what}` : undefined);

export const SESSION_COMMANDS = {
  new: {
    name: "pirc:new",
    description: "PiRC: start a new session (used by PiRC's clients)",
    reason: "new",
    timeout: "pi did not start a new session",
    run: async (_args, ctx) => cancelled("new session")(await ctx.newSession()),
  },
  // Before a user message, its entry ID the argument.
  fork: {
    name: "pirc:fork",
    description: "PiRC: fork before a user message (used by PiRC's clients)",
    reason: "fork",
    timeout: "pi did not fork the session",
    run: async (id, ctx) => forkProblem(ctx, id, "before") ?? cancelled("fork")(await ctx.fork(id)),
  },
  clone: {
    name: "pirc:clone",
    description: "PiRC: clone the session as it is (used by PiRC's clients)",
    reason: "fork",
    timeout: "pi did not clone the session",
    run: async (_args, ctx) => {
      const leaf = ctx.sessionManager.getLeafId() ?? "";
      return forkProblem(ctx, leaf, "at") ?? cancelled("clone")(await ctx.fork(leaf, { position: "at" }));
    },
  },
  // A saved session, its file the argument.
  resume: {
    name: "pirc:resume",
    description: "PiRC: resume a saved session (used by PiRC's clients)",
    reason: "resume",
    timeout: "pi did not resume the session",
    run: async (path, ctx) => (await resumeProblem(ctx, path)) ?? cancelled("resume")(await ctx.switchSession(path)),
  },
  // To an entry, its ID the argument, then "summarize" to summarise the
  // branch left first.
  tree: {
    name: "pirc:tree",
    description: "PiRC: move in the session tree (used by PiRC's clients)",
    timeout: "pi did not move in the session tree",
    run: async (args, ctx) => {
      const [id, summarize] = args.split(" ");
      return treeProblem(ctx, id) ?? cancelled("move in the session tree")(await ctx.navigateTree(id, { summarize: summarize === "summarize" }));
    },
  },
  reload: {
    name: "pirc:reload",
    description: "PiRC: reload pi's resources (used by PiRC's clients)",
    reason: "reload",
    timeout: "pi did not reload",
    run: async (_args, ctx) => {
      await ctx.reload();
      return undefined;
    },
  },
} satisfies Record<string, SessionCommand>;

type CommandName = keyof typeof SESSION_COMMANDS;
const reasonOf = (which: CommandName) => (SESSION_COMMANDS[which] as SessionCommand).reason;

// What a client sends: everything in SessionMessage but the session's own
// messages to clients.
type Request = Exclude<NonNullable<SessionMessage["body"]["case"]>, "event" | "history" | "accepted" | "error" | "models" | "stats" | "commands" | "pastSessions" | "tree">;
// Each request as a change, run at most once per session, client and
// request ID, or a question, answered afresh (host.ts). A new request does
// not compile until it is placed here; the session announces them all.
export const REQUESTS: Record<Request, "change" | "question"> = {
  prompt: "change",
  abort: "change",
  setModel: "change",
  setThinkingLevel: "change",
  compact: "change",
  newSession: "change",
  fork: "change",
  clone: "change",
  resume: "change",
  reload: "change",
  navigateTree: "change",
  rename: "change",
  stop: "change",
  launch: "change",
  answer: "change",
  historyRequest: "question",
  listModels: "question",
  statsRequest: "question",
  listCommands: "question",
  listPastSessions: "question",
  listTree: "question",
};
// Why pi cannot fork the session before entry `id` (a user message, as
// /fork) or at it (as /clone), if so. pi 1.0.0 exits on any error an
// extension's fork() meets (docs/design.md, section 8), so each of its
// refusals is checked here first: an unknown entry, a fork before anything
// but a user message, and a session pi has not written yet (it writes the
// file with the first reply), which it cannot branch.
export function forkProblem(ctx: Pick<ExtensionContext, "sessionManager">, id: string, position: "before" | "at"): string | undefined {
  const sm = ctx.sessionManager;
  const e = id ? sm.getEntry(id) : undefined;
  if (!e) return position === "at" ? "nothing to clone yet" : "no such entry in this session";
  if (position === "before" && !(e.type === "message" && e.message.role === "user")) return "not a user message of this session";
  const target = position === "at" ? e.id : e.parentId;
  const file = sm.getSessionFile();
  if (target && file && !existsSync(file)) return "pi has not saved this session yet: it has no reply to keep";
  return undefined;
}

// Why pi cannot move the session to entry `id` in its tree, if so. pi
// throws for an unknown entry, an error the command handler catches.
export function treeProblem(ctx: Pick<ExtensionContext, "sessionManager">, id: string): string | undefined {
  return id && ctx.sessionManager.getEntry(id) ? undefined : "no such entry in this session";
}

// The sessions pi has saved, as its /resume lists them, newest change
// first: those of the session's folder, or of every folder. pi gives
// extensions no way to list them, and the bundle cannot import pi's code
// (Node loads it, not pi's loader), so pi's SessionManager is reached as
// the class of the context's own (docs/design.md, section 8).
export async function pastSessions(ctx: Pick<ExtensionContext, "sessionManager">, allFolders: boolean): Promise<SessionInfo[]> {
  const sm = ctx.sessionManager as ExtensionContext["sessionManager"] & { usesDefaultSessionDir?(): boolean };
  const pi = sm.constructor as {
    list?(cwd: string, sessionDir?: string): Promise<SessionInfo[]>;
    listAll?(sessionDir?: string): Promise<SessionInfo[]>;
  };
  if (typeof pi.list !== "function" || typeof pi.listAll !== "function") throw new Error("this pi gives no way to list its sessions");
  const dir = sm.getSessionDir();
  if (!allFolders) return pi.list(sm.getCwd(), dir);
  return sm.usesDefaultSessionDir?.() === false ? pi.listAll(dir) : pi.listAll();
}

// Why pi cannot resume the session saved at `path`, if so. pi exits on
// any error its switch meets but one, a folder that no longer exists, for
// which it asks at its terminal instead; both are checked here first. Only
// a session /resume would list is taken.
export async function resumeProblem(ctx: Pick<ExtensionContext, "sessionManager">, path: string): Promise<string | undefined> {
  if (!path) return "no session given";
  if (path === ctx.sessionManager.getSessionFile()) return "pi has this session open already";
  const find = async (all: boolean) => (await pastSessions(ctx, all)).find((s) => s.path === path);
  const info = (await find(false)) ?? (await find(true));
  if (!info) return "pi has no such saved session";
  if (info.cwd && !existsSync(info.cwd)) return `its folder no longer exists: ${info.cwd}`;
  return undefined;
}

// pi 1.0.0's built-in commands (dist/core/slash-commands.js), which run
// only in its terminal; pi does not export the list. Sent as prompt text
// they would reach the model, so they are refused, naming the action
// that does the same where there is one.
export const BUILTIN_COMMANDS = new Set([
  "settings", "model", "tree", "thinking", "scoped-models", "export", "import", "share", "bug", "copy", "name",
  "session", "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new", "compact", "resume",
  "reload", "quit",
]);
const ACTION_FOR: Record<string, string> = {
  model: "set model",
  thinking: "set thinking level",
  name: "rename",
  new: "new session",
  fork: "fork",
  clone: "clone",
  resume: "resume",
  reload: "reload",
  compact: "compact",
  session: "stats",
};

// The command a prompt names, if it starts with "/".
function commandName(text: string): string | undefined {
  return text.startsWith("/") ? text.slice(1).split(/\s/, 1)[0] : undefined;
}

const isPircCommand = (name: string) => name === "pirc" || name.startsWith("pirc:");

// Why a prompt naming command `name` is refused, or undefined.
function refusedCommand(name: string): string | undefined {
  if (isPircCommand(name)) return `/${name} is PiRC's own command; it runs only in pi's terminal`;
  if (!BUILTIN_COMMANDS.has(name)) return undefined;
  const action = ACTION_FOR[name];
  return `pi's /${name} runs only in its terminal` + (action ? `; use the ${action} action` : "");
}

const SOURCE: Record<string, CommandSource> = {
  extension: CommandSource.EXTENSION,
  prompt: CommandSource.PROMPT,
  skill: CommandSource.SKILL,
};

interface Pending {
  message: AgentMessage;
  since: number;
  // How long its tool ran, as timed here (a tool result's).
  took?: number;
  requestId?: string;
  messageId?: string;
}

// A prompt sent to an idle pi, not yet confirmed by its run starting.
interface Unconfirmed {
  requestId: string;
  text: string;
  respond: Respond;
  timer: NodeJS.Timeout | undefined;
}

// A session's latest notice, and the number of the last one announced with
// push set: kept by the host for a return to the session.
export interface NoticeMemo {
  notice: Notice | undefined;
  pushed: bigint;
}

// A prompt that came while pi compacts, accepted and not yet sent.
interface Held {
  requestId: string;
  text: string;
  images: boolean;
  content: Parameters<ExtensionAPI["sendUserMessage"]>[0];
  deliverAs: "steer" | "followUp";
}

export class Live {
  readonly sessionId: string;
  readonly origin: SessionOrigin;
  private seq: bigint;
  private working = false;
  private compacting = false;
  private unconfirmed: Unconfirmed[] = [];
  // pi refuses prompts while it compacts; as its terminal does with what is
  // typed meanwhile, these wait, in order, until it has finished.
  private held: Held[] = [];
  private releasing: NodeJS.Immediate | undefined;
  // Sent the first to an idle pi: the rest wait for its run to start, or
  // for as long as a prompt may take to, not counting a compaction first.
  private starting = false;
  private startTimer: NodeJS.Timeout | undefined;
  // A Compact being run, answered when pi finishes it.
  private compaction: { respond: Respond } | undefined;
  // A NewSession, Fork, Clone, Resume, Reload or NavigateTree under way
  // (SESSION_COMMANDS), answered when pi shuts this session down for its
  // command's reason, or for NavigateTree when its command has run. While
  // pi summarises the branch it leaves, the session is compacting.
  private replacement: { respond: Respond; timer: NodeJS.Timeout; which: CommandName; summarizing: boolean } | undefined;
  private turnId: string;
  private firstPrompt: string;
  private pending: Pending[] = [];
  private pendingTimer: NodeJS.Timeout | undefined;
  private assistantId = "";
  private delta: { messageId: string; turnId: string; index: number; kind: "text" | "thinking"; text: string } | undefined;
  private deltaTimer: NodeJS.Timeout | undefined;
  private progress = new Map<string, { text: string; timer: NodeJS.Timeout | undefined; sentAt: number }>();
  // When each running tool started, then how long it took, for a pi that
  // does not record it on the result (pi's agent core before 1.4).
  private toolStarts = new Map<string, number>();
  private toolTook = new Map<string, number>();
  private prompts: { requestId: string; text: string; images: boolean; at: number }[] = [];
  private disposed = false;
  // The announcement onAnnouncementChanged is sending, for the sink to send
  // as it is rather than build again.
  private building: SessionAnnouncement | undefined;
  // The run's last reply, for the notice when it ends.
  private reply: AgentMessage | undefined;
  // The questions seen showing, so that only a new one raises a notice.
  private seenQuestions: Set<string>;
  notice: NoticeMemo;

  constructor(
    public pi: ExtensionAPI,
    public ctx: ExtensionContext,
    private readonly sink: Sink,
    // The host key can arrive after the session starts (enrolment).
    private readonly hostKey: () => Uint8Array,
    readonly instanceId: string,
    reason: SessionStartEvent["reason"],
    readonly replaces: string,
    private readonly versions: { pi: string; extension: string },
    // Where the session's sequence numbers left off, if this process had it
    // before (/resume back to it): they never go backwards in one process.
    seq = 0n,
    // Its notice, likewise.
    notice: NoticeMemo = { notice: undefined, pushed: 0n },
  ) {
    this.seq = seq;
    this.notice = notice;
    this.seenQuestions = new Set(sink.questions().map((q) => q.id));
    this.sessionId = ctx.sessionManager.getSessionId();
    this.origin = ORIGIN[reason] ?? SessionOrigin.UNSPECIFIED;
    const branch = ctx.sessionManager.getBranch();
    this.turnId = lastTurnId(branch);
    this.firstPrompt = firstPrompt(branch);
    this.working = !ctx.isIdle();
  }

  // The same session after a reload, with pi's new objects.
  rebind(pi: ExtensionAPI, ctx: ExtensionContext): void {
    this.pi = pi;
    this.ctx = ctx;
  }

  get lastSeq(): bigint {
    return this.seq;
  }

  get ref() {
    return { hostKey: this.hostKey(), sessionId: this.sessionId, instanceId: this.instanceId };
  }

  announcement(): SessionAnnouncement {
    const sm = this.ctx.sessionManager;
    const model = this.ctx.model;
    const started = sm.getHeader()?.timestamp;
    return create(SessionAnnouncementSchema, {
      name: this.pi.getSessionName() ?? "",
      cwd: this.ctx.cwd,
      hostname: hostname(),
      model: model && modelRef(model),
      thinkingLevel: thinkingLevel(this.pi.getThinkingLevel()) ?? ThinkingLevel.UNSPECIFIED,
      working: this.working,
      compacting: this.compacting,
      startedAt: started ? atIso(started) : undefined,
      replacesSessionId: this.replaces,
      origin: this.origin,
      piVersion: this.versions.pi,
      extensionVersion: this.versions.extension,
      place: this.sink.place(),
      firstPrompt: this.firstPrompt,
      requests: Object.keys(REQUESTS).map(requestName),
      launcher: this.sink.launcher()?.name ?? "",
      launchId: this.sink.launchId,
      questions: this.sink.questions(),
      notice: this.notice.notice,
      ...this.usage(),
    });
  }

  // What the session has cost and how full its context is, as Stats has
  // them.
  private usage(): { cost: number; contextTokens?: bigint; contextWindow: bigint } {
    const usage = this.ctx.getContextUsage();
    return {
      cost: sessionTotals(this.ctx.sessionManager.getEntries()).cost,
      contextTokens: usage && usage.tokens !== null ? count(usage.tokens) : undefined,
      contextWindow: count(usage?.contextWindow ?? this.ctx.model?.contextWindow),
    };
  }

  announcementBytes(): Uint8Array {
    return toBinary(SessionAnnouncementSchema, this.building ?? this.announcement());
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.pendingTimer);
    clearTimeout(this.deltaTimer);
    for (const p of this.progress.values()) clearTimeout(p.timer);
    clearImmediate(this.releasing);
    clearTimeout(this.startTimer);
    // Accepted already; the session's end says they were not sent.
    this.held = [];
    for (const u of this.unconfirmed.splice(0)) {
      clearTimeout(u.timer);
      u.respond(errorReply(u.requestId, ErrorCode.SESSION_GONE, "the session ended before the prompt ran"));
    }
    this.compaction?.respond(errorReply("", ErrorCode.SESSION_GONE, "the session ended before the compaction finished"));
    this.compaction = undefined;
    if (this.replacement) {
      clearTimeout(this.replacement.timer);
      // Ended as the session is; nothing goes out after dispose.
      this.replacement.respond(errorReply("", ErrorCode.SESSION_GONE, "the session ended other than by the replacement asked for"));
      this.replacement = undefined;
    }
  }

  // pi is shutting this session down; a replacement waiting for that is
  // answered now, before the session's end goes out.
  onShutdown(reason: SessionShutdownEvent["reason"]): void {
    const r = this.replacement;
    if (!r || reason !== reasonOf(r.which)) return;
    this.endReplacement();
    r.respond(accepted(""));
  }

  // One of SESSION_COMMANDS is running: one that keeps the session is
  // answered when it has run, however long that takes (a summary).
  onCommandStart(which: CommandName): void {
    const r = this.replacement;
    if (r?.which === which && !reasonOf(which)) clearTimeout(r.timer);
  }

  // One of SESSION_COMMANDS has run, failing (it was cancelled, or failed)
  // if failed says why.
  onCommandRan(which: CommandName, failed: string | undefined): void {
    const r = this.replacement;
    if (r?.which !== which || (!failed && reasonOf(which))) return;
    this.endReplacement();
    r.respond(failed ? errorReply("", ErrorCode.PI_FAILED, failed) : accepted(""));
  }

  private endReplacement(): void {
    const r = this.replacement;
    if (!r) return;
    this.replacement = undefined;
    clearTimeout(r.timer);
    if (r.summarizing) this.onCompactEnd();
  }

  // The session moved in its tree, at a client's request or at pi's
  // terminal: clients ask for the conversation again.
  onTree(leafId: string | null): void {
    this.catchUp();
    this.turnId = lastTurnId(this.ctx.sessionManager.getBranch());
    this.emit({ case: "branchChanged", value: { leafId: leafId ?? "" } });
    // Another branch has its own context use, and a summary its cost; a
    // move that summarised announces as its summary ends.
    if (!this.replacement?.summarizing) this.onAnnouncementChanged();
  }

  // Runs a timer's work, keeping its errors from pi.
  private guard(where: string, fn: () => void): () => void {
    return () => {
      if (this.disposed) return;
      try {
        fn();
      } catch (e) {
        this.sink.fail(where, e);
      }
    };
  }

  // --- Events from pi -------------------------------------------------

  private emit(body: NonNullable<MessageInitShape<typeof SessionEventSchema>["body"]>): void {
    if (body.case !== "assistantDelta") this.flushDelta();
    this.seq++;
    this.sink.broadcast(this, create(SessionMessageSchema, {
      body: { case: "event", value: { seq: this.seq, at: timestampFromDate(new Date()), body } },
    }));
  }

  private emitItem(item: ConversationItem): void {
    // Room for the event around it.
    this.emit({ case: "item", value: fitItem(item, this.sink.maxPayloadBytes() - 256) });
  }

  // Called first thing on every event: the messages that ended before it
  // are persisted by now (pi persists after its extension handlers return,
  // and awaits each event before the next), so their entries are known.
  private catchUp(): void {
    this.resolvePending();
  }

  private findEntry(message: AgentMessage): string | undefined {
    const entries = this.ctx.sessionManager.getEntries();
    for (let i = entries.length - 1, n = 0; i >= 0 && n < 200; i--, n++) {
      const e = entries[i] as SessionEntry;
      if (e.type === "message" && e.message === message) return e.id;
    }
    return undefined;
  }

  // Sends the finished messages in order once pi has persisted each; one
  // still not persisted after PERSIST_MS goes without an entry ID.
  private resolvePending(): void {
    const now = Date.now();
    let replied = false;
    while (this.pending.length > 0) {
      const p = this.pending[0];
      const entryId = this.findEntry(p.message);
      if (entryId === undefined && now - p.since < PERSIST_MS) break;
      this.pending.shift();
      if (p.message.role === "assistant") replied = true;
      if (p.message.role === "user" && entryId) this.turnId = entryId;
      // The session's first message names it until pi has a name.
      if (p.message.role === "user" && !this.firstPrompt) {
        this.firstPrompt = firstLine(promptText(textOf(p.message.content)));
        if (this.firstPrompt) this.onAnnouncementChanged();
      }
      const at = atMs((p.message as { timestamp?: number }).timestamp);
      // Timed here, for a pi that does not record it on the result.
      const m = p.took !== undefined && (p.message as { durationMs?: number }).durationMs === undefined ? ({ ...p.message, durationMs: p.took } as AgentMessage) : p.message;
      for (const item of messageItems(m, { entryId: entryId ?? "", turnId: this.turnId, at }, p)) {
        this.emitItem(item);
      }
      // A client's images, shown in pi's chat after its message. Appended
      // now, while the message is the last entry: pi saves a message only
      // after the extension's message_end (docs/design.md, section 8).
      if (p.requestId && entryId && photosOf(p.message).length > 0) {
        this.pi.appendEntry<PhotoData>(PHOTO_ENTRY, { message: entryId });
      }
    }
    clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    // A reply changes the cost and the context use the announcement has:
    // each assistant message, a run's every step.
    if (replied && !this.disposed) this.onAnnouncementChanged();
    if (this.pending.length > 0 && !this.disposed) this.waitForPending();
  }

  // The last message of a run has no next event to resolve it: look again
  // shortly.
  private waitForPending(): void {
    this.pendingTimer = setTimeout(this.guard("pending", () => {
      this.pendingTimer = undefined;
      this.resolvePending();
    }), 10);
  }

  onMessageStart(m: AgentMessage): void {
    this.catchUp();
    if (m.role === "assistant") {
      this.assistantId = "m-" + randomBytes(8).toString("hex");
    }
  }

  onMessageUpdate(e: MessageUpdateEvent): void {
    this.catchUp();
    const ev = e.assistantMessageEvent;
    if (ev.type !== "text_delta" && ev.type !== "thinking_delta") return;
    const kind = ev.type === "text_delta" ? "text" : "thinking";
    const d = this.delta;
    if (d && d.messageId === this.assistantId && d.index === ev.contentIndex && d.kind === kind) {
      d.text += ev.delta;
      return;
    }
    this.flushDelta();
    this.delta = { messageId: this.assistantId, turnId: this.turnId, index: ev.contentIndex, kind, text: ev.delta };
    this.deltaTimer = setTimeout(this.guard("delta", () => this.flushDelta()), DELTA_MS);
  }

  private flushDelta(): void {
    clearTimeout(this.deltaTimer);
    this.deltaTimer = undefined;
    const d = this.delta;
    if (!d) return;
    this.delta = undefined;
    this.emit({
      case: "assistantDelta",
      value: { messageId: d.messageId, turnId: d.turnId, blockIndex: d.index, body: { case: d.kind, value: d.text } },
    });
  }

  onMessageEnd(m: AgentMessage): void {
    this.catchUp();
    if (!SHOWN.has(m.role)) return;
    const p: Pending = { message: m, since: Date.now() };
    if (m.role === "toolResult") {
      p.took = this.toolTook.get(m.toolCallId);
      this.toolTook.delete(m.toolCallId);
    }
    if (m.role === "user") {
      p.requestId = this.matchPrompt(textOf(m.content), Array.isArray(m.content) && m.content.some((c) => c.type === "image"));
      if (p.requestId) this.confirm((u) => u.requestId === p.requestId);
      if (p.requestId) preparePhotos(photosOf(m));
    }
    if (m.role === "assistant") {
      p.messageId = this.assistantId;
      this.reply = m;
    }
    this.pending.push(p);
    if (!this.pendingTimer) this.waitForPending();
  }

  onToolUpdate(e: ToolExecutionUpdateEvent): void {
    this.catchUp();
    if (e.parentToolCallId) return;
    // A quarter of the payload in characters: at most four bytes each.
    const text = clip(textOf((e.partialResult as { content?: [] } | undefined)?.content), Math.floor(this.sink.maxPayloadBytes() / 4));
    let p = this.progress.get(e.toolCallId);
    if (!p) {
      p = { text, timer: undefined, sentAt: 0 };
      this.progress.set(e.toolCallId, p);
    }
    p.text = text;
    if (p.timer) return;
    const send = () => {
      p.timer = undefined;
      p.sentAt = Date.now();
      this.emit({ case: "toolProgress", value: { toolCallId: e.toolCallId, turnId: this.turnId, text: p.text } });
    };
    const wait = PROGRESS_MS - (Date.now() - p.sentAt);
    if (wait <= 0) send();
    else p.timer = setTimeout(this.guard("progress", send), wait);
  }

  onToolStart(toolCallId: string): void {
    this.toolStarts.set(toolCallId, Date.now());
  }

  onToolEnd(toolCallId: string): void {
    this.catchUp();
    const start = this.toolStarts.get(toolCallId);
    this.toolStarts.delete(toolCallId);
    if (start !== undefined) {
      // A result that never came is not kept for ever.
      if (this.toolTook.size > 100) this.toolTook.clear();
      this.toolTook.set(toolCallId, Date.now() - start);
    }
    const p = this.progress.get(toolCallId);
    if (p) clearTimeout(p.timer);
    this.progress.delete(toolCallId);
  }

  onWorking(working: boolean): void {
    this.catchUp();
    if (working && !this.working) this.reply = undefined;
    if (!working && this.working) this.raise(turnNotice(this.reply, this.nextNumber()));
    if (working) {
      // A command that expands (a prompt template, a skill) is echoed as
      // different text; the run starting confirms it.
      this.confirm((u, i) => i === 0 && u.text.startsWith("/"));
    } else if (!this.compaction) {
      // A compaction pi failed to report has ended with the run.
      this.compacting = false;
    }
    if (working) {
      clearTimeout(this.startTimer);
      this.starting = false;
    }
    this.release();
    if (working === this.working) return;
    this.working = working;
    this.emit({ case: "workingChanged", value: { working } });
    this.onAnnouncementChanged();
  }

  onAnnouncementChanged(): void {
    // Built once for both: its cost and context use read the whole session.
    const a = this.announcement();
    this.emit({ case: "announcement", value: a });
    this.building = a;
    try {
      this.sink.announce(this);
    } finally {
      this.building = undefined;
    }
  }

  // pi refuses prompts while it compacts. A compaction before a prompt's
  // run (pi compacts first when the context is full) pauses its deadline.
  onCompactStart(): void {
    for (const u of this.unconfirmed) clearTimeout(u.timer);
    clearTimeout(this.startTimer);
    if (this.compacting) return;
    this.compacting = true;
    this.onAnnouncementChanged();
  }

  onCompactEnd(): void {
    if (!this.sink.questions().length) for (const u of this.unconfirmed) this.armConfirm(u);
    if (this.starting) this.armStart();
    this.release();
    if (!this.compacting) return;
    this.compacting = false;
    this.onAnnouncementChanged();
  }

  // A question an extension asks before a prompt's run (in
  // before_agent_start, say) holds the run up: the prompt's deadline waits
  // while one is asked.
  onQuestionsChanged(): void {
    const now = this.sink.questions();
    const fresh = now.filter((q) => !this.seenQuestions.has(q.id));
    this.seenQuestions = new Set(now.map((q) => q.id));
    if (fresh.length > 0) this.raise(questionNotice(fresh[fresh.length - 1], this.nextNumber()));
    const asking = now.length > 0;
    for (const u of this.unconfirmed) {
      if (asking) clearTimeout(u.timer);
      else if (!this.compacting) this.armConfirm(u);
    }
  }

  onCompact(entry: { id: string; timestamp: string; summary: string; tokensBefore: number }): void {
    this.catchUp();
    this.emitItem(compactionItem(entry, this.turnId));
    // The item, then the end of compacting it.
    this.onCompactEnd();
  }

  // --- Requests from clients ------------------------------------------

  private prunePrompts(): void {
    const now = Date.now();
    this.prompts = this.prompts.filter((p) => now - p.at < PROMPT_ECHO_MS);
  }

  // The request a user message echoes: the same text, or failing that the
  // oldest prompt it starts with, since pi appends notes to a prompt with
  // images ("[image resized]"), also to one with no text.
  private matchPrompt(text: string, images: boolean): string | undefined {
    this.prunePrompts();
    let i = this.prompts.findIndex((p) => p.text === text);
    if (i < 0) i = this.prompts.findIndex((p) => (p.text === "" ? p.images && images : text.startsWith(p.text)));
    if (i < 0) return undefined;
    return this.prompts.splice(i, 1)[0].requestId;
  }

  // Sends the held prompts once pi has finished compacting: pi clears its
  // compaction only after its hooks return, so not before then. An idle pi
  // starts a run with the first; the rest go once it has, as pi queues
  // only what comes mid-run.
  private release(): void {
    if (this.held.length === 0 || this.releasing || this.starting) return;
    this.releasing = setImmediate(this.guard("release", () => {
      this.releasing = undefined;
      while (this.held.length > 0 && !this.compacting && !this.starting && !this.disposed) {
        const idle = this.ctx.isIdle();
        const h = this.held.shift()!;
        this.prunePrompts();
        this.prompts.push({ requestId: h.requestId, text: h.text, images: h.images, at: Date.now() });
        this.pi.sendUserMessage(h.content, { deliverAs: h.deliverAs, expandPromptTemplates: true });
        if (idle) {
          this.starting = true;
          this.armStart();
        }
      }
    }));
  }

  private armStart(): void {
    clearTimeout(this.startTimer);
    this.startTimer = setTimeout(this.guard("start", () => {
      this.starting = false;
      this.release();
    }), CONFIRM_MS);
  }

  private nextNumber(): bigint {
    return nextNumber(this.notice.notice?.number);
  }

  // A notice goes out with the next announcement.
  private raise(n: Notice | undefined): void {
    if (n) this.notice = { ...this.notice, notice: n };
  }

  // Answers Accepted to the unconfirmed prompts `which` picks.
  private confirm(which: (u: Unconfirmed, i: number) => boolean): void {
    const keep: Unconfirmed[] = [];
    this.unconfirmed.forEach((u, i) => {
      if (!which(u, i)) return keep.push(u);
      clearTimeout(u.timer);
      u.respond(accepted(u.requestId));
    });
    this.unconfirmed = keep;
  }

  private armConfirm(u: Unconfirmed): void {
    clearTimeout(u.timer);
    u.timer = setTimeout(this.guard("confirm", () => {
      this.unconfirmed = this.unconfirmed.filter((x) => x !== u);
      u.respond(errorReply(u.requestId, ErrorCode.TIMEOUT, "pi did not start the prompt; it may have refused it (see pi's screen)"));
    }), CONFIRM_MS);
  }

  // Whether text runs an extension command, which pi handles at once, even
  // mid-run, and which starts no run.
  private isCommand(text: string): boolean {
    const name = commandName(text);
    if (name === undefined) return false;
    return this.pi.getCommands().some((c) => c.source === "extension" && c.name === name);
  }

  // Why compacting or replacing the session cannot start now, if so.
  private busy(): string | undefined {
    if (this.compacting || this.compaction) return "pi is compacting the session";
    if (this.replacement) return this.replacement.which === "tree" ? "the session is moving in its tree" : "the session is being replaced";
    // pi has the prompt but has not started its run yet.
    if (this.unconfirmed.length > 0 || this.held.length > 0) return "a prompt is starting";
    if (this.working || !this.ctx.isIdle()) return "the agent is working; stop it first";
    return undefined;
  }

  // Runs then with what a promise of pi's gives, unless the session has
  // ended by then; a rejection is answered PI_FAILED.
  private whenSettled<T>(requestId: string, where: string, p: Promise<T>, respond: Respond, then: (v: T) => void): void {
    p.then(
      (v) => {
        if (this.disposed) return respond(errorReply(requestId, ErrorCode.SESSION_GONE, "the session ended"));
        this.guard(where, () => then(v))();
      },
      (e) => respond(errorReply(requestId, ErrorCode.PI_FAILED, errorText(e))),
    );
  }

  // Changes the session through one of PiRC's commands, answered when pi
  // shuts this session down for its reason (onShutdown), or when it has
  // run (onCommandRan).
  private replace(requestId: string, which: CommandName, args: string, respond: Respond, summarizing = false): void {
    const { name, timeout } = SESSION_COMMANDS[which];
    const command = args ? `/${name} ${args}` : `/${name}`;
    const why = this.busy();
    if (why) return respond(errorReply(requestId, ErrorCode.BUSY, why));
    const timer = setTimeout(this.guard("replacement", () => {
      if (this.replacement?.timer !== timer) return;
      this.endReplacement();
      respond(errorReply(requestId, ErrorCode.TIMEOUT, timeout));
    }), CONFIRM_MS);
    // Answers carry the request's ID, whoever sends them.
    this.replacement = { respond: (r) => respond(withRequestId(r, requestId)), timer, which, summarizing };
    if (summarizing) this.onCompactStart();
    try {
      this.pi.sendUserMessage(command, { deliverAs: "followUp", expandPromptTemplates: true });
    } catch (e) {
      this.onCommandRan(which, errorText(e));
    }
  }

  // Handles one request, answering it through respond, now or later.
  onRequest(m: SessionMessage, respond: Respond): void {
    const body = m.body;
    switch (body.case) {
      case "prompt": {
        const { requestId, text, images, delivery } = body.value;
        if (!text && images.length === 0) return respond(errorReply(requestId, ErrorCode.INVALID, "empty prompt"));
        const name = commandName(text);
        const refused = name === undefined ? undefined : refusedCommand(name);
        if (refused) return respond(errorReply(requestId, ErrorCode.INVALID, refused));
        const command = images.length === 0 && this.isCommand(text);
        // pi throws this from a promise no extension sees; check first.
        if (!command && !this.ctx.model) return respond(errorReply(requestId, ErrorCode.PI_FAILED, "no model is selected in pi"));
        const content = images.length === 0
          ? text
          : [
              ...(text ? [{ type: "text" as const, text }] : []),
              ...images.map((i) => ({ type: "image" as const, mimeType: i.mimeType, data: Buffer.from(i.data).toString("base64") })),
            ];
        // Always pass deliverAs: without it, a message sent while the
        // agent runs is dropped (docs/design.md, section 8).
        const deliverAs = delivery === Delivery.STEER ? "steer" : "followUp";
        // Behind any held already, to keep their order.
        if (!command && (this.compacting || this.held.length > 0)) {
          this.held.push({ requestId, text, images: images.length > 0, content, deliverAs });
          return respond(accepted(requestId));
        }
        const idle = this.ctx.isIdle();
        this.prunePrompts();
        if (!command) this.prompts.push({ requestId, text, images: images.length > 0, at: Date.now() });
        this.pi.sendUserMessage(content, { deliverAs, expandPromptTemplates: true });
        // A command has run, and a prompt sent mid-run is queued, by the
        // time pi answers; one sent to an idle pi is confirmed by its echo
        // or its run starting.
        if (command || !idle) return respond(accepted(requestId));
        const u: Unconfirmed = { requestId, text, respond, timer: undefined };
        this.unconfirmed.push(u);
        if (!this.compacting && !this.sink.questions().length) this.armConfirm(u);
        return;
      }
      case "abort":
        this.ctx.abort();
        return respond(accepted(body.value.requestId));
      case "historyRequest":
        return respond(this.history(body.value.requestId, body.value.limit, body.value.afterEntryId));
      case "listModels": {
        const current = this.ctx.model;
        return respond(create(SessionMessageSchema, {
          body: {
            case: "models",
            value: {
              requestId: body.value.requestId,
              models: this.ctx.modelRegistry.getAvailable().map(modelInfo),
              current: current && modelInfo(current),
            },
          },
        }));
      }
      case "setModel": {
        const { requestId, model } = body.value;
        if (!model?.provider || !model.id) return respond(errorReply(requestId, ErrorCode.INVALID, "no model given"));
        const found = this.ctx.modelRegistry.find(model.provider, model.id);
        if (!found) return respond(errorReply(requestId, ErrorCode.INVALID, `pi has no model ${model.provider}/${model.id}`));
        return this.whenSettled(requestId, "set model", this.pi.setModel(found), respond, (ok) => {
          if (!ok) return respond(errorReply(requestId, ErrorCode.PI_FAILED, `pi has no credentials for ${model.provider}`));
          this.onAnnouncementChanged();
          respond(accepted(requestId));
        });
      }
      case "setThinkingLevel": {
        const { requestId, level } = body.value;
        const name = thinkingName(level);
        if (!name) return respond(errorReply(requestId, ErrorCode.INVALID, "no thinking level given"));
        this.pi.setThinkingLevel(name);
        // pi announces only a change; the level in effect goes out anyway.
        this.onAnnouncementChanged();
        return respond(accepted(requestId));
      }
      case "rename": {
        const { requestId } = body.value;
        const name = body.value.name.trim();
        if (!name) return respond(errorReply(requestId, ErrorCode.INVALID, "empty name"));
        this.pi.setSessionName(name);
        this.onAnnouncementChanged();
        return respond(accepted(requestId));
      }
      case "compact": {
        const { requestId, instructions } = body.value;
        const why = this.busy();
        if (why) return respond(errorReply(requestId, ErrorCode.BUSY, why));
        if (!this.ctx.model) return respond(errorReply(requestId, ErrorCode.PI_FAILED, "no model is selected in pi"));
        const c = { respond: (r: SessionMessage) => respond(withRequestId(r, requestId)) };
        // Compacting from now: pi's own hook comes only after it prepares.
        this.compaction = c;
        this.onCompactStart();
        const finish = (reply: SessionMessage) => this.guard("compact", () => {
          if (this.compaction !== c) return;
          this.compaction = undefined;
          this.onCompactEnd();
          c.respond(reply);
        })();
        this.ctx.compact({
          customInstructions: instructions || undefined,
          onComplete: () => finish(accepted(requestId)),
          onError: (e) => finish(errorReply(requestId, ErrorCode.PI_FAILED, e.message)),
        });
        return;
      }
      case "newSession":
        return this.replace(body.value.requestId, "new", "", respond);
      case "fork": {
        const { requestId, entryId } = body.value;
        const problem = forkProblem(this.ctx, entryId, "before");
        if (problem) return respond(errorReply(requestId, ErrorCode.INVALID, problem));
        return this.replace(requestId, "fork", entryId, respond);
      }
      case "clone": {
        const { requestId } = body.value;
        const problem = forkProblem(this.ctx, this.ctx.sessionManager.getLeafId() ?? "", "at");
        if (problem) return respond(errorReply(requestId, ErrorCode.INVALID, problem));
        return this.replace(requestId, "clone", "", respond);
      }
      case "listPastSessions": {
        const { requestId, allFolders } = body.value;
        return this.whenSettled(requestId, "past sessions", pastSessions(this.ctx, allFolders), respond, (all) => respond(this.pastSessions(requestId, all)));
      }
      case "resume": {
        const { requestId, path } = body.value;
        const why = this.busy();
        if (why) return respond(errorReply(requestId, ErrorCode.BUSY, why));
        return this.whenSettled(requestId, "resume", resumeProblem(this.ctx, path), respond, (problem) => {
          if (problem) return respond(errorReply(requestId, ErrorCode.INVALID, problem));
          this.replace(requestId, "resume", path, respond);
        });
      }
      case "reload":
        return this.replace(body.value.requestId, "reload", "", respond);
      case "navigateTree": {
        const { requestId, entryId, summarize } = body.value;
        const problem = treeProblem(this.ctx, entryId);
        if (problem) return respond(errorReply(requestId, ErrorCode.INVALID, problem));
        if (summarize && !this.ctx.model) return respond(errorReply(requestId, ErrorCode.PI_FAILED, "no model is selected in pi to summarise with"));
        return this.replace(requestId, "tree", summarize ? `${entryId} summarize` : entryId, respond, summarize);
      }
      case "listTree": {
        const { requestId } = body.value;
        const all = branches(this.ctx.sessionManager);
        // The current branch and the newest are kept: the oldest are at the end.
        return respond(fitting(all.slice().reverse(), this.sink.maxPayloadBytes() - 1024, (kept) =>
          create(SessionMessageSchema, { body: { case: "tree", value: { requestId, branches: kept.slice().reverse(), truncated: kept.length < all.length } } })));
      }
      case "stop": {
        const { requestId } = body.value;
        const why = this.busy();
        if (why) return respond(errorReply(requestId, ErrorCode.BUSY, why));
        respond(accepted(requestId));
        // After the answer has had a moment to leave.
        setTimeout(this.guard("stop", () => this.ctx.shutdown()), STOP_DELAY_MS);
        return;
      }
      case "launch": {
        const { requestId } = body.value;
        const launcher = this.sink.launcher();
        if (!launcher) return respond(errorReply(requestId, ErrorCode.INVALID, "this pi cannot open another: it runs in neither tmux nor herdr, and no extension gives a launcher"));
        const folder = launchFolder(body.value.cwd);
        if ("problem" in folder) return respond(errorReply(requestId, ErrorCode.INVALID, folder.problem));
        return this.whenSettled(requestId, "launch", launcher.launch({ cwd: folder.path, command: piCommand(), env: launchEnv(process.env, requestId), name: launchName(body.value.name) }), respond, () => respond(accepted(requestId)));
      }
      case "answer": {
        const { requestId } = body.value;
        const why = this.sink.answer(body.value);
        return respond(why ? errorReply(requestId, ErrorCode.INVALID, why) : accepted(requestId));
      }
      case "statsRequest": {
        const usage = this.ctx.getContextUsage();
        return respond(create(SessionMessageSchema, {
          body: {
            case: "stats",
            value: {
              requestId: body.value.requestId,
              total: sessionTotals(this.ctx.sessionManager.getEntries()),
              contextTokens: usage && usage.tokens !== null ? count(usage.tokens) : undefined,
              contextWindow: count(usage?.contextWindow ?? this.ctx.model?.contextWindow),
            },
          },
        }));
      }
      case "listCommands":
        return respond(create(SessionMessageSchema, {
          body: {
            case: "commands",
            value: {
              requestId: body.value.requestId,
              commands: this.pi.getCommands()
                .filter((c) => !isPircCommand(c.name))
                .map((c) => ({ name: c.name, description: c.description ?? "", source: SOURCE[c.source] ?? CommandSource.UNSPECIFIED })),
            },
          },
        }));
      default:
        // A kind of request newer than this extension has no body here.
        return respond(errorReply(m.requestId, ErrorCode.INVALID, body.case ? `not a request: ${body.case}` : `this session's extension (${this.versions.extension}) does not take that request; update it`));
    }
  }

  // The saved sessions but this one, newest first, within one frame.
  private pastSessions(requestId: string, all: SessionInfo[]): SessionMessage {
    const budget = this.sink.maxPayloadBytes() - 1024;
    const current = this.ctx.sessionManager.getSessionFile();
    const shown = all.filter((s) => s.path !== current).map((s) => ({
      path: s.path,
      sessionId: s.id,
      cwd: s.cwd,
      name: s.name ?? "",
      firstPrompt: firstLine(promptText(s.firstMessage)),
      createdAt: timestampFromDate(s.created),
      modifiedAt: timestampFromDate(s.modified),
      messageCount: s.messageCount,
    }));
    // Newest first: the oldest are at the end.
    return fitting(shown.slice().reverse(), budget, (kept) => create(SessionMessageSchema, {
      body: { case: "pastSessions", value: { requestId, sessions: kept.slice().reverse(), truncated: kept.length < shown.length } },
    }));
  }

  // The conversation on the current branch, newest last, within one frame.
  history(requestId: string, limit: number, afterEntryId = ""): SessionMessage {
    this.flushDelta();
    this.resolvePending();
    const budget = this.sink.maxPayloadBytes() - 1024;
    // Each item fits on its own, so the newest always gets through.
    const all = historyItems(this.ctx.sessionManager.getBranch()).map((i) => fitItem(i, budget - 256));
    // Those after the client's last entry, when they are few enough and
    // fit whole; else the usual answer, which replaces what it has.
    const at = afterEntryId ? all.findLastIndex((i) => i.entryId === afterEntryId) : -1;
    if (at >= 0 && (limit === 0 || all.length - at - 1 <= limit)) {
      const after = all.slice(at + 1);
      const m = fitting(after, budget, (kept) =>
        create(SessionMessageSchema, { body: { case: "history", value: create(HistorySchema, { requestId, items: kept, seq: this.seq, fromEntry: true }) } }));
      if (m.body.case === "history" && m.body.value.items.length === after.length) return m;
    }
    const items = limit > 0 ? all.slice(-limit) : all;
    return fitting(items, budget, (kept) =>
      create(SessionMessageSchema, { body: { case: "history", value: create(HistorySchema, { requestId, items: kept, seq: this.seq, truncated: kept.length < all.length }) } }));
  }
}

// The message build makes of as many of items as fit in budget, dropping
// the oldest (the first) an eighth at a time.
function fitting<T>(items: T[], budget: number, build: (kept: T[]) => SessionMessage): SessionMessage {
  let kept = items;
  let m = build(kept);
  while (kept.length > 0 && toBinary(SessionMessageSchema, m).length > budget) {
    kept = kept.slice(Math.max(1, Math.floor(kept.length / 8)));
    m = build(kept);
  }
  return m;
}

export function errorText(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}

// The reply with its request ID set.
function withRequestId(m: SessionMessage, requestId: string): SessionMessage {
  if (m.body.case === "accepted" || m.body.case === "error") m.body.value.requestId = requestId;
  return m;
}
