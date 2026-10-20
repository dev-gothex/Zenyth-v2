import type { Message } from "discord.js";
import { guildData, userData } from "./store";
import { ZENYTH_PREFIX } from "./modules";

/** The prefix commands use in a server (falls back to the default). */
export function guildPrefix(guildId?: string | null): string {
  return (guildId && (guildData(guildId).prefix as string | undefined)) || ZENYTH_PREFIX;
}

/** Finds which prefix (server or the author's personal one) a message starts with. */
export function matchPrefix(message: Message): { prefix: string; rest: string } | null {
  const candidates = [guildPrefix(message.guildId)];
  const personal = userData(message.author.id).prefix as string | undefined;
  if (personal) candidates.push(personal);
  for (const prefix of candidates.sort((a, b) => b.length - a.length)) {
    if (message.content.startsWith(prefix)) return { prefix, rest: message.content.slice(prefix.length) };
  }
  return null;
}
