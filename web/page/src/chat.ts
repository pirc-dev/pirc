// The chat's commands, as its components pass them down. How the chat
// groups and shows its items is in core/chat.ts.
import type { Answer, Body, CommandName } from "../../core/api.ts";

// Sends a command to the session, saying in the chat's notice line why it
// failed if it did; undefined when it got no answer.
export type Run = <K extends CommandName>(name: K, body: Body<K>) => Promise<Answer<K> | undefined>;
