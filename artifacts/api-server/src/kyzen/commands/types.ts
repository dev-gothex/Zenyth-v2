import type {
  Client,
  EmbedBuilder,
  Guild,
  GuildMember,
  Message,
} from "discord.js";
import type { CommandReferenceEntry } from "../command-reference";

export interface Indexed {
  moduleId: string;
  groupIndex: number;
  entryIndex: number;
  entry: CommandReferenceEntry;
  hasChildren: boolean;
}

export interface Ctx {
  client: Client;
  message: Message<true>;
  guild: Guild;
  member: GuildMember;
  indexed: Indexed;
  /** Full command path, e.g. "vanity channel". */
  path: string;
  /** Arguments after the command path. */
  args: string[];
  /** Raw argument text after the command path. */
  raw: string;
  prefix: string;
  reply(body: string | EmbedBuilder): Promise<Message>;
  ok(text: string): Promise<Message>;
  fail(text: string): Promise<Message>;
}

/** Throw to show the command's usage page (same as running it with no args). */
export class UsageError extends Error {}
/** Throw to send a plain failure message. */
export class CommandError extends Error {}

export type Handler = (ctx: Ctx) => Promise<void>;
